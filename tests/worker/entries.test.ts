import { env } from "cloudflare:workers";
import type { Entry } from "@shared/schemas/entry";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csrfGuard, requireSession } from "../../src/worker/auth/middleware";
import { addDays, todayIn } from "../../src/worker/fx/today";
import { sha256Hex } from "../../src/worker/lib/crypto";
import type { AppEnv } from "../../src/worker/lib/env";
import { HttpError } from "../../src/worker/lib/errors";
import { newId } from "../../src/worker/lib/ids";
import { entriesRoutes } from "../../src/worker/routes/entries";
import { accountBalances } from "../../src/worker/services/entries";

const db = env.DB;
const ORIGIN = "https://app.test";
const NOW = new Date().toISOString();
const TODAY = todayIn("Europe/Rome");
const LAST_WEEK = addDays(TODAY, -7);
const NEXT_WEEK = addDays(TODAY, 7);
const MONTH = TODAY.slice(0, 7);

const ALICE = "01900000-0000-7000-8000-00000000000a";
const BOB = "01900000-0000-7000-8000-00000000000b";
const ALICE_TOKEN = "alice-session-token";
const BOB_TOKEN = "bob-session-token";

// Accounts
const JOINT = "acc-joint-eur";
const SAVINGS = "acc-savings-dkk";
const POCKET = "acc-pocket-eur";
const DOLLAR = "acc-dollar-usd";
const OLD = "acc-old-eur";
// Categories
const FOOD = "cat-food";
const GROCERIES = "cat-groceries";
const SALARY = "cat-salary";
const OLD_CAT = "cat-old";
const PROJECT = "proj-trip";

/** Mirrors how `src/worker/app.ts` mounts a data router. */
function makeApp() {
  const app = new Hono<AppEnv>().basePath("/api");
  app.use("*", csrfGuard);
  app.use("/entries", requireSession);
  app.use("/entries/*", requireSession);
  app.route("/", entriesRoutes);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, ...err.extra }, err.status);
    throw err;
  });
  return app;
}
const app = makeApp();

type As = { as?: string };
function call(method: string, path: string, body?: unknown, opts: As = {}) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    "content-type": "application/json",
    cookie: `__Host-bb_session=${opts.as ?? ALICE_TOKEN}`,
  };
  return app.request(
    `${ORIGIN}/api${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
}
const post = (path: string, body: unknown, opts?: As) => call("POST", path, body, opts);
const patch = (path: string, body: unknown, opts?: As) => call("PATCH", path, body, opts);
const del = (path: string, opts?: As) => call("DELETE", path, undefined, opts);
const get = (path: string, opts?: As) => call("GET", path, undefined, opts);

async function seed() {
  await db.batch(
    [
      "DELETE FROM reconciliations",
      "DELETE FROM entries",
      "DELETE FROM projects",
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
  const user = db.prepare(
    "INSERT INTO users (id, email, name, salt, verifier, created_at, updated_at) VALUES (?1, ?2, ?3, 's', 'v', ?4, ?4)",
  );
  const session = db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)",
  );
  const account = db.prepare(
    "INSERT INTO accounts (id, name, currency, opening_minor, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
  );
  const category = db.prepare(
    "INSERT INTO categories (id, type, parent_id, name, icon, colour, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'IconTag', ?5, ?6, ?7, ?7)",
  );
  await db.batch([
    db
      .prepare(
        "INSERT INTO household (id, base_currency, timezone, argon_params, created_at) VALUES (1, 'EUR', 'Europe/Rome', '{}', ?)",
      )
      .bind(NOW),
    user.bind(ALICE, "alice@example.com", "Alice", NOW),
    user.bind(BOB, "bob@example.com", "Bob", NOW),
    session.bind(await sha256Hex(ALICE_TOKEN), ALICE, NOW, expires),
    session.bind(await sha256Hex(BOB_TOKEN), BOB, NOW, expires),
    account.bind(JOINT, "Joint", "EUR", 100_000, null, NOW),
    account.bind(SAVINGS, "Savings", "DKK", 0, null, NOW),
    account.bind(POCKET, "Pocket", "EUR", 0, null, NOW),
    account.bind(DOLLAR, "Dollar card", "USD", 0, null, NOW),
    account.bind(OLD, "Closed", "EUR", 0, NOW, NOW),
    category.bind(FOOD, "expense", null, "Food", "#e8590c", null, NOW),
    category.bind(GROCERIES, "expense", FOOD, "Groceries", null, null, NOW),
    category.bind(SALARY, "income", null, "Salary", "#2f9e44", null, NOW),
    category.bind(OLD_CAT, "expense", null, "Old", "#868e96", NOW, NOW),
    db
      .prepare(
        "INSERT INTO projects (id, name, colour, created_at, updated_at) VALUES (?1, 'Trip', '#000000', ?2, ?2)",
      )
      .bind(PROJECT, NOW),
  ]);
}

/** Stores a rate row for `date` (units of `currency` per 1 EUR). */
async function seedRate(date: string, currency: string, perEur: number, sourceDate = date) {
  await db
    .prepare("INSERT INTO fx_rates (date, currency, rate_scaled, source_date) VALUES (?, ?, ?, ?)")
    .bind(date, currency, Math.round(perEur * 1e10), sourceDate)
    .run();
}

function expense(overrides: Record<string, unknown> = {}) {
  return {
    id: newId(),
    kind: "expense",
    date: TODAY,
    amountMinor: 1250,
    currency: "EUR",
    accountId: JOINT,
    categoryId: GROCERIES,
    ...overrides,
  };
}

async function create(body: Record<string, unknown>, opts?: As): Promise<Entry> {
  const res = await post("/entries", body, opts);
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json();
}

async function row(id: string) {
  return db.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

async function count(): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM entries").first<{ n: number }>())?.n ?? 0;
}

async function monthTotals(month: string) {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN base_amount_minor END), 0) AS income,
              COALESCE(SUM(CASE WHEN kind = 'expense' THEN base_amount_minor END), 0) AS expense
       FROM entries WHERE date LIKE ?1 || '-%'`,
    )
    .bind(month)
    .first<{ income: number; expense: number }>();
  return r;
}

async function insertAdjustment(id: string) {
  await db
    .prepare(
      "INSERT INTO entries (id, kind, date, user_id, account_id, account_amount_minor, base_amount_minor, fx_state, created_at, updated_at) VALUES (?1, 'adjustment', ?2, ?3, ?4, -500, -500, 'fixed', ?5, ?5)",
    )
    .bind(id, TODAY, ALICE, JOINT, NOW)
    .run();
}

beforeEach(async () => {
  await seed();
  // No test should reach the real rate provider.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("creating entries", () => {
  it("stores a foreign expense with the overwritten account amount and values it from that amount", async () => {
    const entry = await create(
      expense({ amountMinor: 3000, currency: "JPY", accountId: JOINT, accountAmountMinor: 1870 }),
    );
    expect(entry).toMatchObject({
      amountMinor: 3000,
      currency: "JPY",
      accountAmountMinor: 1870,
      accountCurrency: "EUR",
      baseAmountMinor: 1870,
      fxState: "fixed",
      userId: ALICE,
      version: 1,
    });
    const stored = await row(entry.id);
    expect(stored).toMatchObject({
      orig_currency: "JPY",
      orig_amount_minor: 3000,
      account_amount_minor: 1870,
    });
  });

  it("values a foreign-account expense at the rate for its date", async () => {
    await seedRate(LAST_WEEK, "USD", 1.25);
    const entry = await create(
      expense({ date: LAST_WEEK, amountMinor: 10_000, currency: "USD", accountId: DOLLAR }),
    );
    expect(entry).toMatchObject({ accountAmountMinor: 10_000, baseAmountMinor: 8000, fxState: "fixed" });
    const stored = await row(entry.id);
    expect(stored).toMatchObject({ orig_currency: null, orig_amount_minor: null });
  });

  it("requires an account amount when the currency differs from the account's", async () => {
    const res = await post("/entries", expense({ currency: "JPY", amountMinor: 3000 }));
    expect(res.status).toBe(422);
    expect(await count()).toBe(0);
  });

  it("returns the existing row when the same create is posted twice", async () => {
    const body = expense();
    expect((await post("/entries", body)).status).toBe(201);
    const again = await post("/entries", body);
    expect(again.status).toBe(200);
    expect(((await again.json()) as Entry).id).toBe(body.id);
    expect(await count()).toBe(1);
  });

  it("rejects a reused id with a different amount and writes nothing", async () => {
    const body = expense();
    await create(body);
    const res = await post("/entries", { ...body, amountMinor: 9999 });
    expect(res.status).toBe(409);
    expect(await row(body.id)).toMatchObject({ account_amount_minor: 1250, version: 1 });
    expect(await count()).toBe(1);
  });

  it("rejects an archived account", async () => {
    const res = await post("/entries", expense({ accountId: OLD }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "validation_failed" });
    expect(await count()).toBe(0);
  });

  it("rejects an archived category", async () => {
    expect((await post("/entries", expense({ categoryId: OLD_CAT }))).status).toBe(422);
  });

  it("rejects an expense with an income category", async () => {
    const res = await post("/entries", expense({ categoryId: SALARY }));
    expect(res.status).toBe(422);
    expect(await count()).toBe(0);
  });

  it("rejects a malformed payload with field issues", async () => {
    const res = await post("/entries", expense({ date: "2026-13-40", notes: "x".repeat(501) }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: { path: (string | number)[] }[] };
    const paths = body.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["date", "notes"]));
  });

  it("records the partner chosen, defaulting to the signed-in one", async () => {
    const mine = await create(expense(), { as: BOB_TOKEN });
    expect(mine.userId).toBe(BOB);
    const theirs = await create(expense({ userId: ALICE }), { as: BOB_TOKEN });
    expect(theirs.userId).toBe(ALICE);
    expect((await post("/entries", expense({ userId: "someone-else" }))).status).toBe(422);
  });
});

describe("transfers", () => {
  it("moves money between currencies without touching the month's income and expense", async () => {
    await create(expense({ amountMinor: 2000 }));
    await create({ ...expense({ categoryId: SALARY, amountMinor: 300_000 }), kind: "income" });
    const before = await monthTotals(MONTH);

    const res = await post("/entries", {
      id: newId(),
      kind: "transfer",
      date: TODAY,
      accountId: JOINT,
      toAccountId: SAVINGS,
      amountMinor: 50_000,
      toAmountMinor: 372_500,
    });
    expect(res.status).toBe(201);
    const transfer = (await res.json()) as Entry;
    expect(transfer).toMatchObject({ accountCurrency: "EUR", toCurrency: "DKK", toAmountMinor: 372_500 });

    const balances = await accountBalances(db, [JOINT, SAVINGS]);
    expect(balances[JOINT]).toBe(100_000 - 2000 + 300_000 - 50_000);
    expect(balances[SAVINGS]).toBe(372_500);
    expect(await monthTotals(MONTH)).toEqual(before);
  });

  it("copies the amount to the destination when both accounts share a currency", async () => {
    const res = await post("/entries", {
      id: newId(),
      kind: "transfer",
      date: TODAY,
      accountId: JOINT,
      toAccountId: POCKET,
      amountMinor: 10_000,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Entry).toAmountMinor).toBe(10_000);
    expect((await accountBalances(db, [POCKET]))[POCKET]).toBe(10_000);
  });

  it("requires the arriving amount when the currencies differ", async () => {
    const res = await post("/entries", {
      id: newId(),
      kind: "transfer",
      date: TODAY,
      accountId: JOINT,
      toAccountId: SAVINGS,
      amountMinor: 10_000,
    });
    expect(res.status).toBe(422);
  });

  it("requires both amounts again when an edit changes an account's currency", async () => {
    const t = await create({
      id: newId(),
      kind: "transfer",
      date: TODAY,
      accountId: JOINT,
      toAccountId: POCKET,
      amountMinor: 10_000,
    });
    const missing = await patch(`/entries/${t.id}`, { version: 1, toAccountId: SAVINGS });
    expect(missing.status).toBe(422);
    const ok = await patch(`/entries/${t.id}`, {
      version: 1,
      toAccountId: SAVINGS,
      amountMinor: 10_000,
      toAmountMinor: 74_500,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ toAccountId: SAVINGS, toAmountMinor: 74_500, version: 2 });
  });
});

describe("account balances", () => {
  it("adds opening, income, transfers in and adjustments, and subtracts expenses and transfers out", async () => {
    await create(expense({ amountMinor: 3000, currency: "JPY", accountAmountMinor: 1870 }));
    await create({ ...expense({ categoryId: SALARY, amountMinor: 50_000 }), kind: "income" });
    await create({
      id: newId(),
      kind: "transfer",
      date: TODAY,
      accountId: SAVINGS,
      toAccountId: JOINT,
      amountMinor: 74_600,
      toAmountMinor: 10_000,
    });
    await create({
      id: newId(),
      kind: "transfer",
      date: TODAY,
      accountId: JOINT,
      toAccountId: POCKET,
      amountMinor: 2500,
    });
    await insertAdjustment(newId());
    expect(await accountBalances(db)).toEqual({
      [JOINT]: 100_000 - 1870 + 50_000 + 10_000 - 2500 - 500,
      [SAVINGS]: -74_600,
      [POCKET]: 2500,
      [DOLLAR]: 0,
      [OLD]: 0,
    });
  });
});

describe("editing entries", () => {
  it("keeps a stored base value after newer rates arrive", async () => {
    await seedRate("2026-03-10", "USD", 1 / 0.92);
    const entry = await create(
      expense({ date: "2026-03-10", amountMinor: 10_000, currency: "USD", accountId: DOLLAR }),
    );
    expect(entry.baseAmountMinor).toBe(9200);

    await seedRate("2026-03-11", "USD", 1 / 0.85);
    await seedRate(LAST_WEEK, "USD", 1 / 0.85);
    const res = await patch(`/entries/${entry.id}`, { version: 1, notes: "Hotel" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ baseAmountMinor: 9200, fxState: "fixed", notes: "Hotel" });
    expect(((await (await get(`/entries/${entry.id}`)).json()) as Entry).baseAmountMinor).toBe(9200);
  });

  it("moves an entry from fixed to provisional when its date moves past the newest rate", async () => {
    await seedRate(LAST_WEEK, "USD", 1.25);
    const entry = await create(
      expense({ date: LAST_WEEK, amountMinor: 10_000, currency: "USD", accountId: DOLLAR }),
    );
    expect(entry.fxState).toBe("fixed");
    const res = await patch(`/entries/${entry.id}`, { version: 1, date: NEXT_WEEK });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      date: NEXT_WEEK,
      fxState: "provisional",
      baseAmountMinor: 8000,
    });
  });

  it("rejects moving to an account in another currency without a new account amount", async () => {
    const entry = await create(expense());
    const res = await patch(`/entries/${entry.id}`, { version: 1, accountId: SAVINGS });
    expect(res.status).toBe(422);
    expect(await row(entry.id)).toMatchObject({ account_id: JOINT, version: 1 });

    const ok = await patch(`/entries/${entry.id}`, {
      version: 1,
      accountId: SAVINGS,
      accountAmountMinor: 9300,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      amountMinor: 1250,
      currency: "EUR",
      accountAmountMinor: 9300,
      accountCurrency: "DKK",
    });
  });

  it("rejects a stale version with the current row", async () => {
    const entry = await create(expense());
    expect((await patch(`/entries/${entry.id}`, { version: 1, amountMinor: 1300 })).status).toBe(200);
    const res = await patch(`/entries/${entry.id}`, { version: 1, amountMinor: 1400 }, { as: BOB_TOKEN });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string; current: Entry };
    expect(body.error).toBe("conflict");
    expect(body.message).toBe("This changed since you opened it — reload");
    expect(body.current).toMatchObject({ id: entry.id, amountMinor: 1300, version: 2 });
  });

  it("rejects a change of kind", async () => {
    const entry = await create(expense());
    const res = await patch(`/entries/${entry.id}`, { version: 1, kind: "income", categoryId: SALARY });
    expect(res.status).toBe(422);
    expect(await row(entry.id)).toMatchObject({ kind: "expense", version: 1 });
  });

  it("rejects moving an entry into an archived account", async () => {
    const entry = await create(expense());
    expect((await patch(`/entries/${entry.id}`, { version: 1, accountId: OLD })).status).toBe(422);
  });

  it("rejects editing an adjustment", async () => {
    const id = newId();
    await insertAdjustment(id);
    expect((await patch(`/entries/${id}`, { version: 1, notes: "x" })).status).toBe(422);
  });
});

describe("deleting entries", () => {
  it("returns 204 when deleting an entry that is already gone", async () => {
    const entry = await create(expense());
    expect((await del(`/entries/${entry.id}?version=1`)).status).toBe(204);
    expect((await del(`/entries/${entry.id}?version=1`)).status).toBe(204);
    expect(await count()).toBe(0);
  });

  it("rejects a stale version and keeps the row", async () => {
    const entry = await create(expense());
    await patch(`/entries/${entry.id}`, { version: 1, notes: "edited" });
    const res = await del(`/entries/${entry.id}?version=1`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", current: { version: 2 } });
    expect(await row(entry.id)).not.toBeNull();
  });

  it("rejects deleting an adjustment", async () => {
    const id = newId();
    await insertAdjustment(id);
    expect((await del(`/entries/${id}?version=1`)).status).toBe(422);
    expect(await row(id)).not.toBeNull();
  });

  it("restores a deleted entry under the same id when undone", async () => {
    const body = expense({ projectId: PROJECT, notes: "Dinner", userId: BOB });
    const entry = await create(body);
    expect((await del(`/entries/${entry.id}?version=1`)).status).toBe(204);
    const undo = await post("/entries", body);
    expect(undo.status).toBe(201);
    expect(await undo.json()).toMatchObject({
      id: entry.id,
      projectId: PROJECT,
      notes: "Dinner",
      userId: BOB,
      amountMinor: 1250,
    });
  });
});

describe("listing entries", () => {
  it("filters by partner", async () => {
    const a = await create(expense());
    const b = await create(expense(), { as: BOB_TOKEN });
    const res = await get(`/entries?month=${MONTH}&userId=${BOB}`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Entry[];
    expect(list.map((e) => e.id)).toEqual([b.id]);
    expect(list.map((e) => e.id)).not.toContain(a.id);
  });

  it("lists a month newest first with both amounts, including transfers into a filtered account", async () => {
    const older = await create(expense({ date: `${MONTH}-01` }));
    const foreign = await create(expense({ amountMinor: 3000, currency: "JPY", accountAmountMinor: 1870 }));
    const incoming = await create({
      id: newId(),
      kind: "transfer",
      date: TODAY,
      accountId: SAVINGS,
      toAccountId: POCKET,
      amountMinor: 7460,
      toAmountMinor: 1000,
    });
    await create(expense({ date: "2020-01-15" }));

    const all = (await (await get(`/entries?month=${MONTH}`)).json()) as Entry[];
    expect(all.map((e) => e.id)).toEqual([incoming.id, foreign.id, older.id]);
    expect(all.find((e) => e.id === foreign.id)).toMatchObject({
      amountMinor: 3000,
      currency: "JPY",
      accountAmountMinor: 1870,
      accountCurrency: "EUR",
    });

    const pocket = (await (await get(`/entries?month=${MONTH}&accountId=${POCKET}`)).json()) as Entry[];
    expect(pocket.map((e) => e.id)).toEqual([incoming.id]);
  });

  it("rejects a malformed month", async () => {
    expect((await get("/entries?month=2026-1")).status).toBe(422);
  });

  it("requires a session", async () => {
    const res = await app.request(`${ORIGIN}/api/entries`, {}, env);
    expect(res.status).toBe(401);
  });
});

describe("drawer defaults", () => {
  it("suggests the partner's last non-archived account per kind and top categories", async () => {
    await create(expense({ categoryId: FOOD }));
    await create(expense({ categoryId: FOOD }));
    await create(expense({ categoryId: FOOD }));
    await create(expense({ categoryId: GROCERIES, date: addDays(TODAY, -120) }));
    await create(expense({ categoryId: GROCERIES, date: addDays(TODAY, -120) }));
    await create({ ...expense({ categoryId: SALARY, accountId: JOINT }), kind: "income" });
    await create(expense({ accountId: POCKET }));
    await db.prepare("UPDATE accounts SET archived_at = NULL WHERE id = ?").bind(OLD).run();
    await create(expense({ accountId: OLD }));
    await db.prepare("UPDATE accounts SET archived_at = ? WHERE id = ?").bind(NOW, OLD).run();
    await create(expense({ accountId: DOLLAR, currency: "USD" }), { as: BOB_TOKEN });
    await create(expense({ accountId: DOLLAR, currency: "USD" }), { as: BOB_TOKEN });

    const res = await get("/entries/defaults");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lastAccountByKind: Record<string, string | undefined>;
      topCategories: { expense: string[]; income: string[] };
    };
    expect(body.lastAccountByKind.expense).toBe(POCKET);
    expect(body.lastAccountByKind.income).toBe(JOINT);
    expect(body.lastAccountByKind.transfer).toBeUndefined();
    expect(body.topCategories.expense).toEqual([FOOD, GROCERIES]);
    expect(body.topCategories.income).toEqual([SALARY]);
  });
});
