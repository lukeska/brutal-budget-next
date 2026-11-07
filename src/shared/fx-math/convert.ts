import { assertCurrencyCode, type CurrencyCode, exponentOf } from "@shared/money";

/** Rates are integers: units of a currency per 1 EUR, multiplied by this scale. */
export const RATE_SCALE = 10_000_000_000n;

const RATE_DECIMALS = 10;

/** Scaled rate per EUR for each currency. EUR is implied at `RATE_SCALE` when absent. */
export type ScaledRates = Readonly<Partial<Record<CurrencyCode, number | bigint>>>;

export class MissingRateError extends Error {
  readonly currency: CurrencyCode;
  constructor(currency: CurrencyCode) {
    super(`No exchange rate for ${currency}`);
    this.name = "MissingRateError";
    this.currency = currency;
  }
}

/** Parses a positive decimal rate string (e.g. "136.04") exactly into a scaled integer. */
export function toScaledRate(decimal: string): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  const fraction = match?.[2] ?? "";
  if (!match || fraction.length > RATE_DECIMALS) throw new RangeError(`Invalid rate: ${decimal}`);
  const scaled = BigInt((match[1] ?? "") + fraction.padEnd(RATE_DECIMALS, "0"));
  if (scaled <= 0n || scaled > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError(`Invalid rate: ${decimal}`);
  return Number(scaled);
}

/** Integer division rounding half to even. `denominator` must be positive. */
function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const quotient = n / denominator;
  const twiceRemainder = (n % denominator) * 2n;
  const roundUp = twiceRemainder > denominator || (twiceRemainder === denominator && quotient % 2n === 1n);
  const result = roundUp ? quotient + 1n : quotient;
  return negative ? -result : result;
}

function rateOf(currency: CurrencyCode, rates: ScaledRates): bigint {
  const rate = rates[currency];
  if (rate === undefined) {
    if (currency === "EUR") return RATE_SCALE;
    throw new MissingRateError(currency);
  }
  return BigInt(rate);
}

function toSafeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError("Converted amount is out of range");
  return result;
}

/** Scaled rate (×10^10) for 1 unit of `from` expressed in `to`, via EUR, rounded half to even. */
export function crossRateScaled(from: CurrencyCode, to: CurrencyCode, rates: ScaledRates): number {
  assertCurrencyCode(from);
  assertCurrencyCode(to);
  if (from === to) return Number(RATE_SCALE);
  return toSafeNumber(divideHalfEven(rateOf(to, rates) * RATE_SCALE, rateOf(from, rates)));
}

export interface ConvertMinorInput {
  amountMinor: number;
  from: CurrencyCode;
  to: CurrencyCode;
  rates: ScaledRates;
}

/**
 * Converts an amount in minor units between currencies through EUR:
 * value in `to` = amount × rate(to) / rate(from), rounded half to even at `to`'s exponent.
 */
export function convertMinor({ amountMinor, from, to, rates }: ConvertMinorInput): number {
  assertCurrencyCode(from);
  assertCurrencyCode(to);
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError("Amount must be a safe integer");
  if (from === to) return amountMinor;

  const numerator = BigInt(amountMinor) * 10n ** BigInt(exponentOf(to)) * rateOf(to, rates);
  const denominator = 10n ** BigInt(exponentOf(from)) * rateOf(from, rates);
  return toSafeNumber(divideHalfEven(numerator, denominator));
}
