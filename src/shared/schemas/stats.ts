import { z } from "zod";

/** Yearly statistics. Money is integer minor units in the household base currency. */

export const statsYearSchema = z.object({
  year: z.string().regex(/^\d{4}$/, "Expected a four-digit year"),
});

export const statsMonthSchema = z.object({
  /** `YYYY-MM`. */
  month: z.string(),
  incomeMinor: z.number().int(),
  expenseMinor: z.number().int(),
  netMinor: z.number().int(),
});
export type StatsMonth = z.infer<typeof statsMonthSchema>;

export const statsCategorySchema = z.object({
  /** Always a top-level category; subcategory amounts are rolled up into it. */
  categoryId: z.string(),
  name: z.string(),
  colour: z.string(),
  icon: z.string(),
  type: z.enum(["expense", "income"]),
  /** Twelve amounts, January to December. */
  months: z.array(z.number().int()).length(12),
  totalMinor: z.number().int(),
});
export type StatsCategory = z.infer<typeof statsCategorySchema>;

/** The newest stored exchange rates: units per 1 EUR, scaled by 10^10. */
export const latestRatesSchema = z.object({
  date: z.string().nullable(),
  rates: z.record(z.string(), z.number().int()),
});
export type LatestRates = z.infer<typeof latestRatesSchema>;

export const statsResponseSchema = z.object({
  year: z.number().int(),
  baseCurrency: z.string(),
  months: z.array(statsMonthSchema).length(12),
  byCategory: z.array(statsCategorySchema),
  /** Expenses and income in the year still waiting for an exchange rate, left out of every total. */
  waitingCount: z.number().int(),
  latestRates: latestRatesSchema,
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;
