import type { Project, ProjectCreate, ProjectPatch, ProjectSummary } from "@shared/schemas/project";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";

export const projectKeys = {
  all: ["projects"] as const,
  list: () => ["projects", "list"] as const,
  summary: (id: string) => ["projects", "summary", id] as const,
};

/** Every project with its totals, archived ones included and flagged; pickers drop archived ones. */
export function useProjects() {
  return useQuery({ queryKey: projectKeys.list(), queryFn: () => api.get<Project[]>("/api/projects") });
}

export function useProjectSummary(id: string) {
  return useQuery({
    queryKey: projectKeys.summary(id),
    queryFn: () => api.get<ProjectSummary>(`/api/projects/${id}/summary`),
  });
}

function useInvalidateProjects() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: projectKeys.all });
}

export function useCreateProject() {
  const onSettled = useInvalidateProjects();
  return useMutation({
    mutationFn: (input: ProjectCreate) => api.post<Project>("/api/projects", input),
    onSettled,
  });
}

export function useUpdateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: ProjectPatch & { id: string }) =>
      api.patch<Project>(`/api/projects/${id}`, patch),
    // A new name or colour shows on entries everywhere.
    onSettled: () => client.invalidateQueries(),
  });
}

export function useDeleteProject() {
  const onSettled = useInvalidateProjects();
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      api.delete<null>(`/api/projects/${id}?version=${version}`),
    onSettled,
  });
}
