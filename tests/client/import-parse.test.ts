import { describe, expect, it } from "vitest";
import {
  buildRows,
  chunk,
  matchAccount,
  matchPartner,
  parseCsv,
  rateRange,
  rateWindows,
  sha256Hex,
} from "../../src/client/features/import/parse";

const HEADER =
  "date,type,amount,currency,account_amount,account,category,subcategory,project,partner,notes,icon";

function csv(...lines: string[]): string {
  return [HEADER, ...lines].join("\n");
}

describe("parseCsv", () => {
  it("reads a file with a BOM and headers in any case or spacing", () => {
    const text =
      "﻿ Date ,TYPE,Amount,currency,Account Amount,account,Category,Subcategory,project,Partner,notes,icon\n" +
      "2026-10-01,Expense,12.50,eur,,Joint,Food,Groceries,,alice@example.com,Weekly shop,IconShoppingCart\n" +
      "2026-10-02,income,2000,EUR,,,Salary,,,Bob,,\n";
    const result = parseCsv(text);
    expect(result.fileError).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        rowNumber: 2,
        occurrence: 0,
        date: "2026-10-01",
        type: "expense",
        amountMinor: 1250,
        currency: "EUR",
        account: "Joint",
        category: "Food",
        subcategory: "Groceries",
        partner: "alice@example.com",
        notes: "Weekly shop",
        icon: "IconShoppingCart",
      },
      {
        rowNumber: 3,
        occurrence: 0,
        date: "2026-10-02",
        type: "income",
        amountMinor: 200000,
        currency: "EUR",
        account: "",
        category: "Salary",
        partner: "Bob",
      },
    ]);
    expect(result.accountNames).toEqual(["Joint", ""]);
    expect(result.partners).toEqual(["alice@example.com", "Bob"]);
  });

  it("reports an unknown currency, a bad date and JPY decimals with their row numbers", () => {
    const result = parseCsv(
      csv(
        "2026-10-01,expense,10,XYZ,,,Food,,,Alice,,",
        "01/10/2026,expense,10,EUR,,,Food,,,Alice,,",
        "2026-02-30,expense,10,EUR,,,Food,,,Alice,,",
        "2026-10-01,expense,1500.5,JPY,,,Food,,,Alice,,",
        "2026-10-01,expense,1500,JPY,,,Food,,,Alice,,",
      ),
    );
    expect(result.rows.map((r) => r.rowNumber)).toEqual([6]);
    expect(result.errors).toEqual([
      { rowNumber: 2, messages: ["Unknown currency “XYZ”"] },
      { rowNumber: 3, messages: ["Date must be YYYY-MM-DD"] },
      { rowNumber: 4, messages: ["Date must be YYYY-MM-DD"] },
      { rowNumber: 5, messages: ["JPY amounts have no decimals"] },
    ]);
  });

  it("rejects transfers", () => {
    const result = parseCsv(csv("2026-10-01,transfer,10,EUR,,Joint,Food,,,Alice,,"));
    expect(result.errors).toEqual([
      { rowNumber: 2, messages: ["Transfers can't be imported — add them in the app"] },
    ]);
  });

  it("reports missing values and bad amounts", () => {
    const result = parseCsv(csv(",expense,-4,EUR,abc,,,,,Alice,,", "2026-10-01,gift,0,EUR,,,Food,,,Alice,,"));
    expect(result.errors).toEqual([
      {
        rowNumber: 2,
        messages: [
          "Date must be YYYY-MM-DD",
          "Amount must be a positive number like 12.50",
          "account_amount must be a positive number like 12.50",
          "Category is required",
        ],
      },
      { rowNumber: 3, messages: ["Type must be expense or income", "Amount must be more than zero"] },
    ]);
  });

  it("explains a missing column instead of reading rows", () => {
    const result = parseCsv("date,type,amount\n2026-10-01,expense,10\n");
    expect(result.fileError).toBe("Missing columns: currency, category, partner");
    expect(result.rows).toEqual([]);
  });

  it("numbers identical rows so both import, ignoring whitespace and case", () => {
    const result = parseCsv(
      csv(
        "2026-10-01,expense,3.20,EUR,,Joint,Food,,,Alice,Coffee,",
        "2026-10-01,expense,3.2,EUR,,joint ,food,,,Bob, coffee ,",
        "2026-10-01,expense,3.20,EUR,,Joint,Food,,,Alice,Tea,",
        "2026-10-01,expense,3.20,EUR,,Joint,Food,,,Alice,COFFEE,",
      ),
    );
    expect(result.rows.map((r) => r.occurrence)).toEqual([0, 1, 0, 2]);
  });

  it("parses 5,000 rows and splits them into 200-row chunks", () => {
    const lines = Array.from(
      { length: 5000 },
      (_, i) =>
        `2026-${String((i % 12) + 1).padStart(2, "0")}-15,expense,${i + 1}.00,EUR,,Joint,Food,,,Alice,row ${i},`,
    );
    const result = parseCsv(csv(...lines));
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(5000);
    const chunks = chunk(result.rows, 200);
    expect(chunks).toHaveLength(25);
    expect(chunks.every((c) => c.length === 200)).toBe(true);
    expect(chunks[24]?.at(-1)?.rowNumber).toBe(5001);
  });
});

describe("buildRows", () => {
  const accounts = new Map([
    ["acc-eur", "EUR" as const],
    ["acc-jpy", "JPY" as const],
  ]);

  it("maps accounts and partners, and numbers identical rows by the account they map to", () => {
    const parsed = parseCsv(
      csv(
        "2026-10-01,expense,3.20,EUR,,Joint,Food,,,Alice,Coffee,",
        "2026-10-01,expense,3.20,EUR,,Joint account,Food,,,Alice,Coffee,",
        "2026-10-01,expense,3.20,EUR,,,Food,Café,Trip,Bob,Coffee,IconCoffee",
      ),
    );
    const { rows, errors } = buildRows(parsed.rows, {
      accounts: { Joint: "acc-eur", "Joint account": "acc-eur", "": "acc-jpy" },
      partners: { Alice: "user-a", Bob: "user-b" },
      accountCurrencies: accounts,
    });
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.accountId, r.occurrence, r.userId])).toEqual([
      ["acc-eur", 0, "user-a"],
      ["acc-eur", 1, "user-a"],
      ["acc-jpy", 0, "user-b"],
    ]);
    expect(rows[2]).toMatchObject({
      categoryPath: { parent: "Food", child: "Café" },
      projectName: "Trip",
      notes: "Coffee",
      icon: "IconCoffee",
    });
  });

  it("reads account_amount in the mapped account's currency", () => {
    const parsed = parseCsv(
      csv(
        "2026-10-01,expense,10,EUR,1650,Tokyo,Food,,,Alice,,",
        "2026-10-01,expense,10,EUR,1650.5,Tokyo,Food,,,Alice,,",
      ),
    );
    const { rows, errors } = buildRows(parsed.rows, {
      accounts: { Tokyo: "acc-jpy" },
      partners: { Alice: "user-a" },
      accountCurrencies: accounts,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountAmountMinor).toBe(1650);
    expect(errors).toEqual([{ rowNumber: 3, messages: ["JPY amounts have no decimals (account_amount)"] }]);
  });
});

describe("helpers", () => {
  it("splits a two-year range into windows of at most 90 days", () => {
    const windows = rateWindows("2024-01-01", "2025-12-31");
    expect(windows).toHaveLength(9);
    expect(windows[0]).toEqual({ from: "2024-01-01", to: "2024-03-30" });
    expect(windows.at(-1)).toEqual({ from: "2025-12-21", to: "2025-12-31" });
    for (let i = 1; i < windows.length; i++) {
      const prevEnd = new Date(`${windows[i - 1]?.to}T00:00:00Z`).getTime();
      expect(new Date(`${windows[i]?.from}T00:00:00Z`).getTime() - prevEnd).toBe(86_400_000);
    }
  });

  it("only asks for rates over rows that need a conversion", () => {
    const accountCurrencies = new Map([
      ["acc-eur", "EUR" as const],
      ["acc-usd", "USD" as const],
    ]);
    const base = { amountMinor: 1, type: "expense" as const, userId: "u", categoryPath: { parent: "F" } };
    const rows = [
      {
        ...base,
        rowNumber: 2,
        occurrence: 0,
        date: "2020-01-01",
        currency: "EUR" as const,
        accountId: "acc-eur",
      },
      {
        ...base,
        rowNumber: 3,
        occurrence: 0,
        date: "2024-05-01",
        currency: "JPY" as const,
        accountId: "acc-eur",
      },
      {
        ...base,
        rowNumber: 4,
        occurrence: 0,
        date: "2024-02-01",
        currency: "USD" as const,
        accountId: "acc-usd",
      },
      {
        ...base,
        rowNumber: 5,
        occurrence: 0,
        date: "2026-01-01",
        currency: "EUR" as const,
        accountId: "acc-eur",
      },
    ];
    expect(rateRange(rows, accountCurrencies, "EUR")).toEqual({ from: "2024-02-01", to: "2024-05-01" });
    expect(rateRange(rows.slice(0, 1), accountCurrencies, "EUR")).toBeNull();
  });

  it("matches file accounts by name and partners by email or name", () => {
    const accounts = [
      { id: "a", name: "Joint" },
      { id: "b", name: "Cash" },
    ];
    expect(matchAccount(" joint", accounts)).toBe("a");
    expect(matchAccount("Savings", accounts)).toBeUndefined();
    const people = [
      { id: "u1", name: "Alice", email: "alice@example.com" },
      { id: "u2", name: "Bob" },
    ];
    expect(matchPartner("ALICE@example.com", people)).toBe("u1");
    expect(matchPartner("bob", people)).toBe("u2");
    expect(matchPartner("carol", people)).toBeUndefined();
  });

  it("hashes file bytes with SHA-256", async () => {
    const digest = await sha256Hex(new TextEncoder().encode("abc"));
    expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
