import { type CurrencyCode, formatMinor } from "@shared/money";
import type { MonthCategory, MonthEntry, MonthResponse } from "@shared/schemas/month";
import { IconChevronDown, IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CategoryIcon, ColourDot } from "../components/CategoryIcon";
import { EntryRow } from "../components/EntryRow";
import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { Money } from "../components/ui/money";
import { Page } from "../components/ui/page";
import { openCreate } from "../drawer/store";
import { useMe } from "../features/auth/use-me";
import { type DisplayCurrency, useDisplayCurrency } from "../features/display-currency";
import { useDeleteEntry } from "../features/entries/api";
import { currentMonth, shiftMonth, useMonth, useMonthSummaries } from "../features/month/api";
import { cn } from "../lib/cn";
import { formatIsoDate } from "../lib/date";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const Route = createFileRoute("/")({
  component: MonthPage,
  validateSearch: (search: Record<string, unknown>): { month?: string } => {
    const m = search.month;
    if (typeof m === "string" && MONTH_RE.test(m)) return { month: m };
    return {};
  },
});

const STRIPE_RADIUS = 12;

function shortMonthLabel(month: string): string {
  return formatIsoDate(`${month}-01`, { month: "short", year: "numeric" });
}

function dayLabel(date: string): string {
  return formatIsoDate(date, { weekday: "short", day: "numeric", month: "short" });
}

/** Signed contribution to the household net, in the base currency; zero for anything not counted. */
function netContribution(entry: MonthEntry): number {
  if (entry.baseAmountMinor === null) return 0;
  if (entry.kind === "income") return entry.baseAmountMinor;
  if (entry.kind === "expense") return -entry.baseAmountMinor;
  return 0;
}

function groupByDay(entries: MonthEntry[]): { date: string; netMinor: number; entries: MonthEntry[] }[] {
  const days: { date: string; netMinor: number; entries: MonthEntry[] }[] = [];
  for (const entry of entries) {
    let day = days.at(-1);
    if (day?.date !== entry.date) {
      day = { date: entry.date, netMinor: 0, entries: [] };
      days.push(day);
    }
    day.entries.push(entry);
    day.netMinor += netContribution(entry);
  }
  return days;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function MonthPicker({
  selected,
  onSelect,
  onClose,
}: {
  selected: string;
  onSelect: (month: string) => void;
  onClose: () => void;
}) {
  const [year, setYear] = useState(() => Number(selected.split("-")[0]));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute top-full left-1/2 z-20 mt-2 w-64 -translate-x-1/2 rounded-lg border border-rule bg-bg p-3 shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous year"
          onClick={() => setYear((y) => y - 1)}
          className="rounded p-1 hover:bg-surface"
        >
          <IconChevronLeft aria-hidden size={16} />
        </button>
        <span className="text-sm font-medium">{year}</span>
        <button
          type="button"
          aria-label="Next year"
          onClick={() => setYear((y) => y + 1)}
          className="rounded p-1 hover:bg-surface"
        >
          <IconChevronRight aria-hidden size={16} />
        </button>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {MONTH_NAMES.map((name, i) => {
          const m = `${year}-${String(i + 1).padStart(2, "0")}`;
          const active = m === selected;
          return (
            <button
              key={m}
              type="button"
              onClick={() => {
                onSelect(m);
                onClose();
              }}
              className={cn(
                "rounded-md px-2 py-1.5 text-sm transition-colors",
                active ? "bg-fg text-bg font-medium" : "hover:bg-surface",
              )}
            >
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MonthStripe({ selected, onSelect }: { selected: string; onSelect: (month: string) => void }) {
  // The center of the stripe only changes when the selected month falls outside its range.
  const [center, setCenter] = useState(selected);
  const firstMonth = shiftMonth(center, -STRIPE_RADIUS);
  const lastMonth = shiftMonth(center, STRIPE_RADIUS);
  if (selected < firstMonth || selected > lastMonth) setCenter(selected);

  const from = shiftMonth(center, -STRIPE_RADIUS);
  const to = shiftMonth(center, STRIPE_RADIUS);
  const { data } = useMonthSummaries(from, to);
  const [pickerOpen, setPickerOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);

  const months = useMemo(() => {
    const list: string[] = [];
    for (let i = -STRIPE_RADIUS; i <= STRIPE_RADIUS; i++) list.push(shiftMonth(center, i));
    return list;
  }, [center]);

  const expenseMap = useMemo(() => {
    const map = new Map<string, number>();
    if (data) for (const m of data.months) map.set(m.month, m.expenseMinor);
    return map;
  }, [data]);

  // Center the selected card on first render and when the stripe recenters.
  useLayoutEffect(() => {
    initialScrollDone.current = false;
  }, [center]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const idx = months.indexOf(selected);
    const card = el.children[idx] as HTMLElement | undefined;
    if (!card) return;
    const target = card.offsetLeft - el.offsetWidth / 2 + card.offsetWidth / 2;
    if (!initialScrollDone.current) {
      el.scrollLeft = target;
      initialScrollDone.current = true;
    }
  }, [months, selected]);

  const scroll = useCallback((dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    const card = el.firstElementChild as HTMLElement | null;
    if (!card) return;
    const style = getComputedStyle(el);
    const gap = Number.parseFloat(style.gap) || 0;
    el.scrollBy({ left: dir * (card.offsetWidth + gap), behavior: "smooth" });
  }, []);

  return (
    <div className="relative" role="tablist" aria-label="Month">
      {/* Left arrow — desktop only */}
      <button
        type="button"
        aria-label="Scroll left"
        onClick={() => scroll(-1)}
        className="absolute top-0 bottom-0 -left-5 z-10 hidden w-9 items-center justify-center md:flex"
      >
        <IconChevronLeft aria-hidden size={20} className="text-muted" />
      </button>

      <div
        ref={scrollRef}
        className="flex gap-2 overflow-x-auto scroll-smooth scrollbar-none md:mx-4"
        style={{ scrollSnapType: "x mandatory" }}
      >
        {months.map((m) => {
          const active = m === selected;
          const expense = expenseMap.get(m) ?? 0;
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                if (active) setPickerOpen((v) => !v);
                else onSelect(m);
              }}
              className={cn(
                "flex shrink-0 snap-start flex-col items-center rounded-lg border px-4 py-2 text-center transition-colors",
                active ? "border-fg bg-fg text-bg" : "border-rule bg-surface text-fg hover:border-fg",
              )}
              style={{ minWidth: "6rem" }}
            >
              <span className="text-sm font-medium">{shortMonthLabel(m)}</span>
              <span className={cn("font-numbers text-xs", active ? "text-bg/70" : "text-muted")}>
                {data ? formatMinor(expense, data.baseCurrency as CurrencyCode) : "\u00A0"}
              </span>
            </button>
          );
        })}
      </div>

      {/* Right arrow — desktop only */}
      <button
        type="button"
        aria-label="Scroll right"
        onClick={() => scroll(1)}
        className="absolute top-0 bottom-0 -right-5 z-10 hidden w-9 items-center justify-center md:flex"
      >
        <IconChevronRight aria-hidden size={20} className="text-muted" />
      </button>

      {pickerOpen && (
        <MonthPicker selected={selected} onSelect={onSelect} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}

export function MonthPage() {
  const { month: searchMonth } = Route.useSearch();
  const navigate = useNavigate();
  const month = searchMonth ?? currentMonth();
  const setMonth = useCallback(
    (m: string) => navigate({ to: "/", search: { month: m }, replace: true }),
    [navigate],
  );
  const { data, isPending, isError } = useMonth(month);
  const display = useDisplayCurrency(data);
  const { data: me } = useMe();

  const stepper = <MonthStripe selected={month} onSelect={setMonth} />;

  const actions = display.canToggle ? (
    <Button
      variant="outline"
      size="sm"
      onClick={display.toggle}
      aria-pressed={display.currency !== data?.baseCurrency}
    >
      Show in {display.currency === data?.baseCurrency ? me?.secondaryCurrency : data?.baseCurrency}
    </Button>
  ) : undefined;

  return (
    <Page stepper={stepper} actions={actions}>
      {isPending ? (
        <p className="text-muted">Loading…</p>
      ) : isError || !data ? (
        <p className="text-negative">Couldn't load this month.</p>
      ) : (
        <MonthBody data={data} display={display} />
      )}
    </Page>
  );
}

function MonthBody({ data, display }: { data: MonthResponse; display: DisplayCurrency }) {
  const { totals } = data;
  const days = useMemo(() => groupByDay(data.entries), [data.entries]);
  const expense = data.categories.filter((c) => c.type === "expense");
  const income = data.categories.filter((c) => c.type === "income");
  // One mutation for the list; each row awaits its own delete so a failure restores only that row.
  const remove = useDeleteEntry();

  return (
    <div className="flex flex-col gap-10">
      <section aria-label="Totals" className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <Total label="Income" minor={display.convert(totals.incomeMinor)} currency={display.currency} />
        <Total label="Expenses" minor={display.convert(totals.expenseMinor)} currency={display.currency} />
        <Total label="Net" minor={display.convert(totals.netMinor)} currency={display.currency} signed />
      </section>

      {data.waitingCount > 0 && (
        <p className="text-sm text-muted">
          {data.waitingCount === 1 ? "1 entry" : `${data.waitingCount} entries`} waiting for a rate
        </p>
      )}

      {data.entries.length === 0 ? (
        <Empty
          title="Nothing logged this month"
          action={
            <div className="flex flex-wrap items-center gap-4">
              <Button onClick={() => openCreate("expense")}>Add your first expense</Button>
              <Link to="/import" className="text-sm underline underline-offset-4">
                or import a CSV
              </Link>
            </div>
          }
        />
      ) : (
        <>
          {expense.length > 0 && (
            <Breakdown
              title="Expenses"
              categories={expense}
              totalMinor={totals.expenseMinor}
              display={display}
            />
          )}
          {income.length > 0 && (
            <Breakdown title="Income" categories={income} totalMinor={totals.incomeMinor} display={display} />
          )}
          <section aria-label="Entries" className="flex flex-col gap-6">
            {days.map((day) => (
              <div key={day.date}>
                <h3 className="flex items-baseline justify-between border-b border-fg pb-1 text-sm font-medium">
                  <span>{dayLabel(day.date)}</span>
                  <Money
                    minor={display.convert(day.netMinor)}
                    currency={display.currency}
                    signed
                    className="text-muted"
                  />
                </h3>
                <ul>
                  {day.entries.map((entry) => (
                    <EntryRow key={entry.id} entry={entry} onDelete={remove.mutateAsync} />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

function Total({
  label,
  minor,
  currency,
  signed = false,
}: {
  label: string;
  minor: number;
  currency: CurrencyCode;
  signed?: boolean;
}) {
  return (
    <div
      className="flex flex-col gap-1 border-t border-rule pt-3"
      data-testid={`total-${label.toLowerCase()}`}
    >
      <span className="text-sm text-muted">{label}</span>
      <Money minor={minor} currency={currency} signed={signed} className="text-3xl md:text-4xl" />
    </div>
  );
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "";
}

function Breakdown({
  title,
  categories,
  totalMinor,
  display,
}: {
  title: string;
  categories: MonthCategory[];
  totalMinor: number;
  display: DisplayCurrency;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section aria-label={`${title} by category`}>
      <h2 className="border-b border-fg pb-1 text-sm font-medium">{title}</h2>
      <ul>
        {categories.map((cat) => {
          const expandable = cat.children.length > 0;
          const expanded = open.has(cat.id);
          const line = (
            <>
              <ColourDot colour={cat.colour} />
              <CategoryIcon icon={cat.icon} colour={cat.colour} variant="plain" size="sm" />
              <span className="flex-1 truncate">{cat.name}</span>
              <span className="w-12 text-right font-numbers text-sm text-muted">
                {percent(cat.totalMinor, totalMinor)}
              </span>
              <Money
                minor={display.convert(cat.totalMinor)}
                currency={display.currency}
                className="w-28 text-right"
              />
              {expandable ? (
                <IconChevronDown
                  aria-hidden
                  size={16}
                  className={cn("shrink-0 transition-transform", expanded && "rotate-180")}
                />
              ) : (
                <span className="w-4 shrink-0" />
              )}
            </>
          );
          return (
            <li key={cat.id} className="border-b border-rule">
              {expandable ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggle(cat.id)}
                  className="flex w-full items-center gap-3 py-3 text-left"
                >
                  {line}
                </button>
              ) : (
                <div className="flex items-center gap-3 py-3">{line}</div>
              )}
              {expandable && expanded && (
                <ul className="pb-2 pl-6">
                  {cat.children.map((sub) => (
                    <SubLine
                      key={sub.id}
                      name={sub.name}
                      icon={sub.icon}
                      colour={sub.colour}
                      minor={sub.totalMinor}
                      parentMinor={cat.totalMinor}
                      display={display}
                    />
                  ))}
                  {cat.ownMinor !== 0 && (
                    <SubLine
                      name={`On ${cat.name} itself`}
                      icon={cat.icon}
                      colour={cat.colour}
                      minor={cat.ownMinor}
                      parentMinor={cat.totalMinor}
                      display={display}
                    />
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SubLine({
  name,
  icon,
  colour,
  minor,
  parentMinor,
  display,
}: {
  name: string;
  icon: string;
  colour: string;
  minor: number;
  parentMinor: number;
  display: DisplayCurrency;
}) {
  return (
    <li className="flex items-center gap-3 py-1.5 text-sm">
      <CategoryIcon icon={icon} colour={colour} variant="plain" size="sm" />
      <span className="flex-1 truncate text-muted">{name}</span>
      <span className="w-12 text-right font-numbers text-muted">{percent(minor, parentMinor)}</span>
      <Money minor={display.convert(minor)} currency={display.currency} className="w-28 text-right" />
      <span className="w-4 shrink-0" />
    </li>
  );
}
