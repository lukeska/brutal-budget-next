import {
  CURRENCIES,
  type CurrencyCode,
  isCurrencyCode,
  type ParseAmountResult,
  parseAmount,
} from "@shared/money";
import { NAME_MAX } from "@shared/schemas/category";
import { type CsvRow, cleanText, matchKey, RATE_WINDOW_DAYS } from "@shared/schemas/csv";
import { NOTES_MAX } from "@shared/schemas/entry";
import Papa from "papaparse";

/**
 * Reads an import CSV in the browser: header normalisation, per-row validation and the occurrence
 * index of identical rows. The file format is documented in docs/csv-format.md.
 */

export const COLUMNS = [
  "date",
  "type",
  "amount",
  "currency",
  "account_amount",
  "account",
  "category",
  "subcategory",
  "project",
  "partner",
  "notes",
  "icon",
] as const;
type Column = (typeof COLUMNS)[number];
const REQUIRED: Column[] = ["date", "type", "amount", "currency", "category", "partner"];

/** A valid file row, before its account and partner are mapped. */
export interface ParsedRow {
  /** Row number as a spreadsheet shows it (the header is row 1). */
  rowNumber: number;
  /** How many identical rows came before this one. */
  occurrence: number;
  date: string;
  type: "expense" | "income";
  amountMinor: number;
  currency: CurrencyCode;
  /** As written; read once the account (and so its currency) is known. */
  accountAmount?: string;
  /** The file's account name, trimmed; empty when the row names none. */
  account: string;
  category: string;
  subcategory?: string;
  project?: string;
  partner: string;
  notes?: string;
  icon?: string;
}

export interface RowError {
  rowNumber: number;
  messages: string[];
}

export interface ParseResult {
  rows: ParsedRow[];
  errors: RowError[];
  /** Distinct account names in file order; "" stands for rows that name no account. */
  accountNames: string[];
  /** Distinct partner values in file order. */
  partners: string[];
  /** Set when the file as a whole can't be read (e.g. a missing column). */
  fileError?: string;
}

export const TRANSFER_MESSAGE = "Transfers can't be imported — add them in the app";
const DECIMAL_PATTERN = /^\d+(?:[.,]\d+)?$/;

export function normaliseHeader(header: string): string {
  return header
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function amountMessage(
  result: Exclude<ParseAmountResult, { ok: true }>,
  currency: CurrencyCode,
  field = "Amount",
) {
  const suffix = field === "Amount" ? "" : ` (${field})`;
  if (result.error === "too_many_decimals") {
    const exponent = CURRENCIES[currency].exponent;
    return exponent === 0
      ? `${currency} amounts have no decimals${suffix}`
      : `${currency} amounts have at most ${exponent} decimals${suffix}`;
  }
  if (result.error === "too_large") return `${field} is too large`;
  return `${field} must be a positive number like 12.50`;
}

const optional = (value: string): string | undefined => (value === "" ? undefined : value);

function identity(parts: (string | number)[]): string {
  return JSON.stringify(parts);
}

/** For each item, how many earlier items share its key. */
export function assignOccurrences<T>(items: T[], key: (item: T) => string): number[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const k = key(item);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n;
  });
}

function validateRow(raw: Record<Column, string>, rowNumber: number): ParsedRow | RowError {
  const messages: string[] = [];
  const date = raw.date;
  if (!isIsoDate(date)) messages.push("Date must be YYYY-MM-DD");

  const type = raw.type.toLowerCase();
  if (type === "transfer") messages.push(TRANSFER_MESSAGE);
  else if (type !== "expense" && type !== "income") messages.push("Type must be expense or income");

  const currency = raw.currency.toUpperCase();
  let amountMinor = 0;
  if (!isCurrencyCode(currency)) {
    messages.push(currency === "" ? "Currency is required" : `Unknown currency “${raw.currency}”`);
  } else {
    const amount = parseAmount(raw.amount, currency);
    if (!amount.ok) messages.push(amountMessage(amount, currency));
    else if (amount.minor === 0) messages.push("Amount must be more than zero");
    else amountMinor = amount.minor;
  }
  if (raw.account_amount !== "" && !DECIMAL_PATTERN.test(raw.account_amount)) {
    messages.push("account_amount must be a positive number like 12.50");
  }

  const category = cleanText(raw.category);
  const subcategory = cleanText(raw.subcategory);
  const project = cleanText(raw.project);
  if (category === "") messages.push("Category is required");
  for (const [label, value] of [
    ["Category", category],
    ["Subcategory", subcategory],
    ["Project", project],
  ] as const) {
    if (value.length > NAME_MAX) messages.push(`${label} is longer than ${NAME_MAX} characters`);
  }
  if (raw.notes.length > NOTES_MAX) messages.push(`Notes are longer than ${NOTES_MAX} characters`);

  if (messages.length > 0) return { rowNumber, messages };
  const row: ParsedRow = {
    rowNumber,
    occurrence: 0,
    date,
    type: type as ParsedRow["type"],
    amountMinor,
    currency: currency as CurrencyCode,
    accountAmount: optional(raw.account_amount),
    account: raw.account,
    category,
    subcategory: optional(subcategory),
    project: optional(project),
    partner: raw.partner,
    notes: optional(raw.notes),
    icon: optional(raw.icon),
  };
  for (const key of Object.keys(row) as (keyof ParsedRow)[]) if (row[key] === undefined) delete row[key];
  return row;
}

export function parseCsv(text: string): ParseResult {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: normaliseHeader,
  });
  const fields = parsed.meta.fields ?? [];
  const missing = REQUIRED.filter((c) => !fields.includes(c));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [],
      accountNames: [],
      partners: [],
      fileError: `Missing columns: ${missing.join(", ")}`,
    };
  }

  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];
  parsed.data.forEach((record, index) => {
    const raw = Object.fromEntries(COLUMNS.map((c) => [c, (record[c] ?? "").trim()])) as Record<
      Column,
      string
    >;
    const result = validateRow(raw, index + 2);
    if ("messages" in result) errors.push(result);
    else rows.push(result);
  });

  const occurrences = assignOccurrences(rows, (r) =>
    identity([
      r.date,
      r.type,
      r.amountMinor,
      r.currency,
      matchKey(r.account),
      matchKey(r.category),
      matchKey(r.subcategory ?? ""),
      matchKey(r.notes ?? ""),
    ]),
  );
  rows.forEach((r, i) => {
    r.occurrence = occurrences[i] ?? 0;
  });

  return {
    rows,
    errors,
    accountNames: [...new Set(rows.map((r) => r.account))],
    partners: [...new Set(rows.map((r) => r.partner))],
  };
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ParsedFile extends ParseResult {
  fileName: string;
  fileSha256: string;
}

/** Reads a chosen file as UTF-8 (with or without a BOM), parses it and hashes its bytes. */
export async function parseCsvFile(file: File): Promise<ParsedFile> {
  const bytes = await file.arrayBuffer();
  const text = new TextDecoder("utf-8").decode(bytes);
  return { ...parseCsv(text), fileName: file.name, fileSha256: await sha256Hex(bytes) };
}

export interface Mapping {
  /** File account name ("" for none) -> account id. */
  accounts: Record<string, string>;
  /** File partner value -> user id. */
  partners: Record<string, string>;
  accountCurrencies: ReadonlyMap<string, CurrencyCode>;
}

/**
 * Turns parsed rows into request rows. Identical rows are numbered again by the account they map
 * to, so two file names mapped to one account can't collide.
 */
export function buildRows(parsed: ParsedRow[], mapping: Mapping): { rows: CsvRow[]; errors: RowError[] } {
  const rows: CsvRow[] = [];
  const errors: RowError[] = [];
  for (const p of parsed) {
    const accountId = mapping.accounts[p.account];
    const userId = mapping.partners[p.partner];
    const accountCurrency = accountId ? mapping.accountCurrencies.get(accountId) : undefined;
    if (!accountId || !userId || !accountCurrency) continue;

    const row: CsvRow = {
      rowNumber: p.rowNumber,
      occurrence: 0,
      date: p.date,
      type: p.type,
      amountMinor: p.amountMinor,
      currency: p.currency,
      accountId,
      categoryPath: p.subcategory ? { parent: p.category, child: p.subcategory } : { parent: p.category },
      userId,
    };
    if (p.accountAmount !== undefined && p.currency !== accountCurrency) {
      const amount = parseAmount(p.accountAmount, accountCurrency);
      if (!amount.ok || amount.minor === 0) {
        const message = amount.ok
          ? "account_amount must be more than zero"
          : amountMessage(amount, accountCurrency, "account_amount");
        errors.push({ rowNumber: p.rowNumber, messages: [message] });
        continue;
      }
      row.accountAmountMinor = amount.minor;
    }
    if (p.project) row.projectName = p.project;
    if (p.notes) row.notes = p.notes;
    if (p.icon) row.icon = p.icon;
    rows.push(row);
  }

  const occurrences = assignOccurrences(rows, (r) =>
    identity([
      r.date,
      r.type,
      r.amountMinor,
      r.currency,
      r.accountId,
      matchKey(r.categoryPath.parent),
      matchKey(r.categoryPath.child ?? ""),
      matchKey(r.notes ?? ""),
    ]),
  );
  rows.forEach((r, i) => {
    r.occurrence = occurrences[i] ?? 0;
  });
  return { rows, errors };
}

export function matchAccount(name: string, accounts: { id: string; name: string }[]): string | undefined {
  const key = matchKey(name);
  if (key === "") return undefined;
  return accounts.find((a) => matchKey(a.name) === key)?.id;
}

export function matchPartner(
  value: string,
  people: { id: string; name: string; email?: string }[],
): string | undefined {
  const key = matchKey(value);
  if (key === "") return undefined;
  return people.find((p) => (p.email !== undefined && matchKey(p.email) === key) || matchKey(p.name) === key)
    ?.id;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Splits [from, to] into consecutive windows of at most `days` days. */
export function rateWindows(
  from: string,
  to: string,
  days = RATE_WINDOW_DAYS,
): { from: string; to: string }[] {
  const windows: { from: string; to: string }[] = [];
  for (let start = from; start <= to; start = addDays(start, days)) {
    const end = addDays(start, days - 1);
    windows.push({ from: start, to: end < to ? end : to });
  }
  return windows;
}

function needsRate(
  r: CsvRow,
  accountCurrencies: ReadonlyMap<string, CurrencyCode>,
  baseCurrency: string,
): boolean {
  const accountCurrency = accountCurrencies.get(r.accountId);
  return (
    accountCurrency !== baseCurrency || (r.currency !== accountCurrency && r.accountAmountMinor === undefined)
  );
}

/** The date span of rows that need an exchange rate, or null when none do. */
export function rateRange(
  rows: CsvRow[],
  accountCurrencies: ReadonlyMap<string, CurrencyCode>,
  baseCurrency: string,
): { from: string; to: string } | null {
  let from: string | null = null;
  let to: string | null = null;
  for (const r of rows) {
    if (!needsRate(r, accountCurrencies, baseCurrency)) continue;
    if (from === null || r.date < from) from = r.date;
    if (to === null || r.date > to) to = r.date;
  }
  return from && to ? { from, to } : null;
}

/**
 * Windows of at most `days` days covering every date of rows that need an exchange rate. A gap of
 * `days` or more between two such dates starts a new run, so long stretches without rows cost no requests.
 */
export function rateWindowsForRows(
  rows: CsvRow[],
  accountCurrencies: ReadonlyMap<string, CurrencyCode>,
  baseCurrency: string,
  days = RATE_WINDOW_DAYS,
): { from: string; to: string }[] {
  const dates = [
    ...new Set(rows.filter((r) => needsRate(r, accountCurrencies, baseCurrency)).map((r) => r.date)),
  ].sort();
  const windows: { from: string; to: string }[] = [];
  let start: string | undefined;
  let prev: string | undefined;
  for (const date of dates) {
    if (start === undefined || prev === undefined) {
      start = date;
    } else if (date >= addDays(prev, days)) {
      windows.push(...rateWindows(start, prev, days));
      start = date;
    }
    prev = date;
  }
  if (start !== undefined && prev !== undefined) windows.push(...rateWindows(start, prev, days));
  return windows;
}
