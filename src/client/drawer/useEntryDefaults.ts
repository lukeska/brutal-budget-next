import { convertMinor, type ScaledRates } from "@shared/fx-math";
import type { CurrencyCode } from "@shared/money";
import type { Account } from "@shared/schemas/account";
import type { EntryDefaults } from "@shared/schemas/entry";
import { useQuery } from "@tanstack/react-query";
import { v7 as uuidv7 } from "uuid";
import { useAccounts } from "../features/accounts/api";
import { useMe } from "../features/auth/use-me";
import { useEntryDefaults } from "../features/entries/api";
import { useSettings } from "../features/settings/api";
import { api } from "../lib/api";
import type { EntryForm } from "./form";
import type { EntryKind } from "./store";

export interface Partner {
  id: string;
  name: string;
}

/** Today's date (YYYY-MM-DD) in `timeZone`, or in the browser's zone when it's missing or unknown. */
export function todayIn(timeZone: string | undefined, now: Date = new Date()): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
    } catch {
      // Unknown zone: fall through to the browser's date.
    }
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface DrawerDefaults {
  /** False until the accounts and the signed-in partner are known. */
  ready: boolean;
  meId: string;
  partners: Partner[];
  today: string;
  /** Every account (archived ones included, for editing old entries). */
  accounts: Account[];
  activeAccounts: Account[];
  topCategories: EntryDefaults["topCategories"];
  currencyOf: (accountId: string) => CurrencyCode | undefined;
  /** The account a new entry of this kind starts on: the partner's last one, else the first active one. */
  accountFor: (kind: EntryKind) => Account | undefined;
  /** A fresh form for a new entry, with a new client id. */
  newForm: (kind: EntryKind) => EntryForm;
}

/**
 * The drawer's smart defaults: partner = me, date = today in the household's time zone,
 * account = the last account this partner used for the kind, currency = that account's.
 * There is never a default category; the partner's most used ones are offered as chips instead.
 */
export function useDrawerDefaults(): DrawerDefaults {
  const me = useMe();
  const settings = useSettings();
  const accountsQuery = useAccounts();
  const defaults = useEntryDefaults();

  const accounts = accountsQuery.data ?? [];
  const activeAccounts = accounts.filter((a) => a.archivedAt === null);
  const meId = me.data?.id ?? settings.data?.me.id ?? "";
  const partners: Partner[] = settings.data
    ? [settings.data.me, ...(settings.data.partner ? [settings.data.partner] : [])].map(({ id, name }) => ({
        id,
        name,
      }))
    : me.data
      ? [{ id: me.data.id, name: me.data.name }]
      : [];
  const today = todayIn(settings.data?.household.timezone);
  const lastAccountByKind = defaults.data?.lastAccountByKind ?? {};
  const topCategories = defaults.data?.topCategories ?? { expense: [], income: [] };

  const currencyOf = (accountId: string) => accounts.find((a) => a.id === accountId)?.currency;
  const accountFor = (kind: EntryKind) => {
    const lastId = lastAccountByKind[kind];
    return activeAccounts.find((a) => a.id === lastId) ?? activeAccounts[0];
  };

  const ready =
    Boolean(meId) &&
    accountsQuery.isSuccess &&
    !defaults.isPending &&
    // Settings give the time zone and the partner list; wait for them unless they failed.
    !settings.isPending;

  const newForm = (kind: EntryKind): EntryForm => {
    const account = accountFor(kind);
    const toAccount = activeAccounts.find((a) => a.id !== account?.id);
    return {
      kind,
      id: uuidv7(),
      version: 0,
      amount: "",
      currency: account?.currency ?? "EUR",
      accountId: account?.id ?? "",
      accountAmount: "",
      accountAmountTouched: false,
      toAccountId: kind === "transfer" ? (toAccount?.id ?? "") : "",
      toAmount: "",
      toAmountTouched: false,
      categoryId: "",
      date: today,
      userId: meId,
      projectId: "",
      notes: "",
    };
  };

  return {
    ready,
    meId,
    partners,
    today,
    accounts,
    activeAccounts,
    topCategories,
    currencyOf,
    accountFor,
    newForm,
  };
}

type PastRates = {
  status: "ok" | "unavailable";
  days: { date: string; rates: Record<string, { rateScaled: number }> }[];
};
type LatestRates = { status: "ok" | "unavailable"; date: string | null; rates: Record<string, number> };

export type Prefill =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "ok"; minor: number };

/**
 * The amount in `to` that `amountMinor` of `from` is worth on `date`: that day's rate for past and
 * current dates, the latest published rate for future ones. "unavailable" when no rate is known.
 */
export function useConvertedPrefill(input: {
  amountMinor: number | null;
  from: CurrencyCode | undefined;
  to: CurrencyCode | undefined;
  date: string;
  today: string;
}): Prefill {
  const { amountMinor, from, to, date, today } = input;
  const active = Boolean(from && to && from !== to && /^\d{4}-\d{2}-\d{2}$/.test(date));
  const future = date > today;

  const past = useQuery({
    queryKey: ["rates", "day", date],
    queryFn: () => api.get<PastRates>(`/api/rates?date=${date}`),
    enabled: active && !future,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const latest = useQuery({
    queryKey: ["rates", "latest"],
    queryFn: () => api.get<LatestRates>("/api/rates/latest"),
    enabled: active && future,
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (!active || !from || !to) return { state: "idle" };
  const query = future ? latest : past;
  if (query.isPending) return { state: "loading" };

  let rates: ScaledRates | undefined;
  if (future) {
    if (latest.data?.status === "ok") rates = latest.data.rates as ScaledRates;
  } else {
    const day = past.data?.days.find((d) => d.date === date);
    if (day) {
      rates = Object.fromEntries(
        Object.entries(day.rates).map(([code, r]) => [code, r.rateScaled]),
      ) as ScaledRates;
    }
  }
  const hasRate = (code: CurrencyCode) => code === "EUR" || rates?.[code] !== undefined;
  if (!rates || !hasRate(from) || !hasRate(to)) return { state: "unavailable" };
  if (amountMinor === null) return { state: "idle" };
  return { state: "ok", minor: convertMinor({ amountMinor, from, to, rates }) };
}
