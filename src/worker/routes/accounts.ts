import { zValidator } from "@hono/zod-validator";
import type { CurrencyCode } from "@shared/money";
import {
  type Account,
  type AccountCreate,
  type AccountPatch,
  accountCreateSchema,
  accountDeleteQuerySchema,
  accountPatchSchema,
  balanceQuerySchema,
  type HistoryPage,
  type HistoryRow,
  historyQuerySchema,
  reconcileCreateSchema,
} from "@shared/schemas/account";
import { CONFLICT_MESSAGE, type ValidationIssue } from "@shared/schemas/entry";
import type { Context } from "hono";
import { Hono } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../lib/env";
import { HttpError } from "../lib/errors";
import { nowIso } from "../lib/time";
import { accountBalances, balanceAsOf, changesSinceReconcile } from "../services/balances";
import { bookReconciliation, deleteReconciliation, listReconciliations } from "../services/reconcile";

/** Validates a request part, answering 422 with field issues when it doesn't parse. */
function validate<T extends z.ZodType>(target: "json" | "query", schema: T) {
  return zValidator(target, schema, (result, c: Context) => {
    if (result.success) return;
    const issues: ValidationIssue[] = result.error.issues.map((i) => ({
      path: i.path.map((p) => (typeof p === "number" ? p : String(p))),
      message: i.message,
    }));
    return c.json({ error: "validation_failed", issues }, 422);
  });
}

function invalid(field: string, message: string): HttpError {
  return new HttpError(422, "validation_failed", { issues: [{ path: [field], message }] });
}

// ---------- reading accounts ----------

interface AccountRow {
  id: string;
  name: string;
  currency: CurrencyCode;
  opening_minor: number;
  archived_at: string | null;
  version: number;
  has_entries: number;
}

const SELECT_ACCOUNT = `SELECT a.id, a.name, a.currency, a.opening_minor, a.archived_at, a.version,
    EXISTS (SELECT 1 FROM entries e WHERE e.account_id = a.id OR e.to_account_id = a.id) AS has_entries
  FROM accounts a`;

async function readAccounts(d1: D1Database, id?: string): Promise<Account[]> {
  const ids = id ? [id] : undefined;
  const stmt = id
    ? d1.prepare(`${SELECT_ACCOUNT} WHERE a.id = ?1`).bind(id)
    : d1.prepare(`${SELECT_ACCOUNT} ORDER BY a.name COLLATE NOCASE, a.id`);
  const [{ results }, balances, changes] = await Promise.all([
    stmt.all<AccountRow>(),
    accountBalances(d1, ids),
    changesSinceReconcile(d1, ids),
  ]);
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    currency: r.currency,
    openingMinor: r.opening_minor,
    archivedAt: r.archived_at,
    version: r.version,
    balanceMinor: balances[r.id] ?? r.opening_minor,
    hasEntries: r.has_entries === 1,
    changedSinceReconcile: changes[r.id] ?? null,
  }));
}

async function readAccount(d1: D1Database, id: string): Promise<Account | null> {
  return (await readAccounts(d1, id))[0] ?? null;
}

async function requireAccount(d1: D1Database, id: string): Promise<Account> {
  const account = await readAccount(d1, id);
  if (!account) throw new HttpError(404, "not_found");
  return account;
}

// ---------- writing accounts ----------

async function createAccount(
  d1: D1Database,
  input: AccountCreate,
): Promise<{ status: 200 | 201; account: Account }> {
  const now = nowIso();
  const { meta } = await d1
    .prepare(
      `INSERT INTO accounts (id, name, currency, opening_minor, version, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5) ON CONFLICT (id) DO NOTHING`,
    )
    .bind(input.id, input.name, input.currency, input.openingMinor, now)
    .run();
  const account = await requireAccount(d1, input.id);
  if (meta.changes > 0) return { status: 201, account };
  const same =
    account.name === input.name &&
    account.currency === input.currency &&
    account.openingMinor === input.openingMinor;
  if (!same) throw new HttpError(409, "id_conflict", { message: "An account with this id already exists" });
  return { status: 200, account };
}

/**
 * Applies an edit in one conditional statement: the version must match, a currency change needs the
 * account to be unused by any entry, and archiving needs another active account to remain. When
 * nothing changed, the current state tells which condition failed.
 */
async function updateAccount(d1: D1Database, id: string, patch: AccountPatch): Promise<Account> {
  const existing = await requireAccount(d1, id);
  const changesCurrency = patch.currency !== undefined && patch.currency !== existing.currency;
  const archives = patch.archived === true && existing.archivedAt === null;
  const now = nowIso();
  const archivedAt =
    patch.archived === undefined ? existing.archivedAt : patch.archived ? (existing.archivedAt ?? now) : null;

  const { meta } = await d1
    .prepare(
      `UPDATE accounts SET name = ?3, currency = ?4, opening_minor = ?5, archived_at = ?6,
         version = version + 1, updated_at = ?7
       WHERE id = ?1 AND version = ?2
         AND (?8 = 0 OR NOT EXISTS (SELECT 1 FROM entries WHERE account_id = ?1 OR to_account_id = ?1))
         AND (?9 = 0 OR EXISTS (SELECT 1 FROM accounts o WHERE o.archived_at IS NULL AND o.id <> ?1))`,
    )
    .bind(
      id,
      patch.version,
      patch.name ?? existing.name,
      patch.currency ?? existing.currency,
      patch.openingMinor ?? existing.openingMinor,
      archivedAt,
      now,
      changesCurrency ? 1 : 0,
      archives ? 1 : 0,
    )
    .run();

  const current = await requireAccount(d1, id);
  if (meta.changes > 0) return current;
  if (current.version !== patch.version) {
    throw new HttpError(409, "conflict", { message: CONFLICT_MESSAGE, current });
  }
  if (changesCurrency && current.hasEntries) {
    throw invalid("currency", "The currency can't change once the account has entries");
  }
  if (archives) throw invalid("archived", "Keep at least one active account");
  throw new HttpError(409, "conflict", { message: CONFLICT_MESSAGE, current });
}

/** Deletes an unused account. Entries or reconciliations referring to it make the foreign key refuse. */
async function deleteAccount(d1: D1Database, id: string, version: number): Promise<void> {
  let changes: number;
  try {
    ({
      meta: { changes },
    } = await d1.prepare("DELETE FROM accounts WHERE id = ?1 AND version = ?2").bind(id, version).run());
  } catch (err) {
    if (err instanceof Error && /FOREIGN KEY/i.test(err.message)) {
      throw new HttpError(409, "in_use", { message: "Entries use this account; archive it instead" });
    }
    throw err;
  }
  if (changes > 0) return;
  const current = await readAccount(d1, id);
  if (current) throw new HttpError(409, "conflict", { message: CONFLICT_MESSAGE, current });
}

// ---------- history ----------

interface HistoryDbRow {
  id: string;
  kind: HistoryRow["kind"];
  date: string;
  user_id: string;
  delta: number;
  balance: number;
  counterpart: string | null;
  amount_minor: number;
  currency: CurrencyCode;
  category_id: string | null;
  project_id: string | null;
  notes: string | null;
  version: number;
}

/**
 * Entries from or into the account, newest first, each with the balance right after it. The running
 * balance is a window over the account's whole history, so pages agree with each other.
 */
async function accountHistory(
  d1: D1Database,
  account: Account,
  limit: number,
  before: string | undefined,
): Promise<HistoryPage> {
  const cursor = before
    ? "WHERE (date, created_at, id) < (SELECT date, created_at, id FROM entries WHERE id = ?4)"
    : "";
  const { results } = await d1
    .prepare(
      `WITH moves AS (
         SELECT e.id, e.kind, e.date, e.created_at, e.user_id, e.category_id, e.project_id, e.notes, e.version,
           CASE WHEN e.to_account_id = ?1 THEN e.to_amount_minor
                WHEN e.kind IN ('income', 'adjustment') THEN e.account_amount_minor
                ELSE -e.account_amount_minor END AS delta,
           CASE WHEN e.to_account_id = ?1 THEN e.account_id ELSE e.to_account_id END AS counterpart,
           CASE WHEN e.to_account_id = ?1 THEN e.to_amount_minor
                ELSE COALESCE(e.orig_amount_minor, e.account_amount_minor) END AS amount_minor,
           CASE WHEN e.to_account_id = ?1 THEN a.currency ELSE COALESCE(e.orig_currency, a.currency) END
             AS currency
         FROM entries e JOIN accounts a ON a.id = ?1
         WHERE e.account_id = ?1 OR e.to_account_id = ?1),
       running AS (
         SELECT *, ?2 + SUM(delta) OVER (ORDER BY date, created_at, id ROWS UNBOUNDED PRECEDING) AS balance
         FROM moves)
       SELECT * FROM running ${cursor}
       ORDER BY date DESC, created_at DESC, id DESC
       LIMIT ?3`,
    )
    .bind(account.id, account.openingMinor, limit + 1, ...(before ? [before] : []))
    .all<HistoryDbRow>();

  const rows = results.slice(0, limit).map(
    (r): HistoryRow => ({
      id: r.id,
      kind: r.kind,
      date: r.date,
      userId: r.user_id,
      deltaMinor: r.delta,
      balanceMinor: r.balance,
      counterpartAccountId: r.counterpart,
      amountMinor: r.amount_minor,
      currency: r.currency,
      categoryId: r.category_id,
      projectId: r.project_id,
      notes: r.notes,
      version: r.version,
    }),
  );
  const last = rows.at(-1);
  return { rows, nextBefore: results.length > limit && last ? last.id : null };
}

// ---------- routes ----------

/** Accounts, their history and reconciliations. Paths carry their own prefix; mount at "/". */
export const accountsRoutes = new Hono<AppEnv>()
  .get("/accounts", async (c) => c.json(await readAccounts(c.env.DB)))
  .post("/accounts", validate("json", accountCreateSchema), async (c) => {
    const { status, account } = await createAccount(c.env.DB, c.req.valid("json"));
    return c.json(account, status);
  })
  .get("/accounts/:id", async (c) => c.json(await requireAccount(c.env.DB, c.req.param("id"))))
  .patch("/accounts/:id", validate("json", accountPatchSchema), async (c) => {
    return c.json(await updateAccount(c.env.DB, c.req.param("id"), c.req.valid("json")));
  })
  .delete("/accounts/:id", validate("query", accountDeleteQuerySchema), async (c) => {
    await deleteAccount(c.env.DB, c.req.param("id"), c.req.valid("query").version);
    return c.body(null, 204);
  })
  .get("/accounts/:id/history", validate("query", historyQuerySchema), async (c) => {
    const account = await requireAccount(c.env.DB, c.req.param("id"));
    const { limit, before } = c.req.valid("query");
    return c.json(await accountHistory(c.env.DB, account, limit, before));
  })
  .get("/accounts/:id/balance", validate("query", balanceQuerySchema), async (c) => {
    const { date } = c.req.valid("query");
    const balanceMinor = await balanceAsOf(c.env.DB, c.req.param("id"), date);
    if (balanceMinor === null) throw new HttpError(404, "not_found");
    return c.json({ date, balanceMinor });
  })
  .get("/accounts/:id/reconciliations", async (c) => {
    return c.json(await listReconciliations(c.env.DB, c.req.param("id")));
  })
  .post("/accounts/:id/reconciliations", validate("json", reconcileCreateSchema), async (c) => {
    const { status, reconciliation } = await bookReconciliation(
      c.env.DB,
      c.var.user.id,
      c.req.param("id"),
      c.req.valid("json"),
    );
    return c.json(reconciliation, status);
  })
  .delete("/reconciliations/:id", async (c) => {
    await deleteReconciliation(c.env.DB, c.req.param("id"));
    return c.body(null, 204);
  });
