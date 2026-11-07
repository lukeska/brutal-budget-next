import { z } from "zod";
import { keySchema } from "../auth";
import { CURRENCY_CODES, type CurrencyCode } from "../money";

export const THEMES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEMES)[number];

const currencySchema = z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]]);

export type SettingsResponse = {
  me: { id: string; name: string; email: string; secondaryCurrency: string | null; theme: ThemeChoice };
  partner: { id: string; name: string } | null;
  household: { baseCurrency: string; timezone: string };
};

/**
 * A partner's own profile changes. Unknown keys are refused, so an attempt to change the household
 * base currency (fixed after setup) fails validation instead of being silently ignored.
 */
export const profilePatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  /** null clears it. Must differ from the base currency; the server checks that against the household. */
  secondaryCurrency: currencySchema.nullable().optional(),
  theme: z.enum(THEMES).optional(),
});
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

export const emailChangeSchema = z.object({
  currentKey: keySchema,
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
});
export type EmailChange = z.infer<typeof emailChangeSchema>;
