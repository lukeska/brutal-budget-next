import { z } from "zod";
import { entrySchema, yearMonth } from "./entry";
import { latestRatesSchema } from "./stats";

/** The month view. Totals are integer minor units in the household base currency. */

export const monthParamSchema = z.object({ month: yearMonth });
export const monthQuerySchema = z.object({
  /** Limits totals, categories, entries and the waiting count to one partner. */
  userId: z.string().min(1).max(64).optional(),
});

export const monthTotalsSchema = z.object({
  incomeMinor: z.number().int(),
  expenseMinor: z.number().int(),
  netMinor: z.number().int(),
});
export type MonthTotals = z.infer<typeof monthTotalsSchema>;

export const monthSubcategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  /** Always the parent's colour. */
  colour: z.string(),
  totalMinor: z.number().int(),
});
export type MonthSubcategory = z.infer<typeof monthSubcategorySchema>;

export const monthCategorySchema = z.object({
  id: z.string(),
  type: z.enum(["expense", "income"]),
  name: z.string(),
  icon: z.string(),
  colour: z.string(),
  /** The parent's own amount plus all of its subcategories. */
  totalMinor: z.number().int(),
  /** The amount booked directly on the parent, not on a subcategory. */
  ownMinor: z.number().int(),
  children: z.array(monthSubcategorySchema),
});
export type MonthCategory = z.infer<typeof monthCategorySchema>;

/** An entry with the names the list shows already resolved. */
export const monthEntrySchema = entrySchema.extend({
  userName: z.string(),
  accountName: z.string(),
  toAccountName: z.string().nullable(),
  categoryName: z.string().nullable(),
  categoryIcon: z.string().nullable(),
  /** A subcategory reports its parent's colour. */
  categoryColour: z.string().nullable(),
  projectName: z.string().nullable(),
  projectColour: z.string().nullable(),
});
export type MonthEntry = z.infer<typeof monthEntrySchema>;

export const monthResponseSchema = z.object({
  month: z.string(),
  baseCurrency: z.string(),
  totals: monthTotalsSchema,
  /** Expense categories first, then income; each sorted by total, largest first. */
  categories: z.array(monthCategorySchema),
  /** Newest first, including transfers and adjustments. */
  entries: z.array(monthEntrySchema),
  /** Expenses and income still waiting for an exchange rate, left out of every total. */
  waitingCount: z.number().int(),
  latestRates: latestRatesSchema,
});
export type MonthResponse = z.infer<typeof monthResponseSchema>;

export const monthSummariesQuerySchema = z.object({
  from: yearMonth,
  to: yearMonth,
});

export const monthSummarySchema = z.object({
  month: z.string(),
  expenseMinor: z.number().int(),
  incomeMinor: z.number().int(),
});
export type MonthSummary = z.infer<typeof monthSummarySchema>;

export const monthSummariesResponseSchema = z.object({
  baseCurrency: z.string(),
  months: z.array(monthSummarySchema),
});
export type MonthSummariesResponse = z.infer<typeof monthSummariesResponseSchema>;
