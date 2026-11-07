import { type CurrencyCode, MAX_ABS_MINOR } from "@shared/money";
import { z } from "zod";
import { currencyCode, isoDate } from "./entry";

/** Account and reconciliation payloads shared by the API and the client. Money is integer minor units. */

export const ACCOUNT_NAME_MAX = 80;
export const HISTORY_PAGE_DEFAULT = 50;
export const HISTORY_PAGE_MAX = 200;

const signedMinor = z.number().int().min(-MAX_ABS_MINOR).max(MAX_ABS_MINOR);
const accountName = z.string().trim().min(1, "Name is required").max(ACCOUNT_NAME_MAX);
const version = z.number().int().positive();

export const accountCreateSchema = z.object({
  id: z.uuidv7(),
  name: accountName,
  currency: currencyCode,
  openingMinor: signedMinor,
});
export type AccountCreate = z.infer<typeof accountCreateSchema>;

/** A partial edit. `version` is the one the client loaded. */
export const accountPatchSchema = z.object({
  version,
  name: accountName.optional(),
  currency: currencyCode.optional(),
  openingMinor: signedMinor.optional(),
  archived: z.boolean().optional(),
});
export type AccountPatch = z.infer<typeof accountPatchSchema>;

export const accountDeleteQuerySchema = z.object({ version: z.coerce.number().int().positive() });

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).default(HISTORY_PAGE_DEFAULT),
  /** Id of the last row already shown; the page continues with older rows. */
  before: z.string().min(1).max(64).optional(),
});

export const balanceQuerySchema = z.object({ date: isoDate });

export const reconcileCreateSchema = z.object({
  id: z.uuidv7(),
  date: isoDate,
  bankBalanceMinor: signedMinor,
  /** The computed balance the client showed; booking is refused if it no longer matches. */
  shownComputedMinor: signedMinor,
});
export type ReconcileCreate = z.infer<typeof reconcileCreateSchema>;

/** How far the balance as of the last reconciliation's date has moved since it was reconciled. */
export interface ChangedSinceReconcile {
  date: string;
  bankBalanceMinor: number;
  deltaMinor: number;
}

export interface Account {
  id: string;
  name: string;
  currency: CurrencyCode;
  openingMinor: number;
  archivedAt: string | null;
  version: number;
  /** Current balance in the account's own currency. */
  balanceMinor: number;
  /** True once any entry uses the account (as source or destination); its currency is then locked. */
  hasEntries: boolean;
  changedSinceReconcile: ChangedSinceReconcile | null;
}

/** One entry as seen from an account, with the account's balance right after it. */
export interface HistoryRow {
  id: string;
  kind: "expense" | "income" | "transfer" | "adjustment";
  date: string;
  userId: string;
  /** Signed change to this account's balance. */
  deltaMinor: number;
  balanceMinor: number;
  /** For transfers: the other account involved. */
  counterpartAccountId: string | null;
  /** Original amount and currency as entered (may differ from the account's for foreign expenses). */
  amountMinor: number;
  currency: CurrencyCode;
  categoryId: string | null;
  projectId: string | null;
  notes: string | null;
  version: number;
}

export interface HistoryPage {
  rows: HistoryRow[];
  /** Pass as `before` to load older rows; null on the last page. */
  nextBefore: string | null;
}

export interface BalanceAt {
  date: string;
  balanceMinor: number;
}

export interface Reconciliation {
  id: string;
  accountId: string;
  date: string;
  bankBalanceMinor: number;
  computedMinor: number;
  adjustmentEntryId: string | null;
  /** Signed amount booked by the adjustment; null when there was no gap. */
  adjustmentMinor: number | null;
  userId: string;
  createdAt: string;
}

export const RECONCILE_CONFLICT_MESSAGE = "The balance changed since you checked it";

/** 409 body when the computed balance no longer matches the one the client showed. */
export interface ReconcileConflict {
  error: "conflict";
  message: string;
  computedMinor: number;
}
