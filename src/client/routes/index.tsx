import type { CurrencyCode } from "@shared/money";
import type { MonthCategory, MonthEntry, MonthResponse } from "@shared/schemas/month";
import { IconChevronDown, IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { CategoryIcon, ColourDot } from "../components/CategoryIcon";
import { EntryRow } from "../components/EntryRow";
import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { Money } from "../components/ui/money";
import { Page } from "../components/ui/page";
import { Segmented } from "../components/ui/segmented";
import { openCreate } from "../drawer/store";
import { useMe } from "../features/auth/use-me";
import { type DisplayCurrency, useDisplayCurrency } from "../features/display-currency";
import { currentMonth, prefetchMonth, shiftMonth, useMonth } from "../features/month/api";
import { useSettings } from "../features/settings/api";
import { cn } from "../lib/cn";

export const Route = createFileRoute("/")({
  component: MonthPage,
});

const ALL = "all";

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
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

/** Runs `fn` when the browser is idle (or soon, where idle callbacks don't exist). */
function whenIdle(fn: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(fn, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 300);
  return () => window.clearTimeout(id);
}

export function MonthPage() {
  const client = useQueryClient();
  const [month, setMonth] = useState(currentMonth);
  const [partner, setPartner] = useState<string>(ALL);
  const userId = partner === ALL ? undefined : partner;
  const { data, isPending, isError } = useMonth(month, userId);
  const display = useDisplayCurrency(data);
  const { data: me } = useMe();
  const { data: settings } = useSettings();

  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  useEffect(
    () =>
      whenIdle(() => {
        void prefetchMonth(client, prev, userId);
        void prefetchMonth(client, next, userId);
      }),
    [client, prev, next, userId],
  );

  const partnerOptions = useMemo(() => {
    const people = [settings?.me, settings?.partner].filter((p): p is { id: string; name: string } => !!p);
    return [{ value: ALL, label: "All" }, ...people.map((p) => ({ value: p.id, label: p.name }))];
  }, [settings]);

  const stepper = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Previous month"
          onClick={() => setMonth(prev)}
          onMouseEnter={() => void prefetchMonth(client, prev, userId)}
          onFocus={() => void prefetchMonth(client, prev, userId)}
        >
          <IconChevronLeft aria-hidden size={20} />
        </Button>
        <span className="min-w-40 text-center font-numbers text-lg" aria-live="polite">
          {monthLabel(month)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Next month"
          onClick={() => setMonth(next)}
          onMouseEnter={() => void prefetchMonth(client, next, userId)}
          onFocus={() => void prefetchMonth(client, next, userId)}
        >
          <IconChevronRight aria-hidden size={20} />
        </Button>
      </div>
      {partnerOptions.length > 1 && (
        <Segmented
          aria-label="Partner"
          options={partnerOptions}
          value={partner}
          onChange={setPartner}
          className="min-w-60"
        />
      )}
    </div>
  );

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
    <Page title="Month" stepper={stepper} actions={actions}>
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
                    <EntryRow key={entry.id} entry={entry} />
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
