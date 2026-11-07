import { type ReactNode, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useFocusTrap } from "../../lib/use-focus-trap";
import { Button } from "./button";

type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Sticky bottom area, e.g. the Save button. */
  footer?: ReactNode;
  className?: string;
};

/**
 * Right-side drawer: full screen on phones, a max-w-md panel on desktop. Traps focus,
 * closes on Escape or overlay click, and restores focus to the opener.
 */
export function Sheet({ open, onClose, title, children, footer, className }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(panelRef, open, onClose);
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-fg/30 opacity-100 transition-opacity starting:opacity-0 motion-reduce:transition-none"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "absolute inset-y-0 right-0 flex w-full flex-col bg-bg outline-none md:max-w-md md:border-l md:border-rule",
          "translate-x-0 transition-transform duration-200 ease-out starting:translate-x-full motion-reduce:transition-none",
          className,
        )}
      >
        <header className="flex items-center justify-between border-b border-rule px-4 py-2">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && (
          <footer className="border-t border-rule px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
