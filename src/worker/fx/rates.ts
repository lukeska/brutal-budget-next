import type { FxState } from "../db/schema";
import { fetchRatesBetween, type PublishedRate, QUOTE_CURRENCIES } from "./frankfurter";
import { addDays, daysBetween, eachDay, maxDate, minDate } from "./today";

/**
 * Exchange rates stored per calendar day (units per 1 EUR, scaled by 10^10). Days without an ECB
 * publication (weekends, holidays, today before publication) hold the last published rate, with
 * `source_date` set to the day it was actually published.
 */

export interface RateRow {
  rateScaled: number;
  sourceDate: string;
}

export interface StoredRate extends RateRow {
  date: string;
  currency: string;
}

export type RateLookup = ({ status: "ok" } & RateRow) | { status: "unavailable" };
export type EnsureResult = { ok: true } | { ok: false; reason: string };

/** Longest range one `ensureRange` call accepts. */
export const MAX_RANGE_DAYS = 92;
/** Extra days fetched before a gap so its first days can carry the last working day's rate. */
const LOOKBACK_DAYS = 7;
/** Rows per upsert statement, keeping each statement well under D1's size limit. */
const UPSERT_CHUNK = 500;

const UPSERT_SQL = `INSERT INTO fx_rates (date, currency, rate_scaled, source_date)
SELECT value ->> 0, value ->> 1, value ->> 2, value ->> 3 FROM json_each(?1) WHERE true
ON CONFLICT (date, currency) DO UPDATE SET rate_scaled = excluded.rate_scaled, source_date = excluded.source_date
WHERE excluded.source_date > fx_rates.source_date`;

/** Inserts rows, replacing a stored row only when the incoming one was published later. */
async function upsertRates(d1: D1Database, rows: StoredRate[]): Promise<void> {
  if (rows.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows
      .slice(i, i + UPSERT_CHUNK)
      .map((r) => [r.date, r.currency, r.rateScaled, r.sourceDate]);
    statements.push(d1.prepare(UPSERT_SQL).bind(JSON.stringify(chunk)));
  }
  await d1.batch(statements);
}

function published(rates: PublishedRate[]): StoredRate[] {
  return rates.map((r) => ({
    date: r.date,
    currency: r.currency,
    rateScaled: r.rateScaled,
    sourceDate: r.date,
  }));
}

/** Fills every day in [from, to] with the latest rate published on or before it, per currency. */
async function copyForward(d1: D1Database, from: string, to: string): Promise<void> {
  const [before, inRange] = await d1.batch<StoredRate>([
    d1
      .prepare(
        `SELECT f.date, f.currency, f.rate_scaled AS rateScaled, f.source_date AS sourceDate FROM fx_rates f
         JOIN (SELECT currency, MAX(date) AS d FROM fx_rates WHERE date < ?1 GROUP BY currency) m
           ON f.currency = m.currency AND f.date = m.d`,
      )
      .bind(from),
    d1
      .prepare(
        "SELECT date, currency, rate_scaled AS rateScaled, source_date AS sourceDate FROM fx_rates WHERE date BETWEEN ?1 AND ?2",
      )
      .bind(from, to),
  ]);

  const carry = new Map<string, RateRow>();
  for (const r of before?.results ?? []) carry.set(r.currency, r);
  const stored = new Map<string, StoredRate>();
  for (const r of inRange?.results ?? []) stored.set(`${r.date}|${r.currency}`, r);

  const copies: StoredRate[] = [];
  for (const date of eachDay(from, to)) {
    for (const currency of QUOTE_CURRENCIES) {
      const existing = stored.get(`${date}|${currency}`);
      const carried = carry.get(currency);
      if (existing && (!carried || existing.sourceDate >= carried.sourceDate)) {
        carry.set(currency, existing);
      } else if (carried) {
        copies.push({ date, currency, rateScaled: carried.rateScaled, sourceDate: carried.sourceDate });
      }
    }
  }
  await upsertRates(d1, copies);
}

/**
 * Makes sure every day in [from, min(to, today)] has stored rates. Missing days cost one provider
 * request for the whole span. Throws RangeError for spans longer than `MAX_RANGE_DAYS`.
 */
export async function ensureRange(
  d1: D1Database,
  from: string,
  to: string,
  today: string,
): Promise<EnsureResult> {
  const end = minDate(to, today);
  if (from > end) return { ok: true };
  if (daysBetween(from, end) + 1 > MAX_RANGE_DAYS) {
    throw new RangeError(`Rate ranges are limited to ${MAX_RANGE_DAYS} days`);
  }

  const { results } = await d1
    .prepare("SELECT date, COUNT(*) AS n FROM fx_rates WHERE date BETWEEN ?1 AND ?2 GROUP BY date")
    .bind(from, end)
    .all<{ date: string; n: number }>();
  const complete = new Set(results.filter((r) => r.n >= QUOTE_CURRENCIES.length).map((r) => r.date));
  const firstMissing = eachDay(from, end).find((d) => !complete.has(d));
  if (!firstMissing) return { ok: true };

  const fetchFrom = addDays(firstMissing, -LOOKBACK_DAYS);
  const result = await fetchRatesBetween(fetchFrom, end);
  if (!result.ok) return result;
  await upsertRates(d1, published(result.rates));
  await copyForward(d1, fetchFrom, end);
  return { ok: true };
}

/**
 * Daily refresh: one provider request from the newest stored publication up to today, so a missed
 * run heals itself, then carries the newest publication forward to today.
 */
export async function refreshRates(d1: D1Database, today: string): Promise<EnsureResult> {
  const newest = await newestPublishedDate(d1);
  const from = newest
    ? maxDate(minDate(newest, today), addDays(today, 1 - MAX_RANGE_DAYS))
    : addDays(today, -LOOKBACK_DAYS);
  const result = await fetchRatesBetween(from, today);
  if (!result.ok) return result;
  await upsertRates(d1, published(result.rates));
  await copyForward(d1, from, today);
  return { ok: true };
}

async function newestPublishedDate(d1: D1Database): Promise<string | null> {
  const row = await d1.prepare("SELECT MAX(source_date) AS d FROM fx_rates").first<{ d: string | null }>();
  return row?.d ?? null;
}

async function readRate(d1: D1Database, date: string, currency: string): Promise<RateRow | null> {
  return d1
    .prepare(
      "SELECT rate_scaled AS rateScaled, source_date AS sourceDate FROM fx_rates WHERE date = ?1 AND currency = ?2",
    )
    .bind(date, currency)
    .first<RateRow>();
}

/** The stored rate for a day, fetching a missing past day from the provider once. */
export async function rateFor(
  d1: D1Database,
  date: string,
  currency: string,
  today: string,
): Promise<RateLookup> {
  let row = await readRate(d1, date, currency);
  if (!row && date <= today) {
    const ensured = await ensureRange(d1, date, date, today);
    if (ensured.ok) row = await readRate(d1, date, currency);
  }
  return row ? { status: "ok", ...row } : { status: "unavailable" };
}

/** Rates needed to value a batch of entries, loaded in one round trip. */
export interface RateSnapshot {
  /** Newest published rate per currency (its `sourceDate` is the newest publication). */
  latest: Map<string, RateRow>;
  /** Stored rows for the requested dates, keyed `date|currency`. */
  byDate: Map<string, RateRow>;
}

/** Newest published rate per currency: the row stored on that currency's newest publication day. */
export const LATEST_RATES_SQL = `SELECT f.date, f.currency, f.rate_scaled AS rateScaled, f.source_date AS sourceDate
  FROM fx_rates f
  JOIN (SELECT currency, MAX(source_date) AS s FROM fx_rates GROUP BY currency) m
    ON f.currency = m.currency AND f.date = m.s`;

function latestMap(rows: StoredRate[]): Map<string, RateRow> {
  return new Map(rows.map((r) => [r.currency, r]));
}

export async function loadLatestRates(d1: D1Database): Promise<Map<string, RateRow>> {
  const { results } = await d1.prepare(LATEST_RATES_SQL).all<StoredRate>();
  return latestMap(results);
}

/** Latest rates as the month and stats views report them, from `LATEST_RATES_SQL` rows. */
export function latestRatesBody(rows: StoredRate[]): { date: string | null; rates: Record<string, number> } {
  const rates: Record<string, number> = {};
  let date: string | null = null;
  for (const r of rows) {
    rates[r.currency] = r.rateScaled;
    if (date === null || r.sourceDate > date) date = r.sourceDate;
  }
  return { date, rates };
}

export async function loadRateSnapshot(d1: D1Database, dates: string[]): Promise<RateSnapshot> {
  const [latest, byDate] = await d1.batch<StoredRate>([
    d1.prepare(LATEST_RATES_SQL),
    d1
      .prepare(
        `SELECT date, currency, rate_scaled AS rateScaled, source_date AS sourceDate FROM fx_rates
         WHERE date IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify([...new Set(dates)])),
  ]);
  return {
    latest: latestMap(latest?.results ?? []),
    byDate: new Map((byDate?.results ?? []).map((r) => [`${r.date}|${r.currency}`, r])),
  };
}

/**
 * Rate state of an entry: `provisional` when its date is after the newest publication (today
 * before publication, or the future), otherwise `fixed` if its date has a stored rate, else `waiting`.
 */
export function classify(input: {
  entryDate: string;
  newestPublished: string | null;
  hasRateForDate: boolean;
  hasLatestRate: boolean;
}): FxState {
  const { entryDate, newestPublished, hasRateForDate, hasLatestRate } = input;
  if (newestPublished !== null && entryDate <= newestPublished) return hasRateForDate ? "fixed" : "waiting";
  return hasLatestRate ? "provisional" : "waiting";
}
