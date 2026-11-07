import { toScaledRate } from "@shared/fx-math";
import { CURRENCY_CODES, type CurrencyCode, isCurrencyCode } from "@shared/money";

/** Adapter for the Frankfurter v2 API (ECB data, EUR pivot). */

const BASE_URL = "https://api.frankfurter.dev/v2/rates";

/** Every supported currency except the EUR pivot. */
export const QUOTE_CURRENCIES: readonly CurrencyCode[] = CURRENCY_CODES.filter((c) => c !== "EUR");

export interface PublishedRate {
  /** The date the provider published this rate. */
  date: string;
  currency: CurrencyCode;
  rateScaled: number;
}

export type ProviderResult = { ok: true; rates: PublishedRate[] } | { ok: false; reason: string };

export function fetchRatesOn(date: string): Promise<ProviderResult> {
  return request({ date });
}

export function fetchRatesBetween(from: string, to: string): Promise<ProviderResult> {
  return request({ from, to });
}

export function fetchLatestRates(): Promise<ProviderResult> {
  return request({});
}

async function request(params: Record<string, string>): Promise<ProviderResult> {
  const url = new URL(BASE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("base", "EUR");
  url.searchParams.set("quotes", QUOTE_CURRENCIES.join(","));
  url.searchParams.set("providers", "ecb");

  let body: unknown;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return fail(`Frankfurter responded ${res.status}`);
    body = await res.json();
  } catch (err) {
    return fail(`Frankfurter request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(body)) return fail("Frankfurter returned an unexpected body");
  return { ok: true, rates: parseRates(body) };
}

function fail(reason: string): ProviderResult {
  console.error(reason);
  return { ok: false, reason };
}

/** Parses `[{date, base, quote, rate}]`, dropping bad items and logging currencies missing per date. */
function parseRates(items: unknown[]): PublishedRate[] {
  const rates: PublishedRate[] = [];
  const seen = new Map<string, Set<CurrencyCode>>();
  for (const item of items) {
    const parsed = parseItem(item);
    if (!parsed) continue;
    rates.push(parsed);
    const set = seen.get(parsed.date) ?? new Set<CurrencyCode>();
    set.add(parsed.currency);
    seen.set(parsed.date, set);
  }
  for (const [date, set] of seen) {
    const missing = QUOTE_CURRENCIES.filter((c) => !set.has(c));
    if (missing.length > 0) console.error(`Frankfurter has no rate on ${date} for ${missing.join(", ")}`);
  }
  return rates;
}

function parseItem(item: unknown): PublishedRate | null {
  if (typeof item !== "object" || item === null) return null;
  const { date, base, quote, rate } = item as Record<string, unknown>;
  if (base !== "EUR" || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (typeof quote !== "string" || !isCurrencyCode(quote) || quote === "EUR") return null;
  try {
    return { date, currency: quote, rateScaled: toScaledRate(rateToDecimal(rate)) };
  } catch {
    console.error(`Frankfurter sent an unusable rate for ${quote} on ${date}`);
    return null;
  }
}

/** Formats a JSON rate as a plain decimal string (never exponent form), at most 10 decimals. */
function rateToDecimal(rate: unknown): string {
  if (typeof rate === "string") return rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate >= 1e21) {
    throw new RangeError("bad rate");
  }
  return rate.toFixed(10);
}
