import type {
  Category,
  CategoryCreate,
  CategoryMergeResult,
  CategoryNode,
  CategoryPatch,
  CategorySummary,
  CategoryType,
} from "@shared/schemas/category";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { invalidateEntryViews } from "../entries/api";

export const categoryKeys = {
  all: ["categories"] as const,
  list: (type?: CategoryType) => ["categories", "list", type ?? "all"] as const,
  summary: (id: string, month?: string) => ["categories", "summary", id, month ?? "current"] as const,
};

/**
 * The category tree (parents with their subcategories), archived ones included and flagged.
 * Pickers should drop archived categories, and subcategories of an archived parent, themselves.
 */
export function useCategories(type?: CategoryType) {
  return useQuery({
    queryKey: categoryKeys.list(type),
    queryFn: () => api.get<CategoryNode[]>(type ? `/api/categories?type=${type}` : "/api/categories"),
  });
}

/** Categories a picker may offer: not archived, and not under an archived parent. */
export function activeCategories(tree: CategoryNode[]): CategoryNode[] {
  return tree
    .filter((c) => !c.archived)
    .map((c) => ({ ...c, children: c.children.filter((child) => !child.archived) }));
}

export function useCategorySummary(id: string, month?: string) {
  return useQuery({
    queryKey: categoryKeys.summary(id, month),
    queryFn: () => api.get<CategorySummary>(`/api/categories/${id}/summary${month ? `?month=${month}` : ""}`),
    // Switching months keeps the bars on screen while the new month's entries load.
    placeholderData: keepPreviousData,
  });
}

/** Merges and deletions also move or drop entries, so month and statistics caches refresh too. */
function useInvalidateAll() {
  const client = useQueryClient();
  return () => invalidateEntryViews(client);
}

function useInvalidateCategories() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: categoryKeys.all });
}

export function useCreateCategory() {
  const onSettled = useInvalidateCategories();
  return useMutation({
    mutationFn: (input: CategoryCreate) => api.post<Category>("/api/categories", input),
    onSettled,
  });
}

export function useUpdateCategory() {
  const onSettled = useInvalidateAll();
  return useMutation({
    mutationFn: ({ id, ...patch }: CategoryPatch & { id: string }) =>
      api.patch<Category>(`/api/categories/${id}`, patch),
    onSettled,
  });
}

export function useDeleteCategory() {
  const onSettled = useInvalidateCategories();
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      api.delete<null>(`/api/categories/${id}?version=${version}`),
    onSettled,
  });
}

export function useMergeCategory() {
  const onSettled = useInvalidateAll();
  return useMutation({
    mutationFn: ({ id, targetId, version }: { id: string; targetId: string; version: number }) =>
      api.post<CategoryMergeResult>(`/api/categories/${id}/merge`, { targetId, version }),
    onSettled,
  });
}
