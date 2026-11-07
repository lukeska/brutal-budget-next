import { convertMinor, crossRateScaled, type ScaledRates } from "@shared/fx-math";
import type { CurrencyCode } from "@shared/money";
import type { FxState } from "../db/schema";
import { classify, ensureRange, loadRateSnapshot, type RateRow, type RateSnapshot } from "./rates";
import { maxDate, minDate } from "./today";

export interface BaseValueInput {
  accountAmountMinor: number;
  accountCurrency: CurrencyCode;
  baseCurrency: CurrencyCode;
  entryDate: string;
  /** Today in the household's time zone. */
  today: string;
}

export interface BaseValue {
  /** NULL exactly when `fxState` is `waiting`. */
  baseAmountMinor: number | null;
  fxState: FxState;
  /** Account-to-base rate ×10^10; NULL when no conversion was needed or possible. */
  rateScaled: number | null;
  /** Publication date of the rate used. */
  rateDate: string | null;
}

const WAITING: BaseValue = { baseAmountMinor: null, fxState: "waiting", rateScaled: null, rateDate: null };

function pivotCurrencies(input: BaseValueInput): CurrencyCode[] {
  return [...new Set([input.accountCurrency, input.baseCurrency])].filter((c) => c !== "EUR");
}

/** Values an entry from already-loaded rates. Never touches the database or network. */
export function baseValueFromSnapshot(input: BaseValueInput, snapshot: RateSnapshot): BaseValue {
  const { accountAmountMinor, accountCurrency, baseCurrency, entryDate } = input;
  if (accountCurrency === baseCurrency) {
    return { baseAmountMinor: accountAmountMinor, fxState: "fixed", rateScaled: null, rateDate: null };
  }
  const currencies = pivotCurrencies(input);
  const latest = currencies.map((c) => snapshot.latest.get(c));
  const onDate = currencies.map((c) => snapshot.byDate.get(`${entryDate}|${c}`));
  const allLatest = latest.every((r) => r !== undefined);
  const newestPublished = allLatest ? latest.map((r) => r.sourceDate).reduce(minDate) : null;

  const fxState = classify({
    entryDate,
    newestPublished,
    hasRateForDate: onDate.every((r) => r !== undefined),
    hasLatestRate: allLatest,
  });
  if (fxState === "waiting") return WAITING;

  const used = (fxState === "fixed" ? onDate : latest) as RateRow[];
  const scaled: ScaledRates = Object.fromEntries(currencies.map((c, i) => [c, used[i]?.rateScaled ?? 0]));
  return {
    baseAmountMinor: convertMinor({
      amountMinor: accountAmountMinor,
      from: accountCurrency,
      to: baseCurrency,
      rates: scaled,
    }),
    fxState,
    rateScaled: crossRateScaled(accountCurrency, baseCurrency, scaled),
    rateDate: used.map((r) => r.sourceDate).reduce(maxDate),
  };
}

/**
 * Computes an entry's base value, fetching a missing past date's rates from the provider once.
 * A provider failure never throws: the entry is valued as `waiting` instead.
 */
export async function computeBaseValue(d1: D1Database, input: BaseValueInput): Promise<BaseValue> {
  if (input.accountCurrency === input.baseCurrency) return baseValueFromSnapshot(input, emptySnapshot());

  let snapshot = await loadRateSnapshot(d1, [input.entryDate]);
  const missing = pivotCurrencies(input).some((c) => !snapshot.byDate.has(`${input.entryDate}|${c}`));
  if (missing && input.entryDate <= input.today) {
    const ensured = await ensureRange(d1, input.entryDate, input.entryDate, input.today);
    if (ensured.ok) snapshot = await loadRateSnapshot(d1, [input.entryDate]);
  }
  return baseValueFromSnapshot(input, snapshot);
}

function emptySnapshot(): RateSnapshot {
  return { latest: new Map(), byDate: new Map() };
}
