import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CURRENCY_CODES, type CurrencyCode } from "@shared/money";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeBaseValue } from "../../src/worker/fx/base-value";
import { runFxCron } from "../../src/worker/fx/cron";
import { ensureRange, rateFor } from "../../src/worker/fx/rates";
import worker from "../../src/worker/index";

const db = env.DB;
const NOW = "2026-11-01T10:00:00.000Z";
const QUOTES = CURRENCY_CODES.filter((c) => c !== "EUR");

// ---------- fake Frankfurter v2 ----------

type DayRates = Partial<Record<CurrencyCode, number>>;
const DEFAULT_RATES: Record<Exclude<CurrencyCode, "EUR">, number> = {
  USD: 1.1,
  GBP: 0.87,
  JPY: 160,
  CAD: 1.5,
  AUD: 1.65,
  CHF: 0.94,
  CNY: 7.9,
  INR: 93.5,
  BRL: 6.2,
  DKK: 7.46,
  NOK: 11.6,
  SEK: 11.2,
  ISK: 136,
};
function day(overrides: DayRates = {}, omit: CurrencyCode[] = []): DayRates {
  const rates: DayRates = { ...DEFAULT_RATES, ...overrides };
  for (const c of omit) delete rates[c];
  return rates;
}

interface FakeProvider {
  published: Record<string, DayRates>;
  calls: URL[];
  down: boolean;
  onRequest?: (url: URL) => Promise<void>;
}

function fakeFrankfurter(published: Record<string, DayRates> = {}): FakeProvider {
  const provider: FakeProvider = { published, calls: [], down: false };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    provider.calls.push(url);
    await provider.onRequest?.(url);
    if (provider.down) return new Response("Service Unavailable", { status: 503 });
    const quotes = (url.searchParams.get("quotes") ?? "").split(",");
    const dates = Object.keys(provider.published).sort();
    const date = url.searchParams.get("date");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    let selected: string[];
    if (date) selected = dates.filter((d) => d <= date).slice(-1);
    else if (from && to) selected = dates.filter((d) => d >= from && d <= to);
    else selected = dates.slice(-1);
    const body = selected.flatMap((d) =>
      Object.entries(provider.published[d] ?? {})
        .filter(([quote]) => quotes.includes(quote))
        .map(([quote, rate]) => ({ date: d, base: "EUR", quote, rate })),
    );
    return Response.json(body);
  });
  return provider;
}

// ---------- data helpers ----------

async function resetData() {
  await db.batch(
    [
      "DELETE FROM entries",
      "DELETE FROM categories",
      "DELETE FROM accounts",
      "DELETE FROM users",
      "DELETE FROM household",
      "DELETE FROM fx_rates",
    ].map((s) => db.prepare(s)),
  );
}

async function seed() {
  await db.batch([
    db
      .prepare(
        "INSERT INTO household (id, base_currency, timezone, argon_params, created_at) VALUES (1, 'EUR', 'Europe/Rome', '{}', ?)",
      )
      .bind(NOW),
    db
      .prepare(
        "INSERT INTO users (id, email, name, salt, verifier, created_at, updated_at) VALUES ('u1', 'a@example.com', 'A', 's', 'v', ?, ?)",
      )
      .bind(NOW, NOW),
    db
      .prepare(
        "INSERT INTO accounts (id, name, currency, opening_minor, created_at, updated_at) VALUES ('eur', 'Joint', 'EUR', 0, ?1, ?1), ('usd', 'Dollar card', 'USD', 0, ?1, ?1), ('jpy', 'Yen wallet', 'JPY', 0, ?1, ?1)",
      )
      .bind(NOW),
    db
      .prepare(
        "INSERT INTO categories (id, type, name, icon, colour, created_at, updated_at) VALUES ('cat1', 'expense', 'Food', 'IconToolsKitchen2', '#e8590c', ?, ?)",
      )
      .bind(NOW, NOW),
  ]);
}

interface EntryRow {
  id: string;
  account_amount_minor: number;
  base_amount_minor: number | null;
  fx_state: string;
  rate_scaled: number | null;
  rate_date: string | null;
  version: number;
}

async function insertEntry(e: {
  id: string;
  date: string;
  accountId: string;
  amount: number;
  fxState: "fixed" | "waiting" | "provisional";
  base: number | null;
  rateScaled?: number | null;
  rateDate?: string | null;
}) {
  await db
    .prepare(
      "INSERT INTO entries (id, kind, date, user_id, account_id, account_amount_minor, base_amount_minor, fx_state, rate_scaled, rate_date, category_id, created_at, updated_at) VALUES (?, 'expense', ?, 'u1', ?, ?, ?, ?, ?, ?, 'cat1', ?, ?)",
    )
    .bind(
      e.id,
      e.date,
      e.accountId,
      e.amount,
      e.base,
      e.fxState,
      e.rateScaled ?? null,
      e.rateDate ?? null,
      NOW,
      NOW,
    )
    .run();
}

/** Saves an entry the way the entries API will: base value computed at save time. */
async function saveEntry(id: string, date: string, accountId: "usd" | "jpy", amount: number, today: string) {
  const accountCurrency = accountId === "usd" ? "USD" : "JPY";
  const value = await computeBaseValue(db, {
    accountAmountMinor: amount,
    accountCurrency,
    baseCurrency: "EUR",
    entryDate: date,
    today,
  });
  await insertEntry({
    id,
    date,
    accountId,
    amount,
    fxState: value.fxState,
    base: value.baseAmountMinor,
    rateScaled: value.rateScaled,
    rateDate: value.rateDate,
  });
  return value;
}

async function entry(id: string): Promise<EntryRow> {
  const row = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first<EntryRow>();
  if (!row) throw new Error(`entry ${id} not found`);
  return row;
}

async function rateRow(date: string, currency: string) {
  return db
    .prepare("SELECT rate_scaled, source_date FROM fx_rates WHERE date = ? AND currency = ?")
    .bind(date, currency)
    .first<{ rate_scaled: number; source_date: string }>();
}

async function rateCount(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM fx_rates").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Instant in UTC; household is in Europe/Rome (UTC+1 in November/December). */
const at = (iso: string) => new Date(iso);

beforeEach(async () => {
  await resetData();
  await seed();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// 2026-11-06 is a Friday, 2026-11-07 Saturday, 2026-11-08 Sunday, 2026-11-09 Monday.

describe("rate storage and lookup", () => {
  it("answers a Sunday with Friday's stored rate, without fetching", async () => {
    const provider = fakeFrankfurter({ "2026-11-06": day({ USD: 1.1172 }) });
    await runFxCron(db, at("2026-11-08T16:00:00Z"));
    const fetchesAfterCron = provider.calls.length;

    const result = await rateFor(db, "2026-11-08", "USD", "2026-11-08");

    expect(result).toEqual({ status: "ok", rateScaled: 11_172_000_000, sourceDate: "2026-11-06" });
    expect(provider.calls.length).toBe(fetchesAfterCron);
  });

  it("fetches a missing past date once, stores it, and serves it from storage afterwards", async () => {
    const provider = fakeFrankfurter({ "2026-10-14": day({ USD: 1.163 }) });

    const first = await rateFor(db, "2026-10-14", "USD", "2026-11-07");
    expect(first).toEqual({ status: "ok", rateScaled: 11_630_000_000, sourceDate: "2026-10-14" });
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0];
    expect(call?.origin + (call?.pathname ?? "")).toBe("https://api.frankfurter.dev/v2/rates");
    expect(call?.searchParams.get("providers")).toBe("ecb");
    expect(call?.searchParams.get("base")).toBe("EUR");
    expect(call?.searchParams.get("quotes")?.split(",").sort()).toEqual([...QUOTES].sort());

    const second = await rateFor(db, "2026-10-14", "USD", "2026-11-07");
    expect(second).toEqual(first);
    expect(provider.calls).toHaveLength(1);
  });

  it("fills 90 days with exactly one provider request", async () => {
    const published: Record<string, DayRates> = {};
    for (let d = new Date("2026-06-01T00:00:00Z"); d <= new Date("2026-09-30T00:00:00Z"); ) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) published[d.toISOString().slice(0, 10)] = day();
      d = new Date(d.getTime() + 86_400_000);
    }
    const provider = fakeFrankfurter(published);

    const result = await ensureRange(db, "2026-07-01", "2026-09-28", "2026-11-07");

    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(1);
    const days = await db
      .prepare(
        "SELECT COUNT(DISTINCT date) AS n FROM fx_rates WHERE date BETWEEN '2026-07-01' AND '2026-09-28'",
      )
      .first<{ n: number }>();
    expect(days?.n).toBe(90);
    // A Sunday inside the range carries the Friday before it.
    expect(await rateRow("2026-08-02", "USD")).toEqual({
      rate_scaled: 11_000_000_000,
      source_date: "2026-07-31",
    });
  });

  it("rejects ranges longer than 92 days", async () => {
    fakeFrankfurter();
    await expect(ensureRange(db, "2026-01-01", "2026-06-30", "2026-11-07")).rejects.toThrow(RangeError);
  });

  it("fails only the currency a provider response lacks, and logs it", async () => {
    const provider = fakeFrankfurter({ "2026-10-14": day({}, ["ISK"]) });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const isk = await rateFor(db, "2026-10-14", "ISK", "2026-11-07");
    const usd = await rateFor(db, "2026-10-14", "USD", "2026-11-07");

    expect(isk).toEqual({ status: "unavailable" });
    expect(usd).toEqual({ status: "ok", rateScaled: 11_000_000_000, sourceDate: "2026-10-14" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ISK"));
    expect(provider.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("daily cron", () => {
  it("stores no duplicate rows when it runs twice on the same day", async () => {
    fakeFrankfurter({ "2026-11-05": day(), "2026-11-06": day() });
    await runFxCron(db, at("2026-11-06T16:00:00Z"));
    const once = await rateCount();
    await runFxCron(db, at("2026-11-06T22:00:00Z"));

    expect(once).toBeGreaterThan(0);
    expect(await rateCount()).toBe(once);
    expect(once % QUOTES.length).toBe(0);
  });

  it("copies the last publication forward before today is published, then replaces it", async () => {
    const provider = fakeFrankfurter({ "2026-11-06": day({ USD: 1.1 }) });
    await runFxCron(db, at("2026-11-09T08:00:00Z"));
    expect(await rateRow("2026-11-09", "USD")).toEqual({
      rate_scaled: 11_000_000_000,
      source_date: "2026-11-06",
    });

    provider.published["2026-11-09"] = day({ USD: 1.12 });
    await runFxCron(db, at("2026-11-09T16:00:00Z"));

    expect(await rateRow("2026-11-09", "USD")).toEqual({
      rate_scaled: 11_200_000_000,
      source_date: "2026-11-09",
    });
    expect(await rateRow("2026-11-08", "USD")).toEqual({
      rate_scaled: 11_000_000_000,
      source_date: "2026-11-06",
    });
  });

  it("populates all 13 non-euro currencies when the Worker's scheduled handler fires", async () => {
    fakeFrankfurter({ "2026-11-06": day() });
    const controller = createScheduledController({
      scheduledTime: at("2026-11-06T16:00:00Z"),
      cron: "0 16 * * *",
    });
    const ctx = createExecutionContext();

    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const { results } = await db
      .prepare("SELECT currency FROM fx_rates WHERE date = '2026-11-06' ORDER BY currency")
      .all<{ currency: string }>();
    expect(results.map((r) => r.currency)).toEqual([...QUOTES].sort());
  });
});

describe("entry base values", () => {
  it("saves as waiting when the provider is down, and the next cron run fills the base value", async () => {
    const provider = fakeFrankfurter({ "2026-11-06": day({ USD: 1.25 }) });
    provider.down = true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const value = await saveEntry("e1", "2026-11-06", "usd", 10_000, "2026-11-06");
    expect(value).toEqual({ baseAmountMinor: null, fxState: "waiting", rateScaled: null, rateDate: null });

    await expect(runFxCron(db, at("2026-11-06T16:00:00Z"))).resolves.toBeUndefined();
    expect((await entry("e1")).fx_state).toBe("waiting");

    provider.down = false;
    await runFxCron(db, at("2026-11-06T22:00:00Z"));

    const row = await entry("e1");
    expect(row.fx_state).toBe("fixed");
    expect(row.base_amount_minor).toBe(8_000); // 100 USD / 1.25
    expect(row.rate_date).toBe("2026-11-06");
    expect(row.rate_scaled).toBe(8_000_000_000);
    expect(row.version).toBe(2);
  });

  it("gives up on a stalled provider after a timeout and saves the entry as waiting", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The provider accepts the request and never answers; only an abort ends it.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    // Stand in for the timer so the test needn't wait: fire the request's timeout by hand.
    const timer = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);

    const saving = saveEntry("e1", "2026-11-06", "usd", 10_000, "2026-11-06");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(timer.signal);
    timer.abort(new DOMException("The operation timed out.", "TimeoutError"));

    expect(await saving).toEqual({
      baseAmountMinor: null,
      fxState: "waiting",
      rateScaled: null,
      rateDate: null,
    });
  });

  it("keeps a fixed entry's base value when newer rates arrive", async () => {
    const provider = fakeFrankfurter({ "2026-03-10": day({ USD: 1.25 }) });
    await runFxCron(db, at("2026-03-10T16:00:00Z"));
    const value = await saveEntry("e1", "2026-03-10", "usd", 10_000, "2026-03-10");
    expect(value.fxState).toBe("fixed");
    expect(value.baseAmountMinor).toBe(8_000);

    provider.published["2026-03-11"] = day({ USD: 1.0 });
    await runFxCron(db, at("2026-03-11T16:00:00Z"));

    expect(await entry("e1")).toMatchObject({ base_amount_minor: 8_000, fx_state: "fixed", version: 1 });
  });

  it("marks a morning entry for today provisional and fixes it after the evening run", async () => {
    const provider = fakeFrankfurter({ "2026-11-06": day({ USD: 1.25 }) });
    await runFxCron(db, at("2026-11-09T08:00:00Z"));

    const value = await saveEntry("e1", "2026-11-09", "usd", 10_000, "2026-11-09");
    expect(value).toEqual({
      baseAmountMinor: 8_000,
      fxState: "provisional",
      rateScaled: 8_000_000_000,
      rateDate: "2026-11-06",
    });

    provider.published["2026-11-09"] = day({ USD: 1.6 });
    await runFxCron(db, at("2026-11-09T22:00:00Z"));

    expect(await entry("e1")).toMatchObject({
      base_amount_minor: 6_250,
      fx_state: "fixed",
      rate_date: "2026-11-09",
      version: 2,
    });
  });

  it("fixes a Saturday entry at Friday's rate once Monday is published", async () => {
    const provider = fakeFrankfurter({ "2026-11-06": day({ USD: 1.25 }) });
    await runFxCron(db, at("2026-11-07T16:00:00Z"));
    const value = await saveEntry("e1", "2026-11-07", "usd", 10_000, "2026-11-07");
    expect(value.fxState).toBe("provisional");

    await runFxCron(db, at("2026-11-08T16:00:00Z"));
    expect((await entry("e1")).fx_state).toBe("provisional");

    provider.published["2026-11-09"] = day({ USD: 1.6 });
    await runFxCron(db, at("2026-11-09T16:00:00Z"));

    expect(await entry("e1")).toMatchObject({
      base_amount_minor: 8_000,
      fx_state: "fixed",
      rate_date: "2026-11-06",
    });
  });

  it("fixes an ECB-holiday entry at the previous working day's rate once the next working day is published", async () => {
    // 2026-12-25 (Friday) and 2026-12-26 have no ECB publication.
    const provider = fakeFrankfurter({ "2026-12-23": day({ USD: 1.2 }), "2026-12-24": day({ USD: 1.25 }) });
    await runFxCron(db, at("2026-12-25T16:00:00Z"));
    const value = await saveEntry("e1", "2026-12-25", "usd", 10_000, "2026-12-25");
    expect(value.fxState).toBe("provisional");

    provider.published["2026-12-28"] = day({ USD: 1.6 });
    await runFxCron(db, at("2026-12-28T16:00:00Z"));

    expect(await entry("e1")).toMatchObject({
      base_amount_minor: 8_000,
      fx_state: "fixed",
      rate_date: "2026-12-24",
    });
  });

  it("fixes a backdated Saturday entry immediately at Friday's rate", async () => {
    const provider = fakeFrankfurter({
      "2026-11-06": day({ USD: 1.25 }),
      "2026-11-09": day({ USD: 1.6 }),
      "2026-11-10": day({ USD: 1.6 }),
    });
    await runFxCron(db, at("2026-11-10T16:00:00Z"));
    const fetches = provider.calls.length;

    const value = await saveEntry("e1", "2026-11-07", "usd", 10_000, "2026-11-10");

    expect(value).toEqual({
      baseAmountMinor: 8_000,
      fxState: "fixed",
      rateScaled: 8_000_000_000,
      rateDate: "2026-11-06",
    });
    expect(provider.calls.length).toBe(fetches);
  });

  it("gives a future-dated entry the latest rate as provisional, then fixes it once its date is published", async () => {
    const provider = fakeFrankfurter({ "2026-11-09": day({ USD: 1.25 }) });
    await runFxCron(db, at("2026-11-09T16:00:00Z"));
    const value = await saveEntry("e1", "2026-11-12", "usd", 10_000, "2026-11-09");
    expect(value).toMatchObject({ baseAmountMinor: 8_000, fxState: "provisional", rateDate: "2026-11-09" });

    provider.published["2026-11-10"] = day({ USD: 1.3 });
    provider.published["2026-11-11"] = day({ USD: 1.4 });
    await runFxCron(db, at("2026-11-11T16:00:00Z"));
    expect((await entry("e1")).fx_state).toBe("provisional");

    provider.published["2026-11-12"] = day({ USD: 1.6 });
    await runFxCron(db, at("2026-11-12T16:00:00Z"));

    expect(await entry("e1")).toMatchObject({
      base_amount_minor: 6_250,
      fx_state: "fixed",
      rate_date: "2026-11-12",
    });
  });

  it("skips an entry edited between the cron's read and write, then uses the new amount next run", async () => {
    const provider = fakeFrankfurter({ "2026-10-14": day({ USD: 1.25 }), "2026-11-06": day({ USD: 1.6 }) });
    await insertEntry({
      id: "e1",
      date: "2026-10-14",
      accountId: "usd",
      amount: 10_000,
      fxState: "waiting",
      base: null,
    });
    // A partner's PATCH lands while the cron is fetching the entry's missing rate.
    provider.onRequest = async (url) => {
      if (url.searchParams.get("to") === "2026-10-14") {
        provider.onRequest = undefined;
        await db
          .prepare("UPDATE entries SET account_amount_minor = 20000, version = version + 1 WHERE id = 'e1'")
          .run();
      }
    };

    await runFxCron(db, at("2026-11-06T16:00:00Z"));

    expect(await entry("e1")).toMatchObject({
      account_amount_minor: 20_000,
      fx_state: "waiting",
      version: 2,
    });

    await runFxCron(db, at("2026-11-06T22:00:00Z"));

    expect(await entry("e1")).toMatchObject({ base_amount_minor: 16_000, fx_state: "fixed", version: 3 });
    // A client still holding the pre-cron version can no longer write.
    const stale = await db
      .prepare(
        "UPDATE entries SET account_amount_minor = 1, version = version + 1 WHERE id = 'e1' AND version = 2",
      )
      .run();
    expect(stale.meta.changes).toBe(0);
  });

  it("converts a JPY amount beyond 64-bit SQL arithmetic exactly, rounding half to even", async () => {
    // 9_000_000_000_000_004 JPY at 160 JPY/EUR is 5_625_000_000_000_002.5 cents.
    fakeFrankfurter({ "2026-11-06": day({ JPY: 160 }) });
    await insertEntry({
      id: "e1",
      date: "2026-11-06",
      accountId: "jpy",
      amount: 9_000_000_000_000_004,
      fxState: "waiting",
      base: null,
    });

    await runFxCron(db, at("2026-11-06T16:00:00Z"));

    const row = await db
      .prepare("SELECT CAST(base_amount_minor AS TEXT) AS base, fx_state FROM entries WHERE id = 'e1'")
      .first<{ base: string; fx_state: string }>();
    expect(row).toEqual({ base: "5625000000000002", fx_state: "fixed" });
  });
});

describe("rates API", () => {
  it("returns a date's rates with their source dates, fetching a missing past date", async () => {
    const provider = fakeFrankfurter({ "2026-10-16": day({ USD: 1.163 }) });
    const { ratesRoutes } = await import("../../src/worker/routes/rates");

    const res = await ratesRoutes.request("/rates?date=2026-10-18", {}, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      days: { date: string; rates: Record<string, { rateScaled: number; sourceDate: string }> }[];
    };
    expect(body.status).toBe("ok");
    expect(body.days).toHaveLength(1);
    expect(body.days[0]?.date).toBe("2026-10-18");
    expect(body.days[0]?.rates.USD).toEqual({ rateScaled: 11_630_000_000, sourceDate: "2026-10-16" });
    expect(provider.calls).toHaveLength(1);
  });

  it("rejects a malformed date", async () => {
    fakeFrankfurter();
    const { ratesRoutes } = await import("../../src/worker/routes/rates");
    const res = await ratesRoutes.request("/rates?date=2026-13-40", {}, env);
    expect(res.status).toBe(400);
  });

  it("returns the latest published rates and their date", async () => {
    fakeFrankfurter({ "2026-11-05": day({ USD: 1.2 }), "2026-11-06": day({ USD: 1.1172 }) });
    await runFxCron(db, at("2026-11-07T16:00:00Z"));
    const { ratesRoutes } = await import("../../src/worker/routes/rates");

    const res = await ratesRoutes.request("/rates/latest", {}, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { date: string; rates: Record<string, number> };
    expect(body.date).toBe("2026-11-06");
    expect(body.rates.USD).toBe(11_172_000_000);
    expect(Object.keys(body.rates).sort()).toEqual([...QUOTES].sort());
  });
});
