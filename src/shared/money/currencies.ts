export interface Currency {
  readonly code: string;
  readonly symbol: string;
  readonly name: string;
  /** Number of decimal places in the currency's minor unit (JPY and ISK have none). */
  readonly exponent: 0 | 2;
}

export const CURRENCIES = {
  EUR: { code: "EUR", symbol: "€", name: "Euro", exponent: 2 },
  USD: { code: "USD", symbol: "$", name: "US Dollar", exponent: 2 },
  GBP: { code: "GBP", symbol: "£", name: "British Pound", exponent: 2 },
  JPY: { code: "JPY", symbol: "¥", name: "Japanese Yen", exponent: 0 },
  CAD: { code: "CAD", symbol: "CA$", name: "Canadian Dollar", exponent: 2 },
  AUD: { code: "AUD", symbol: "A$", name: "Australian Dollar", exponent: 2 },
  CHF: { code: "CHF", symbol: "CHF", name: "Swiss Franc", exponent: 2 },
  CNY: { code: "CNY", symbol: "CN¥", name: "Chinese Yuan", exponent: 2 },
  INR: { code: "INR", symbol: "₹", name: "Indian Rupee", exponent: 2 },
  BRL: { code: "BRL", symbol: "R$", name: "Brazilian Real", exponent: 2 },
  DKK: { code: "DKK", symbol: "kr", name: "Danish Krone", exponent: 2 },
  NOK: { code: "NOK", symbol: "kr", name: "Norwegian Krone", exponent: 2 },
  SEK: { code: "SEK", symbol: "kr", name: "Swedish Krona", exponent: 2 },
  ISK: { code: "ISK", symbol: "kr", name: "Icelandic Króna", exponent: 0 },
} as const satisfies Record<string, Currency>;

export type CurrencyCode = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

export class UnknownCurrencyError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Unknown currency: ${code}`);
    this.name = "UnknownCurrencyError";
    this.code = code;
  }
}

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(CURRENCIES, value);
}

/** Throws `UnknownCurrencyError` unless `code` is a supported currency. */
export function assertCurrencyCode(code: string): asserts code is CurrencyCode {
  if (!isCurrencyCode(code)) throw new UnknownCurrencyError(code);
}

export function exponentOf(code: CurrencyCode): 0 | 2 {
  assertCurrencyCode(code);
  return CURRENCIES[code].exponent;
}
