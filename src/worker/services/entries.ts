import { assertCurrencyCode, type CurrencyCode } from "@shared/money";
import {
  CONFLICT_MESSAGE,
  type Entry,
  type EntryCreate,
  type EntryDefaults,
  type EntryListQuery,
  type EntryPatch,
  type ValidationIssue,
} from "@shared/schemas/entry";
import { HOUSEHOLD_SQL, type HouseholdRow, parseHousehold, readHouseholdRow } from "../db/household";
import type { EntryKind, FxState } from "../db/schema";
import { type BaseValue, computeBaseValue } from "../fx/base-value";
import { addDays, nextMonthStart, safeToday } from "../fx/today";
import { HttpError } from "../lib/errors";
import { nowIso } from "../lib/time";

interface EntryRow {
  id: string;
  kind: EntryKind;
  date: string;
  user_id: string;
  account_id: string;
  account_amount_minor: number;
  to_account_id: string | null;
  to_amount_minor: number | null;
  orig_currency: string | null;
  orig_amount_minor: number | null;
  base_amount_minor: number | null;
  fx_state: FxState;
  rate_scaled: number | null;
  rate_date: string | null;
  category_id: string | null;
  project_id: string | null;
  notes: string | null;
  fingerprint: string | null;
  import_batch_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  account_currency: CurrencyCode;
  to_currency: CurrencyCode | null;
}

const SELECT_ENTRY = `SELECT e.*, a.currency AS account_currency, ta.currency AS to_currency
  FROM entries e
  JOIN accounts a ON a.id = e.account_id
  LEFT JOIN accounts ta ON ta.id = e.to_account_id`;

function toEntry(r: EntryRow): Entry {
  const currency = (r.orig_currency ?? r.account_currency) as CurrencyCode;
  return {
    id: r.id,
    kind: r.kind,
    date: r.date,
    userId: r.user_id,
    amountMinor: r.orig_amount_minor ?? r.account_amount_minor,
    currency,
    accountId: r.account_id,
    accountCurrency: r.account_currency,
    accountAmountMinor: r.account_amount_minor,
    toAccountId: r.to_account_id,
    toCurrency: r.to_currency,
    toAmountMinor: r.to_amount_minor,
    baseAmountMinor: r.base_amount_minor,
    fxState: r.fx_state,
    rateScaled: r.rate_scaled,
    rateDate: r.rate_date,
    categoryId: r.category_id,
    projectId: r.project_id,
    notes: r.notes,
    fingerprint: r.fingerprint,
    importBatchId: r.import_batch_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function readRow(d1: D1Database, id: string): Promise<EntryRow | null> {
  return d1.prepare(`${SELECT_ENTRY} WHERE e.id = ?1`).bind(id).first<EntryRow>();
}

export async function getEntry(d1: D1Database, id: string): Promise<Entry | null> {
  const row = await readRow(d1, id);
  return row ? toEntry(row) : null;
}

function invalid(issues: ValidationIssue[]): HttpError {
  return new HttpError(422, "validation_failed", { issues });
}

function conflict(current: EntryRow): HttpError {
  return new HttpError(409, "conflict", { message: CONFLICT_MESSAGE, current: toEntry(current) });
}

const ADJUSTMENT_LOCKED = invalid([
  { path: ["kind"], message: "Adjustments are changed through their reconciliation" },
]);

interface Household {
  baseCurrency: CurrencyCode;
  today: string;
}
interface AccountRef {
  id: string;
  currency: CurrencyCode;
  archived: boolean;
}
interface CategoryRef {
  id: string;
  type: "expense" | "income";
  archived: boolean;
}
interface Refs {
  household: Household;
  accounts: Map<string, AccountRef>;
  category: CategoryRef | null;
  project: { id: string; archived: boolean } | null;
  userExists: boolean;
}

async function loadRefs(
  d1: D1Database,
  want: { accountIds: string[]; categoryId: string | null; projectId: string | null; userId: string },
): Promise<Refs> {
  const [household, accounts, category, project, user] = await d1.batch<Record<string, unknown>>([
    d1.prepare(HOUSEHOLD_SQL),
    d1
      .prepare("SELECT id, currency, archived_at FROM accounts WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(want.accountIds)),
    d1.prepare("SELECT id, type, archived_at FROM categories WHERE id = ?1").bind(want.categoryId),
    d1.prepare("SELECT id, archived_at FROM projects WHERE id = ?1").bind(want.projectId),
    d1.prepare("SELECT id FROM users WHERE id = ?1").bind(want.userId),
  ]);
  const h = parseHousehold(household?.results[0] as HouseholdRow | undefined);
  const c = category?.results[0] as { id: string; type: "expense" | "income"; archived_at: string | null };
  const p = project?.results[0] as { id: string; archived_at: string | null } | undefined;
  const accountRows = (accounts?.results ?? []) as {
    id: string;
    currency: string;
    archived_at: string | null;
  }[];
  return {
    household: { baseCurrency: h.baseCurrency, today: safeToday(h.timezone) },
    accounts: new Map(
      accountRows.map((a) => {
        assertCurrencyCode(a.currency);
        return [a.id, { id: a.id, currency: a.currency, archived: a.archived_at !== null }];
      }),
    ),
    category: c ? { id: c.id, type: c.type, archived: c.archived_at !== null } : null,
    project: p ? { id: p.id, archived: p.archived_at !== null } : null,
    userExists: (user?.results.length ?? 0) > 0,
  };
}

/** The fields of an entry as the client describes them, after merging an edit onto the stored row. */
interface Draft {
  kind: "expense" | "income" | "transfer";
  date: string;
  userId: string;
  accountId: string;
  amountMinor: number | undefined;
  currency: CurrencyCode | undefined;
  accountAmountMinor: number | undefined;
  toAccountId: string | null;
  toAmountMinor: number | undefined;
  categoryId: string | null;
  projectId: string | null;
  notes: string | null;
}

/** Stored columns that the client controls (everything except valuation and bookkeeping). */
interface Values {
  kind: "expense" | "income" | "transfer";
  date: string;
  userId: string;
  accountId: string;
  accountAmountMinor: number;
  toAccountId: string | null;
  toAmountMinor: number | null;
  origCurrency: CurrencyCode | null;
  origAmountMinor: number | null;
  categoryId: string | null;
  projectId: string | null;
  notes: string | null;
}

type Target = "accountId" | "toAccountId" | "categoryId" | "projectId";

function normaliseNotes(notes: string | null | undefined): string | null {
  const trimmed = notes?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Validates a draft against the referenced rows and turns it into stored columns. Archived rows are
 * rejected only when the draft newly targets them (`targets`), so editing an old entry still works.
 */
function resolve(draft: Draft, refs: Refs, targets: ReadonlySet<Target>): Values {
  const issues: ValidationIssue[] = [];
  const issue = (field: string, message: string) => issues.push({ path: [field], message });

  if (!refs.userExists) issue("userId", "Unknown partner");
  const account = refs.accounts.get(draft.accountId);
  if (!account) issue("accountId", "Account not found");
  else if (account.archived && targets.has("accountId")) issue("accountId", "Account is archived");

  const values: Values = {
    kind: draft.kind,
    date: draft.date,
    userId: draft.userId,
    accountId: draft.accountId,
    accountAmountMinor: 0,
    toAccountId: null,
    toAmountMinor: null,
    origCurrency: null,
    origAmountMinor: null,
    categoryId: null,
    projectId: null,
    notes: draft.notes,
  };

  if (draft.amountMinor === undefined) issue("amountMinor", "Amount is required");
  const amount = draft.amountMinor ?? 0;

  if (draft.kind === "transfer") {
    const to = draft.toAccountId ? refs.accounts.get(draft.toAccountId) : undefined;
    if (!to) issue("toAccountId", "Account not found");
    else if (to.archived && targets.has("toAccountId")) issue("toAccountId", "Account is archived");
    if (draft.toAccountId === draft.accountId) issue("toAccountId", "Choose two different accounts");
    values.accountAmountMinor = amount;
    values.toAccountId = draft.toAccountId;
    if (account && to) {
      if (account.currency === to.currency) values.toAmountMinor = amount;
      else if (draft.toAmountMinor === undefined) {
        issue("toAmountMinor", "Enter the amount that arrived");
      } else values.toAmountMinor = draft.toAmountMinor;
    }
  } else {
    const category = refs.category;
    if (!category) issue("categoryId", "Category not found");
    else if (category.type !== draft.kind) issue("categoryId", `Choose an ${draft.kind} category`);
    else if (category.archived && targets.has("categoryId")) issue("categoryId", "Category is archived");
    values.categoryId = draft.categoryId;

    if (draft.projectId !== null) {
      if (!refs.project) issue("projectId", "Project not found");
      else if (refs.project.archived && targets.has("projectId")) issue("projectId", "Project is archived");
    }
    values.projectId = draft.projectId;

    if (account) {
      const currency = draft.currency ?? account.currency;
      if (currency === account.currency) {
        values.accountAmountMinor = amount;
      } else if (draft.accountAmountMinor === undefined) {
        issue("accountAmountMinor", `Enter the amount in ${account.currency}`);
      } else {
        values.accountAmountMinor = draft.accountAmountMinor;
        values.origCurrency = currency;
        values.origAmountMinor = amount;
      }
    }
  }

  if (issues.length > 0) throw invalid(issues);
  return values;
}

function sameValues(v: Values, r: EntryRow): boolean {
  return (
    v.kind === r.kind &&
    v.date === r.date &&
    v.userId === r.user_id &&
    v.accountId === r.account_id &&
    v.accountAmountMinor === r.account_amount_minor &&
    v.toAccountId === r.to_account_id &&
    v.toAmountMinor === r.to_amount_minor &&
    v.origCurrency === r.orig_currency &&
    v.origAmountMinor === r.orig_amount_minor &&
    v.categoryId === r.category_id &&
    v.projectId === r.project_id &&
    v.notes === r.notes
  );
}

/**
 * Transfers move money between accounts and never count in totals, so they carry no conversion:
 * they are stored as `fixed` with a zero base value, which satisfies the base/waiting CHECK and
 * keeps them out of the rate job.
 */
const TRANSFER_VALUE: BaseValue = { baseAmountMinor: 0, fxState: "fixed", rateScaled: null, rateDate: null };

function baseValueFor(d1: D1Database, values: Values, refs: Refs): Promise<BaseValue> {
  if (values.kind === "transfer") return Promise.resolve(TRANSFER_VALUE);
  const account = refs.accounts.get(values.accountId);
  if (!account) throw new Error("account must be resolved before valuing");
  return computeBaseValue(d1, {
    accountAmountMinor: values.accountAmountMinor,
    accountCurrency: account.currency,
    baseCurrency: refs.household.baseCurrency,
    entryDate: values.date,
    today: refs.household.today,
  });
}

function draftFromCreate(input: EntryCreate, sessionUserId: string): Draft {
  const base = {
    date: input.date,
    userId: input.userId ?? sessionUserId,
    accountId: input.accountId,
    amountMinor: input.amountMinor,
    notes: normaliseNotes(input.notes),
  };
  if (input.kind === "transfer") {
    return {
      ...base,
      kind: "transfer",
      currency: undefined,
      accountAmountMinor: undefined,
      toAccountId: input.toAccountId,
      toAmountMinor: input.toAmountMinor,
      categoryId: null,
      projectId: null,
    };
  }
  return {
    ...base,
    kind: input.kind,
    currency: input.currency,
    accountAmountMinor: input.accountAmountMinor,
    toAccountId: null,
    toAmountMinor: undefined,
    categoryId: input.categoryId,
    projectId: input.projectId ?? null,
  };
}

function refsWanted(draft: Draft) {
  return {
    accountIds: draft.toAccountId ? [draft.accountId, draft.toAccountId] : [draft.accountId],
    categoryId: draft.categoryId,
    projectId: draft.projectId,
    userId: draft.userId,
  };
}

/** A retried create matches when the stored row holds the same client-controlled values. */
function matchesExisting(draft: Draft, refs: Refs, existing: EntryRow): boolean {
  try {
    return sameValues(resolve(draft, refs, new Set()), existing);
  } catch {
    return false;
  }
}

export type CreateResult = { status: 200 | 201; entry: Entry };

type Restore = NonNullable<EntryCreate["restore"]>;

/**
 * A restore may drop the fingerprint or batch (taken or undone meanwhile), so a stored null matches
 * too; a different stored value doesn't.
 */
function restoredMatches(restore: Restore, row: EntryRow): boolean {
  const same = (stored: string | null, wanted: string | null | undefined) =>
    stored === null || stored === (wanted ?? null);
  return same(row.fingerprint, restore.fingerprint) && same(row.import_batch_id, restore.importBatchId);
}

/** SQL guard: account (?5) and optional to-account (?7) still have the validated currencies (?19, ?20). */
const CURRENCIES_UNCHANGED = `(SELECT currency FROM accounts WHERE id = ?5) = ?19
         AND (?7 IS NULL OR (SELECT currency FROM accounts WHERE id = ?7) = ?20)`;
/** Same guard for the update statement, whose account is ?3, to-account ?5 and currencies ?19, ?20. */
const CURRENCIES_UNCHANGED_FOR_UPDATE = `(SELECT currency FROM accounts WHERE id = ?3) = ?19
         AND (?5 IS NULL OR (SELECT currency FROM accounts WHERE id = ?5) = ?20)`;
const ACCOUNT_CURRENCY_CHANGED = new HttpError(409, "account_currency_changed", {
  message: "An account's currency changed while you were editing — reload and try again",
});

/**
 * Creates an entry under the client's id. Posting the same payload again returns the stored row;
 * a different payload under an existing id is a conflict. Undoing a delete posts the old id again
 * with `restore`: references archived since are accepted (existence, type and currency still are
 * checked), and an imported entry gets back its fingerprint (unless another row holds it now) and
 * its batch (unless that import was undone).
 */
export async function createEntry(
  d1: D1Database,
  sessionUserId: string,
  input: EntryCreate,
): Promise<CreateResult> {
  const draft = draftFromCreate(input, sessionUserId);
  const [refs, existing] = await Promise.all([loadRefs(d1, refsWanted(draft)), readRow(d1, input.id)]);

  const { restore } = input;
  const replay = (row: EntryRow): CreateResult => {
    if (!matchesExisting(draft, refs, row) || (restore && !restoredMatches(restore, row))) {
      throw new HttpError(409, "id_conflict", { message: "An entry with this id already exists" });
    }
    return { status: 200, entry: toEntry(row) };
  };
  if (existing) return replay(existing);

  const values = resolve(
    draft,
    refs,
    restore ? new Set() : new Set<Target>(["accountId", "toAccountId", "categoryId", "projectId"]),
  );
  const value = await baseValueFor(d1, values, refs);
  const now = nowIso();
  // The insert only lands while the accounts still have the currencies the amounts were validated
  // against, so a concurrent currency change can't leave an entry in the wrong currency. A restored
  // fingerprint is dropped when another row holds it (a re-import), so the unique index never fails,
  // and the batch is dropped when that import was undone.
  const { meta } = await d1
    .prepare(
      `INSERT INTO entries (id, kind, date, user_id, account_id, account_amount_minor, to_account_id,
         to_amount_minor, orig_currency, orig_amount_minor, base_amount_minor, fx_state, rate_scaled,
         rate_date, category_id, project_id, notes, fingerprint, import_batch_id, version, created_at,
         updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
         CASE WHEN NOT EXISTS (SELECT 1 FROM entries WHERE fingerprint = ?21) THEN ?21 END,
         (SELECT id FROM import_batches WHERE id = ?22), 1, ?18, ?18
       WHERE ${CURRENCIES_UNCHANGED}
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(
      input.id,
      values.kind,
      values.date,
      values.userId,
      values.accountId,
      values.accountAmountMinor,
      values.toAccountId,
      values.toAmountMinor,
      values.origCurrency,
      values.origAmountMinor,
      value.baseAmountMinor,
      value.fxState,
      value.rateScaled,
      value.rateDate,
      values.categoryId,
      values.projectId,
      values.notes,
      now,
      refs.accounts.get(values.accountId)?.currency ?? null,
      values.toAccountId ? (refs.accounts.get(values.toAccountId)?.currency ?? null) : null,
      restore?.fingerprint ?? null,
      restore?.importBatchId ?? null,
    )
    .run();

  const row = await readRow(d1, input.id);
  if (!row) throw ACCOUNT_CURRENCY_CHANGED;
  // A concurrent create with the same id won the race: treat ours as a retry.
  if (meta.changes === 0) return replay(row);
  return { status: 201, entry: toEntry(row) };
}

function draftFromPatch(existing: EntryRow, patch: EntryPatch, refs: Refs, issues: ValidationIssue[]): Draft {
  const kind = existing.kind as Draft["kind"];
  const accountId = patch.accountId ?? existing.account_id;
  const accountCurrency = refs.accounts.get(accountId)?.currency;
  const accountCurrencyChanged =
    accountCurrency !== undefined && accountCurrency !== existing.account_currency;
  const common = {
    kind,
    date: patch.date ?? existing.date,
    userId: patch.userId ?? existing.user_id,
    accountId,
    notes: patch.notes === undefined ? existing.notes : normaliseNotes(patch.notes),
  };

  if (kind === "transfer") {
    const toAccountId = patch.toAccountId ?? existing.to_account_id;
    const toCurrency = toAccountId ? refs.accounts.get(toAccountId)?.currency : undefined;
    const toCurrencyChanged = toCurrency !== undefined && toCurrency !== existing.to_currency;
    const currencyChanged = accountCurrencyChanged || toCurrencyChanged;
    if (currencyChanged && patch.amountMinor === undefined) {
      issues.push({ path: ["amountMinor"], message: "Enter both amounts again for the new accounts" });
    }
    return {
      ...common,
      amountMinor: patch.amountMinor ?? existing.account_amount_minor,
      currency: undefined,
      accountAmountMinor: undefined,
      toAccountId,
      toAmountMinor: currencyChanged
        ? patch.toAmountMinor
        : (patch.toAmountMinor ?? existing.to_amount_minor ?? undefined),
      categoryId: null,
      projectId: null,
    };
  }

  const currency = patch.currency ?? ((existing.orig_currency ?? existing.account_currency) as CurrencyCode);
  const amountMinor = patch.amountMinor ?? existing.orig_amount_minor ?? existing.account_amount_minor;
  const unchanged =
    !accountCurrencyChanged &&
    currency === (existing.orig_currency ?? existing.account_currency) &&
    amountMinor === (existing.orig_amount_minor ?? existing.account_amount_minor);
  return {
    ...common,
    amountMinor,
    currency,
    // A foreign amount booked to the account stays valid only while nothing it depends on changed.
    accountAmountMinor: patch.accountAmountMinor ?? (unchanged ? existing.account_amount_minor : undefined),
    toAccountId: null,
    toAmountMinor: undefined,
    categoryId: patch.categoryId ?? existing.category_id,
    projectId: patch.projectId === undefined ? existing.project_id : patch.projectId,
  };
}

/** Applies an edit when `patch.version` still matches; otherwise 409 with the current row. */
export async function updateEntry(d1: D1Database, id: string, patch: EntryPatch): Promise<Entry> {
  const existing = await readRow(d1, id);
  if (!existing) throw new HttpError(404, "not_found");
  if (existing.kind === "adjustment") throw ADJUSTMENT_LOCKED;
  if (patch.kind !== undefined && patch.kind !== existing.kind) {
    throw invalid([{ path: ["kind"], message: "An entry's type can't be changed" }]);
  }
  if (patch.version !== existing.version) throw conflict(existing);

  const accountId = patch.accountId ?? existing.account_id;
  const toAccountId = patch.toAccountId ?? existing.to_account_id;
  const refs = await loadRefs(d1, {
    accountIds: toAccountId ? [accountId, toAccountId] : [accountId],
    categoryId: patch.categoryId ?? existing.category_id,
    projectId: patch.projectId === undefined ? existing.project_id : patch.projectId,
    userId: patch.userId ?? existing.user_id,
  });

  const issues: ValidationIssue[] = [];
  const draft = draftFromPatch(existing, patch, refs, issues);
  if (issues.length > 0) throw invalid(issues);
  const targets = new Set<Target>();
  if (draft.accountId !== existing.account_id) targets.add("accountId");
  if (draft.toAccountId !== existing.to_account_id) targets.add("toAccountId");
  if (draft.categoryId !== existing.category_id) targets.add("categoryId");
  if (draft.projectId !== existing.project_id) targets.add("projectId");
  const values = resolve(draft, refs, targets);

  const needsRevaluing =
    values.accountAmountMinor !== existing.account_amount_minor ||
    values.date !== existing.date ||
    refs.accounts.get(values.accountId)?.currency !== existing.account_currency;
  const value: BaseValue = needsRevaluing
    ? await baseValueFor(d1, values, refs)
    : {
        baseAmountMinor: existing.base_amount_minor,
        fxState: existing.fx_state,
        rateScaled: existing.rate_scaled,
        rateDate: existing.rate_date,
      };

  const { meta } = await d1
    .prepare(
      `UPDATE entries SET date = ?1, user_id = ?2, account_id = ?3, account_amount_minor = ?4,
         to_account_id = ?5, to_amount_minor = ?6, orig_currency = ?7, orig_amount_minor = ?8,
         base_amount_minor = ?9, fx_state = ?10, rate_scaled = ?11, rate_date = ?12, category_id = ?13,
         project_id = ?14, notes = ?15, version = version + 1, updated_at = ?16
       WHERE id = ?17 AND version = ?18 AND kind <> 'adjustment' AND ${CURRENCIES_UNCHANGED_FOR_UPDATE}`,
    )
    .bind(
      values.date,
      values.userId,
      values.accountId,
      values.accountAmountMinor,
      values.toAccountId,
      values.toAmountMinor,
      values.origCurrency,
      values.origAmountMinor,
      value.baseAmountMinor,
      value.fxState,
      value.rateScaled,
      value.rateDate,
      values.categoryId,
      values.projectId,
      values.notes,
      nowIso(),
      id,
      patch.version,
      refs.accounts.get(values.accountId)?.currency ?? null,
      values.toAccountId ? (refs.accounts.get(values.toAccountId)?.currency ?? null) : null,
    )
    .run();

  const current = await readRow(d1, id);
  if (!current) throw new HttpError(404, "not_found");
  if (meta.changes === 0) {
    if (current.version === patch.version) throw ACCOUNT_CURRENCY_CHANGED;
    throw conflict(current);
  }
  return toEntry(current);
}

/** Deletes when `version` still matches. Already gone is success; a stale version is a 409. */
export async function deleteEntry(d1: D1Database, id: string, version: number): Promise<void> {
  const { meta } = await d1
    .prepare("DELETE FROM entries WHERE id = ?1 AND version = ?2 AND kind <> 'adjustment'")
    .bind(id, version)
    .run();
  if (meta.changes > 0) return;
  const current = await readRow(d1, id);
  if (!current) return;
  if (current.kind === "adjustment") throw ADJUSTMENT_LOCKED;
  throw conflict(current);
}

export type EntryFilter = EntryListQuery & { categoryIds?: string[] };

/** Entries newest first (by date, then creation), with optional filters. */
export function entriesStatement(d1: D1Database, query: EntryFilter): D1PreparedStatement {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replaceAll("?", `?${params.length}`));
  };
  if (query.month) {
    add("e.date >= ?", `${query.month}-01`);
    add("e.date < ?", nextMonthStart(query.month));
  }
  if (query.accountId) add("(e.account_id = ? OR e.to_account_id = ?)", query.accountId);
  if (query.categoryId) add("e.category_id = ?", query.categoryId);
  if (query.categoryIds)
    add("e.category_id IN (SELECT value FROM json_each(?))", JSON.stringify(query.categoryIds));
  if (query.projectId) add("e.project_id = ?", query.projectId);
  if (query.userId) add("e.user_id = ?", query.userId);
  const sql = `${SELECT_ENTRY} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY e.date DESC, e.created_at DESC, e.id DESC`;
  return d1.prepare(sql).bind(...params);
}

export function toEntries(rows: unknown[]): Entry[] {
  return (rows as EntryRow[]).map(toEntry);
}

export async function listEntries(d1: D1Database, query: EntryFilter): Promise<Entry[]> {
  const { results } = await entriesStatement(d1, query).all<EntryRow>();
  return results.map(toEntry);
}

const TOP_CATEGORIES = 5;
const TOP_CATEGORY_DAYS = 90;

/** Drawer defaults for one partner: their last usable account per kind and most-used categories. */
export async function entryDefaults(d1: D1Database, userId: string): Promise<EntryDefaults> {
  const since = addDays(safeToday((await readHouseholdRow(d1))?.timezone), -TOP_CATEGORY_DAYS);
  const [accounts, categories] = await d1.batch<Record<string, string | number>>([
    d1
      .prepare(
        `SELECT kind, account_id FROM (
           SELECT e.kind, e.account_id,
                  ROW_NUMBER() OVER (PARTITION BY e.kind ORDER BY e.created_at DESC, e.id DESC) AS rn
           FROM entries e JOIN accounts a ON a.id = e.account_id
           WHERE e.user_id = ?1 AND a.archived_at IS NULL AND e.kind IN ('expense', 'income', 'transfer'))
         WHERE rn = 1`,
      )
      .bind(userId),
    d1
      .prepare(
        `SELECT type, category_id FROM (
           SELECT c.type, e.category_id,
                  ROW_NUMBER() OVER (PARTITION BY c.type ORDER BY COUNT(*) DESC, MAX(e.created_at) DESC) AS rn
           FROM entries e JOIN categories c ON c.id = e.category_id
           WHERE e.user_id = ?1 AND e.date >= ?2 AND c.archived_at IS NULL
             AND e.kind IN ('expense', 'income')
           GROUP BY c.type, e.category_id)
         WHERE rn <= ?3
         ORDER BY type, rn`,
      )
      .bind(userId, since, TOP_CATEGORIES),
  ]);

  const defaults: EntryDefaults = { lastAccountByKind: {}, topCategories: { expense: [], income: [] } };
  for (const r of (accounts?.results ?? []) as {
    kind: "expense" | "income" | "transfer";
    account_id: string;
  }[]) {
    defaults.lastAccountByKind[r.kind] = r.account_id;
  }
  for (const r of (categories?.results ?? []) as { type: "expense" | "income"; category_id: string }[]) {
    defaults.topCategories[r.type].push(r.category_id);
  }
  return defaults;
}

/**
 * Current balance per account, in its own currency: opening + income − expenses − transfers out
 * + transfers in + adjustments. Pass ids to limit the result; every account is returned otherwise.
 */
export async function accountBalances(
  d1: D1Database,
  accountIds?: string[],
): Promise<Record<string, number>> {
  const filter = accountIds ? "WHERE a.id IN (SELECT value FROM json_each(?1))" : "";
  const stmt = d1.prepare(
    `SELECT a.id, a.opening_minor
       + COALESCE((SELECT SUM(CASE WHEN e.kind IN ('income', 'adjustment') THEN e.account_amount_minor
                                   ELSE -e.account_amount_minor END)
                   FROM entries e WHERE e.account_id = a.id), 0)
       + COALESCE((SELECT SUM(e.to_amount_minor) FROM entries e
                   WHERE e.to_account_id = a.id AND e.kind = 'transfer'), 0) AS balance
     FROM accounts a ${filter}`,
  );
  const { results } = await (accountIds ? stmt.bind(JSON.stringify(accountIds)) : stmt).all<{
    id: string;
    balance: number;
  }>();
  return Object.fromEntries(results.map((r) => [r.id, r.balance]));
}
