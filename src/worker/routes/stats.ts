import type { StatsCategory, StatsMonth, StatsResponse } from "@shared/schemas/stats";
import { statsYearSchema } from "@shared/schemas/stats";
import { Hono } from "hono";
import { LATEST_RATES_SQL, latestRatesBody, type StoredRate } from "../fx/rates";
import type { AppEnv } from "../lib/env";
import { validate } from "../lib/validate";

/** Only expenses and income with a base value count; transfers, adjustments and waiting entries don't. */
const COUNTED = "e.kind IN ('expense', 'income') AND e.fx_state <> 'waiting'";
const IN_YEAR = "e.date >= ?1 AND e.date < ?2";

type MonthRow = { m: string; income: number; expense: number };
type CategoryRow = {
  id: string;
  name: string;
  colour: string;
  icon: string;
  type: "expense" | "income";
  m: string;
  total: number;
};

const monthIndex = (m: string) => Number(m) - 1;

/** Yearly statistics in one D1 batch. */
export const statsRoutes = new Hono<AppEnv>().get(
  "/stats/:year",
  validate("param", statsYearSchema),
  async (c) => {
    const year = Number(c.req.valid("param").year);
    const from = `${year}-01-01`;
    const to = `${year + 1}-01-01`;
    const d1 = c.env.DB;

    const [household, months, categories, waiting, rates] = await d1.batch<unknown>([
      d1.prepare("SELECT base_currency AS baseCurrency FROM household WHERE id = 1"),
      d1
        .prepare(
          `SELECT substr(e.date, 6, 2) AS m,
                  SUM(CASE WHEN e.kind = 'income' THEN e.base_amount_minor ELSE 0 END) AS income,
                  SUM(CASE WHEN e.kind = 'expense' THEN e.base_amount_minor ELSE 0 END) AS expense
           FROM entries e WHERE ${IN_YEAR} AND ${COUNTED} GROUP BY m`,
        )
        .bind(from, to),
      d1
        .prepare(
          `SELECT p.id, p.name, p.colour, p.icon, p.type, substr(e.date, 6, 2) AS m,
                  SUM(e.base_amount_minor) AS total
           FROM entries e
           JOIN categories c ON c.id = e.category_id
           JOIN categories p ON p.id = COALESCE(c.parent_id, c.id)
           WHERE ${IN_YEAR} AND ${COUNTED}
           GROUP BY p.id, m`,
        )
        .bind(from, to),
      d1
        .prepare(
          `SELECT COUNT(*) AS n FROM entries e
           WHERE ${IN_YEAR} AND e.kind IN ('expense', 'income') AND e.fx_state = 'waiting'`,
        )
        .bind(from, to),
      d1.prepare(LATEST_RATES_SQL),
    ]);

    const monthList: StatsMonth[] = Array.from({ length: 12 }, (_, i) => ({
      month: `${year}-${String(i + 1).padStart(2, "0")}`,
      incomeMinor: 0,
      expenseMinor: 0,
      netMinor: 0,
    }));
    for (const r of (months?.results ?? []) as MonthRow[]) {
      const slot = monthList[monthIndex(r.m)];
      if (!slot) continue;
      slot.incomeMinor = r.income;
      slot.expenseMinor = r.expense;
      slot.netMinor = r.income - r.expense;
    }

    const byId = new Map<string, StatsCategory>();
    for (const r of (categories?.results ?? []) as CategoryRow[]) {
      let cat = byId.get(r.id);
      if (!cat) {
        cat = {
          categoryId: r.id,
          name: r.name,
          colour: r.colour,
          icon: r.icon,
          type: r.type,
          months: Array<number>(12).fill(0),
          totalMinor: 0,
        };
        byId.set(r.id, cat);
      }
      cat.months[monthIndex(r.m)] = r.total;
      cat.totalMinor += r.total;
    }
    const byCategory = [...byId.values()].sort(
      (a, b) => a.type.localeCompare(b.type) || b.totalMinor - a.totalMinor || a.name.localeCompare(b.name),
    );

    const body: StatsResponse = {
      year,
      baseCurrency: (household?.results[0] as { baseCurrency: string } | undefined)?.baseCurrency ?? "EUR",
      months: monthList,
      byCategory,
      waitingCount: (waiting?.results[0] as { n: number } | undefined)?.n ?? 0,
      latestRates: latestRatesBody((rates?.results ?? []) as StoredRate[]),
    };
    return c.json(body);
  },
);
