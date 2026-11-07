import { assertCurrencyCode, type CurrencyCode } from "@shared/money";
import { HttpError } from "../lib/errors";

export const HOUSEHOLD_SQL = "SELECT base_currency, timezone FROM household WHERE id = 1";

export interface HouseholdRow {
  base_currency: string;
  timezone: string;
}

export interface Household {
  baseCurrency: CurrencyCode;
  timezone: string;
}

/** Throws 409 `not_set_up` when there is no household row. */
export function parseHousehold(row: HouseholdRow | null | undefined): Household {
  if (!row) throw new HttpError(409, "not_set_up");
  assertCurrencyCode(row.base_currency);
  return { baseCurrency: row.base_currency, timezone: row.timezone };
}

/** The raw household row, or null before setup. Never throws for a missing row. */
export function readHouseholdRow(d1: D1Database): Promise<HouseholdRow | null> {
  return d1.prepare(HOUSEHOLD_SQL).first<HouseholdRow>();
}

export async function loadHousehold(d1: D1Database): Promise<Household> {
  return parseHousehold(await readHouseholdRow(d1));
}
