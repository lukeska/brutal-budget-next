import { z } from "zod";
import { argonParamsSchema, keySchema, saltSchema } from "./auth";
import { CURRENCY_CODES, type CurrencyCode, MAX_ABS_MINOR } from "./money";

const currencySchema = z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]]);

/** True when the runtime knows `value` as an IANA time zone, e.g. "Europe/Rome". */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const nameSchema = z.string().trim().min(1).max(100);

export const setupPartnerSchema = z.object({
  name: nameSchema,
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  salt: saltSchema,
  key: keySchema,
});

/**
 * The first-run setup body. Partner emails must differ; the server relies on the database's unique
 * email index for that, so a clash rolls the whole setup back instead of being caught here.
 */
export const setupRequestSchema = z.object({
  setupToken: z.string().min(1).max(1024),
  baseCurrency: currencySchema,
  timezone: z.string().min(1).max(64).refine(isTimeZone, "unknown time zone"),
  argonParams: argonParamsSchema,
  partners: z.tuple([setupPartnerSchema, setupPartnerSchema]),
  account: z.object({
    name: nameSchema,
    currency: currencySchema,
    openingMinor: z.number().int().min(-MAX_ABS_MINOR).max(MAX_ABS_MINOR),
  }),
  addDefaultCategories: z.boolean(),
});
export type SetupRequest = z.input<typeof setupRequestSchema>;

export const setupStatusSchema = z.object({ needsSetup: z.boolean() });
export type SetupStatus = z.infer<typeof setupStatusSchema>;
