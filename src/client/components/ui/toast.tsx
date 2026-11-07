import { useSyncExternalStore } from "react";
import { Button } from "./button";

type ToastAction = { label: string; onClick: () => void };
type ToastItem = { id: number; message: string; action?: ToastAction };
type ToastOptions = { action?: ToastAction; durationMs?: number };

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Shows a short message, optionally with one action (e.g. Undo). Returns its id. */
export function toast(
  message: string,
  { action, durationMs = action ? 6000 : 4000 }: ToastOptions = {},
): number {
  const id = nextId++;
  items = [...items, { id, message, action }];
  timers.set(
    id,
    setTimeout(() => dismissToast(id), durationMs),
  );
  emit();
  return id;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const getItems = () => items;

/** Mounted once by the root layout. */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribe, getItems, getItems);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex w-full max-w-sm items-center justify-between gap-3 bg-fg py-1 pr-1 pl-4 text-sm text-bg"
        >
          <span className="py-2">{t.message}</span>
          {t.action && (
            <Button
              size="sm"
              className="bg-transparent text-bg underline underline-offset-4 hover:bg-bg/10"
              onClick={() => {
                t.action?.onClick();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
