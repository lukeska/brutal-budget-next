import type { CurrencyCode } from "@shared/money";
import {
  type MonthCategory,
  type MonthEntry,
  type MonthResponse,
  monthParamSchema,
  monthQuerySchema,
} from "@shared/schemas/month";
import { Hono } from "hono";
import type { EntryKind, FxState } from "../db/schema";
import { LATEST_RATES_SQL, latestRatesBody, type StoredRate } from "../fx/rates";
import { nextMonthStart } from "../fx/today";
import type { AppEnv } from "../lib/env";
import { validate } from "../lib/validate";

/** Only expenses and income with a base value count; transfers, adjustments and waiting entries don't. */
const COUNTED = "e.kind IN ('expense', 'income') AND e.fx_state <> 'waiting'";
/** ?1 = first day of the month, ?2 = first day of the next month, ?3 = partner or NULL for both. */
const SCOPE = "e.date >= ?1 AND e.date < ?2 AND (?3 IS NULL OR e.user_id = ?3)";

type TotalsRow = { income: number | null; expense: number | null };
type CategoryTotalRow = {
  id: string;
  parent_id: string | null;
  type: "expense" | "income";
  name: string;
  icon: string;
  colour: string | null;
  parent_name: string | null;
  parent_icon: string | null;
  parent_colour: string | null;
  total: number;
};
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
  import_batch_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  account_currency: string;
  account_name: string;
  to_currency: string | null;
  to_account_name: string | null;
  user_name: string;
  category_name: string | null;
  category_icon: string | null;
  category_colour: string | null;
  project_name: string | null;
  project_colour: string | null;
}

const ENTRIES_SQL = `SELECT e.id, e.kind, e.date, e.user_id, e.account_id, e.account_amount_minor, e.to_account_id,
    e.to_amount_minor, e.orig_currency, e.orig_amount_minor, e.base_amount_minor, e.fx_state, e.rate_scaled,
    e.rate_date, e.category_id, e.project_id, e.notes, e.import_batch_id, e.version, e.created_at, e.updated_at,
    a.currency AS account_currency, a.name AS account_name,
    ta.currency AS to_currency, ta.name AS to_account_name,
    u.name AS user_name,
    c.name AS category_name, c.icon AS category_icon, COALESCE(c.colour, cp.colour) AS category_colour,
    p.name AS project_name, p.colour AS project_colour
  FROM entries e
  JOIN accounts a ON a.id = e.account_id
  JOIN users u ON u.id = e.user_id
  LEFT JOIN accounts ta ON ta.id = e.to_account_id
  LEFT JOIN categories c ON c.id = e.category_id
  LEFT JOIN categories cp ON cp.id = c.parent_id
  LEFT JOIN projects p ON p.id = e.project_id
  WHERE ${SCOPE}
  ORDER BY e.date DESC, e.created_at DESC, e.id DESC`;

function toMonthEntry(r: EntryRow): MonthEntry {
  return {
    id: r.id,
    kind: r.kind,
    date: r.date,
    userId: r.user_id,
    amountMinor: r.orig_amount_minor ?? r.account_amount_minor,
    currency: (r.orig_currency ?? r.account_currency) as CurrencyCode,
    accountId: r.account_id,
    accountCurrency: r.account_currency as CurrencyCode,
    accountAmountMinor: r.account_amount_minor,
    toAccountId: r.to_account_id,
    toCurrency: r.to_currency as CurrencyCode | null,
    toAmountMinor: r.to_amount_minor,
    baseAmountMinor: r.base_amount_minor,
    fxState: r.fx_state,
    rateScaled: r.rate_scaled,
    rateDate: r.rate_date,
    categoryId: r.category_id,
    projectId: r.project_id,
    notes: r.notes,
    importBatchId: r.import_batch_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    userName: r.user_name,
    accountName: r.account_name,
    toAccountName: r.to_account_name,
    categoryName: r.category_name,
    categoryIcon: r.category_icon,
    categoryColour: r.category_colour,
    projectName: r.project_name,
    projectColour: r.project_colour,
  };
}

/** Builds the two-level breakdown from per-category sums (a parent appears even if only its children have entries). */
function categoryTree(rows: CategoryTotalRow[]): MonthCategory[] {
  const parents = new Map<string, MonthCategory>();
  const parentOf = (r: CategoryTotalRow): MonthCategory => {
    const id = r.parent_id ?? r.id;
    let parent = parents.get(id);
    if (!parent) {
      parent = r.parent_id
        ? {
            id,
            type: r.type,
            name: r.parent_name ?? "",
            icon: r.parent_icon ?? "",
            colour: r.parent_colour ?? "",
            totalMinor: 0,
            ownMinor: 0,
            children: [],
          }
        : {
            id,
            type: r.type,
            name: r.name,
            icon: r.icon,
            colour: r.colour ?? "",
            totalMinor: 0,
            ownMinor: 0,
            children: [],
          };
      parents.set(id, parent);
    }
    return parent;
  };
  for (const r of rows) {
    const parent = parentOf(r);
    parent.totalMinor += r.total;
    if (r.parent_id) {
      parent.children.push({
        id: r.id,
        name: r.name,
        icon: r.icon,
        colour: parent.colour,
        totalMinor: r.total,
      });
    } else {
      parent.ownMinor += r.total;
    }
  }
  const byTotal = <T extends { totalMinor: number; name: string }>(a: T, b: T) =>
    b.totalMinor - a.totalMinor || a.name.localeCompare(b.name);
  const list = [...parents.values()];
  for (const p of list) p.children.sort(byTotal);
  return list.sort((a, b) => (a.type === b.type ? byTotal(a, b) : a.type === "expense" ? -1 : 1));
}

/** The month view in one D1 batch. */
export const monthRoutes = new Hono<AppEnv>().get(
  "/month/:month",
  validate("param", monthParamSchema),
  validate("query", monthQuerySchema),
  async (c) => {
    const { month } = c.req.valid("param");
    const userId = c.req.valid("query").userId ?? null;
    const scope = [`${month}-01`, nextMonthStart(month), userId] as const;
    const d1 = c.env.DB;

    const [household, totals, categories, entries, waiting, rates] = await d1.batch<unknown>([
      d1.prepare("SELECT base_currency AS baseCurrency FROM household WHERE id = 1"),
      d1
        .prepare(
          `SELECT SUM(CASE WHEN e.kind = 'income' THEN e.base_amount_minor ELSE 0 END) AS income,
                  SUM(CASE WHEN e.kind = 'expense' THEN e.base_amount_minor ELSE 0 END) AS expense
           FROM entries e WHERE ${SCOPE} AND ${COUNTED}`,
        )
        .bind(...scope),
      d1
        .prepare(
          `SELECT c.id, c.parent_id, c.type, c.name, c.icon, c.colour,
                  p.name AS parent_name, p.icon AS parent_icon, p.colour AS parent_colour,
                  SUM(e.base_amount_minor) AS total
           FROM entries e
           JOIN categories c ON c.id = e.category_id
           LEFT JOIN categories p ON p.id = c.parent_id
           WHERE ${SCOPE} AND ${COUNTED}
           GROUP BY c.id`,
        )
        .bind(...scope),
      d1.prepare(ENTRIES_SQL).bind(...scope),
      d1
        .prepare(
          `SELECT COUNT(*) AS n FROM entries e
           WHERE ${SCOPE} AND e.kind IN ('expense', 'income') AND e.fx_state = 'waiting'`,
        )
        .bind(...scope),
      d1.prepare(LATEST_RATES_SQL),
    ]);

    const t = (totals?.results[0] as TotalsRow | undefined) ?? { income: 0, expense: 0 };
    const incomeMinor = t.income ?? 0;
    const expenseMinor = t.expense ?? 0;

    const body: MonthResponse = {
      month,
      baseCurrency: (household?.results[0] as { baseCurrency: string } | undefined)?.baseCurrency ?? "EUR",
      totals: { incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor },
      categories: categoryTree((categories?.results ?? []) as CategoryTotalRow[]),
      entries: ((entries?.results ?? []) as EntryRow[]).map(toMonthEntry),
      waitingCount: (waiting?.results[0] as { n: number } | undefined)?.n ?? 0,
      latestRates: latestRatesBody((rates?.results ?? []) as StoredRate[]),
    };
    return c.json(body);
  },
);
