import { env } from "cloudflare:workers";
import type { MonthResponse } from "@shared/schemas/month";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csrfGuard, requireSession } from "../../src/worker/auth/middleware";
import { sha256Hex } from "../../src/worker/lib/crypto";
import type { AppEnv } from "../../src/worker/lib/env";
import { HttpError } from "../../src/worker/lib/errors";
import { newId } from "../../src/worker/lib/ids";
import { monthRoutes } from "../../src/worker/routes/month";

const db = env.DB;
const ORIGIN = "https://app.test";
const NOW = new Date().toISOString();
const ALICE = "01900000-0000-7000-8000-00000000000a";
const BOB = "01900000-0000-7000-8000-00000000000b";
const TOKEN = "alice-session-token";

const JOINT = "acc-joint-eur";
const SAVINGS = "acc-savings-dkk";
const FOOD = "cat-food";
const GROCERIES = "cat-groceries";
const RESTAURANTS = "cat-restaurants";
const SALARY = "cat-salary";
const JAPAN = "prj-japan";

/** Mirrors how `src/worker/app.ts` mounts a data router. */
function makeApp() {
  const app = new Hono<AppEnv>().basePath("/api");
  app.use("*", csrfGuard);
  app.use("/month", requireSession);
  app.use("/month/*", requireSession);
  app.route("/", monthRoutes);
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

async function month(path: string): Promise<MonthResponse> {
  const res = await get(`/month/${path}`);
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
      "DELETE FROM projects",
      "DELETE FROM accounts",
      "DELETE FROM sessions",
      "DELETE FROM users",
      "DELETE FROM household",
      "DELETE FROM fx_rates",
    ].map((s) => db.prepare(s)),
  );
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  const user = db.prepare(
    "INSERT INTO users (id, email, name, salt, verifier, created_at, updated_at) VALUES (?1, ?2, ?3, 's', 'v', ?4, ?4)",
  );
  const category = db.prepare(
    "INSERT INTO categories (id, type, parent_id, name, icon, colour, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
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
    user.bind(ALICE, "alice@example.com", "Alice", NOW),
    user.bind(BOB, "bob@example.com", "Bob", NOW),
    db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)",
      )
      .bind(await sha256Hex(TOKEN), ALICE, NOW, expires),
    account.bind(JOINT, "Joint", "EUR", NOW),
    account.bind(SAVINGS, "Savings", "DKK", NOW),
    category.bind(FOOD, "expense", null, "Food", "IconBread", "#e8590c", NOW),
    category.bind(GROCERIES, "expense", FOOD, "Groceries", "IconBasket", null, NOW),
    category.bind(RESTAURANTS, "expense", FOOD, "Restaurants", "IconToolsKitchen2", null, NOW),
    category.bind(SALARY, "income", null, "Salary", "IconCash", "#2f9e44", NOW),
    db
      .prepare(
        "INSERT INTO projects (id, name, colour, created_at, updated_at) VALUES (?1, 'Japan trip', '#1971c2', ?2, ?2)",
      )
      .bind(JAPAN, NOW),
    db
      .prepare(
        "INSERT INTO fx_rates (date, currency, rate_scaled, source_date) VALUES ('2026-11-06', 'USD', 11000000000, '2026-11-06')",
      )
      .bind(),
  ]);
}

type Row = {
  kind: "expense" | "income" | "transfer" | "adjustment";
  date: string;
  /** Amount booked to the account (signed for adjustments). */
  amount: number;
  /** Base value; null means waiting for a rate. Defaults to `amount` (0 for transfers). */
  base?: number | null;
  category?: string;
  user?: string;
  orig?: { currency: string; amount: number };
  project?: string;
  notes?: string;
};

const entryInsert = () =>
  db.prepare(
    `INSERT INTO entries (id, kind, date, user_id, account_id, account_amount_minor, to_account_id, to_amount_minor,
       orig_currency, orig_amount_minor, base_amount_minor, fx_state, category_id, project_id, notes, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`,
  );

function bindRow(stmt: D1PreparedStatement, r: Row, id = newId()) {
  const transfer = r.kind === "transfer";
  const base = r.base === undefined ? (transfer ? 0 : r.amount) : r.base;
  return stmt.bind(
    id,
    r.kind,
    r.date,
    r.user ?? ALICE,
    JOINT,
    r.amount,
    transfer ? SAVINGS : null,
    transfer ? r.amount * 7 : null,
    r.orig?.currency ?? null,
    r.orig?.amount ?? null,
    base,
    base === null ? "waiting" : "fixed",
    r.category ?? null,
    r.project ?? null,
    r.notes ?? null,
    NOW,
  );
}

async function insert(...rows: Row[]) {
  const stmt = entryInsert();
  await db.batch(rows.map((r) => bindRow(stmt, r)));
}

beforeEach(async () => {
  await seed();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/month/:month", () => {
  it("rolls subcategories into their parent and keeps the parent's own amount apart", async () => {
    await insert(
      { kind: "expense", date: "2026-11-03", amount: 4_000, category: GROCERIES },
      { kind: "expense", date: "2026-11-04", amount: 1_000, category: FOOD },
      { kind: "income", date: "2026-11-01", amount: 300_000, category: SALARY },
    );
    const body = await month("2026-11");
    expect(body.month).toBe("2026-11");
    expect(body.baseCurrency).toBe("EUR");
    expect(body.categories.map((c) => c.name)).toEqual(["Food", "Salary"]);
    const food = body.categories[0];
    expect(food).toEqual({
      id: FOOD,
      type: "expense",
      name: "Food",
      icon: "IconBread",
      colour: "#e8590c",
      totalMinor: 5_000,
      ownMinor: 1_000,
      children: [
        { id: GROCERIES, name: "Groceries", icon: "IconBasket", colour: "#e8590c", totalMinor: 4_000 },
      ],
    });
    expect(body.categories[1]).toMatchObject({ type: "income", totalMinor: 300_000, ownMinor: 300_000 });
    expect(body.totals).toEqual({ incomeMinor: 300_000, expenseMinor: 5_000, netMinor: 295_000 });
  });

  it("lists transfers and adjustments but leaves them out of every total", async () => {
    await insert(
      { kind: "expense", date: "2026-11-05", amount: 2_000, category: GROCERIES },
      { kind: "transfer", date: "2026-11-06", amount: 50_000 },
      { kind: "adjustment", date: "2026-11-07", amount: -2_500, base: -2_500 },
    );
    const body = await month("2026-11");
    expect(body.totals).toEqual({ incomeMinor: 0, expenseMinor: 2_000, netMinor: -2_000 });
    expect(body.categories.map((c) => c.totalMinor)).toEqual([2_000]);
    expect(body.entries.map((e) => e.kind)).toEqual(["adjustment", "transfer", "expense"]);
    const transfer = body.entries[1];
    expect(transfer).toMatchObject({
      accountName: "Joint",
      toAccountName: "Savings",
      accountAmountMinor: 50_000,
      toAmountMinor: 350_000,
      toCurrency: "DKK",
      categoryName: null,
    });
  });

  it("leaves an entry waiting for a rate out of the totals and counts it", async () => {
    await insert(
      { kind: "expense", date: "2026-11-05", amount: 2_000, category: GROCERIES },
      {
        kind: "expense",
        date: "2026-11-06",
        amount: 1_800,
        base: null,
        category: GROCERIES,
        orig: { currency: "USD", amount: 2_000 },
      },
      // Waiting, but in another month
      { kind: "expense", date: "2026-10-06", amount: 1_800, base: null, category: GROCERIES },
    );
    const body = await month("2026-11");
    expect(body.totals.expenseMinor).toBe(2_000);
    expect(body.waitingCount).toBe(1);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]?.fxState).toBe("waiting");
  });

  it("limits totals, categories and entries to one partner", async () => {
    await insert(
      { kind: "expense", date: "2026-11-02", amount: 1_000, category: GROCERIES, user: ALICE },
      { kind: "expense", date: "2026-11-03", amount: 7_000, category: RESTAURANTS, user: BOB },
      { kind: "income", date: "2026-11-04", amount: 90_000, category: SALARY, user: BOB },
    );
    const all = await month("2026-11");
    expect(all.totals).toEqual({ incomeMinor: 90_000, expenseMinor: 8_000, netMinor: 82_000 });

    const bob = await month(`2026-11?userId=${BOB}`);
    expect(bob.totals).toEqual({ incomeMinor: 90_000, expenseMinor: 7_000, netMinor: 83_000 });
    expect(bob.entries.map((e) => e.userName)).toEqual(["Bob", "Bob"]);
    expect(bob.categories[0]?.children.map((c) => c.name)).toEqual(["Restaurants"]);

    const alice = await month(`2026-11?userId=${ALICE}`);
    expect(alice.totals).toEqual({ incomeMinor: 0, expenseMinor: 1_000, netMinor: -1_000 });
    expect(alice.entries).toHaveLength(1);
  });

  it("returns both amounts and resolved names for a foreign-currency entry", async () => {
    await insert({
      kind: "expense",
      date: "2026-11-10",
      amount: 1_870,
      category: RESTAURANTS,
      orig: { currency: "JPY", amount: 3_000 },
      project: JAPAN,
      notes: "Ramen",
    });
    const [entry] = (await month("2026-11")).entries;
    expect(entry).toMatchObject({
      amountMinor: 3_000,
      currency: "JPY",
      accountAmountMinor: 1_870,
      accountCurrency: "EUR",
      baseAmountMinor: 1_870,
      userName: "Alice",
      accountName: "Joint",
      categoryName: "Restaurants",
      categoryIcon: "IconToolsKitchen2",
      categoryColour: "#e8590c",
      projectName: "Japan trip",
      projectColour: "#1971c2",
      notes: "Ramen",
    });
  });

  it("keeps entries of other months out and carries the latest rates", async () => {
    await insert(
      { kind: "expense", date: "2026-10-31", amount: 100, category: FOOD },
      { kind: "expense", date: "2026-11-01", amount: 200, category: FOOD },
      { kind: "expense", date: "2026-11-30", amount: 300, category: FOOD },
      { kind: "expense", date: "2026-12-01", amount: 400, category: FOOD },
    );
    const body = await month("2026-11");
    expect(body.entries.map((e) => e.date)).toEqual(["2026-11-30", "2026-11-01"]);
    expect(body.totals.expenseMinor).toBe(500);
    expect(body.latestRates).toEqual({ date: "2026-11-06", rates: { USD: 11_000_000_000 } });
  });

  it("reads everything in a single D1 batch", async () => {
    await insert({ kind: "expense", date: "2026-11-05", amount: 2_000, category: GROCERIES });
    const batch = vi.spyOn(env.DB, "batch");
    await month("2026-11");
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("answers for a month with 1,000 entries", async () => {
    const stmt = entryInsert();
    const rows = Array.from({ length: 1_000 }, (_, i) =>
      bindRow(stmt, {
        kind: i % 10 === 0 ? "income" : "expense",
        date: `2026-11-${String((i % 30) + 1).padStart(2, "0")}`,
        amount: 100 + i,
        category: i % 10 === 0 ? SALARY : i % 2 ? GROCERIES : FOOD,
        user: i % 3 ? ALICE : BOB,
      }),
    );
    await db.batch(rows);
    const body = await month("2026-11");
    expect(body.entries).toHaveLength(1_000);
    const income = body.entries
      .filter((e) => e.kind === "income")
      .reduce((s, e) => s + e.accountAmountMinor, 0);
    const expense = body.entries
      .filter((e) => e.kind === "expense")
      .reduce((s, e) => s + e.accountAmountMinor, 0);
    expect(body.totals).toEqual({ incomeMinor: income, expenseMinor: expense, netMinor: income - expense });
  });

  it("refuses a malformed month", async () => {
    const res = await get("/month/2026-13");
    expect(res.status).toBe(422);
  });

  it("needs a session", async () => {
    const res = await get("/month/2026-11", "nope");
    expect(res.status).toBe(401);
  });
});
