import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { readHouseholdRow } from "../db/household";
import { ensureRange, loadLatestRates, MAX_RANGE_DAYS, refreshRates } from "../fx/rates";
import { daysBetween, eachDay, isIsoDate, safeToday } from "../fx/today";

type RatesEnv = { Bindings: Env };

const isoDate = z.string().refine(isIsoDate, "Expected a YYYY-MM-DD date");
const ratesQuery = z.union([
  z.object({ date: isoDate }),
  z.object({ from: isoDate, to: isoDate }).refine((q) => q.from <= q.to, "from must not be after to"),
]);

interface StoredRate {
  date: string;
  currency: string;
  rateScaled: number;
  sourceDate: string;
}

async function householdToday(d1: D1Database): Promise<string> {
  return safeToday((await readHouseholdRow(d1))?.timezone);
}

/** Exchange-rate endpoints (rates are units per 1 EUR, scaled by 10^10; EUR itself is implied). */
export const ratesRoutes = new Hono<RatesEnv>()
  .get(
    "/rates",
    zValidator("query", ratesQuery, (result, c) => {
      if (!result.success) return c.json({ error: "invalid_query" }, 400);
    }),
    async (c) => {
      const query = c.req.valid("query");
      const [from, to] = "date" in query ? [query.date, query.date] : [query.from, query.to];
      if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) return c.json({ error: "range_too_long" }, 400);

      const d1 = c.env.DB;
      const today = await householdToday(d1);
      const ensured = await ensureRange(d1, from, to, today);

      const { results } = await d1
        .prepare(
          "SELECT date, currency, rate_scaled AS rateScaled, source_date AS sourceDate FROM fx_rates WHERE date BETWEEN ?1 AND ?2 ORDER BY date, currency",
        )
        .bind(from, to)
        .all<StoredRate>();
      const byDay = new Map<string, Record<string, { rateScaled: number; sourceDate: string }>>();
      for (const r of results) {
        const rates = byDay.get(r.date) ?? {};
        rates[r.currency] = { rateScaled: r.rateScaled, sourceDate: r.sourceDate };
        byDay.set(r.date, rates);
      }
      const days = eachDay(from, to)
        .filter((d) => byDay.has(d))
        .map((date) => ({ date, rates: byDay.get(date) ?? {} }));
      const pastDays = eachDay(from, to).filter((d) => d <= today);
      const complete = ensured.ok && pastDays.every((d) => byDay.has(d));
      return c.json({ status: complete ? "ok" : "unavailable", days });
    },
  )
  .get("/rates/latest", async (c) => {
    const d1 = c.env.DB;
    let latest = await loadLatestRates(d1);
    if (latest.size === 0) {
      await refreshRates(d1, await householdToday(d1));
      latest = await loadLatestRates(d1);
    }
    if (latest.size === 0) return c.json({ status: "unavailable", date: null, rates: {} });
    const rates: Record<string, number> = {};
    let date = "";
    for (const [currency, row] of latest) {
      rates[currency] = row.rateScaled;
      if (row.sourceDate > date) date = row.sourceDate;
    }
    return c.json({ status: "ok", date, rates });
  });
