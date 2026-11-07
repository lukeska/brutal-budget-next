import { minorToDecimalString } from "./amount";
import { type CurrencyCode, exponentOf } from "./currencies";

const formatters = new Map<string, Intl.NumberFormat>();

/** Formats minor units for display in the given locale (the runtime default when omitted). */
export function formatMinor(minor: number, currency: CurrencyCode, locale?: string): string {
  const key = `${locale ?? ""}|${currency}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    const exponent = exponentOf(currency);
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    });
    formatters.set(key, formatter);
  }
  // A decimal string keeps the value exact; no float division on amounts.
  return formatter.format(minorToDecimalString(minor, currency) as Intl.StringNumericLiteral);
}
