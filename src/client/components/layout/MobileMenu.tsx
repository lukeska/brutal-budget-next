import { useId, useRef, useState } from "react";
import { useFocusTrap } from "../../lib/use-focus-trap";
import { Button } from "../ui/button";
import { NavLinks, useLogout } from "./nav";

function Icon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d={d} />
    </svg>
  );
}

/** Phone navigation (below md): a hamburger that opens a full-width panel with the same sections. */
export function MobileMenu() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const logout = useLogout();
  const close = () => setOpen(false);
  useFocusTrap(panelRef, open, close);

  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-bg">
      <div className="flex items-center justify-between px-4">
        <span className="font-numbers text-lg font-semibold tracking-tight">Brutal Budget</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(true)}
        >
          <Icon d="M4 7h16M4 12h16M4 17h16" />
        </Button>
      </div>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          className="fixed inset-0 z-50 flex flex-col bg-bg"
        >
          <div className="flex items-center justify-between border-b border-rule px-4">
            <span className="font-numbers text-lg font-semibold tracking-tight">Brutal Budget</span>
            <Button variant="ghost" size="icon" aria-label="Close menu" onClick={close}>
              <Icon d="M6 6l12 12M18 6L6 18" />
            </Button>
          </div>
          <nav aria-label="Sections" className="flex-1 overflow-y-auto px-4 py-2">
            <NavLinks
              className="flex flex-col divide-y divide-rule"
              linkClassName="py-3 text-2xl"
              onNavigate={close}
            />
          </nav>
          <div className="border-t border-rule px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Button variant="ghost" className="w-full justify-start px-0" onClick={logout}>
              Log out
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
