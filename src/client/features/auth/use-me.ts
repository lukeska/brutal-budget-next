import type { MeResponse } from "@shared/auth";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../lib/api";

export const meQueryKey = ["auth", "me"] as const;

/** The logged-in partner; `data` is null when there is no valid session. */
export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: async () => {
      try {
        return await api.get<MeResponse>("/api/auth/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });
}
