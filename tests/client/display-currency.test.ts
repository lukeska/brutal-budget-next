import type { MeResponse } from "@shared/auth";
import type { StatsResponse } from "@shared/schemas/stats";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meQueryKey } from "../../src/client/features/auth/use-me";
import { useDisplayCurrency } from "../../src/client/features/display-currency";

const me = (secondaryCurrency: string | null): MeResponse => ({
  id: "u1",
  name: "Alice",
  email: "alice@example.com",
  secondaryCurrency,
  theme: null,
  mustChangePassword: false,
});

/** A slice of an API response: base totals plus the latest rates (units per 1 EUR, ×10^10). */
function response(): Pick<StatsResponse, "baseCurrency" | "latestRates" | "months"> {
  return {
    baseCurrency: "EUR",
    latestRates: { date: "2026-11-06", rates: { DKK: 74_600_000_000, USD: 11_000_000_000 } },
    months: [{ month: "2026-01", incomeMinor: 100_000, expenseMinor: 40_000, netMinor: 60_000 }],
  };
}

function setup(secondary: string | null, data = response()) {
  const client = new QueryClient();
  client.setQueryData(meQueryKey, me(secondary));
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useDisplayCurrency(data), { wrapper });
}

/** Node's own (file-less) localStorage global shadows jsdom's, so each test gets a fresh one. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useDisplayCurrency", () => {
  it("shows the base currency until the partner toggles to their secondary currency", () => {
    const data = response();
    const { result } = setup("DKK", data);
    expect(result.current.canToggle).toBe(true);
    expect(result.current.currency).toBe("EUR");
    expect(result.current.convert(100_000)).toBe(100_000);

    act(() => result.current.toggle());

    expect(result.current.currency).toBe("DKK");
    // €1,000.00 at 7.46 DKK per EUR
    expect(result.current.convert(100_000)).toBe(746_000);
    expect(result.current.convert(-40_000)).toBe(-298_400);
    // The API data itself is untouched.
    expect(data.months[0]).toEqual({
      month: "2026-01",
      incomeMinor: 100_000,
      expenseMinor: 40_000,
      netMinor: 60_000,
    });

    act(() => result.current.toggle());
    expect(result.current.currency).toBe("EUR");
  });

  it("remembers the choice on this device", () => {
    const first = setup("DKK");
    act(() => first.result.current.toggle());
    first.unmount();

    const second = setup("DKK");
    expect(second.result.current.currency).toBe("DKK");
  });

  it("can't toggle without a secondary currency or a rate for it", () => {
    expect(setup(null).result.current.canToggle).toBe(false);
    expect(setup("EUR").result.current.canToggle).toBe(false);
    const noRate = setup("JPY");
    expect(noRate.result.current.canToggle).toBe(false);
    act(() => noRate.result.current.toggle());
    expect(noRate.result.current.currency).toBe("EUR");
    expect(noRate.result.current.convert(1_234)).toBe(1_234);
  });
});
