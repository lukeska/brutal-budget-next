import { env } from "cloudflare:workers";
import { COLOURS } from "@shared/icons";
import type {
  CsvRow,
  ImportBatch,
  ImportCheckResponse,
  ImportRowsResponse,
  ImportUndoPreview,
} from "@shared/schemas/csv";
import type { Entry } from "@shared/schemas/entry";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csrfGuard, requireSession } from "../../src/worker/auth/middleware";
import { addDays, eachDay } from "../../src/worker/fx/today";
import { sha256Hex } from "../../src/worker/lib/crypto";
import type { AppEnv } from "../../src/worker/lib/env";
import { HttpError } from "../../src/worker/lib/errors";
import { entriesRoutes } from "../../src/worker/routes/entries";
import { importRoutes } from "../../src/worker/routes/import";
import { ratesRoutes } from "../../src/worker/routes/rates";

const db = env.DB;
const ORIGIN = "https://app.test";
const NOW = new Date().toISOString();

const ALICE = "01900000-0000-7000-8000-00000000000a";
const BOB = "01900000-0000-7000-8000-00000000000b";
const TOKEN = "alice-session-token";
const JOINT = "acc-joint-eur";
const DOLLAR = "acc-dollar-usd";
const FOOD = "cat-food";
const FILE_SHA = "a".repeat(64);

function makeApp() {
  const app = new Hono<AppEnv>().basePath("/api");
  app.use("*", csrfGuard);
  app.use("/rates", requireSession);
  app.use("/rates/*", requireSession);
  app.route("/", ratesRoutes);
  app.use("/import", requireSession);
  app.use("/import/*", requireSession);
  app.route("/", importRoutes);
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

function call(method: string, path: string, body?: unknown) {
  return app.request(
    `${ORIGIN}/api${path}`,
    {
      method,
      headers: { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-bb_session=${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function seed() {
  await db.batch(
    [
      "DELETE FROM reconciliations",
      "DELETE FROM entries",
      "DELETE FROM import_batches",
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
    account.bind(DOLLAR, "Dollar card", "USD", NOW),
    db
      .prepare(
        "INSERT INTO categories (id, type, parent_id, name, icon, colour, created_at, updated_at) VALUES (?1, 'expense', NULL, 'Food', 'IconCoffee', '#ef4444', ?2, ?2)",
      )
      .bind(FOOD, NOW),
  ]);
}

let nextRow = 2;
function row(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    rowNumber: nextRow++,
    occurrence: 0,
    date: "2026-10-01",
    type: "expense",
    amountMinor: 1250,
    currency: "EUR",
    accountId: JOINT,
    categoryPath: { parent: "Food" },
    userId: ALICE,
    ...overrides,
  };
}

/** Rows with distinct amounts so each has its own fingerprint. */
function distinctRows(n: number, overrides: Partial<CsvRow> = {}): CsvRow[] {
  return Array.from({ length: n }, (_, i) => row({ amountMinor: 100 + i, ...overrides }));
}

const check = async (rows: CsvRow[]) =>
  json<ImportCheckResponse>(await call("POST", "/import/check", { rows }));

async function createBatch(rowCount = 1): Promise<ImportBatch> {
  return json<ImportBatch>(
    await call("POST", "/import/batches", { fileName: "history.csv", fileSha256: FILE_SHA, rowCount }),
    201,
  );
}

const commit = async (batchId: string, rows: CsvRow[]) =>
  json<ImportRowsResponse>(await call("POST", `/import/batches/${batchId}/rows`, { rows }));

async function countEntries(where = "1 = 1"): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE ${where}`).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Stores a rate for every day in [from, to] (units per 1 EUR). */
async function seedRates(from: string, to: string, rates: Record<string, number>) {
  const stmt = db.prepare(
    "INSERT INTO fx_rates (date, currency, rate_scaled, source_date) VALUES (?1, ?2, ?3, ?1)",
  );
  await db.batch(
    eachDay(from, to).flatMap((d) =>
      Object.entries(rates).map(([c, r]) => stmt.bind(d, c, Math.round(r * 1e10))),
    ),
  );
}

/** Reads the only entry through the API, then deletes it the way the month view does. */
async function deleteOnlyEntry(): Promise<Entry> {
  const only = await db.prepare("SELECT id FROM entries").first<{ id: string }>();
  const entry = await json<Entry>(await call("GET", `/entries/${only?.id}`));
  expect((await call("DELETE", `/entries/${entry.id}?version=${entry.version}`)).status).toBe(204);
  return entry;
}

/** What the client's Undo posts (see restorePayload). */
function restoreBody(entry: Entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    date: entry.date,
    accountId: entry.accountId,
    userId: entry.userId,
    notes: entry.notes,
    amountMinor: entry.amountMinor,
    currency: entry.currency,
    categoryId: entry.categoryId,
    projectId: entry.projectId,
    restore: { fingerprint: entry.fingerprint, importBatchId: entry.importBatchId },
  };
}

beforeEach(async () => {
  await seed();
  nextRow = 2;
});
afterEach(() => vi.restoreAllMocks());

describe("duplicate check", () => {
  it("flags every row of an already imported file, and committing it again adds nothing", async () => {
    const rows = distinctRows(5);
    const before = await check(rows);
    expect(before.results.map((r) => r.exists)).toEqual([false, false, false, false, false]);
    expect(before.results.every((r) => r.fingerprint.startsWith("v1:"))).toBe(true);
    expect(before.results.map((r) => r.rowNumber)).toEqual(rows.map((r) => r.rowNumber));

    const batch = await createBatch(5);
    expect(await commit(batch.id, rows)).toEqual({ inserted: 5, skipped: 0, failed: [] });

    const after = await check(rows);
    expect(after.results.every((r) => r.exists)).toBe(true);
    const again = await createBatch(5);
    expect(await commit(again.id, rows)).toEqual({ inserted: 0, skipped: 5, failed: [] });
    expect(await countEntries()).toBe(5);
  });

  it("imports two identical rows as two entries, and a re-upload matches both", async () => {
    const rows = [row({ notes: "Coffee" }), row({ notes: "Coffee", occurrence: 1 })];
    const batch = await createBatch(2);
    expect((await commit(batch.id, rows)).inserted).toBe(2);
    expect(await countEntries()).toBe(2);
    expect((await check(rows)).results.map((r) => r.exists)).toEqual([true, true]);
  });

  it("still matches with extra whitespace, other casing and rows in a different order", async () => {
    const original = [
      row({ notes: "Coffee with Bob", categoryPath: { parent: "Food" }, accountId: JOINT }),
      row({ notes: "Bus", accountId: DOLLAR, currency: "USD" }),
    ];
    const batch = await createBatch(2);
    await commit(batch.id, original);

    const reuploaded = [
      row({ notes: "Bus  ", accountId: DOLLAR, currency: "USD" }),
      row({ notes: "  coffee   with bob ", categoryPath: { parent: " food" }, accountId: JOINT }),
    ];
    expect((await check(reuploaded)).results.map((r) => r.exists)).toEqual([true, true]);
  });

  it("checks a 250-row chunk, and a row's fingerprint doesn't depend on its chunk", async () => {
    const rows = distinctRows(250);
    const { results } = await check(rows);
    expect(results).toHaveLength(250);
    const alone = await check([rows[137] as CsvRow]);
    expect(alone.results[0]?.fingerprint).toBe(results[137]?.fingerprint);
  });

  it("refuses more than 250 rows in one request", async () => {
    const res = await call("POST", "/import/check", { rows: distinctRows(251) });
    expect(res.status).toBe(422);
  });
});

describe("commit", () => {
  it("creates a new category and subcategory once even when 40 rows across chunks name them", async () => {
    const rows = distinctRows(40, {
      categoryPath: { parent: "Hobbies", child: "Climbing" },
      icon: "IconBike",
    });
    const batch = await createBatch(40);
    await commit(batch.id, rows.slice(0, 20));
    await commit(
      batch.id,
      rows.slice(20).map((r) => ({ ...r, categoryPath: { parent: "hobbies", child: "CLIMBING" } })),
    );

    const { results } = await db
      .prepare(
        "SELECT id, parent_id, name, icon, colour FROM categories WHERE name IN ('Hobbies', 'Climbing')",
      )
      .all<{ id: string; parent_id: string | null; name: string; icon: string; colour: string | null }>();
    expect(results).toHaveLength(2);
    const parent = results.find((c) => c.name === "Hobbies");
    const child = results.find((c) => c.name === "Climbing");
    expect(parent?.icon).toBe("IconBike");
    expect(COLOURS).toContain(parent?.colour);
    expect(child?.parent_id).toBe(parent?.id);
    expect(child?.colour).toBeNull();
    expect(await countEntries(`category_id = '${child?.id}'`)).toBe(40);
  });

  it("gives a new category the fallback icon when the file's icon is unknown, and creates projects once", async () => {
    const rows = [
      row({ categoryPath: { parent: "Pets" }, icon: "IconDoesNotExist", projectName: "Japan trip" }),
      row({ categoryPath: { parent: "Pets" }, amountMinor: 99, projectName: "japan trip" }),
      row({ type: "income", categoryPath: { parent: "Food" }, amountMinor: 50 }),
    ];
    const batch = await createBatch(3);
    expect((await commit(batch.id, rows)).inserted).toBe(3);
    const pets = await db
      .prepare("SELECT icon FROM categories WHERE name = 'Pets'")
      .first<{ icon: string }>();
    expect(pets?.icon).toBe("IconTag");
    const projects = await db
      .prepare("SELECT name, colour FROM projects")
      .all<{ name: string; colour: string }>();
    expect(projects.results).toHaveLength(1);
    expect(COLOURS).toContain(projects.results[0]?.colour);
    expect(await countEntries("project_id IS NOT NULL")).toBe(2);
    // Income rows never land in the expense category of the same name.
    const food = await db
      .prepare("SELECT COUNT(*) AS n FROM categories WHERE name = 'Food'")
      .first<{ n: number }>();
    expect(food?.n).toBe(2);
  });

  it("stores the batch id, fingerprint, partner and notes on each entry", async () => {
    const batch = await createBatch(1);
    await commit(batch.id, [row({ userId: BOB, notes: "  Lunch ", date: "2026-09-30" })]);
    const entry = await db
      .prepare(
        "SELECT import_batch_id, fingerprint, user_id, notes, date, fx_state, base_amount_minor FROM entries",
      )
      .first<Record<string, unknown>>();
    expect(entry).toMatchObject({
      import_batch_id: batch.id,
      user_id: BOB,
      notes: "Lunch",
      date: "2026-09-30",
      fx_state: "fixed",
      base_amount_minor: 1250,
    });
    expect(String(entry?.fingerprint)).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("ends with no duplicates when a chunk is sent again after a failure", async () => {
    const rows = distinctRows(30);
    const batch = await createBatch(30);
    await commit(batch.id, rows.slice(0, 15));
    // The second chunk's response was lost; the client retries both.
    await commit(batch.id, rows.slice(15));
    expect(await commit(batch.id, rows.slice(15))).toEqual({ inserted: 0, skipped: 15, failed: [] });
    expect(await countEntries()).toBe(30);

    const res = await call("DELETE", `/import/batches/${batch.id}?confirm=1`);
    expect(res.status).toBe(204);
    expect(await countEntries()).toBe(0);
  });

  it("restores a deleted imported entry with its fingerprint and batch, so re-check and undo still see it", async () => {
    const rows = [row()];
    const batch = await createBatch(1);
    await commit(batch.id, rows);
    const entry = await deleteOnlyEntry();
    expect(entry.fingerprint).toMatch(/^v1:/);
    expect((await check(rows)).results[0]?.exists).toBe(false);

    await json<Entry>(await call("POST", "/entries", restoreBody(entry)), 201);
    const stored = await db
      .prepare("SELECT fingerprint, import_batch_id FROM entries WHERE id = ?")
      .bind(entry.id)
      .first();
    expect(stored).toEqual({ fingerprint: entry.fingerprint, import_batch_id: batch.id });
    expect((await check(rows)).results[0]?.exists).toBe(true);
    // A retried restore is an idempotent replay.
    await json<Entry>(await call("POST", "/entries", restoreBody(entry)), 200);

    expect((await call("DELETE", `/import/batches/${batch.id}?confirm=1`)).status).toBe(204);
    expect(await countEntries()).toBe(0);
  });

  it("restores without the fingerprint or batch once a re-import or an undo took them", async () => {
    const rows = [row()];
    const batch = await createBatch(1);
    await commit(batch.id, rows);
    const entry = await deleteOnlyEntry();
    // The file is imported again (taking the fingerprint) and the first batch is undone.
    const again = await createBatch(1);
    expect((await commit(again.id, rows)).inserted).toBe(1);
    expect((await call("DELETE", `/import/batches/${batch.id}?confirm=1`)).status).toBe(204);

    const restored = await json<Entry>(await call("POST", "/entries", restoreBody(entry)), 201);
    expect(restored).toMatchObject({ id: entry.id, fingerprint: null, importBatchId: null });
    expect(await countEntries()).toBe(2);
  });

  it("reports one skipped row when a retried chunk contains one row that already exists", async () => {
    const rows = distinctRows(4);
    const batch = await createBatch(4);
    await commit(batch.id, rows.slice(0, 1));
    expect(await commit(batch.id, rows)).toEqual({ inserted: 3, skipped: 1, failed: [] });
  });

  it("keeps a row with no stored rate waiting, and fails a foreign row whose account amount can't be worked out", async () => {
    const batch = await createBatch(2);
    const waiting = row({ accountId: DOLLAR, currency: "USD", date: "2026-08-01" });
    const unconvertible = row({ currency: "JPY", amountMinor: 1500, date: "2026-08-01" });
    const result = await commit(batch.id, [waiting, unconvertible]);
    expect(result.inserted).toBe(1);
    expect(result.failed).toEqual([{ rowNumber: unconvertible.rowNumber, message: expect.any(String) }]);
    const entry = await db.prepare("SELECT fx_state, base_amount_minor FROM entries").first();
    expect(entry).toEqual({ fx_state: "waiting", base_amount_minor: null });
  });

  it("uses the file's account amount for a foreign row when it has one", async () => {
    const batch = await createBatch(1);
    await commit(batch.id, [row({ currency: "JPY", amountMinor: 1500, accountAmountMinor: 912 })]);
    const entry = await db
      .prepare("SELECT account_amount_minor, orig_currency, orig_amount_minor FROM entries")
      .first();
    expect(entry).toEqual({ account_amount_minor: 912, orig_currency: "JPY", orig_amount_minor: 1500 });
  });

  it("rejects rows that point at an archived account", async () => {
    await db.prepare("UPDATE accounts SET archived_at = ?1 WHERE id = ?2").bind(NOW, DOLLAR).run();
    const batch = await createBatch(1);
    const res = await call("POST", `/import/batches/${batch.id}/rows`, {
      rows: [row({ accountId: DOLLAR })],
    });
    expect(res.status).toBe(422);
    expect(await countEntries()).toBe(0);
  });

  it("answers 404 for an unknown batch", async () => {
    const res = await call("POST", "/import/batches/missing/rows", { rows: [row()] });
    expect(res.status).toBe(404);
  });
});

describe("exchange rates for a long file", () => {
  it("fills two years in 90-day windows with one provider call each, and foreign rows get base values", async () => {
    const calls: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url);
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const body = eachDay(from, to).flatMap((date) =>
        (url.searchParams.get("quotes") ?? "")
          .split(",")
          .map((quote) => ({ date, base: "EUR", quote, rate: quote === "JPY" ? 160 : 1.1 })),
      );
      return Response.json(body);
    });

    const first = "2024-01-01";
    const last = "2025-12-31";
    let windows = 0;
    for (let from = first; from <= last; from = addDays(from, 90)) {
      const to = addDays(from, 89) < last ? addDays(from, 89) : last;
      const res = await call("GET", `/rates?from=${from}&to=${to}`);
      expect(res.status).toBe(200);
      windows++;
    }
    expect(windows).toBe(9);
    expect(calls).toHaveLength(9);

    const batch = await createBatch(3);
    const rows = [
      row({ date: "2024-03-15", currency: "JPY", amountMinor: 1600 }),
      row({ date: "2025-07-01", accountId: DOLLAR, currency: "USD", amountMinor: 1100 }),
      row({ date: "2025-12-31", currency: "USD", amountMinor: 1100 }),
    ];
    expect((await commit(batch.id, rows)).inserted).toBe(3);
    expect(calls).toHaveLength(9);
    const { results } = await db
      .prepare("SELECT date, account_amount_minor, base_amount_minor, fx_state FROM entries ORDER BY date")
      .all();
    expect(results).toEqual([
      { date: "2024-03-15", account_amount_minor: 1000, base_amount_minor: 1000, fx_state: "fixed" },
      { date: "2025-07-01", account_amount_minor: 1100, base_amount_minor: 1000, fx_state: "fixed" },
      { date: "2025-12-31", account_amount_minor: 1000, base_amount_minor: 1000, fx_state: "fixed" },
    ]);
  });

  it("values foreign rows from stored rates without calling the provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await seedRates("2026-07-01", "2026-07-03", { USD: 1.25 });
    const batch = await createBatch(1);
    await commit(batch.id, [row({ date: "2026-07-02", currency: "USD", amountMinor: 2500 })]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const entry = await db.prepare("SELECT account_amount_minor, base_amount_minor FROM entries").first();
    expect(entry).toEqual({ account_amount_minor: 2000, base_amount_minor: 2000 });
  });
});

describe("history and undo", () => {
  it("lists batches with how many of their entries remain", async () => {
    const batch = await createBatch(3);
    await commit(batch.id, distinctRows(3));
    const list = await json<ImportBatch[]>(await call("GET", "/import/batches"));
    expect(list).toEqual([
      expect.objectContaining({
        id: batch.id,
        fileName: "history.csv",
        rowCount: 3,
        entryCount: 3,
        userId: ALICE,
      }),
    ]);
  });

  it("shows edited and reconciled counts before undoing, and only undoes when confirmed", async () => {
    const batch = await createBatch(4);
    await commit(batch.id, [
      row({ date: "2026-01-10" }),
      row({ date: "2026-02-10" }),
      row({ date: "2026-03-10" }),
      row({ date: "2026-04-10", accountId: DOLLAR, currency: "USD" }),
    ]);
    await db.prepare("UPDATE entries SET version = 2 WHERE date IN ('2026-03-10', '2026-04-10')").run();
    await db
      .prepare(
        "INSERT INTO reconciliations (id, account_id, date, bank_balance_minor, computed_minor, user_id, created_at) VALUES ('rec-1', ?1, '2026-02-10', 0, 0, ?2, ?3)",
      )
      .bind(JOINT, ALICE, NOW)
      .run();

    const preview = await json<ImportUndoPreview>(
      await call("GET", `/import/batches/${batch.id}/undo-preview`),
    );
    expect(preview).toEqual({ entryCount: 4, editedCount: 2, reconciledCount: 2 });

    expect((await call("DELETE", `/import/batches/${batch.id}`)).status).toBe(400);
    expect(await countEntries()).toBe(4);

    expect((await call("DELETE", `/import/batches/${batch.id}?confirm=1`)).status).toBe(204);
    expect(await countEntries()).toBe(0);
    expect(await json<ImportBatch[]>(await call("GET", "/import/batches"))).toEqual([]);
  });

  it("leaves entries from other batches and typed by hand alone", async () => {
    const a = await createBatch(1);
    const b = await createBatch(1);
    await commit(a.id, [row({ amountMinor: 1 })]);
    await commit(b.id, [row({ amountMinor: 2 })]);
    await call("DELETE", `/import/batches/${a.id}?confirm=1`);
    expect(await countEntries()).toBe(1);
    expect(await countEntries(`import_batch_id = '${b.id}'`)).toBe(1);
  });
});
