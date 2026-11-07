import { formatMinor } from "@shared/money";
import type { MonthEntry } from "@shared/schemas/month";
import { IconArrowsRightLeft, IconScale } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type PointerEvent, useRef, useState } from "react";
import { openEdit } from "../drawer/store";
import { useDeleteEntry } from "../features/entries/api";
import { cn } from "../lib/cn";
import { CategoryIcon } from "./CategoryIcon";

/** Movement before a gesture is judged horizontal (swipe) or vertical (scroll). */
const AXIS_LOCK_PX = 10;
const MAX_THRESHOLD_PX = 120;
const THRESHOLD_SHARE = 0.4;
const MINUS = "−";

type Gesture = { id: number; x: number; y: number; width: number; axis: "x" | "y" | null };

function title(entry: MonthEntry): string {
  if (entry.kind === "transfer") return `Transfer ${entry.accountName} → ${entry.toAccountName ?? ""}`;
  if (entry.kind === "adjustment") return "Adjustment";
  return entry.categoryName ?? "";
}

/** The account amount, plus the original amount when it was in another currency (e.g. "¥3,000 · €18.70"). */
export function entryAmountText(entry: MonthEntry): string {
  if (entry.kind === "adjustment") {
    const sign = entry.accountAmountMinor < 0 ? MINUS : "+";
    return `${sign}${formatMinor(Math.abs(entry.accountAmountMinor), entry.accountCurrency)}`;
  }
  if (entry.kind === "transfer") {
    const left = formatMinor(entry.accountAmountMinor, entry.accountCurrency);
    return entry.toCurrency && entry.toCurrency !== entry.accountCurrency && entry.toAmountMinor !== null
      ? `${left} → ${formatMinor(entry.toAmountMinor, entry.toCurrency)}`
      : left;
  }
  const sign = entry.kind === "income" ? "+" : "";
  const booked = formatMinor(entry.accountAmountMinor, entry.accountCurrency);
  return entry.currency !== entry.accountCurrency
    ? `${sign}${formatMinor(entry.amountMinor, entry.currency)} · ${booked}`
    : `${sign}${booked}`;
}

function Leading({ entry }: { entry: MonthEntry }) {
  if (entry.kind === "transfer" || entry.kind === "adjustment") {
    const Glyph = entry.kind === "transfer" ? IconArrowsRightLeft : IconScale;
    return (
      <span aria-hidden="true" className="inline-flex size-9 shrink-0 items-center justify-center bg-surface">
        <Glyph size={20} stroke={1.5} />
      </span>
    );
  }
  return <CategoryIcon icon={entry.categoryIcon ?? ""} colour={entry.categoryColour} />;
}

function RowBody({ entry }: { entry: MonthEntry }) {
  const detail = [entry.notes, entry.projectName].filter(Boolean).join(" · ");
  return (
    <>
      <Leading entry={entry} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{title(entry)}</span>
        {detail && <span className="truncate text-sm text-muted">{detail}</span>}
      </span>
      <span
        title={entry.userName}
        className="inline-flex size-6 shrink-0 items-center justify-center border border-rule text-xs text-muted"
      >
        <span aria-hidden="true">{entry.userName.slice(0, 1).toUpperCase()}</span>
        <span className="sr-only">{entry.userName}</span>
      </span>
      <span
        className={cn(
          "shrink-0 text-right font-numbers whitespace-nowrap",
          entry.kind === "income" && "text-fg",
          entry.kind !== "income" && entry.kind !== "expense" && "text-muted",
        )}
      >
        {entryAmountText(entry)}
      </span>
    </>
  );
}

const ROW = "relative flex w-full items-center gap-3 bg-bg px-1 py-3 text-left";

/**
 * One entry in a list. Tapping opens it in the drawer (adjustments go to their account instead).
 * On touch, a horizontal swipe past the threshold deletes it with an Undo toast; a mostly vertical
 * movement is left to the page scroll and never deletes.
 */
export function EntryRow({ entry }: { entry: MonthEntry }) {
  const remove = useDeleteEntry();
  const gesture = useRef<Gesture | null>(null);
  const swiped = useRef(false);
  const [offset, setOffset] = useState(0);

  if (entry.kind === "adjustment") {
    return (
      <li className="border-b border-rule">
        <Link to="/accounts/$accountId" params={{ accountId: entry.accountId }} className={ROW}>
          <RowBody entry={entry} />
        </Link>
      </li>
    );
  }
  const kind = entry.kind;

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" || gesture.current) return;
    swiped.current = false;
    gesture.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      width: e.currentTarget.getBoundingClientRect().width,
      axis: null,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.axis === null) {
      if (Math.hypot(dx, dy) < AXIS_LOCK_PX) return;
      g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (g.axis === "x") {
        swiped.current = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Capture is a nicety; the swipe still works without it.
        }
      }
    }
    if (g.axis === "x") setOffset(Math.min(0, dx));
  };

  const end = (e: PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (g.axis !== "x") return;
    const threshold = g.width > 0 ? Math.min(g.width * THRESHOLD_SHARE, MAX_THRESHOLD_PX) : MAX_THRESHOLD_PX;
    const dx = e.clientX - g.x;
    if (cancelled || -dx < threshold) {
      setOffset(0);
      return;
    }
    setOffset(-(g.width || window.innerWidth));
    remove.mutate(entry, { onError: () => setOffset(0) });
  };

  return (
    <li className="relative overflow-hidden border-b border-rule">
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-end bg-negative pr-4 text-sm font-medium text-bg"
      >
        Delete
      </span>
      <button
        type="button"
        className={cn(ROW, offset === 0 && "transition-transform", "touch-pan-y")}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => end(e, false)}
        onPointerCancel={(e) => end(e, true)}
        onClick={() => {
          if (swiped.current) {
            swiped.current = false;
            return;
          }
          openEdit(entry.id, kind);
        }}
      >
        <RowBody entry={entry} />
      </button>
    </li>
  );
}
