import { type CurrencyCode, type ParseAmountResult, parseAmount } from "@shared/money";
import type {
  Account,
  AccountCreate,
  AccountPatch,
  BalanceAt,
  HistoryPage,
  ReconcileCreate,
  Reconciliation,
} from "@shared/schemas/account";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";

/** Root of every account query. Invalidate it after any entry change: balances and history move. */
export const accountsQueryKey = ["accounts"] as const;

const keys = {
  list: () => [...accountsQueryKey, "list"] as const,
  one: (id: string) => [...accountsQueryKey, "one", id] as const,
  history: (id: string) => [...accountsQueryKey, "history", id] as const,
  balanceAt: (id: string, date: string) => [...accountsQueryKey, "balance", id, date] as const,
  reconciliations: (id: string) => [...accountsQueryKey, "reconciliations", id] as const,
};

export function useAccounts() {
  return useQuery({ queryKey: keys.list(), queryFn: () => api.get<Account[]>("/api/accounts") });
}

export function useAccount(id: string) {
  return useQuery({
    queryKey: keys.one(id),
    queryFn: () => api.get<Account>(`/api/accounts/${encodeURIComponent(id)}`),
  });
}

const HISTORY_PAGE = 50;

export function useAccountHistory(id: string) {
  return useInfiniteQuery({
    queryKey: keys.history(id),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(HISTORY_PAGE) });
      if (pageParam) params.set("before", pageParam);
      return api.get<HistoryPage>(`/api/accounts/${encodeURIComponent(id)}/history?${params}`);
    },
    getNextPageParam: (last) => last.nextBefore,
  });
}

/** The computed balance at the end of `date`, for the reconcile dialog. */
export function useBalanceAt(id: string, date: string, enabled = true) {
  return useQuery({
    queryKey: keys.balanceAt(id, date),
    queryFn: () => api.get<BalanceAt>(`/api/accounts/${encodeURIComponent(id)}/balance?date=${date}`),
    enabled: enabled && /^\d{4}-\d{2}-\d{2}$/.test(date),
    staleTime: 0,
  });
}

export function useReconciliations(id: string) {
  return useQuery({
    queryKey: keys.reconciliations(id),
    queryFn: () => api.get<Reconciliation[]>(`/api/accounts/${encodeURIComponent(id)}/reconciliations`),
  });
}

function useInvalidateAccounts() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: accountsQueryKey });
}

export function useCreateAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (input: AccountCreate) => api.post<Account>("/api/accounts", input),
    onSettled: invalidate,
  });
}

export function useUpdateAccount(id: string) {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (patch: AccountPatch) => api.patch<Account>(`/api/accounts/${encodeURIComponent(id)}`, patch),
    onSettled: invalidate,
  });
}

export function useDeleteAccount(id: string) {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (version: number) =>
      api.delete<null>(`/api/accounts/${encodeURIComponent(id)}?version=${version}`),
    onSettled: invalidate,
  });
}

export function useBookReconciliation(accountId: string) {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (input: ReconcileCreate) =>
      api.post<Reconciliation>(`/api/accounts/${encodeURIComponent(accountId)}/reconciliations`, input),
    onSettled: invalidate,
  });
}

export function useDeleteReconciliation() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (id: string) => api.delete<null>(`/api/reconciliations/${encodeURIComponent(id)}`),
    onSettled: invalidate,
  });
}

/** Parses a typed amount that may be negative (overdrawn accounts, credit cards). */
export function parseSignedAmount(input: string, currency: CurrencyCode): ParseAmountResult {
  const trimmed = input.trim().replace(/^[\u2212]/, "-");
  const negative = trimmed.startsWith("-");
  const result = parseAmount(negative ? trimmed.slice(1) : trimmed, currency);
  return result.ok && negative ? { ok: true, minor: -result.minor } : result;
}
