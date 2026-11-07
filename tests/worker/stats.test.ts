import { env } from "cloudflare:workers";
import type { StatsResponse } from "@shared/schemas/stats";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csrfGuard, requireSession } from "../../src/worker/auth/middleware";
import { sha256Hex } from "../../src/worker/lib/crypto";
import type { AppEnv } from "../../src/worker/lib/env";
import { HttpError } from "../../src/worker/lib/errors";
import { newId } from "../../src/worker/lib/ids";
import { statsRoutes } from "../../src/worker/routes/stats";

const db = env.DB;
const ORIGIN = "https://app.test";
const NOW = new Date().toISOString();
const ALICE = "01900000-0000-7000-8000-00000000000a";
const TOKEN = "alice-session-token";

const JOINT = "acc-joint-eur";
const SAVINGS = "acc-savings-dkk";
const FOOD = "cat-food";
const GROCERIES = "cat-groceries";
const RESTAURANTS = "cat-restaurants";
const SALARY = "cat-salary";
const OLD = "cat-old";

/** Mirrors how `src/worker/app.ts` mounts a data router. */
function makeApp() {
  const app = new Hono<AppEnv>().basePath("/api");
  app.use("*", csrfGuard);
  app.use("/stats", requireSession);
  app.use("/stats/*", requireSession);
  app.route("/", statsRoutes);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, ...err.extra }, err.status);
    throw err;
  });
  return app;
}
const app = makeApp();

function get(path: string, token = TOKEN) {
  return app.request(
    `${ORIGIN}/api${path}`,
    { method: "GET", headers: { origin: ORIGIN, cookie: `__Host-bb_session=${token}` } },
    env,
  );
}

async function stats(year: number): Promise<StatsResponse> {
  const res = await get(`/stats/${year}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

async function seed() {
  await db.batch(
    [
      "DELETE FROM reconciliations",
      "DELETE FROM entries",
      "DELETE FROM categories WHERE parent_id IS NOT NULL",
      "DELETE FROM categories",
      "DELETE FROM accounts",
      "DELETE FROM sessions",
      "DELETE FROM users",
      "DELETE FROM household",
      "DELETE FROM fx_rates",
    ].map((s) => db.prepare(s)),
  );
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  const category = db.prepare(
    "INSERT INTO categories (id, type, parent_id, name, icon, colour, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
  );
  const account = db.prepare(
    "INSERT INTO accounts (id, name, currency, opening_minor, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)",
  );
  await db.batch([
    db
      .prepare(
        "INSERT INTO household (id, base_currency, timezone, argon_params, created_at) VALUES (1, 'EUR', 'Europe/Rome', '{}', ?)",
      )
      .bind(NOW),
    db
      .prepare(
        "INSERT INTO users (id, email, name, salt, verifier, created_at, updated_at) VALUES (?1, 'alice@example.com', 'Alice', 's', 'v', ?2, ?2)",
      )
      .bind(ALICE, NOW),
    db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)",
      )
      .bind(await sha256Hex(TOKEN), ALICE, NOW, expires),
    account.bind(JOINT, "Joint", "EUR", NOW),
    account.bind(SAVINGS, "Savings", "DKK", NOW),
    category.bind(FOOD, "expense", null, "Food", "IconBread", "#e8590c", null, NOW),
    category.bind(GROCERIES, "expense", FOOD, "Groceries", "IconBasket", null, null, NOW),
    category.bind(RESTAURANTS, "expense", FOOD, "Restaurants", "IconToolsKitchen", null, null, NOW),
    category.bind(SALARY, "income", null, "Salary", "IconCash", "#2f9e44", null, NOW),
    category.bind(OLD, "expense", null, "Old", "IconArchive", "#868e96", NOW, NOW),
  ]);
}

type Row = {
  kind: "expense" | "income" | "transfer" | "adjustment";
  date: string;
  base: number | null;
  category?: string;
};

async function insert(...rows: Row[]) {
  const stmt = db.prepare(
    `INSERT INTO entries (id, kind, date, user_id, account_id, account_amount_minor, to_account_id, to_amount_minor,
       base_amount_minor, fx_state, category_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
  );
  await db.batch(
    rows.map((r) => {
      const transfer = r.kind === "transfer";
      const amount = r.base === null || r.base === 0 ? 999 : r.base;
      return stmt.bind(
        newId(),
        r.kind,
        r.date,
        ALICE,
        JOINT,
        amount,
        transfer ? SAVINGS : null,
        transfer ? amount * 7 : null,
        r.base,
        r.base === null ? "waiting" : "fixed",
        r.category ?? null,
        NOW,
      );
    }),
  );
}

beforeEach(async () => {
  await seed();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/stats/:year", () => {
  it("returns all twelve months with zeros for months without entries", async () => {
    await insert(
      { kind: "expense", date: "2025-01-10", base: 1_000, category: GROCERIES },
      { kind: "income", date: "2025-03-01", base: 300_000, category: SALARY },
      { kind: "expense", date: "2025-03-20", base: 2_500, category: FOOD },
      { kind: "expense", date: "2025-12-31", base: 700, category: GROCERIES },
      // Outside the year
      { kind: "expense", date: "2024-12-31", base: 99_999, category: GROCERIES },
      { kind: "income", date: "2026-01-01", base: 99_999, category: SALARY },
    );
    const body = await stats(2025);
    expect(body.year).toBe(2025);
    expect(body.baseCurrency).toBe("EUR");
    expect(body.months).toHaveLength(12);
    expect(body.months.map((m) => m.month)).toEqual(
      Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}`),
    );
    expect(body.months[0]).toEqual({
      month: "2025-01",
      incomeMinor: 0,
      expenseMinor: 1_000,
      netMinor: -1_000,
    });
    expect(body.months[1]).toEqual({ month: "2025-02", incomeMinor: 0, expenseMinor: 0, netMinor: 0 });
    expect(body.months[2]).toEqual({
      month: "2025-03",
      incomeMinor: 300_000,
      expenseMinor: 2_500,
      netMinor: 297_500,
    });
    expect(body.months[11]).toEqual({ month: "2025-12", incomeMinor: 0, expenseMinor: 700, netMinor: -700 });
    expect(body.waitingCount).toBe(0);
  });

  it("leaves out transfers, adjustments and entries waiting for a rate, and counts the waiting ones", async () => {
    await insert(
      { kind: "expense", date: "2025-05-02", base: 4_000, category: GROCERIES },
      { kind: "income", date: "2025-05-03", base: 10_000, category: SALARY },
      { kind: "transfer", date: "2025-05-04", base: 0 },
      { kind: "adjustment", date: "2025-05-05", base: -500 },
      { kind: "expense", date: "2025-05-06", base: null, category: GROCERIES },
      { kind: "income", date: "2025-08-06", base: null, category: SALARY },
      // Waiting, but in another year
      { kind: "expense", date: "2024-05-06", base: null, category: GROCERIES },
    );
    const body = await stats(2025);
    expect(body.months[4]).toEqual({
      month: "2025-05",
      incomeMinor: 10_000,
      expenseMinor: 4_000,
      netMinor: 6_000,
    });
    expect(body.months[7]).toMatchObject({ incomeMinor: 0, expenseMinor: 0 });
    expect(body.waitingCount).toBe(2);
    const food = body.byCategory.find((c) => c.categoryId === FOOD);
    expect(food?.totalMinor).toBe(4_000);
    expect(body.byCategory.map((c) => c.categoryId).sort()).toEqual([FOOD, SALARY].sort());
  });

  it("rolls subcategory amounts up into their top-level category, archived categories included", async () => {
    await insert(
      { kind: "expense", date: "2025-02-01", base: 1_000, category: GROCERIES },
      { kind: "expense", date: "2025-02-15", base: 2_000, category: RESTAURANTS },
      { kind: "expense", date: "2025-04-01", base: 500, category: FOOD },
      { kind: "expense", date: "2025-04-02", base: 300, category: OLD },
      { kind: "income", date: "2025-04-25", base: 50_000, category: SALARY },
    );
    const body = await stats(2025);
    const food = body.byCategory.find((c) => c.categoryId === FOOD);
    expect(food).toEqual({
      categoryId: FOOD,
      name: "Food",
      colour: "#e8590c",
      icon: "IconBread",
      type: "expense",
      months: [0, 3_000, 0, 500, 0, 0, 0, 0, 0, 0, 0, 0],
      totalMinor: 3_500,
    });
    expect(body.byCategory.find((c) => c.categoryId === OLD)?.totalMinor).toBe(300);
    expect(body.byCategory.find((c) => c.categoryId === SALARY)).toMatchObject({
      type: "income",
      totalMinor: 50_000,
    });
    expect(body.byCategory.some((c) => c.categoryId === GROCERIES || c.categoryId === RESTAURANTS)).toBe(
      false,
    );
  });

  it("returns the newest stored exchange rates for the display-currency toggle", async () => {
    const rate = db.prepare(
      "INSERT INTO fx_rates (date, currency, rate_scaled, source_date) VALUES (?, ?, ?, ?)",
    );
    await db.batch([
      rate.bind("2025-06-01", "DKK", 74_000_000_000, "2025-06-01"),
      rate.bind("2025-06-01", "USD", 11_000_000_000, "2025-06-01"),
      rate.bind("2025-06-02", "DKK", 74_600_000_000, "2025-06-02"),
      rate.bind("2025-06-02", "USD", 11_400_000_000, "2025-06-02"),
    ]);
    const body = await stats(2025);
    expect(body.latestRates).toEqual({
      date: "2025-06-02",
      rates: { DKK: 74_600_000_000, USD: 11_400_000_000 },
    });
  });

  it("reads everything in a single D1 batch", async () => {
    const batch = vi.spyOn(db, "batch");
    await stats(2025);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed year", async () => {
    const res = await get("/stats/25");
    expect(res.status).toBe(422);
  });

  it("requires a session", async () => {
    const res = await get("/stats/2025", "no-such-token");
    expect(res.status).toBe(401);
  });
});
