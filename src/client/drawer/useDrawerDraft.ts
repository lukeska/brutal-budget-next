import { useMemo } from "react";
import type { EntryForm } from "./form";

const PREFIX = "bb:entry-draft";

export function draftKey(userId: string, mode: "create" | "edit", entryId?: string): string {
  return mode === "edit" ? `${PREFIX}:${userId}:edit:${entryId}` : `${PREFIX}:${userId}:create`;
}

export interface DrawerDraft {
  load(): EntryForm | null;
  save(form: EntryForm): void;
  clear(): void;
}

/**
 * The unsaved form, kept in sessionStorage per partner (and per entry when editing) until the
 * server confirms the save or the partner cancels. It survives the drawer closing on a trip to
 * the login screen, so a draft typed before a session expired comes back after logging in again.
 * Storage can be unavailable (private mode, blocked site data): the drawer then works without drafts.
 */
export function useDrawerDraft(key: string | null): DrawerDraft {
  return useMemo(
    () => ({
      load() {
        if (!key) return null;
        try {
          const raw = sessionStorage.getItem(key);
          if (!raw) return null;
          const parsed: unknown = JSON.parse(raw);
          return parsed && typeof parsed === "object" && "kind" in parsed && "id" in parsed
            ? (parsed as EntryForm)
            : null;
        } catch {
          return null;
        }
      },
      save(form) {
        if (!key) return;
        try {
          sessionStorage.setItem(key, JSON.stringify(form));
        } catch {
          // No storage: the form still works, it just won't survive a reload.
        }
      },
      clear() {
        if (!key) return;
        try {
          sessionStorage.removeItem(key);
        } catch {
          // Nothing stored.
        }
      },
    }),
    [key],
  );
}
