import type { StatsResponse } from "@shared/schemas/stats";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

export const statsQueryKey = (year: number) => ["stats", year] as const;

/** Yearly statistics; the previous year's data stays on screen while the next one loads. */
export function useStats(year: number) {
  return useQuery({
    queryKey: statsQueryKey(year),
    queryFn: () => api.get<StatsResponse>(`/api/stats/${year}`),
    placeholderData: keepPreviousData,
  });
}
