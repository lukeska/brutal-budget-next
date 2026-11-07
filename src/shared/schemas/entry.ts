import { CURRENCY_CODES, type CurrencyCode, MAX_ABS_MINOR } from "@shared/money";
import { z } from "zod";

/** Entry payloads shared by the API and the client. Money is integer minor units. */

export const NOTES_MAX = 500;
export const CONFLICT_MESSAGE = "This changed since you opened it — reload";

export const isoDate = z.iso.date("Expected a YYYY-MM-DD date");
export const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected a YYYY-MM month");
export const currencyCode = z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]]);
const refId = z.string().min(1).max(64);
const amountMinor = z.number().int().positive().max(MAX_ABS_MINOR);
const notes = z.string().max(NOTES_MAX).nullish();

/**
 * Sent by Undo when it re-creates a deleted entry: references archived since are accepted (as on an
 * edit), and an imported entry gets its fingerprint and batch back.
 */
const restore = z
  .object({
    fingerprint: z.string().min(1).max(128).nullish(),
    importBatchId: refId.nullish(),
  })
  .optional();

const common = {
  id: z.uuidv7(),
  date: isoDate,
  accountId: refId,
  /** Which partner the entry belongs to; defaults to the signed-in partner. */
  userId: refId.optional(),
  notes,
  restore,
};

const categorised = {
  ...common,
  /** Original amount, in `currency`. */
  amountMinor,
  currency: currencyCode,
  /** Amount booked to the account; required when `currency` differs from the account's. */
  accountAmountMinor: amountMinor.optional(),
  categoryId: refId,
  projectId: refId.nullish(),
};

export const expenseCreateSchema = z.object({ kind: z.literal("expense"), ...categorised });
export const incomeCreateSchema = z.object({ kind: z.literal("income"), ...categorised });
export const transferCreateSchema = z.object({
  kind: z.literal("transfer"),
  ...common,
  toAccountId: refId,
  /** Amount that left `accountId`, in its currency. */
  amountMinor,
  /** Amount that arrived in `toAccountId`; required when the two currencies differ. */
  toAmountMinor: amountMinor.optional(),
});

export const entryCreateSchema = z.discriminatedUnion("kind", [
  expenseCreateSchema,
  incomeCreateSchema,
  transferCreateSchema,
]);
export type EntryCreate = z.infer<typeof entryCreateSchema>;

/** A partial edit. `version` is the one the client loaded; `kind` may be sent but can't change. */
export const entryPatchSchema = z.object({
  version: z.number().int().positive(),
  kind: z.enum(["expense", "income", "transfer", "adjustment"]).optional(),
  date: isoDate.optional(),
  userId: refId.optional(),
  accountId: refId.optional(),
  amountMinor: amountMinor.optional(),
  currency: currencyCode.optional(),
  accountAmountMinor: amountMinor.optional(),
  toAccountId: refId.optional(),
  toAmountMinor: amountMinor.optional(),
  categoryId: refId.optional(),
  projectId: refId.nullish(),
  notes,
});
export type EntryPatch = z.infer<typeof entryPatchSchema>;

export const entryListQuerySchema = z.object({
  month: yearMonth.optional(),
  /** Matches entries from or into this account. */
  accountId: refId.optional(),
  categoryId: refId.optional(),
  projectId: refId.optional(),
  userId: refId.optional(),
});
export type EntryListQuery = z.infer<typeof entryListQuerySchema>;

export const entryDeleteQuerySchema = z.object({ version: z.coerce.number().int().positive() });

export const entrySchema = z.object({
  id: z.string(),
  kind: z.enum(["expense", "income", "transfer", "adjustment"]),
  date: z.string(),
  userId: z.string(),
  /** Original amount and currency (equal to the account's when no conversion happened). */
  amountMinor: z.number(),
  currency: currencyCode,
  accountId: z.string(),
  accountCurrency: currencyCode,
  /** Amount booked to the account (signed for adjustments). */
  accountAmountMinor: z.number(),
  toAccountId: z.string().nullable(),
  toCurrency: currencyCode.nullable(),
  toAmountMinor: z.number().nullable(),
  /** Value in the household base currency; null while waiting for a rate. */
  baseAmountMinor: z.number().nullable(),
  fxState: z.enum(["fixed", "waiting", "provisional"]),
  rateScaled: z.number().nullable(),
  rateDate: z.string().nullable(),
  categoryId: z.string().nullable(),
  projectId: z.string().nullable(),
  notes: z.string().nullable(),
  /** Duplicate-detection key of an imported entry; null for entries made in the app. */
  fingerprint: z.string().nullable(),
  importBatchId: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Entry = z.infer<typeof entrySchema>;

export interface EntryDefaults {
  lastAccountByKind: Partial<Record<"expense" | "income" | "transfer", string>>;
  topCategories: { expense: string[]; income: string[] };
}

export interface ValidationIssue {
  path: (string | number)[];
  message: string;
}
