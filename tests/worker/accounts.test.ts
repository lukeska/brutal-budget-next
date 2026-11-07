import { env } from "cloudflare:workers";
import type { Account, HistoryPage, Reconciliation } from "@shared/schemas/account";
import type { Entry } from "@shared/schemas/entry";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csrfGuard, requireSession } from "../../src/worker/auth/middleware";
import { sha256Hex } from "../../src/worker/lib/crypto";
import type { AppEnv } from "../../src/worker/lib/env";
import { HttpError } from "../../src/worker/lib/errors";
import { newId } from "../../src/worker/lib/ids";
import { accountsRoutes } from "../../src/worker/routes/accounts";
import { entriesRoutes } from "../../src/worker/routes/entries";
import { balanceAsOf } from "../../src/worker/services/balances";

const db = env.DB;
const ORIGIN = "https://app.test";
const NOW = new Date().toISOString();

const ALICE = "01900000-0000-7000-8000-00000000000a";
const BOB = "01900000-0000-7000-8000-00000000000b";
const ALICE_TOKEN = "alice-session-token";
const BOB_TOKEN = "bob-session-token";

const JOINT = "acc-joint-eur";
const SAVINGS = "acc-savings-dkk";
const POCKET = "acc-pocket-eur";
const OLD = "acc-old-eur";
const GROCERIES = "cat-groceries";
const SALARY = "cat-salary";

/** Mirrors how `src/worker/app.ts` mounts the data routers. */
function makeApp() {
  const app = new Hono<AppEnv>().basePath("/api");
  app.use("*", csrfGuard);
  for (const prefix of ["/entries", "/accounts", "/reconciliations"]) {
    app.use(prefix, requireSession);
    app.use(`${prefix}/*`, requireSession);
  }
  app.route("/", entriesRoutes);
  app.route("/", accountsRoutes);
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

async function seed({ jointOpening = 250_000 } = {}) {
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
    "INSERT INTO categories (id, type, parent_id, name, icon, colour, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'IconTag', ?5, ?6, ?6)",
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
    account.bind(JOINT, "Joint", "EUR", jointOpening, null, NOW),
    account.bind(SAVINGS, "Savings", "DKK", 0, null, NOW),
    account.bind(POCKET, "Pocket", "EUR", 0, null, NOW),
    account.bind(OLD, "Closed", "EUR", 0, NOW, NOW),
    category.bind("cat-food", "expense", null, "Food", "#e8590c", NOW),
    category.bind(GROCERIES, "expense", "cat-food", "Groceries", null, NOW),
    category.bind(SALARY, "income", null, "Salary", "#2f9e44", NOW),
  ]);
}

async function createEntry(body: Record<string, unknown>): Promise<Entry> {
  const res = await post("/entries", { id: newId(), ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json();
}
const expense = (date: string, amountMinor: number, accountId = JOINT) =>
  createEntry({ kind: "expense", date, amountMinor, currency: "EUR", accountId, categoryId: GROCERIES });
const income = (date: string, amountMinor: number, accountId = JOINT) =>
  createEntry({ kind: "income", date, amountMinor, currency: "EUR", accountId, categoryId: SALARY });
const transfer = (date: string, from: string, to: string, amountMinor: number, toAmountMinor?: number) =>
  createEntry({ kind: "transfer", date, accountId: from, toAccountId: to, amountMinor, toAmountMinor });

async function accounts(): Promise<Account[]> {
  const res = await get("/accounts");
  expect(res.status).toBe(200);
  return res.json();
}
async function account(id: string): Promise<Account> {
  const found = (await accounts()).find((a) => a.id === id);
  if (!found) throw new Error(`account ${id} missing`);
  return found;
}
const reconcile = (accountId: string, body: Record<string, unknown>, opts?: As) =>
  post(`/accounts/${accountId}/reconciliations`, { id: newId(), ...body }, opts);

async function adjustmentCount(): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM entries WHERE kind = 'adjustment'")
    .first<{ n: number }>();
  return r?.n ?? 0;
}
async function monthExpenses(month: string): Promise<number> {
  const r = await db
    .prepare(
      "SELECT COALESCE(SUM(base_amount_minor), 0) AS total FROM entries WHERE kind = 'expense' AND date LIKE ?1 || '-%'",
    )
    .bind(month)
    .first<{ total: number }>();
  return r?.total ?? 0;
}

beforeEach(async () => {
  await seed();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("balances", () => {
  it("match a hand-computed fixture that mixes every entry kind", async () => {
    // Joint: 2,500.00 opening
    await income("2026-10-01", 300_000); // +3,000.00
    await expense("2026-10-03", 12_345); // −123.45
    await transfer("2026-10-05", JOINT, SAVINGS, 50_000, 372_500); // −500.00, savings +3,725 kr
    await transfer("2026-10-07", POCKET, JOINT, 2_000); // +20.00, pocket −20.00
    await expense("2026-11-02", 1_000); // −10.00, after the reconciliation date
    // computed as of 31 Oct: 250,000 + 300,000 − 12,345 − 50,000 + 2,000 = 489,655
    const booked = await reconcile(JOINT, {
      date: "2026-10-31",
      bankBalanceMinor: 489_000,
      shownComputedMinor: 489_655,
    });
    expect(booked.status).toBe(201); // adjustment −6.55

    const list = await accounts();
    const byId = Object.fromEntries(list.map((a) => [a.id, a]));
    expect(byId[JOINT]?.balanceMinor).toBe(489_000 - 1_000);
    expect(byId[SAVINGS]?.balanceMinor).toBe(372_500);
    expect(byId[POCKET]?.balanceMinor).toBe(-2_000);
    expect(byId[OLD]?.balanceMinor).toBe(0);
    expect(byId[JOINT]).toMatchObject({ currency: "EUR", hasEntries: true, changedSinceReconcile: null });
    expect(byId[OLD]).toMatchObject({ hasEntries: false });
    expect(byId[OLD]?.archivedAt).not.toBeNull();

    expect(await balanceAsOf(db, JOINT, "2026-10-04")).toBe(250_000 + 300_000 - 12_345);
    const at = await get(`/accounts/${JOINT}/balance?date=2026-10-06`);
    expect(await at.json()).toEqual({ date: "2026-10-06", balanceMinor: 487_655 });
  });

  it("history lists entries from and into the account, newest first, with a running balance", async () => {
    await income("2026-10-01", 300_000);
    await transfer("2026-10-05", JOINT, SAVINGS, 50_000, 372_500);
    await transfer("2026-10-07", POCKET, JOINT, 2_000);
    await expense("2026-10-09", 1_000);

    const res = await get(`/accounts/${JOINT}/history`);
    const page: HistoryPage = await res.json();
    expect(page.nextBefore).toBeNull();
    expect(page.rows.map((r) => [r.kind, r.deltaMinor, r.balanceMinor, r.counterpartAccountId])).toEqual([
      ["expense", -1_000, 501_000, null],
      ["transfer", 2_000, 502_000, POCKET],
      ["transfer", -50_000, 500_000, SAVINGS],
      ["income", 300_000, 550_000, null],
    ]);

    const savings: HistoryPage = await (await get(`/accounts/${SAVINGS}/history`)).json();
    expect(savings.rows.map((r) => [r.deltaMinor, r.balanceMinor, r.currency])).toEqual([
      [372_500, 372_500, "DKK"],
    ]);

    const first: HistoryPage = await (await get(`/accounts/${JOINT}/history?limit=3`)).json();
    expect(first.rows).toHaveLength(3);
    expect(first.nextBefore).toBe(first.rows[2]?.id);
    const rest: HistoryPage = await (
      await get(`/accounts/${JOINT}/history?limit=3&before=${first.nextBefore}`)
    ).json();
    expect(rest.rows.map((r) => r.balanceMinor)).toEqual([550_000]);
    expect(rest.nextBefore).toBeNull();
  });
});

describe("reconciling", () => {
  /** Joint shows €2,410.00 after a €90 expense on 5 October. */
  async function jointAt2410() {
    await expense("2026-10-05", 9_000);
    expect((await account(JOINT)).balanceMinor).toBe(241_000);
  }

  it("booking a €25 gap brings the balance to the bank's, shows an adjustment, and leaves month expenses alone", async () => {
    await jointAt2410();
    const before = await monthExpenses("2026-10");

    const res = await reconcile(JOINT, {
      date: "2026-10-31",
      bankBalanceMinor: 238_500,
      shownComputedMinor: 241_000,
    });
    expect(res.status).toBe(201);
    const rec: Reconciliation = await res.json();
    expect(rec).toMatchObject({ bankBalanceMinor: 238_500, computedMinor: 241_000, adjustmentMinor: -2_500 });
    expect(rec.adjustmentEntryId).not.toBeNull();

    expect((await account(JOINT)).balanceMinor).toBe(238_500);
    const history: HistoryPage = await (await get(`/accounts/${JOINT}/history`)).json();
    expect(history.rows[0]).toMatchObject({ kind: "adjustment", deltaMinor: -2_500, balanceMinor: 238_500 });
    expect(await monthExpenses("2026-10")).toBe(before);
    const stored = await db
      .prepare("SELECT base_amount_minor, category_id FROM entries WHERE id = ?")
      .bind(rec.adjustmentEntryId)
      .first();
    expect(stored).toEqual({ base_amount_minor: 0, category_id: null });

    const list: Reconciliation[] = await (await get(`/accounts/${JOINT}/reconciliations`)).json();
    expect(list.map((r) => r.id)).toEqual([rec.id]);
  });

  it("deleting a €12 entry dated before the reconciliation shows the account changed by +€12 since then", async () => {
    await expense("2026-10-05", 7_800);
    const coffee = await expense("2026-10-20", 1_200);
    expect((await account(JOINT)).balanceMinor).toBe(241_000);
    expect(
      (await reconcile(JOINT, { date: "2026-10-31", bankBalanceMinor: 238_500, shownComputedMinor: 241_000 }))
        .status,
    ).toBe(201);
    await expense("2026-11-02", 500); // after the reconciliation: not a change to it
    expect((await account(JOINT)).changedSinceReconcile).toBeNull();

    expect((await del(`/entries/${coffee.id}?version=${coffee.version}`)).status).toBe(204);
    expect((await account(JOINT)).changedSinceReconcile).toEqual({
      date: "2026-10-31",
      bankBalanceMinor: 238_500,
      deltaMinor: 1_200,
    });
  });

  it("a reconciliation with no gap stores the record and books no adjustment", async () => {
    await jointAt2410();
    const res = await reconcile(JOINT, {
      date: "2026-10-31",
      bankBalanceMinor: 241_000,
      shownComputedMinor: 241_000,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ adjustmentEntryId: null, adjustmentMinor: null });
    expect(await adjustmentCount()).toBe(0);
    expect((await account(JOINT)).balanceMinor).toBe(241_000);
  });

  it("a zero-gap reconciliation is refused when the balance moved since it was shown", async () => {
    await jointAt2410();
    await expense("2026-10-10", 500);
    const res = await reconcile(JOINT, {
      date: "2026-10-31",
      bankBalanceMinor: 241_000,
      shownComputedMinor: 241_000,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", computedMinor: 240_500 });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM reconciliations").first<{ n: number }>())?.n).toBe(0);
  });

  it("two partners booking the same gap at once produce one adjustment; the second gets 409", async () => {
    await jointAt2410();
    const body = { date: "2026-10-31", bankBalanceMinor: 238_500, shownComputedMinor: 241_000 };
    const [a, b] = await Promise.all([reconcile(JOINT, body), reconcile(JOINT, body, { as: BOB_TOKEN })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(await loser.json()).toMatchObject({ error: "conflict", computedMinor: 238_500 });
    expect(await adjustmentCount()).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM reconciliations").first<{ n: number }>())?.n).toBe(1);
    expect((await account(JOINT)).balanceMinor).toBe(238_500);
  });

  it("an entry added after the gap was shown makes booking return 409 with the new computed balance", async () => {
    await jointAt2410();
    await expense("2026-10-10", 500);
    const res = await reconcile(JOINT, {
      date: "2026-10-31",
      bankBalanceMinor: 238_500,
      shownComputedMinor: 241_000,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ computedMinor: 240_500 });
    expect(await adjustmentCount()).toBe(0);

    const retry = await reconcile(JOINT, {
      date: "2026-10-31",
      bankBalanceMinor: 238_500,
      shownComputedMinor: 240_500,
    });
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ adjustmentMinor: -2_000 });
  });

  it("posting the same reconciliation twice returns the stored one", async () => {
    await jointAt2410();
    const body = { id: newId(), date: "2026-10-31", bankBalanceMinor: 238_500, shownComputedMinor: 241_000 };
    expect((await post(`/accounts/${JOINT}/reconciliations`, body)).status).toBe(201);
    const again = await post(`/accounts/${JOINT}/reconciliations`, body);
    expect(again.status).toBe(200);
    expect(await adjustmentCount()).toBe(1);
  });

  it("deleting a reconciliation removes its adjustment and the balance returns to the computed value", async () => {
    await jointAt2410();
    const rec: Reconciliation = await (
      await reconcile(JOINT, { date: "2026-10-31", bankBalanceMinor: 238_500, shownComputedMinor: 241_000 })
    ).json();
    expect((await del(`/reconciliations/${rec.id}`)).status).toBe(204);
    expect(await adjustmentCount()).toBe(0);
    expect((await account(JOINT)).balanceMinor).toBe(241_000);
    expect(await (await get(`/accounts/${JOINT}/reconciliations`)).json()).toEqual([]);
  });
});

describe("managing accounts", () => {
  it("creates an account with the client's id and lists it with its opening balance", async () => {
    const id = newId();
    const res = await post("/accounts", { id, name: " Cash ", currency: "DKK", openingMinor: 50_000 });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id, name: "Cash", balanceMinor: 50_000, version: 1 });
    expect((await account(id)).currency).toBe("DKK");
  });

  it("refuses a currency change once the account has entries, but allows changing its opening balance", async () => {
    await expense("2026-10-05", 1_000);
    const current = await account(JOINT);
    const res = await patch(`/accounts/${JOINT}`, { version: current.version, currency: "USD" });
    expect(res.status).toBe(422);
    expect((await account(JOINT)).currency).toBe("EUR");

    const ok = await patch(`/accounts/${JOINT}`, { version: current.version, openingMinor: 300_000 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ openingMinor: 300_000, balanceMinor: 299_000, version: 2 });
  });

  it("allows a currency change while no entry uses the account", async () => {
    const res = await patch(`/accounts/${POCKET}`, { version: 1, currency: "USD" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ currency: "USD" });
  });

  it("refuses a currency change for an account used only as a transfer destination", async () => {
    await transfer("2026-10-05", JOINT, POCKET, 1_000);
    const res = await patch(`/accounts/${POCKET}`, { version: 1, currency: "USD" });
    expect(res.status).toBe(422);
    expect((await account(POCKET)).currency).toBe("EUR");
  });

  it("a currency change racing the first entry never leaves the entry in another currency than its account's", async () => {
    // The change is one conditional statement, so whichever lands second sees the other.
    const [entryRes, patchRes] = await Promise.all([
      post("/entries", {
        id: newId(),
        kind: "expense",
        date: "2026-10-05",
        amountMinor: 1_000,
        currency: "EUR",
        accountId: POCKET,
        categoryId: GROCERIES,
      }),
      patch(`/accounts/${POCKET}`, { version: 1, currency: "USD" }),
    ]);
    const pocket = await account(POCKET);
    const entries = await db
      .prepare("SELECT COUNT(*) AS n FROM entries WHERE account_id = ?")
      .bind(POCKET)
      .first<{ n: number }>();
    if (patchRes.status === 200) {
      expect(entries?.n).toBe(0);
      expect(pocket.currency).toBe("USD");
    } else {
      expect(patchRes.status).toBe(422);
      expect(entryRes.status).toBe(201);
      expect(pocket.currency).toBe("EUR");
    }
  });

  it("a stale version is a conflict", async () => {
    await patch(`/accounts/${POCKET}`, { version: 1, name: "Wallet" });
    const res = await patch(`/accounts/${POCKET}`, { version: 1, name: "Purse" });
    expect(res.status).toBe(409);
    expect((await account(POCKET)).name).toBe("Wallet");
  });

  it("archives an account with a non-zero balance, but never the only active account", async () => {
    await transfer("2026-10-05", JOINT, POCKET, 1_000);
    expect((await patch(`/accounts/${SAVINGS}`, { version: 1, archived: true })).status).toBe(200);
    const pocket = await patch(`/accounts/${POCKET}`, { version: 1, archived: true });
    expect(pocket.status).toBe(200);
    expect(((await pocket.json()) as Account).archivedAt).not.toBeNull();

    const joint = await patch(`/accounts/${JOINT}`, { version: 1, archived: true });
    expect(joint.status).toBe(422);
    expect((await account(JOINT)).archivedAt).toBeNull();

    const back = await patch(`/accounts/${POCKET}`, { version: 2, archived: false });
    expect(await back.json()).toMatchObject({ archivedAt: null });
  });

  it("refuses to delete an account that entries refer to, and deletes an unused one", async () => {
    await transfer("2026-10-05", JOINT, POCKET, 1_000);
    const res = await del(`/accounts/${POCKET}?version=1`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "in_use" });
    expect((await accounts()).map((a) => a.id)).toContain(POCKET);

    expect((await del(`/accounts/${SAVINGS}?version=1`)).status).toBe(204);
    expect((await accounts()).map((a) => a.id)).not.toContain(SAVINGS);
  });
});
