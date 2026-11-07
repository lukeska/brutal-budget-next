import {
  CURRENCIES,
  type CurrencyCode,
  exponentOf,
  formatMinor,
  isCurrencyCode,
  MAX_ABS_MINOR,
  minorToDecimalString,
  parseAmount,
  UnknownCurrencyError,
} from "@shared/money";
import { describe, expect, it } from "vitest";

describe("currency registry", () => {
  it("holds exactly the 14 supported currencies", () => {
    expect(Object.keys(CURRENCIES).sort()).toEqual(
      [
        "AUD",
        "BRL",
        "CAD",
        "CHF",
        "CNY",
        "DKK",
        "EUR",
        "GBP",
        "INR",
        "ISK",
        "JPY",
        "NOK",
        "SEK",
        "USD",
      ].sort(),
    );
    for (const [code, currency] of Object.entries(CURRENCIES)) {
      expect(currency.code).toBe(code);
      expect(currency.symbol).not.toBe("");
      expect(currency.name).not.toBe("");
    }
  });

  it("uses exponent 0 for JPY and ISK and 2 for the rest", () => {
    for (const code of Object.keys(CURRENCIES) as CurrencyCode[]) {
      expect(exponentOf(code)).toBe(code === "JPY" || code === "ISK" ? 0 : 2);
    }
  });

  it("recognises known codes only", () => {
    expect(isCurrencyCode("EUR")).toBe(true);
    expect(isCurrencyCode("eur")).toBe(false);
    expect(isCurrencyCode("XXX")).toBe(false);
    expect(isCurrencyCode("toString")).toBe(false);
  });

  it("throws a typed error for an unknown code", () => {
    expect(() => exponentOf("XXX" as CurrencyCode)).toThrow(UnknownCurrencyError);
  });
});

describe("parseAmount", () => {
  it("parses EUR with a dot or a comma", () => {
    expect(parseAmount("12.34", "EUR")).toEqual({ ok: true, minor: 1234 });
    expect(parseAmount("12,34", "EUR")).toEqual({ ok: true, minor: 1234 });
    expect(parseAmount("  12.5 ", "EUR")).toEqual({ ok: true, minor: 1250 });
    expect(parseAmount("7", "EUR")).toEqual({ ok: true, minor: 700 });
  });

  it("parses JPY without decimals", () => {
    expect(parseAmount("3000", "JPY")).toEqual({ ok: true, minor: 3000 });
  });

  it("rejects decimals beyond the currency's exponent", () => {
    expect(parseAmount("12.5", "JPY")).toEqual({ ok: false, error: "too_many_decimals" });
    expect(parseAmount("12.345", "EUR")).toEqual({ ok: false, error: "too_many_decimals" });
  });

  it("rejects malformed, negative and thousands-separated input", () => {
    for (const input of ["", "  ", "abc", "-5", "1,234.56", "1 234", "12.", ".5", "1e3", "+3"]) {
      expect(parseAmount(input, "EUR")).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("rejects amounts above the cap", () => {
    expect(MAX_ABS_MINOR).toBe(10 ** 13);
    expect(parseAmount("100000000000.00", "EUR")).toEqual({ ok: true, minor: 10 ** 13 });
    expect(parseAmount("100000000000.01", "EUR")).toEqual({ ok: false, error: "too_large" });
    expect(parseAmount("99999999999999999999", "ISK")).toEqual({ ok: false, error: "too_large" });
  });

  it("throws for an unknown currency", () => {
    expect(() => parseAmount("1", "XXX" as CurrencyCode)).toThrow(UnknownCurrencyError);
  });
});

describe("minorToDecimalString", () => {
  it("renders minor units as a plain decimal for form inputs", () => {
    expect(minorToDecimalString(1234, "EUR")).toBe("12.34");
    expect(minorToDecimalString(5, "EUR")).toBe("0.05");
    expect(minorToDecimalString(-1234, "EUR")).toBe("-12.34");
    expect(minorToDecimalString(3000, "JPY")).toBe("3000");
  });
});

describe("formatMinor", () => {
  it("formats EUR with two decimals", () => {
    expect(formatMinor(1234, "EUR", "en-US")).toBe("€12.34");
    expect(formatMinor(100, "EUR", "en-US")).toBe("€1.00");
  });

  it("formats ISK with no decimals", () => {
    const text = formatMinor(150000, "ISK", "en-US");
    expect(text).toContain("150,000");
    expect(text).not.toMatch(/\.\d/);
  });

  it("follows the given locale", () => {
    expect(formatMinor(123456, "EUR", "de-DE")).toBe("1.234,56 €");
  });
});
