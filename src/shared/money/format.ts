import { minorToDecimalString } from "./amount";
import { type CurrencyCode, exponentOf } from "./currencies";

/** Formats minor units for display in the given locale (the runtime default when omitted). */
export function formatMinor(minor: number, currency: CurrencyCode, locale?: string): string {
  const exponent = exponentOf(currency);
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  });
  // A decimal string keeps the value exact; no float division on amounts.
  return formatter.format(minorToDecimalString(minor, currency) as Intl.StringNumericLiteral);
}
