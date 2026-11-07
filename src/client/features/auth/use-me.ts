import type { MeResponse } from "@shared/auth";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../lib/api";

export const meQueryKey = ["auth", "me"] as const;

/** Shared by `useMe()` and the root route gate, so both read one cache entry. */
export const meQueryOptions = queryOptions({
  queryKey: meQueryKey,
  queryFn: async (): Promise<MeResponse | null> => {
    try {
      return await api.get<MeResponse>("/api/auth/me");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
});

/** The logged-in partner; `data` is null when there is no valid session. */
export function useMe() {
  return useQuery(meQueryOptions);
}
