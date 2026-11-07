import type { Entry, EntryCreate, EntryDefaults, EntryPatch } from "@shared/schemas/entry";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "../../components/ui/toast";
import { ApiError, api } from "../../lib/api";
import { accountsQueryKey } from "../accounts/api";
import { categoryKeys } from "../categories/api";
import { projectKeys } from "../projects/api";

export const entryKeys = {
  all: ["entries"] as const,
  detail: (id: string) => ["entries", "detail", id] as const,
  defaults: () => ["entries", "defaults"] as const,
};

/** Month and statistics views cache under these roots; any entry change refreshes them. */
export const monthQueryRoot = ["month"] as const;
const statsQueryRoot = ["stats"] as const;

/** Refreshes every view whose numbers depend on entries. */
export function invalidateEntryViews(client: QueryClient): Promise<unknown> {
  return Promise.all(
    [entryKeys.all, monthQueryRoot, statsQueryRoot, accountsQueryKey, categoryKeys.all, projectKeys.all].map(
      (queryKey) => client.invalidateQueries({ queryKey }),
    ),
  );
}

export function useEntry(id: string | undefined) {
  return useQuery({
    queryKey: entryKeys.detail(id ?? ""),
    queryFn: () => api.get<Entry>(`/api/entries/${id}`),
    enabled: Boolean(id),
  });
}

export function useEntryDefaults() {
  return useQuery({
    queryKey: entryKeys.defaults(),
    queryFn: () => api.get<EntryDefaults>("/api/entries/defaults"),
  });
}

export function useCreateEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EntryCreate) => api.post<Entry>("/api/entries", input),
    onSettled: () => invalidateEntryViews(client),
  });
}

export function useUpdateEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: EntryPatch }) =>
      api.patch<Entry>(`/api/entries/${id}`, patch),
    onSettled: () => invalidateEntryViews(client),
  });
}

/** The create payload that restores a deleted entry under its original id. */
export function restorePayload(entry: Entry): EntryCreate {
  const base = {
    id: entry.id,
    date: entry.date,
    accountId: entry.accountId,
    userId: entry.userId,
    notes: entry.notes,
  };
  if (entry.kind === "transfer") {
    return {
      ...base,
      kind: "transfer",
      toAccountId: entry.toAccountId ?? "",
      amountMinor: entry.accountAmountMinor,
      toAmountMinor: entry.toAmountMinor ?? undefined,
    };
  }
  if (entry.kind !== "expense" && entry.kind !== "income") {
    throw new Error("Only expenses, income and transfers can be restored");
  }
  return {
    ...base,
    kind: entry.kind,
    amountMinor: entry.amountMinor,
    currency: entry.currency,
    accountAmountMinor: entry.currency === entry.accountCurrency ? undefined : entry.accountAmountMinor,
    categoryId: entry.categoryId ?? "",
    projectId: entry.projectId,
  };
}

export function deleteFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409)
    return "Not deleted — it changed since you opened it";
  if (error instanceof TypeError) return "Not deleted — offline";
  return "Not deleted — try again";
}

/**
 * Deletes right away (so a closed or backgrounded app can never lose a delete the partner saw happen)
 * and offers Undo, which re-creates the entry with its original id. A failed delete brings the row back.
 */
export function useDeleteEntry() {
  const client = useQueryClient();
  const restore = useCreateEntry();
  return useMutation({
    mutationFn: (entry: Entry) => api.delete<void>(`/api/entries/${entry.id}?version=${entry.version}`),
    onSuccess: (_data, entry) => {
      toast("Entry deleted", {
        action: {
          label: "Undo",
          onClick: () => {
            // Per-call promise, so overlapping restores each report their own failure.
            restore
              .mutateAsync(restorePayload(entry))
              .catch(() => toast("Couldn't restore the entry — try again"));
          },
        },
      });
    },
    onError: (error) => toast(deleteFailureMessage(error)),
    onSettled: () => invalidateEntryViews(client),
  });
}
