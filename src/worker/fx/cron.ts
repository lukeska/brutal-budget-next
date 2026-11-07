import { assertCurrencyCode, type CurrencyCode } from "@shared/money";
import { parseHousehold, readHouseholdRow } from "../db/household";
import type { FxState } from "../db/schema";
import { baseValueFromSnapshot } from "./base-value";
import { ensureRange, loadRateSnapshot, MAX_RANGE_DAYS, refreshRates } from "./rates";
import { daysBetween, safeToday } from "./today";

/** Entries revalued per run; the rest wait for the next run. */
const ENTRY_BATCH = 200;
/** Provider requests a run may spend fetching old dates for waiting entries. */
const MAX_BACKFILL_FETCHES = 3;

interface Candidate {
  id: string;
  date: string;
  accountAmountMinor: number;
  fxState: FxState;
  version: number;
  currency: string;
}

/**
 * The scheduled exchange-rate job: refresh rates up to today, then fix the base value of waiting
 * and provisional entries whose date now has a published rate. Never throws.
 */
export async function runFxCron(d1: D1Database, now: Date = new Date()): Promise<void> {
  try {
    const row = await readHouseholdRow(d1);
    const today = safeToday(row?.timezone, now);

    const refreshed = await refreshRates(d1, today);
    if (!refreshed.ok) console.error("Exchange-rate refresh failed", refreshed.reason);
    if (!row) return;

    const { baseCurrency } = parseHousehold(row);
    await fixPendingEntries(d1, baseCurrency, today, now.toISOString());
  } catch (err) {
    console.error("Exchange-rate job failed", err instanceof Error ? err.message : String(err));
  }
}

async function fixPendingEntries(d1: D1Database, baseCurrency: CurrencyCode, today: string, nowIso: string) {
  // Phase 1: read the candidates and their versions.
  const { results: candidates } = await d1
    .prepare(
      `SELECT e.id, e.date, e.account_amount_minor AS accountAmountMinor, e.fx_state AS fxState, e.version,
              a.currency
       FROM entries e JOIN accounts a ON a.id = e.account_id
       WHERE e.kind IN ('expense', 'income')
         AND (e.fx_state = 'waiting'
              OR (e.fx_state = 'provisional' AND e.date <= (SELECT MAX(source_date) FROM fx_rates)))
       ORDER BY e.date, e.id
       LIMIT ?1`,
    )
    .bind(ENTRY_BATCH)
    .all<Candidate>();
  if (candidates.length === 0) return;

  await backfillWaitingDates(d1, candidates, today);

  // Phase 2: compute in the Worker with the shared maths, then write with a version guard.
  const snapshot = await loadRateSnapshot(
    d1,
    candidates.map((c) => c.date),
  );
  const updates: D1PreparedStatement[] = [];
  for (const entry of candidates) {
    assertCurrencyCode(entry.currency);
    const value = baseValueFromSnapshot(
      {
        accountAmountMinor: entry.accountAmountMinor,
        accountCurrency: entry.currency,
        baseCurrency,
        entryDate: entry.date,
        today,
      },
      snapshot,
    );
    if (value.fxState === entry.fxState) continue;
    updates.push(
      d1
        .prepare(
          `UPDATE entries SET base_amount_minor = ?1, fx_state = ?2, rate_scaled = ?3, rate_date = ?4,
             version = version + 1, updated_at = ?5
           WHERE id = ?6 AND version = ?7`,
        )
        .bind(
          value.baseAmountMinor,
          value.fxState,
          value.rateScaled,
          value.rateDate,
          nowIso,
          entry.id,
          entry.version,
        ),
    );
  }
  if (updates.length > 0) await d1.batch(updates);
}

/** Fetches rates for the dates of waiting entries, grouping nearby dates into one request each. */
async function backfillWaitingDates(d1: D1Database, candidates: Candidate[], today: string) {
  const dates = [
    ...new Set(candidates.filter((c) => c.fxState === "waiting" && c.date <= today).map((c) => c.date)),
  ];
  const windows: { from: string; to: string }[] = [];
  for (const date of dates) {
    const last = windows.at(-1);
    if (last && daysBetween(last.from, date) < MAX_RANGE_DAYS) last.to = date;
    else windows.push({ from: date, to: date });
  }
  for (const window of windows.slice(0, MAX_BACKFILL_FETCHES)) {
    const result = await ensureRange(d1, window.from, window.to, today);
    if (!result.ok) {
      console.error("Exchange-rate backfill failed", result.reason);
      return;
    }
  }
}
