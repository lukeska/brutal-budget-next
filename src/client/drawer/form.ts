import { type CurrencyCode, minorToDecimalString, parseAmount } from "@shared/money";
import { type Entry, type EntryCreate, type EntryPatch, NOTES_MAX } from "@shared/schemas/entry";
import type { EntryKind } from "./store";

/** Everything the drawer form holds, as typed strings. Saved as-is in the session draft. */
export interface EntryForm {
  kind: EntryKind;
  /** Client-generated id for a create; the entry's id when editing. Kept so a retry resends it. */
  id: string;
  /** The version loaded for an edit (0 for a create). */
  version: number;
  amount: string;
  /** Original currency of an expense or income. Ignored for transfers. */
  currency: CurrencyCode;
  accountId: string;
  /** Amount booked to the account, when `currency` differs from the account's. */
  accountAmount: string;
  /** True once the partner typed the account amount: rate prefills then leave it alone. */
  accountAmountTouched: boolean;
  toAccountId: string;
  /** Amount that arrived, when a transfer's two accounts use different currencies. */
  toAmount: string;
  toAmountTouched: boolean;
  categoryId: string;
  date: string;
  userId: string;
  projectId: string;
  notes: string;
}

/** Field errors keyed like the API's validation issue paths. */
export type FieldErrors = Partial<Record<string, string>>;

export type AccountCurrencies = (accountId: string) => CurrencyCode | undefined;

export type FormResult<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function amountError(
  input: string,
  currency: CurrencyCode,
  empty: string,
): { minor: number; error?: undefined } | { minor?: undefined; error: string } {
  if (input.trim() === "") return { error: empty };
  const parsed = parseAmount(input, currency);
  if (!parsed.ok) {
    if (parsed.error === "too_many_decimals")
      return {
        error: currency === "JPY" || currency === "ISK" ? `${currency} has no decimals` : "Too many decimals",
      };
    if (parsed.error === "too_large") return { error: "Amount is too large" };
    return { error: "Enter a number, like 12.50" };
  }
  if (parsed.minor <= 0) return { error: "Amount must be more than zero" };
  return { minor: parsed.minor };
}

/** True when the account amount field applies: a foreign-currency expense or income. */
export function needsAccountAmount(form: EntryForm, currencyOf: AccountCurrencies): boolean {
  if (form.kind === "transfer") return false;
  const accountCurrency = currencyOf(form.accountId);
  return accountCurrency !== undefined && accountCurrency !== form.currency;
}

/** True when the "Arrived" field applies: a transfer between accounts of different currencies. */
export function needsToAmount(form: EntryForm, currencyOf: AccountCurrencies): boolean {
  if (form.kind !== "transfer") return false;
  const from = currencyOf(form.accountId);
  const to = currencyOf(form.toAccountId);
  return from !== undefined && to !== undefined && from !== to;
}

type Parsed = {
  amountMinor: number;
  accountAmountMinor?: number;
  toAmountMinor?: number;
};

function parse(form: EntryForm, currencyOf: AccountCurrencies): FormResult<Parsed> {
  const errors: FieldErrors = {};
  const accountCurrency = currencyOf(form.accountId);
  if (!form.accountId || !accountCurrency) errors.accountId = "Choose an account";
  if (!DATE_PATTERN.test(form.date)) errors.date = "Choose a date";
  if (form.notes.length > NOTES_MAX) errors.notes = `Keep notes under ${NOTES_MAX} characters`;

  const amountCurrency = form.kind === "transfer" ? (accountCurrency ?? form.currency) : form.currency;
  const amount = amountError(form.amount, amountCurrency, "Enter an amount");
  if (amount.error) errors.amountMinor = amount.error;

  const parsed: Parsed = { amountMinor: amount.minor ?? 0 };

  if (form.kind === "transfer") {
    if (!form.toAccountId || !currencyOf(form.toAccountId)) errors.toAccountId = "Choose an account";
    else if (form.toAccountId === form.accountId) errors.toAccountId = "Choose two different accounts";
    if (needsToAmount(form, currencyOf)) {
      const to = amountError(
        form.toAmount,
        currencyOf(form.toAccountId) as CurrencyCode,
        "Enter the amount that arrived",
      );
      if (to.error) errors.toAmountMinor = to.error;
      else parsed.toAmountMinor = to.minor;
    }
  } else {
    if (!form.categoryId) errors.categoryId = "Choose a category";
    if (needsAccountAmount(form, currencyOf)) {
      const booked = amountError(
        form.accountAmount,
        accountCurrency as CurrencyCode,
        `Enter the amount in ${accountCurrency}`,
      );
      if (booked.error) errors.accountAmountMinor = booked.error;
      else parsed.accountAmountMinor = booked.minor;
    }
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value: parsed };
}

function notesValue(notes: string): string | null {
  const trimmed = notes.trim();
  return trimmed === "" ? null : trimmed;
}

/** Validates the form and builds the create request. */
export function toEntryCreate(form: EntryForm, currencyOf: AccountCurrencies): FormResult<EntryCreate> {
  const result = parse(form, currencyOf);
  if (!result.ok) return result;
  const { amountMinor, accountAmountMinor, toAmountMinor } = result.value;
  const common = {
    id: form.id,
    date: form.date,
    accountId: form.accountId,
    userId: form.userId || undefined,
    notes: notesValue(form.notes),
  };
  if (form.kind === "transfer") {
    return {
      ok: true,
      value: {
        ...common,
        kind: "transfer",
        toAccountId: form.toAccountId,
        amountMinor,
        ...(toAmountMinor === undefined ? {} : { toAmountMinor }),
      },
    };
  }
  return {
    ok: true,
    value: {
      ...common,
      kind: form.kind,
      amountMinor,
      currency: form.currency,
      ...(accountAmountMinor === undefined ? {} : { accountAmountMinor }),
      categoryId: form.categoryId,
      projectId: form.projectId || null,
    },
  };
}

/** Validates the form and builds the edit request, carrying the version the form was loaded at. */
export function toEntryPatch(form: EntryForm, currencyOf: AccountCurrencies): FormResult<EntryPatch> {
  const result = parse(form, currencyOf);
  if (!result.ok) return result;
  const { amountMinor, accountAmountMinor, toAmountMinor } = result.value;
  const common = {
    version: form.version,
    kind: form.kind,
    date: form.date,
    userId: form.userId || undefined,
    accountId: form.accountId,
    amountMinor,
    notes: notesValue(form.notes),
  };
  if (form.kind === "transfer") {
    return {
      ok: true,
      value: {
        ...common,
        toAccountId: form.toAccountId,
        ...(toAmountMinor === undefined ? {} : { toAmountMinor }),
      },
    };
  }
  return {
    ok: true,
    value: {
      ...common,
      currency: form.currency,
      ...(accountAmountMinor === undefined ? {} : { accountAmountMinor }),
      categoryId: form.categoryId,
      projectId: form.projectId || null,
    },
  };
}

/** The form for editing a saved expense, income or transfer. */
export function formFromEntry(entry: Entry): EntryForm {
  const kind: EntryKind = entry.kind === "adjustment" ? "expense" : entry.kind;
  const foreign = entry.kind !== "transfer" && entry.currency !== entry.accountCurrency;
  const crossCurrencyTransfer =
    entry.kind === "transfer" && entry.toCurrency !== null && entry.toCurrency !== entry.accountCurrency;
  return {
    kind,
    id: entry.id,
    version: entry.version,
    amount:
      entry.kind === "transfer"
        ? minorToDecimalString(entry.accountAmountMinor, entry.accountCurrency)
        : minorToDecimalString(entry.amountMinor, entry.currency),
    currency: entry.kind === "transfer" ? entry.accountCurrency : entry.currency,
    accountId: entry.accountId,
    accountAmount: foreign ? minorToDecimalString(entry.accountAmountMinor, entry.accountCurrency) : "",
    accountAmountTouched: foreign,
    toAccountId: entry.toAccountId ?? "",
    toAmount:
      crossCurrencyTransfer && entry.toAmountMinor !== null && entry.toCurrency
        ? minorToDecimalString(entry.toAmountMinor, entry.toCurrency)
        : "",
    toAmountTouched: crossCurrencyTransfer,
    categoryId: entry.categoryId ?? "",
    date: entry.date,
    userId: entry.userId,
    projectId: entry.projectId ?? "",
    notes: entry.notes ?? "",
  };
}

/** Maps a 422 response's issues to field errors; issues without a known field go under `form`. */
export function errorsFromIssues(issues: { path: (string | number)[]; message: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = typeof issue.path[0] === "string" ? issue.path[0] : "form";
    errors[key] ??= issue.message;
  }
  return errors;
}
