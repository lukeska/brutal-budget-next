import { convertMinor, type ScaledRates } from "@shared/fx-math";
import { type CurrencyCode, isCurrencyCode } from "@shared/money";
import type { LatestRates } from "@shared/schemas/stats";
import { useCallback, useSyncExternalStore } from "react";
import { useMe } from "./auth/use-me";

/** What a screen's API response carries for display conversion. */
export type DisplaySource = { baseCurrency: string; latestRates: LatestRates };

export type DisplayCurrency = {
  /** The currency amounts are shown in: the base, or the partner's secondary when toggled. */
  currency: CurrencyCode;
  /** Whether the partner has a secondary currency with a rate to switch to. */
  canToggle: boolean;
  toggle: () => void;
  /** An amount in the base currency, converted to `currency` at the latest rate. */
  convert: (minorInBase: number) => number;
};

const STORAGE_KEY = "brutal-budget:show-secondary";
const listeners = new Set<() => void>();
/** Used only when storage is unavailable (private mode, blocked site data). */
let fallback = false;

function getSnapshot(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return fallback;
  }
}

function setShowSecondary(value: boolean) {
  fallback = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // The choice then lasts for this page only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function hasRate(currency: CurrencyCode, rates: ScaledRates): boolean {
  return currency === "EUR" || rates[currency] !== undefined;
}

/**
 * Display-only switch between the household base currency and the partner's secondary currency.
 * The choice is remembered per device; API data is never changed, only what is shown.
 */
export function useDisplayCurrency(source: DisplaySource | undefined): DisplayCurrency {
  const { data: me } = useMe();
  const showSecondary = useSyncExternalStore(subscribe, getSnapshot, () => false);

  const base = source && isCurrencyCode(source.baseCurrency) ? source.baseCurrency : null;
  const secondary = me?.secondaryCurrency;
  const rates = (source?.latestRates.rates ?? {}) as ScaledRates;
  const target =
    base &&
    secondary &&
    isCurrencyCode(secondary) &&
    secondary !== base &&
    hasRate(base, rates) &&
    hasRate(secondary, rates)
      ? secondary
      : null;

  const currency: CurrencyCode = showSecondary && target ? target : (base ?? "EUR");
  const convert = useCallback(
    (minorInBase: number) =>
      base && currency !== base
        ? convertMinor({ amountMinor: minorInBase, from: base, to: currency, rates })
        : minorInBase,
    [base, currency, rates],
  );
  const toggle = useCallback(() => {
    if (target) setShowSecondary(!getSnapshot());
  }, [target]);

  return { currency, canToggle: target !== null, toggle, convert };
}
