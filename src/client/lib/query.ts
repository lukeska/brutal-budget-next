import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { ApiError } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // A 4xx will not change on retry; network blips and 5xx get one more try.
      retry: (failureCount, error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1,
    },
  },
});

type Snapshot = Array<[QueryKey, unknown]>;

/**
 * Mutation callbacks for an optimistic update of every cached query under `queryKey`:
 * apply `update` immediately, roll back on error, refetch when settled.
 *
 *   useMutation({ mutationFn, ...optimistic<Month, Vars>(["month", m], (old, vars) => ...) })
 */
export function optimistic<TData, TVariables>(
  queryKey: QueryKey,
  update: (old: TData | undefined, variables: TVariables) => TData | undefined,
  client: QueryClient = queryClient,
) {
  return {
    onMutate: async (variables: TVariables): Promise<{ snapshot: Snapshot }> => {
      await client.cancelQueries({ queryKey });
      const snapshot = client.getQueriesData<TData>({ queryKey });
      client.setQueriesData<TData>({ queryKey }, (old) => update(old, variables));
      return { snapshot };
    },
    onError: (_error: unknown, _variables: TVariables, context: { snapshot: Snapshot } | undefined) => {
      for (const [key, data] of context?.snapshot ?? []) client.setQueryData(key, data);
    },
    onSettled: () => client.invalidateQueries({ queryKey }),
  };
}
