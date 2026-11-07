import { zValidator } from "@hono/zod-validator";
import { convertMinor, type ScaledRates } from "@shared/fx-math";
import { COLOUR_PALETTE, FALLBACK_ICON, isKnownIcon } from "@shared/icons";
import { assertCurrencyCode, type CurrencyCode } from "@shared/money";
import {
  type CsvRow,
  cleanText,
  FINGERPRINT_VERSION,
  type ImportBatch,
  type ImportCheckResponse,
  type ImportRowFailure,
  type ImportRowsResponse,
  type ImportUndoPreview,
  importBatchCreateSchema,
  importCheckRequestSchema,
  importRowsRequestSchema,
  matchKey,
} from "@shared/schemas/csv";
import type { ValidationIssue } from "@shared/schemas/entry";
import type { Context } from "hono";
import { Hono } from "hono";
import type { z } from "zod";
import { baseValueFromSnapshot } from "../fx/base-value";
import { loadRateSnapshot, type RateSnapshot } from "../fx/rates";
import { minDate, todayIn } from "../fx/today";
import { sha256Hex } from "../lib/crypto";
import type { AppEnv } from "../lib/env";
import { HttpError } from "../lib/errors";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";

/**
 * CSV import. The browser parses the file; these endpoints fingerprint rows, report which are
 * already stored, store them chunk by chunk under an import batch, and undo a whole batch.
 * Exchange rates for the file's dates are filled beforehand through GET /api/rates?from&to.
 */

function validate<T extends z.ZodType>(target: "json", schema: T) {
  return zValidator(target, schema, (result, c: Context) => {
    if (result.success) return;
    const issues: ValidationIssue[] = result.error.issues.map((i) => ({
      path: i.path.map((p) => (typeof p === "number" ? p : String(p))),
      message: i.message,
    }));
    return c.json({ error: "validation_failed", issues }, 422);
  });
}

// ---------- fingerprints ----------

/**
 * A stable identity for a file row: the same row uploaded again, with different whitespace or
 * casing in its names and notes, gets the same fingerprint. The version prefix lets the recipe
 * change later without colliding with stored values.
 */
export async function fingerprint(row: CsvRow): Promise<string> {
  const canonical = JSON.stringify([
    row.date,
    row.type,
    row.amountMinor,
    row.currency,
    row.accountId,
    matchKey(row.categoryPath.parent),
    matchKey(row.categoryPath.child ?? ""),
    matchKey(row.notes ?? ""),
    row.occurrence,
  ]);
  return `${FINGERPRINT_VERSION}:${await sha256Hex(canonical)}`;
}

async function existingFingerprints(d1: D1Database, fingerprints: string[]): Promise<Set<string>> {
  const { results } = await d1
    .prepare("SELECT fingerprint FROM entries WHERE fingerprint IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(fingerprints))
    .all<{ fingerprint: string }>();
  return new Set(results.map((r) => r.fingerprint));
}

// ---------- categories and projects ----------

/** New categories and projects take the palette's middle shades in turn. */
const NEW_COLOURS = COLOUR_PALETTE.map((h) => h.shades[1]);

interface CategoryRow {
  id: string;
  type: "expense" | "income";
  parent_id: string | null;
  name: string;
  icon: string;
  archived_at: string | null;
}
interface ProjectRow {
  id: string;
  name: string;
  archived_at: string | null;
}

const SELECT_CATEGORIES = "SELECT id, type, parent_id, name, icon, archived_at FROM categories";
const SELECT_PROJECTS = "SELECT id, name, archived_at FROM projects";

const parentKey = (type: string, name: string) => `${type}|${matchKey(name)}`;
const childKey = (parentId: string, name: string) => `${parentId}|${matchKey(name)}`;

/** Name lookups that prefer an active row over an archived one with the same name. */
function indexBy<T extends { archived_at: string | null }>(
  rows: T[],
  key: (row: T) => string | null,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    const seen = map.get(k);
    if (!seen || (seen.archived_at !== null && row.archived_at === null)) map.set(k, row);
  }
  return map;
}

function indexCategories(rows: CategoryRow[]) {
  return {
    parents: indexBy(rows, (c) => (c.parent_id === null ? parentKey(c.type, c.name) : null)),
    children: indexBy(rows, (c) => (c.parent_id === null ? null : childKey(c.parent_id, c.name))),
    parentCount: rows.filter((c) => c.parent_id === null).length,
  };
}

/**
 * Finds or creates every category, subcategory and project the rows name. Creation is idempotent:
 * each insert only lands when no row with that name exists yet, so retried chunks reuse rows.
 * Returns, per row index, the category id and optional project id.
 */
async function resolveNames(
  d1: D1Database,
  rows: CsvRow[],
  categoryRows: CategoryRow[],
  projectRows: ProjectRow[],
  now: string,
): Promise<{ categoryIds: string[]; projectIds: (string | null)[] }> {
  let categories = indexCategories(categoryRows);
  let projects = indexBy(projectRows, (p) => matchKey(p.name));

  // Parents and projects first: they don't depend on anything.
  const firstStage: D1PreparedStatement[] = [];
  const newParents = new Map<string, { type: string; name: string; icon: string }>();
  const newProjects = new Map<string, string>();
  for (const row of rows) {
    const key = parentKey(row.type, row.categoryPath.parent);
    const icon = row.icon && isKnownIcon(row.icon) ? row.icon : null;
    const pending = newParents.get(key);
    if (!categories.parents.has(key) && !pending) {
      newParents.set(key, {
        type: row.type,
        name: cleanText(row.categoryPath.parent),
        icon: icon ?? FALLBACK_ICON,
      });
    } else if (pending && pending.icon === FALLBACK_ICON && icon) {
      pending.icon = icon;
    }
    if (row.projectName) {
      const projectKey = matchKey(row.projectName);
      if (!projects.has(projectKey) && !newProjects.has(projectKey)) {
        newProjects.set(projectKey, cleanText(row.projectName));
      }
    }
  }
  let colourIndex = categories.parentCount;
  for (const parent of newParents.values()) {
    firstStage.push(
      d1
        .prepare(
          `INSERT INTO categories (id, type, parent_id, name, icon, colour, created_at, updated_at)
           SELECT ?1, ?2, NULL, ?3, ?4, ?5, ?6, ?6
           WHERE NOT EXISTS (SELECT 1 FROM categories WHERE type = ?2 AND parent_id IS NULL AND name = ?3 COLLATE NOCASE)`,
        )
        .bind(
          newId(),
          parent.type,
          parent.name,
          parent.icon,
          NEW_COLOURS[colourIndex++ % NEW_COLOURS.length],
          now,
        ),
    );
  }
  let projectColour = projectRows.length;
  for (const name of newProjects.values()) {
    firstStage.push(
      d1
        .prepare(
          `INSERT INTO projects (id, name, colour, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?4
           WHERE NOT EXISTS (SELECT 1 FROM projects WHERE name = ?2 COLLATE NOCASE)`,
        )
        .bind(newId(), name, NEW_COLOURS[projectColour++ % NEW_COLOURS.length], now),
    );
  }
  if (firstStage.length > 0) {
    const results = await d1.batch([
      ...firstStage,
      d1.prepare(SELECT_CATEGORIES),
      d1.prepare(SELECT_PROJECTS),
    ]);
    categories = indexCategories((results.at(-2)?.results ?? []) as CategoryRow[]);
    projects = indexBy((results.at(-1)?.results ?? []) as ProjectRow[], (p) => matchKey(p.name));
  }

  const parentOf = (row: CsvRow): CategoryRow => {
    const parent = categories.parents.get(parentKey(row.type, row.categoryPath.parent));
    if (!parent) throw new Error("parent category must exist after creation");
    return parent;
  };

  // Then subcategories, under the parents that now exist.
  const newChildren = new Map<string, { parent: CategoryRow; name: string; icon: string | null }>();
  for (const row of rows) {
    if (!row.categoryPath.child) continue;
    const parent = parentOf(row);
    const key = childKey(parent.id, row.categoryPath.child);
    if (categories.children.has(key) || newChildren.has(key)) continue;
    const icon = row.icon && isKnownIcon(row.icon) ? row.icon : null;
    newChildren.set(key, { parent, name: cleanText(row.categoryPath.child), icon });
  }
  if (newChildren.size > 0) {
    const inserts = [...newChildren.values()].map((child) =>
      d1
        .prepare(
          `INSERT INTO categories (id, type, parent_id, name, icon, colour, created_at, updated_at)
           SELECT ?1, p.type, p.id, ?3, COALESCE(?4, p.icon), NULL, ?5, ?5 FROM categories p
           WHERE p.id = ?2 AND NOT EXISTS (SELECT 1 FROM categories WHERE parent_id = ?2 AND name = ?3 COLLATE NOCASE)`,
        )
        .bind(newId(), child.parent.id, child.name, child.icon, now),
    );
    const results = await d1.batch([...inserts, d1.prepare(SELECT_CATEGORIES)]);
    categories = indexCategories((results.at(-1)?.results ?? []) as CategoryRow[]);
  }

  const categoryIds = rows.map((row) => {
    const parent = parentOf(row);
    if (!row.categoryPath.child) return parent.id;
    const child = categories.children.get(childKey(parent.id, row.categoryPath.child));
    if (!child) throw new Error("subcategory must exist after creation");
    return child.id;
  });
  const projectIds = rows.map((row) => {
    if (!row.projectName) return null;
    const project = projects.get(matchKey(row.projectName));
    if (!project) throw new Error("project must exist after creation");
    return project.id;
  });
  return { categoryIds, projectIds };
}

// ---------- money ----------

/** Rates to convert on `date` from stored rows, or the newest rates for dates after the newest publication. */
function ratesOn(date: string, currencies: CurrencyCode[], snapshot: RateSnapshot): ScaledRates | null {
  const pivots = currencies.filter((c) => c !== "EUR");
  const onDate = pivots.map((c) => snapshot.byDate.get(`${date}|${c}`));
  let used = onDate;
  if (!onDate.every((r) => r !== undefined)) {
    const latest = pivots.map((c) => snapshot.latest.get(c));
    if (!latest.every((r) => r !== undefined)) return null;
    const newestPublished = latest.map((r) => r.sourceDate).reduce(minDate, "9999-12-31");
    if (date <= newestPublished) return null;
    used = latest;
  }
  return Object.fromEntries(pivots.map((c, i) => [c, used[i]?.rateScaled ?? 0]));
}

/** The row's amount in the account's currency, from the file or converted at the day's rate. */
function accountAmountFor(row: CsvRow, accountCurrency: CurrencyCode, snapshot: RateSnapshot): number | null {
  if (row.currency === accountCurrency) return row.amountMinor;
  if (row.accountAmountMinor !== undefined) return row.accountAmountMinor;
  const rates = ratesOn(row.date, [row.currency, accountCurrency], snapshot);
  if (!rates) return null;
  const converted = convertMinor({
    amountMinor: row.amountMinor,
    from: row.currency,
    to: accountCurrency,
    rates,
  });
  return converted > 0 ? converted : null;
}

// ---------- commit ----------

const ENTRY_COLUMNS = `id, kind, date, user_id, account_id, account_amount_minor, orig_currency, orig_amount_minor,
  base_amount_minor, fx_state, rate_scaled, rate_date, category_id, project_id, notes, fingerprint,
  import_batch_id, version, created_at, updated_at`;
/** Bound values per entry; the batch id (?1) and timestamp (?2) are shared by every row. */
const PARAMS_PER_ROW = 16;
/** D1 allows at most 100 bound parameters per statement. */
const ROWS_PER_INSERT = Math.floor((100 - 2) / PARAMS_PER_ROW);

type EntryValues = [
  string,
  string,
  string,
  string,
  string,
  number,
  string | null,
  number | null,
  number | null,
  string,
  number | null,
  string | null,
  string,
  string | null,
  string | null,
  string,
];

function insertStatements(d1: D1Database, batchId: string, now: string, values: EntryValues[]) {
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < values.length; start += ROWS_PER_INSERT) {
    const group = values.slice(start, start + ROWS_PER_INSERT);
    const tuples = group.map((_, i) => {
      const first = 3 + i * PARAMS_PER_ROW;
      const params = Array.from({ length: PARAMS_PER_ROW }, (_, k) => `?${first + k}`);
      return `(${params.join(", ")}, ?1, 1, ?2, ?2)`;
    });
    statements.push(
      d1
        .prepare(
          `INSERT INTO entries (${ENTRY_COLUMNS}) VALUES ${tuples.join(", ")}
           ON CONFLICT (fingerprint) WHERE fingerprint IS NOT NULL DO NOTHING`,
        )
        .bind(batchId, now, ...group.flat()),
    );
  }
  return statements;
}

function safeToday(timeZone: string): string {
  try {
    return todayIn(timeZone);
  } catch {
    return todayIn("UTC");
  }
}

async function commitRows(d1: D1Database, batchId: string, rows: CsvRow[]): Promise<ImportRowsResponse> {
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const [batch, household, accounts, users, categoryRows, projectRows] = await d1.batch<
    Record<string, unknown>
  >([
    d1.prepare("SELECT id FROM import_batches WHERE id = ?1").bind(batchId),
    d1.prepare("SELECT base_currency, timezone FROM household WHERE id = 1"),
    d1
      .prepare("SELECT id, currency, archived_at FROM accounts WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(accountIds)),
    d1
      .prepare("SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(userIds)),
    d1.prepare(SELECT_CATEGORIES),
    d1.prepare(SELECT_PROJECTS),
  ]);
  if (!batch?.results[0]) throw new HttpError(404, "not_found");
  const h = household?.results[0] as { base_currency: string; timezone: string } | undefined;
  if (!h) throw new HttpError(409, "not_set_up");
  assertCurrencyCode(h.base_currency);
  const baseCurrency = h.base_currency;
  const today = safeToday(h.timezone);

  const activeAccounts = new Map<string, CurrencyCode>();
  for (const a of (accounts?.results ?? []) as {
    id: string;
    currency: string;
    archived_at: string | null;
  }[]) {
    assertCurrencyCode(a.currency);
    if (a.archived_at === null) activeAccounts.set(a.id, a.currency);
  }
  const knownUsers = new Set(((users?.results ?? []) as { id: string }[]).map((u) => u.id));
  const issues: ValidationIssue[] = [];
  rows.forEach((row, i) => {
    if (!activeAccounts.has(row.accountId)) {
      issues.push({ path: ["rows", i, "accountId"], message: "Account not found or archived" });
    }
    if (!knownUsers.has(row.userId)) issues.push({ path: ["rows", i, "userId"], message: "Unknown partner" });
  });
  if (issues.length > 0) throw new HttpError(422, "validation_failed", { issues });

  const now = nowIso();
  const [snapshot, names, fingerprints] = await Promise.all([
    loadRateSnapshot(
      d1,
      rows.map((r) => r.date),
    ),
    resolveNames(
      d1,
      rows,
      (categoryRows?.results ?? []) as unknown as CategoryRow[],
      (projectRows?.results ?? []) as unknown as ProjectRow[],
      now,
    ),
    Promise.all(rows.map(fingerprint)),
  ]);

  const failed: ImportRowFailure[] = [];
  const values: EntryValues[] = [];
  rows.forEach((row, i) => {
    const accountCurrency = activeAccounts.get(row.accountId) as CurrencyCode;
    const accountAmountMinor = accountAmountFor(row, accountCurrency, snapshot);
    if (accountAmountMinor === null) {
      failed.push({
        rowNumber: row.rowNumber,
        message: `No ${row.currency}–${accountCurrency} exchange rate for ${row.date} yet — add an account_amount or try again later`,
      });
      return;
    }
    const foreign = row.currency !== accountCurrency;
    const value = baseValueFromSnapshot(
      { accountAmountMinor, accountCurrency, baseCurrency, entryDate: row.date, today },
      snapshot,
    );
    const notes = row.notes?.trim() ? row.notes.trim() : null;
    values.push([
      newId(),
      row.type,
      row.date,
      row.userId,
      row.accountId,
      accountAmountMinor,
      foreign ? row.currency : null,
      foreign ? row.amountMinor : null,
      value.baseAmountMinor,
      value.fxState,
      value.rateScaled,
      value.rateDate,
      names.categoryIds[i] as string,
      names.projectIds[i] ?? null,
      notes,
      fingerprints[i] as string,
    ]);
  });

  let inserted = 0;
  const statements = insertStatements(d1, batchId, now, values);
  if (statements.length > 0) {
    const results = await d1.batch(statements);
    for (const r of results) inserted += r.meta.changes;
  }
  return { inserted, skipped: values.length - inserted, failed };
}

// ---------- batches ----------

interface BatchRow {
  id: string;
  user_id: string;
  file_name: string;
  file_sha256: string;
  row_count: number;
  created_at: string;
  entry_count: number;
}

const SELECT_BATCH = `SELECT b.*, (SELECT COUNT(*) FROM entries e WHERE e.import_batch_id = b.id) AS entry_count
  FROM import_batches b`;

function toBatch(r: BatchRow): ImportBatch {
  return {
    id: r.id,
    userId: r.user_id,
    fileName: r.file_name,
    fileSha256: r.file_sha256,
    rowCount: r.row_count,
    createdAt: r.created_at,
    entryCount: r.entry_count,
  };
}

async function readBatch(d1: D1Database, id: string): Promise<ImportBatch> {
  const row = await d1.prepare(`${SELECT_BATCH} WHERE b.id = ?1`).bind(id).first<BatchRow>();
  if (!row) throw new HttpError(404, "not_found");
  return toBatch(row);
}

/** CSV import. Paths carry their own prefix; mount at "/". */
export const importRoutes = new Hono<AppEnv>()
  .post("/import/check", validate("json", importCheckRequestSchema), async (c) => {
    const { rows } = c.req.valid("json");
    const fingerprints = await Promise.all(rows.map(fingerprint));
    const existing = await existingFingerprints(c.env.DB, fingerprints);
    const body: ImportCheckResponse = {
      results: rows.map((row, i) => {
        const fp = fingerprints[i] as string;
        return { rowNumber: row.rowNumber, fingerprint: fp, exists: existing.has(fp) };
      }),
    };
    return c.json(body);
  })
  .get("/import/batches", async (c) => {
    const { results } = await c.env.DB.prepare(
      `${SELECT_BATCH} ORDER BY b.created_at DESC, b.id DESC`,
    ).all<BatchRow>();
    return c.json(results.map(toBatch));
  })
  .post("/import/batches", validate("json", importBatchCreateSchema), async (c) => {
    const input = c.req.valid("json");
    const id = newId();
    await c.env.DB.prepare(
      `INSERT INTO import_batches (id, user_id, file_name, file_sha256, row_count, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(id, c.var.user.id, input.fileName, input.fileSha256, input.rowCount, nowIso())
      .run();
    return c.json(await readBatch(c.env.DB, id), 201);
  })
  .post("/import/batches/:id/rows", validate("json", importRowsRequestSchema), async (c) => {
    return c.json(await commitRows(c.env.DB, c.req.param("id"), c.req.valid("json").rows));
  })
  .get("/import/batches/:id/undo-preview", async (c) => {
    const id = c.req.param("id");
    await readBatch(c.env.DB, id);
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) AS entryCount,
         COALESCE(SUM(e.version > 1), 0) AS editedCount,
         COALESCE(SUM(e.date <= (SELECT MAX(r.date) FROM reconciliations r WHERE r.account_id = e.account_id)), 0)
           AS reconciledCount
       FROM entries e WHERE e.import_batch_id = ?1`,
    )
      .bind(id)
      .first<ImportUndoPreview>();
    return c.json(row ?? { entryCount: 0, editedCount: 0, reconciledCount: 0 });
  })
  .delete("/import/batches/:id", async (c) => {
    if (c.req.query("confirm") !== "1") {
      throw new HttpError(400, "confirmation_required", {
        message: "Check the undo preview first, then confirm",
      });
    }
    const id = c.req.param("id");
    await readBatch(c.env.DB, id);
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM entries WHERE import_batch_id = ?1").bind(id),
      c.env.DB.prepare("DELETE FROM import_batches WHERE id = ?1").bind(id),
    ]);
    return c.body(null, 204);
  });
