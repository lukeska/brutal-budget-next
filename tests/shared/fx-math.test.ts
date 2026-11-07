import {
  convertMinor,
  crossRateScaled,
  MissingRateError,
  RATE_SCALE,
  type ScaledRates,
  toScaledRate,
} from "@shared/fx-math";
import { type CurrencyCode, UnknownCurrencyError } from "@shared/money";
import { describe, expect, it } from "vitest";

describe("toScaledRate", () => {
  it("parses decimal strings exactly into rates scaled by 10^10", () => {
    expect(RATE_SCALE).toBe(10_000_000_000n);
    expect(toScaledRate("136.04")).toBe(1_360_400_000_000);
    expect(toScaledRate("0.8732")).toBe(8_732_000_000);
    expect(toScaledRate("1")).toBe(10_000_000_000);
    expect(toScaledRate("1.0869565217")).toBe(10_869_565_217);
  });

  it("rejects malformed, zero and over-precise rates", () => {
    for (const input of ["", "abc", "-1", "0", "0.00", "1.12345678901", "1,5"]) {
      expect(() => toScaledRate(input)).toThrow(RangeError);
    }
  });
});

describe("convertMinor", () => {
  it("converts through EUR, which needs no rate of its own", () => {
    const rates: ScaledRates = { USD: toScaledRate("1.25") };
    expect(convertMinor({ amountMinor: 12500, from: "USD", to: "EUR", rates })).toBe(10000);
    expect(convertMinor({ amountMinor: 10000, from: "EUR", to: "USD", rates })).toBe(12500);
  });

  it("100.00 USD at a USD to EUR rate of 0.92 gives 92.00 EUR", () => {
    // ECB-style rates are quoted per EUR, so 0.92 EUR per USD is 1/0.92 USD per EUR.
    const rates: ScaledRates = { EUR: Number(RATE_SCALE), USD: toScaledRate("1.0869565217") };
    expect(crossRateScaled("USD", "EUR", rates)).toBe(9_200_000_000);
    expect(convertMinor({ amountMinor: 10000, from: "USD", to: "EUR", rates })).toBe(9200);
  });

  it("matches a hand-computed DKK to ISK reference via EUR", () => {
    // 100.00 DKK x 145.30 / 7.4604 = 1947.6167... ISK, rounded to 1948 (ISK has no decimals).
    const rates: ScaledRates = { DKK: toScaledRate("7.4604"), ISK: toScaledRate("145.30") };
    expect(convertMinor({ amountMinor: 10000, from: "DKK", to: "ISK", rates })).toBe(1948);
  });

  it("rounds half to even at the target exponent, in both directions", () => {
    // 130.55 / 7.46 = 17.5 exactly, so 1 DKK = 17.5 ISK.
    const rates: ScaledRates = { DKK: toScaledRate("7.46"), ISK: toScaledRate("130.55") };
    expect(crossRateScaled("DKK", "ISK", rates)).toBe(175_000_000_000);
    expect(convertMinor({ amountMinor: 100, from: "DKK", to: "ISK", rates })).toBe(18); // 17.5 -> 18
    expect(convertMinor({ amountMinor: 300, from: "DKK", to: "ISK", rates })).toBe(52); // 52.5 -> 52
    expect(convertMinor({ amountMinor: -100, from: "DKK", to: "ISK", rates })).toBe(-18);
    expect(convertMinor({ amountMinor: -300, from: "DKK", to: "ISK", rates })).toBe(-52);
  });

  it("returns the input unchanged for the same currency without needing rates", () => {
    expect(convertMinor({ amountMinor: 4242, from: "SEK", to: "SEK", rates: {} })).toBe(4242);
  });

  it("throws a typed error when a rate is missing", () => {
    expect(() => convertMinor({ amountMinor: 100, from: "USD", to: "GBP", rates: { USD: 1 } })).toThrow(
      MissingRateError,
    );
  });

  it("throws a typed error for an unknown currency", () => {
    expect(() =>
      convertMinor({ amountMinor: 100, from: "XXX" as CurrencyCode, to: "EUR", rates: {} }),
    ).toThrow(UnknownCurrencyError);
    expect(() =>
      convertMinor({ amountMinor: 100, from: "XXX" as CurrencyCode, to: "XXX" as CurrencyCode, rates: {} }),
    ).toThrow(UnknownCurrencyError);
  });
});
