import type { CurrencyCode } from "@shared/money";
import type { CategorySummary } from "@shared/schemas/category";
import type { Entry } from "@shared/schemas/entry";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { CategoryIcon } from "../../components/CategoryIcon";
import { Empty } from "../../components/ui/empty";
import { Money } from "../../components/ui/money";
import { Page } from "../../components/ui/page";
import { openEdit } from "../../drawer/store";
import { useCategorySummary } from "../../features/categories/api";
import { cn } from "../../lib/cn";

export const Route = createFileRoute("/categories/$categoryId")({
  component: CategoryDetail,
});

function monthLabel(month: string, style: "short" | "long" = "short"): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)).toLocaleDateString(undefined, {
    month: style,
    year: style === "long" ? "numeric" : "2-digit",
    timeZone: "UTC",
  });
}

function CategoryDetail() {
  const { categoryId } = Route.useParams();
  const [month, setMonth] = useState<string | undefined>(undefined);
  const { data, isPending, isError } = useCategorySummary(categoryId, month);

  if (isPending)
    return (
      <Page title="Category">
        <p className="text-muted">Loading…</p>
      </Page>
    );
  if (isError || !data)
    return (
      <Page title="Category">
        <p className="text-negative">Couldn't load this category.</p>
      </Page>
    );

  const { category, baseCurrency } = data;
  const selected = data.month;
  const selectedTotal = data.months.find((m) => m.month === selected)?.totalMinor;

  return (
    <Page
      title={
        <span className="flex items-center gap-3">
          <CategoryIcon icon={category.icon} colour={category.colour} size="lg" />
          <span>
            {category.name}
            {category.archived && <span className="ml-2 align-middle text-base text-muted">archived</span>}
          </span>
        </span>
      }
      actions={
        <Link to="/categories" className="text-sm text-muted hover:text-fg">
          All categories
        </Link>
      }
    >
      <MonthBars summary={data} selected={selected} onSelect={setMonth} />

      <section className="mt-10">
        <header className="flex items-baseline justify-between border-b border-rule pb-2">
          <h2 className="text-lg font-semibold">{monthLabel(selected, "long")}</h2>
          {selectedTotal !== undefined && (
            <Money minor={selectedTotal} currency={baseCurrency} className="text-2xl" />
          )}
        </header>
        {category.children.length > 0 && <Breakdown summary={data} />}
        <EntryList entries={data.entries} summary={data} />
      </section>
    </Page>
  );
}

/** Twelve months as horizontal bars; the selected month's bar takes the category colour. */
function MonthBars({
  summary,
  selected,
  onSelect,
}: {
  summary: CategorySummary;
  selected: string;
  onSelect: (month: string) => void;
}) {
  const max = Math.max(1, ...summary.months.map((m) => m.totalMinor));
  return (
    <ol className="flex flex-col gap-1" aria-label="Monthly totals">
      {[...summary.months].reverse().map((m) => {
        const active = m.month === selected;
        return (
          <li key={m.month}>
            <button
              type="button"
              onClick={() => onSelect(m.month)}
              aria-pressed={active}
              className={cn(
                "grid w-full grid-cols-[4.5rem_1fr_7rem] items-center gap-3 py-1 text-left",
                "hover:bg-surface focus-visible:outline-2 focus-visible:outline-fg",
              )}
            >
              <span className={cn("text-sm", active ? "font-semibold text-fg" : "text-muted")}>
                {monthLabel(m.month)}
              </span>
              <span className="h-3 bg-surface">
                <span
                  className={cn("block h-full", !active && "bg-fg/25")}
                  style={{
                    width: `${(m.totalMinor / max) * 100}%`,
                    backgroundColor: active ? summary.category.colour : undefined,
                  }}
                />
              </span>
              <Money
                minor={m.totalMinor}
                currency={summary.baseCurrency}
                className={cn("text-right text-sm", !active && "text-muted")}
              />
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The month split between the category itself and each subcategory. */
function Breakdown({ summary }: { summary: CategorySummary }) {
  const { category } = summary;
  const totals = new Map(summary.breakdown.map((b) => [b.categoryId, b.totalMinor]));
  const rows = [
    ...category.children.map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
    { id: category.id, name: `${category.name} itself`, icon: category.icon },
  ].filter((r) => totals.has(r.id));
  if (rows.length === 0) return null;
  return (
    <ul className="border-b border-rule py-2">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3 py-1">
          <CategoryIcon icon={r.icon} colour={category.colour} size="sm" />
          <span className="flex-1">{r.name}</span>
          <Money minor={totals.get(r.id) ?? 0} currency={summary.baseCurrency} />
        </li>
      ))}
    </ul>
  );
}

function EntryList({ entries, summary }: { entries: Entry[]; summary: CategorySummary }) {
  if (entries.length === 0) return <Empty title="No entries this month." className="border-t-0" />;
  const names = new Map([summary.category, ...summary.category.children].map((c) => [c.id, c.name] as const));
  return (
    <ul>
      {entries.map((e) => (
        <li key={e.id} className="border-b border-rule">
          <button
            type="button"
            onClick={() => openEdit(e.id, e.kind === "income" ? "income" : "expense")}
            className="flex w-full items-center gap-3 py-3 text-left hover:bg-surface"
          >
            <span className="w-12 font-numbers text-sm text-muted">{e.date.slice(8)}</span>
            <span className="flex-1 truncate">
              {e.notes || names.get(e.categoryId ?? "") || "—"}
              {e.categoryId !== summary.category.id && e.notes && (
                <span className="ml-2 text-sm text-muted">{names.get(e.categoryId ?? "")}</span>
              )}
            </span>
            {e.fxState === "waiting" && <span className="text-sm text-faint">waiting for rate</span>}
            <Money minor={e.amountMinor} currency={e.currency as CurrencyCode} />
          </button>
        </li>
      ))}
    </ul>
  );
}
