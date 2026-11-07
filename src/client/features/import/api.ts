import type {
  CsvRow,
  ImportBatch,
  ImportBatchCreate,
  ImportCheckResponse,
  ImportCheckResult,
  ImportRowFailure,
  ImportRowsResponse,
  ImportUndoPreview,
} from "@shared/schemas/csv";
import { IMPORT_CHUNK_SIZE } from "@shared/schemas/csv";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { invalidateEntryViews } from "../entries/api";
import { chunk, rateWindows } from "./parse";

export const importKeys = {
  batches: ["import", "batches"] as const,
};

export function useImportBatches() {
  return useQuery({
    queryKey: importKeys.batches,
    queryFn: () => api.get<ImportBatch[]>("/api/import/batches"),
  });
}

type Progress = (done: number, total: number) => void;

/** Asks the server which rows are already stored, one chunk at a time. */
export async function checkRows(rows: CsvRow[], onProgress?: Progress): Promise<ImportCheckResult[]> {
  const results: ImportCheckResult[] = [];
  for (const part of chunk(rows, IMPORT_CHUNK_SIZE)) {
    const res = await api.post<ImportCheckResponse>("/api/import/check", { rows: part });
    results.push(...res.results);
    onProgress?.(results.length, rows.length);
  }
  return results;
}

/** Makes sure exchange rates are stored for [from, to], one request per window of at most 90 days. */
export async function fillRates(
  range: { from: string; to: string },
  onProgress?: Progress,
): Promise<boolean> {
  const windows = rateWindows(range.from, range.to);
  let complete = true;
  for (const [i, w] of windows.entries()) {
    const res = await api.get<{ status: "ok" | "unavailable" }>(`/api/rates?from=${w.from}&to=${w.to}`);
    if (res.status !== "ok") complete = false;
    onProgress?.(i + 1, windows.length);
  }
  return complete;
}

export interface CommitSummary {
  batchId: string;
  inserted: number;
  skipped: number;
  failed: ImportRowFailure[];
}

/** Stores rows under an existing batch, one chunk at a time. */
export async function commitRows(
  batchId: string,
  rows: CsvRow[],
  onProgress?: Progress,
): Promise<CommitSummary> {
  const summary: CommitSummary = { batchId, inserted: 0, skipped: 0, failed: [] };
  let done = 0;
  for (const part of chunk(rows, IMPORT_CHUNK_SIZE)) {
    const res = await api.post<ImportRowsResponse>(
      `/api/import/batches/${encodeURIComponent(batchId)}/rows`,
      {
        rows: part,
      },
    );
    summary.inserted += res.inserted;
    summary.skipped += res.skipped;
    summary.failed.push(...res.failed);
    done += part.length;
    onProgress?.(done, rows.length);
  }
  return summary;
}

export function createBatch(input: ImportBatchCreate): Promise<ImportBatch> {
  return api.post<ImportBatch>("/api/import/batches", input);
}

export function undoPreview(batchId: string): Promise<ImportUndoPreview> {
  return api.get<ImportUndoPreview>(`/api/import/batches/${encodeURIComponent(batchId)}/undo-preview`);
}

/** Imports change entries, categories, projects and balances everywhere. */
export function useRefreshAfterImport() {
  const client = useQueryClient();
  return () => {
    void invalidateEntryViews(client);
    void client.invalidateQueries({ queryKey: importKeys.batches });
  };
}

export function useUndoBatch() {
  const refresh = useRefreshAfterImport();
  return useMutation({
    mutationFn: (batchId: string) =>
      api.delete<null>(`/api/import/batches/${encodeURIComponent(batchId)}?confirm=1`),
    onSettled: refresh,
  });
}
