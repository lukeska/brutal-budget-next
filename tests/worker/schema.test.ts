import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = "2026-11-07T10:00:00.000Z";
const db = env.DB;

async function tableNames(): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

async function resetData() {
  await db.batch(
    [
      "DELETE FROM reconciliations",
      "DELETE FROM entries",
      "DELETE FROM import_batches",
      "DELETE FROM categories WHERE parent_id IS NOT NULL",
      "DELETE FROM categories",
      "DELETE FROM projects",
      "DELETE FROM accounts",
      "DELETE FROM sessions",
      "DELETE FROM users",
      "DELETE FROM household",
    ].map((s) => db.prepare(s)),
  );
}

async function seed() {
  await db.batch([
    db
      .prepare(
        "INSERT INTO household (id, base_currency, timezone, argon_params, created_at) VALUES (1, 'EUR', 'Europe/Rome', ?, ?)",
      )
      .bind(JSON.stringify({ memoryKiB: 65536, iterations: 3, parallelism: 1 }), NOW),
    db
      .prepare(
        "INSERT INTO users (id, email, name, salt, verifier, created_at, updated_at) VALUES ('u1', 'a@example.com', 'A', 's', 'v', ?, ?)",
      )
      .bind(NOW, NOW),
    db
      .prepare(
        "INSERT INTO accounts (id, name, currency, opening_minor, created_at, updated_at) VALUES ('acc1', 'Joint', 'EUR', 10000, ?, ?), ('acc2', 'Card', 'EUR', 0, ?, ?), ('acc3', 'Cash', 'EUR', 500, ?, ?)",
      )
      .bind(NOW, NOW, NOW, NOW, NOW, NOW),
    db
      .prepare(
        "INSERT INTO categories (id, type, name, icon, colour, created_at, updated_at) VALUES ('cat1', 'expense', 'Food', 'IconToolsKitchen2', '#e8590c', ?, ?), ('cat2', 'income', 'Salary', 'IconCash', '#2f9e44', ?, ?)",
      )
      .bind(NOW, NOW, NOW, NOW),
    db
      .prepare(
        "INSERT INTO projects (id, name, colour, created_at, updated_at) VALUES ('p1', 'Holiday', '#1971c2', ?, ?)",
      )
      .bind(NOW, NOW),
  ]);
}

type EntryInput = {
  id: string;
  kind: string;
  accountId?: string;
  amount?: number;
  toAccountId?: string | null;
  toAmount?: number | null;
  categoryId?: string | null;
  projectId?: string | null;
  fingerprint?: string | null;
};

function insertEntry(e: EntryInput) {
  return db
    .prepare(
      `INSERT INTO entries (id, kind, date, user_id, account_id, account_amount_minor, to_account_id, to_amount_minor,
        base_amount_minor, fx_state, category_id, project_id, fingerprint, created_at, updated_at)
       VALUES (?, ?, '2026-11-01', 'u1', ?, ?, ?, ?, ?, 'fixed', ?, ?, ?, ?, ?)`,
    )
    .bind(
      e.id,
      e.kind,
      e.accountId ?? "acc1",
      e.amount ?? 1000,
      e.toAccountId ?? null,
      e.toAmount ?? null,
      e.amount ?? 1000,
      e.categoryId ?? null,
      e.projectId ?? null,
      e.fingerprint ?? null,
      NOW,
      NOW,
    );
}

const BALANCES_SQL = `
  SELECT a.id,
    a.opening_minor
    + COALESCE((SELECT SUM(CASE e.kind WHEN 'expense' THEN -e.account_amount_minor
                                       WHEN 'transfer' THEN -e.account_amount_minor
                                       ELSE e.account_amount_minor END)
                FROM entries e WHERE e.account_id = a.id), 0)
    + COALESCE((SELECT SUM(e.to_amount_minor) FROM entries e WHERE e.to_account_id = a.id), 0) AS balance
  FROM accounts a ORDER BY a.id`;

describe("database schema", () => {
  beforeEach(async () => {
    await resetData();
    await seed();
  });

  it("applies every migration to an empty database, and applying them again changes nothing", async () => {
    const before = await tableNames();
    expect(before).toEqual(
      expect.arrayContaining([
        "accounts",
        "categories",
        "entries",
        "fx_rates",
        "household",
        "import_batches",
        "login_attempts",
        "projects",
        "reconciliations",
        "sessions",
        "users",
      ]),
    );
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    expect(await tableNames()).toEqual(before);
    const { results } = await db.prepare("SELECT COUNT(*) AS n FROM accounts").all<{ n: number }>();
    expect(results[0]?.n).toBe(3);
  });

  it("refuses a second household row", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO household (id, base_currency, timezone, argon_params, created_at) VALUES (2, 'EUR', 'UTC', '{}', ?)",
        )
        .bind(NOW)
        .run(),
    ).rejects.toThrow(/CHECK constraint/);
    await expect(
      db
        .prepare(
          "INSERT INTO household (id, base_currency, timezone, argon_params, created_at) VALUES (1, 'EUR', 'UTC', '{}', ?)",
        )
        .bind(NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint|PRIMARY KEY/);
  });

  it("matches emails case-insensitively and keeps them unique", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO users (id, email, name, salt, verifier, created_at, updated_at) VALUES ('u2', 'A@Example.com', 'B', 's', 'v', ?, ?)",
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint/);
  });

  it("refuses a transfer whose from-account equals its to-account", async () => {
    await expect(
      insertEntry({ id: "e1", kind: "transfer", toAccountId: "acc1", toAmount: 1000 }).run(),
    ).rejects.toThrow(/CHECK constraint/);
  });

  it("refuses an expense with a to-account", async () => {
    await expect(
      insertEntry({
        id: "e1",
        kind: "expense",
        categoryId: "cat1",
        toAccountId: "acc2",
        toAmount: 1000,
      }).run(),
    ).rejects.toThrow(/CHECK constraint/);
  });

  it("refuses a same-currency transfer without the received amount", async () => {
    await expect(insertEntry({ id: "e1", kind: "transfer", toAccountId: "acc2" }).run()).rejects.toThrow(
      /CHECK constraint/,
    );
  });

  it("refuses non-positive amounts except on adjustments, which must be non-zero", async () => {
    await expect(
      insertEntry({ id: "e1", kind: "expense", categoryId: "cat1", amount: -5 }).run(),
    ).rejects.toThrow(/CHECK constraint/);
    await expect(insertEntry({ id: "e2", kind: "adjustment", amount: 0 }).run()).rejects.toThrow(
      /CHECK constraint/,
    );
    await insertEntry({ id: "e3", kind: "adjustment", amount: -250 }).run();
  });

  it("requires a category on expenses and income, and none on transfers or adjustments", async () => {
    await expect(insertEntry({ id: "e1", kind: "expense" }).run()).rejects.toThrow(/CHECK constraint/);
    await expect(
      insertEntry({
        id: "e2",
        kind: "transfer",
        toAccountId: "acc2",
        toAmount: 1000,
        categoryId: "cat1",
      }).run(),
    ).rejects.toThrow(/CHECK constraint/);
  });

  it("refuses two entries with the same fingerprint but allows many without one", async () => {
    await insertEntry({ id: "e1", kind: "expense", categoryId: "cat1", fingerprint: "v1:abc" }).run();
    await expect(
      insertEntry({ id: "e2", kind: "expense", categoryId: "cat1", fingerprint: "v1:abc" }).run(),
    ).rejects.toThrow(/UNIQUE constraint/);
    await insertEntry({ id: "e3", kind: "expense", categoryId: "cat1" }).run();
    await insertEntry({ id: "e4", kind: "expense", categoryId: "cat1" }).run();
  });

  it("refuses to delete an account or a project that entries refer to", async () => {
    await insertEntry({ id: "e1", kind: "expense", categoryId: "cat1", projectId: "p1" }).run();
    await insertEntry({
      id: "e2",
      kind: "transfer",
      accountId: "acc3",
      toAccountId: "acc2",
      toAmount: 1000,
    }).run();
    await expect(db.prepare("DELETE FROM accounts WHERE id = 'acc1'").run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(db.prepare("DELETE FROM accounts WHERE id = 'acc2'").run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(db.prepare("DELETE FROM projects WHERE id = 'p1'").run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("refuses to delete an entry that a reconciliation uses as its adjustment", async () => {
    await insertEntry({ id: "adj", kind: "adjustment", amount: -300 }).run();
    await db
      .prepare(
        "INSERT INTO reconciliations (id, account_id, date, bank_balance_minor, computed_minor, adjustment_entry_id, user_id, created_at) VALUES ('r1', 'acc1', '2026-11-01', 9700, 10000, 'adj', 'u1', ?)",
      )
      .bind(NOW)
      .run();
    await expect(db.prepare("DELETE FROM entries WHERE id = 'adj'").run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("keeps entry counts and every account balance when a later migration rebuilds the accounts table", async () => {
    await db.batch([
      insertEntry({ id: "e1", kind: "expense", categoryId: "cat1", amount: 1250 }),
      insertEntry({ id: "e2", kind: "income", categoryId: "cat2", accountId: "acc2", amount: 300000 }),
      insertEntry({
        id: "e3",
        kind: "transfer",
        accountId: "acc2",
        toAccountId: "acc3",
        toAmount: 20000,
        amount: 20000,
      }),
      insertEntry({ id: "e4", kind: "adjustment", accountId: "acc3", amount: -75 }),
    ]);
    const countBefore = await db.prepare("SELECT COUNT(*) AS n FROM entries").first<number>("n");
    const balancesBefore = (await db.prepare(BALANCES_SQL).all()).results;

    // A column change (opening_minor -> opening_balance_minor). Under deferred foreign keys D1 only
    // resolves the violations a DROP TABLE records when the parent rows are re-inserted into a table
    // with the original name, so the old rows are copied aside, the table is recreated under its own
    // name and refilled. The usual "create new, copy, drop old, rename new" order fails at commit.
    await db.batch(
      [
        "PRAGMA defer_foreign_keys = ON",
        "CREATE TABLE accounts_old AS SELECT * FROM accounts",
        "DROP TABLE accounts",
        `CREATE TABLE accounts (
          id text PRIMARY KEY NOT NULL,
          name text NOT NULL,
          currency text NOT NULL,
          opening_balance_minor integer NOT NULL,
          archived_at text,
          version integer DEFAULT 1 NOT NULL,
          created_at text NOT NULL,
          updated_at text NOT NULL
        )`,
        `INSERT INTO accounts (id, name, currency, opening_balance_minor, archived_at, version, created_at, updated_at)
          SELECT id, name, currency, opening_minor, archived_at, version, created_at, updated_at FROM accounts_old`,
        "DROP TABLE accounts_old",
      ].map((s) => db.prepare(s)),
    );

    const countAfter = await db.prepare("SELECT COUNT(*) AS n FROM entries").first<number>("n");
    const balancesAfter = (
      await db.prepare(BALANCES_SQL.replace("a.opening_minor", "a.opening_balance_minor")).all()
    ).results;
    expect(countAfter).toBe(countBefore);
    expect(balancesAfter).toEqual(balancesBefore);
    expect(balancesAfter).toEqual([
      { id: "acc1", balance: 10000 - 1250 },
      { id: "acc2", balance: 300000 - 20000 },
      { id: "acc3", balance: 500 + 20000 - 75 },
    ]);
    // Foreign keys from entries still point at the rebuilt table.
    const { results: fkProblems } = await db.prepare("PRAGMA foreign_key_check").all();
    expect(fkProblems).toEqual([]);
    await expect(db.prepare("DELETE FROM accounts WHERE id = 'acc1'").run()).rejects.toThrow(/FOREIGN KEY/);
  });
});
