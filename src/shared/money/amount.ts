import { type CurrencyCode, exponentOf } from "./currencies";

/** Largest absolute amount accepted, in minor units. Keeps every sum well inside safe integers. */
export const MAX_ABS_MINOR = 10 ** 13;

export type ParseAmountResult =
  | { ok: true; minor: number }
  | { ok: false; error: "invalid" | "too_many_decimals" | "too_large" };

const AMOUNT_PATTERN = /^(\d+)(?:[.,](\d+))?$/;

/**
 * Parses a non-negative user-typed amount into integer minor units.
 * Accepts "." or "," as the decimal separator; thousands separators are not accepted.
 */
export function parseAmount(input: string, currency: CurrencyCode): ParseAmountResult {
  const exponent = exponentOf(currency);
  const match = AMOUNT_PATTERN.exec(input.trim());
  if (!match) return { ok: false, error: "invalid" };

  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) return { ok: false, error: "too_many_decimals" };

  const minor = BigInt(whole + fraction.padEnd(exponent, "0"));
  if (minor > BigInt(MAX_ABS_MINOR)) return { ok: false, error: "too_large" };
  return { ok: true, minor: Number(minor) };
}

/** Renders minor units as a plain decimal string for form inputs, e.g. 1234 EUR -> "12.34". */
export function minorToDecimalString(minor: number, currency: CurrencyCode): string {
  const exponent = exponentOf(currency);
  const digits = Math.abs(minor).toString();
  const sign = minor < 0 ? "-" : "";
  if (exponent === 0) return sign + digits;
  const padded = digits.padStart(exponent + 1, "0");
  return `${sign}${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}
