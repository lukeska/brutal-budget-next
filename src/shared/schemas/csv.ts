import { z } from "zod";
import { MAX_ABS_MINOR } from "../money";
import { NAME_MAX } from "./category";
import { currencyCode, isoDate, NOTES_MAX } from "./entry";

/**
 * CSV import payloads. The browser parses and validates the file, maps account names and partners
 * to ids, and sends rows in chunks; the server fingerprints and stores them.
 */

/** Most rows one check or commit request accepts. The client sends about 200. */
export const IMPORT_CHUNK_MAX = 250;
/** Rows per request the client sends. */
export const IMPORT_CHUNK_SIZE = 200;
/** Longest date window one rate-fill request covers. */
export const RATE_WINDOW_DAYS = 90;

export const FINGERPRINT_VERSION = "v1";

/** Trimmed, NFC-normalised, with whitespace runs collapsed to one space. How names are stored. */
export function cleanText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** `cleanText` and case-folded: how names and notes are compared. */
export function matchKey(value: string): string {
  return cleanText(value).toLowerCase();
}

const refId = z.string().min(1).max(64);
const name = z.string().trim().min(1).max(NAME_MAX);
const amountMinor = z.number().int().positive().max(MAX_ABS_MINOR);

/** One file row after the client has validated it and mapped its account and partner. */
export const csvRowSchema = z.object({
  /** Row number as a spreadsheet shows it (the header is row 1). */
  rowNumber: z.number().int().min(1),
  /** How many identical rows came before this one in the file, so two equal coffees both import. */
  occurrence: z.number().int().min(0),
  date: isoDate,
  type: z.enum(["expense", "income"]),
  /** Amount in `currency`. */
  amountMinor,
  currency: currencyCode,
  /** Amount booked to the account, in its currency, when the file gave one. */
  accountAmountMinor: amountMinor.optional(),
  accountId: refId,
  categoryPath: z.object({ parent: name, child: name.optional() }),
  projectName: name.optional(),
  userId: refId,
  notes: z.string().max(NOTES_MAX).optional(),
  icon: z.string().max(64).optional(),
});
export type CsvRow = z.infer<typeof csvRowSchema>;

const rowsSchema = z.array(csvRowSchema).min(1).max(IMPORT_CHUNK_MAX);

export const importCheckRequestSchema = z.object({ rows: rowsSchema });
export type ImportCheckRequest = z.infer<typeof importCheckRequestSchema>;

export interface ImportCheckResult {
  rowNumber: number;
  fingerprint: string;
  /** An entry with this fingerprint is already stored. */
  exists: boolean;
}
export interface ImportCheckResponse {
  results: ImportCheckResult[];
}

export const importBatchCreateSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/, "Expected a SHA-256 hex digest"),
  rowCount: z.number().int().min(0),
});
export type ImportBatchCreate = z.infer<typeof importBatchCreateSchema>;

export interface ImportBatch {
  id: string;
  userId: string;
  fileName: string;
  fileSha256: string;
  rowCount: number;
  createdAt: string;
  /** Entries still stored from this batch. */
  entryCount: number;
}

export const importRowsRequestSchema = z.object({ rows: rowsSchema });
export type ImportRowsRequest = z.infer<typeof importRowsRequestSchema>;

export interface ImportRowFailure {
  rowNumber: number;
  message: string;
}
export interface ImportRowsResponse {
  inserted: number;
  /** Rows already stored (same fingerprint), left untouched. */
  skipped: number;
  /** Rows that couldn't be stored, e.g. no exchange rate to work out the account amount. */
  failed: ImportRowFailure[];
}

export interface ImportUndoPreview {
  entryCount: number;
  /** Entries changed since they were imported. */
  editedCount: number;
  /** Entries dated on or before their account's latest reconciliation. */
  reconciledCount: number;
}
