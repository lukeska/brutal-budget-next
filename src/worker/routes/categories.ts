import {
  CATEGORY_TYPES,
  type Category,
  type CategoryMergeResult,
  type CategoryNode,
  type CategorySummary,
  type CategoryType,
  categoryCreateSchema,
  categoryMergeSchema,
  categoryPatchSchema,
  categorySummaryQuerySchema,
  versionQuerySchema,
} from "@shared/schemas/category";
import { CONFLICT_MESSAGE, type Entry } from "@shared/schemas/entry";
import { Hono } from "hono";
import { z } from "zod";
import { HOUSEHOLD_SQL, type HouseholdRow, parseHousehold } from "../db/household";
import { addDays, nextMonthStart, todayIn } from "../fx/today";
import { isForeignKeyError, runDelete } from "../lib/delete";
import type { AppEnv } from "../lib/env";
import { HttpError, invalid } from "../lib/errors";
import { nowIso } from "../lib/time";
import { validate } from "../lib/validate";
import { entriesStatement, toEntries } from "../services/entries";

interface CategoryRow {
  id: string;
  type: CategoryType;
  parent_id: string | null;
  name: string;
  icon: string;
  /** The parent's colour for a subcategory. */
  colour: string;
  archived_at: string | null;
  version: number;
  entry_count: number;
}

const SELECT_CATEGORY = `SELECT c.id, c.type, c.parent_id, c.name, c.icon, c.archived_at, c.version,
    COALESCE(c.colour, p.colour) AS colour,
    (SELECT COUNT(*) FROM entries e WHERE e.category_id = c.id) AS entry_count
  FROM categories c LEFT JOIN categories p ON p.id = c.parent_id`;

function toCategory(r: CategoryRow): Category {
  return {
    id: r.id,
    type: r.type,
    parentId: r.parent_id,
    name: r.name,
    icon: r.icon,
    colour: r.colour,
    archived: r.archived_at !== null,
    archivedAt: r.archived_at,
    entryCount: r.entry_count,
    version: r.version,
  };
}

async function readCategory(d1: D1Database, id: string): Promise<Category | null> {
  const row = await d1.prepare(`${SELECT_CATEGORY} WHERE c.id = ?1`).bind(id).first<CategoryRow>();
  return row ? toCategory(row) : null;
}

async function mustRead(d1: D1Database, id: string): Promise<Category> {
  const category = await readCategory(d1, id);
  if (!category) throw new HttpError(404, "not_found");
  return category;
}

function conflict(current: Category): HttpError {
  return new HttpError(409, "conflict", { message: CONFLICT_MESSAGE, current });
}

/** Parents (by name) each with their subcategories (by name). */
async function listTree(d1: D1Database, type?: CategoryType): Promise<CategoryNode[]> {
  const sql = `${SELECT_CATEGORY} ${type ? "WHERE c.type = ?1" : ""} ORDER BY c.name COLLATE NOCASE, c.id`;
  const stmt = d1.prepare(sql);
  const { results } = await (type ? stmt.bind(type) : stmt).all<CategoryRow>();
  const all = results.map(toCategory);
  const nodes = new Map<string, CategoryNode>();
  for (const c of all) if (c.parentId === null) nodes.set(c.id, { ...c, children: [] });
  for (const c of all) if (c.parentId !== null) nodes.get(c.parentId)?.children.push(c);
  return [...nodes.values()];
}

function previousMonth(month: string): string {
  return addDays(`${month}-01`, -1).slice(0, 7);
}

/** The `count` months ending at `last`, oldest first. */
function monthWindow(last: string, count: number): string[] {
  const months = [last];
  while (months.length < count) months.unshift(previousMonth(months[0] as string));
  return months;
}

async function categorySummary(
  d1: D1Database,
  id: string,
  query: z.infer<typeof categorySummaryQuerySchema>,
): Promise<CategorySummary> {
  const [rows, householdRows] = await d1.batch<unknown>([
    d1
      .prepare(`${SELECT_CATEGORY} WHERE c.id = ?1 OR c.parent_id = ?1 ORDER BY c.name COLLATE NOCASE, c.id`)
      .bind(id),
    d1.prepare(HOUSEHOLD_SQL),
  ]);
  const found = ((rows?.results ?? []) as CategoryRow[]).map(toCategory);
  const own = found.find((c) => c.id === id);
  if (!own) throw new HttpError(404, "not_found");
  const category: CategoryNode = {
    ...own,
    children: own.parentId === null ? found.filter((c) => c.parentId === id) : [],
  };
  const ids = [category.id, ...category.children.map((c) => c.id)];

  const { baseCurrency, timezone } = parseHousehold(householdRows?.results[0] as HouseholdRow | undefined);
  const current = todayIn(timezone).slice(0, 7);
  const months = monthWindow(current, query.months);
  const month = query.month ?? current;
  const first = months[0] as string;

  // Only entries of the category's own kind count, which leaves out transfers and adjustments;
  // entries still waiting for a rate have no base value yet.
  const filter = `category_id IN (SELECT value FROM json_each(?1)) AND kind = ?2 AND fx_state <> 'waiting'`;
  const [monthly, split, listed] = await d1.batch<unknown>([
    d1
      .prepare(
        `SELECT substr(date, 1, 7) AS key, SUM(base_amount_minor) AS total FROM entries
         WHERE ${filter} AND date >= ?3 || '-01' AND date < ?4 GROUP BY key`,
      )
      .bind(JSON.stringify(ids), category.type, first, `${current}-32`),
    d1
      .prepare(
        `SELECT category_id AS key, SUM(base_amount_minor) AS total FROM entries
         WHERE ${filter} AND date >= ?3 AND date < ?4 GROUP BY key`,
      )
      .bind(JSON.stringify(ids), category.type, `${month}-01`, nextMonthStart(month)),
    entriesStatement(d1, { month, categoryIds: ids }),
  ]);
  const totals = new Map(
    ((monthly?.results ?? []) as { key: string; total: number }[]).map((r) => [r.key, r.total]),
  );
  const entries = toEntries(listed?.results ?? []).sort(newestFirst);

  return {
    category,
    baseCurrency,
    months: months.map((m) => ({ month: m, totalMinor: totals.get(m) ?? 0 })),
    month,
    breakdown: ((split?.results ?? []) as { key: string; total: number }[]).map((r) => ({
      categoryId: r.key,
      totalMinor: r.total,
    })),
    entries,
  };
}

function newestFirst(a: Entry, b: Entry): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

async function createCategory(
  d1: D1Database,
  input: z.infer<typeof categoryCreateSchema>,
): Promise<Category> {
  const now = nowIso();
  if (await readCategory(d1, input.id))
    throw new HttpError(409, "id_conflict", { message: "A category with this id already exists" });

  if (!input.parentId) {
    await d1
      .prepare(
        `INSERT INTO categories (id, type, parent_id, name, icon, colour, created_at, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(input.id, input.type, input.name, input.icon, input.colour, now)
      .run();
    return mustRead(d1, input.id);
  }

  // One statement: the parent must exist, be top-level and share the type at insert time.
  const { meta } = await d1
    .prepare(
      `INSERT INTO categories (id, type, parent_id, name, icon, colour, created_at, updated_at)
       SELECT ?1, p.type, p.id, ?3, COALESCE(?4, p.icon), NULL, ?5, ?5
       FROM categories p WHERE p.id = ?2 AND p.parent_id IS NULL AND p.type = ?6`,
    )
    .bind(input.id, input.parentId, input.name, input.icon ?? null, now, input.type)
    .run();
  if (meta.changes > 0) return mustRead(d1, input.id);

  const parent = await readCategory(d1, input.parentId);
  if (!parent) throw invalid("parentId", "The parent category doesn't exist");
  if (parent.parentId !== null) throw invalid("parentId", "A subcategory can't have subcategories");
  throw invalid("parentId", "The parent category is of a different type");
}

async function updateCategory(
  d1: D1Database,
  id: string,
  patch: z.infer<typeof categoryPatchSchema>,
): Promise<Category> {
  const existing = await mustRead(d1, id);
  if (patch.colour !== undefined && existing.parentId !== null)
    throw invalid("colour", "A subcategory uses its parent's colour");
  if (patch.version !== existing.version) throw conflict(existing);

  const now = nowIso();
  const archivedAt = patch.archived === undefined ? undefined : patch.archived ? now : null;
  const { meta } = await d1
    .prepare(
      `UPDATE categories SET
         name = COALESCE(?3, name),
         icon = COALESCE(?4, icon),
         colour = COALESCE(?5, colour),
         archived_at = CASE WHEN ?6 = 1 THEN ?7 ELSE archived_at END,
         version = version + 1,
         updated_at = ?8
       WHERE id = ?1 AND version = ?2`,
    )
    .bind(
      id,
      patch.version,
      patch.name ?? null,
      patch.icon ?? null,
      patch.colour ?? null,
      archivedAt === undefined ? 0 : 1,
      // Re-archiving keeps the original date.
      archivedAt === null ? null : (existing.archivedAt ?? archivedAt ?? null),
      now,
    )
    .run();
  if (meta.changes === 0) throw conflict(await mustRead(d1, id));
  return mustRead(d1, id);
}

async function deleteCategory(d1: D1Database, id: string, version: number): Promise<void> {
  const changes = await runDelete(
    d1.prepare("DELETE FROM categories WHERE id = ?1 AND version = ?2").bind(id, version),
  );
  if (changes > 0) return;
  const current = await readCategory(d1, id);
  if (current) throw conflict(current);
}

/**
 * Moves the source's entries (bumping each one's version) and subcategories to the target, then
 * deletes the source, all in one batch guarded on the source's version.
 */
async function mergeCategory(
  d1: D1Database,
  sourceId: string,
  { targetId, version }: z.infer<typeof categoryMergeSchema>,
): Promise<CategoryMergeResult> {
  if (sourceId === targetId) throw invalid("targetId", "Pick a different category");
  const [source, target] = await Promise.all([mustRead(d1, sourceId), readCategory(d1, targetId)]);
  if (!target) throw invalid("targetId", "The target category doesn't exist");
  if (source.type !== target.type)
    throw invalid("targetId", "Categories can only merge within the same type");
  if (version !== source.version) throw conflict(source);
  const { results: children } = await d1
    .prepare("SELECT id FROM categories WHERE parent_id = ?1")
    .bind(sourceId)
    .all<{ id: string }>();
  if (children.length > 0 && target.parentId !== null)
    throw invalid("targetId", "A category with subcategories can only merge into a top-level category");

  const now = nowIso();
  const guard = "EXISTS (SELECT 1 FROM categories WHERE id = ?2 AND version = ?3)";
  let results: D1Result[];
  try {
    results = await d1.batch([
      d1
        .prepare(
          `UPDATE entries SET category_id = ?1, version = version + 1, updated_at = ?4
           WHERE category_id = ?2 AND ${guard}`,
        )
        .bind(targetId, sourceId, version, now),
      // Never builds a third level: if the target is a subcategory the children stay put and the
      // delete below fails on the foreign key, rolling back the whole batch.
      d1
        .prepare(
          `UPDATE categories SET parent_id = ?1, version = version + 1, updated_at = ?4
           WHERE parent_id = ?2 AND ${guard}
             AND (SELECT parent_id FROM categories WHERE id = ?1) IS NULL`,
        )
        .bind(targetId, sourceId, version, now),
      d1.prepare("DELETE FROM categories WHERE id = ?2 AND version = ?3").bind(targetId, sourceId, version),
    ]);
  } catch (err) {
    if (isForeignKeyError(err)) throw new HttpError(409, "conflict", { message: CONFLICT_MESSAGE });
    throw err;
  }
  const [moved, movedChildren, deleted] = results.map((r) => r.meta.changes);
  if (!deleted) {
    const current = await readCategory(d1, sourceId);
    if (current) throw conflict(current);
    throw new HttpError(404, "not_found");
  }
  return { targetId, movedEntries: moved ?? 0, movedChildren: movedChildren ?? 0 };
}

const listQuerySchema = z.object({ type: z.enum(CATEGORY_TYPES).optional() });

/** Two-level expense and income categories. */
export const categoriesRoutes = new Hono<AppEnv>()
  .get("/categories", validate("query", listQuerySchema), async (c) => {
    return c.json(await listTree(c.env.DB, c.req.valid("query").type));
  })
  .post("/categories", validate("json", categoryCreateSchema), async (c) => {
    return c.json(await createCategory(c.env.DB, c.req.valid("json")), 201);
  })
  .patch("/categories/:id", validate("json", categoryPatchSchema), async (c) => {
    return c.json(await updateCategory(c.env.DB, c.req.param("id"), c.req.valid("json")));
  })
  .delete("/categories/:id", validate("query", versionQuerySchema), async (c) => {
    await deleteCategory(c.env.DB, c.req.param("id"), c.req.valid("query").version);
    return c.body(null, 204);
  })
  .post("/categories/:id/merge", validate("json", categoryMergeSchema), async (c) => {
    return c.json(await mergeCategory(c.env.DB, c.req.param("id"), c.req.valid("json")));
  })
  .get("/categories/:id/summary", validate("query", categorySummaryQuerySchema), async (c) => {
    return c.json(await categorySummary(c.env.DB, c.req.param("id"), c.req.valid("query")));
  });
