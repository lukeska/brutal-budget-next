import { openCreate } from "../drawer/store";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";

type AddButtonProps = {
  /** "floating": round button bottom-right on phones. "bar": "+ Add" in the desktop top bar. */
  variant: "floating" | "bar";
  className?: string;
};

/**
 * Opens the entry drawer ready for an expense. It opens even when offline: the drawer itself
 * says so and keeps Save disabled, so nothing is half-saved.
 */
export function AddButton({ variant, className }: AddButtonProps) {
  if (variant === "bar") {
    return (
      <Button size="sm" className={className} onClick={() => openCreate("expense")}>
        + Add
      </Button>
    );
  }
  return (
    <button
      type="button"
      aria-label="Add entry"
      onClick={() => openCreate("expense")}
      className={cn(
        "fixed right-4 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-40 flex size-14 items-center justify-center",
        "rounded-full bg-fg text-bg shadow-lg transition-transform active:scale-95",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg",
        className,
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  );
}

/** True for a bare "n" keypress outside any text field: the keyboard way to add an expense. */
export function isNewEntryShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "n" && event.key !== "N") return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return false;
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (target.isContentEditable) return false;
    if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"))
      return false;
  }
  return true;
}
