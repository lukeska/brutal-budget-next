import type { MonthResponse } from "@shared/schemas/month";
import { keepPreviousData, type QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { todayIn } from "../../lib/date";
import { monthQueryRoot } from "../entries/api";

/** Under the month root, so any entry change refreshes every cached month. */
export const monthQueryKey = (month: string, userId?: string) =>
  [...monthQueryRoot, month, userId ?? "all"] as const;

function monthOptions(month: string, userId?: string) {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : "";
  return {
    queryKey: monthQueryKey(month, userId),
    queryFn: () => api.get<MonthResponse>(`/api/month/${month}${query}`),
  };
}

/** One month of the household; the previous month stays on screen while the next one loads. */
export function useMonth(month: string, userId?: string) {
  return useQuery({ ...monthOptions(month, userId), placeholderData: keepPreviousData });
}

export function prefetchMonth(client: QueryClient, month: string, userId?: string): Promise<void> {
  return client.prefetchQuery({ ...monthOptions(month, userId), staleTime: 30_000 });
}

/** `YYYY-MM` shifted by `delta` months. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export function currentMonth(now = new Date()): string {
  return todayIn(undefined, now).slice(0, 7);
}
