import { type CurrencyCode, exponentOf, formatMinor } from "@shared/money";
import type { StatsCategory, StatsResponse } from "@shared/schemas/stats";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  type TooltipValueType,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "../../components/ui/button";
import { Empty } from "../../components/ui/empty";
import { Money } from "../../components/ui/money";
import { Page } from "../../components/ui/page";
import { Segmented } from "../../components/ui/segmented";
import { useMe } from "../../features/auth/use-me";
import { type DisplayCurrency, useDisplayCurrency } from "../../features/display-currency";
import { useStats } from "../../features/stats/api";

export const Route = createFileRoute("/statistics/")({
  component: StatisticsPage,
});

type CategoryType = StatsCategory["type"];
type Period = "year" | `${number}`;

const MONTH_LABELS = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat(undefined, { month: "short" }).format(new Date(2000, i, 1)),
);
const MONTH_NAMES = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date(2000, i, 1)),
);

const AXIS = { stroke: "var(--color-rule)", tick: { fill: "var(--color-muted)", fontSize: 12 } } as const;

/** Short axis label such as "€1.2K"; display only, so a float is fine here. */
function compact(minor: number, currency: CurrencyCode): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(minor / 10 ** exponentOf(currency));
}

function StatisticsPage() {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const { data, isPending, isError } = useStats(year);
  const display = useDisplayCurrency(data);
  const { data: me } = useMe();

  const stepper = (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="icon" aria-label="Previous year" onClick={() => setYear((y) => y - 1)}>
        <IconChevronLeft aria-hidden size={20} />
      </Button>
      <span className="min-w-16 text-center font-numbers text-lg" aria-live="polite">
        {year}
      </span>
      <Button variant="ghost" size="icon" aria-label="Next year" onClick={() => setYear((y) => y + 1)}>
        <IconChevronRight aria-hidden size={20} />
      </Button>
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
  ) : null;

  return (
    <Page title="Statistics" stepper={stepper} actions={actions}>
      {isPending ? (
        <p className="text-muted">Loading…</p>
      ) : isError || !data ? (
        <Empty title="Statistics couldn't load">Check your connection and try again.</Empty>
      ) : (
        <YearStats data={data} display={display} />
      )}
    </Page>
  );
}

function YearStats({ data, display }: { data: StatsResponse; display: DisplayCurrency }) {
  const { currency, convert } = display;
  const totals = useMemo(
    () =>
      data.months.reduce(
        (t, m) => ({ income: t.income + m.incomeMinor, expense: t.expense + m.expenseMinor }),
        { income: 0, expense: 0 },
      ),
    [data],
  );
  const hasEntries = data.byCategory.length > 0;

  return (
    <div className="flex flex-col gap-10">
      <dl className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <Total label="Income" minor={convert(totals.income)} currency={currency} />
        <Total label="Expenses" minor={convert(totals.expense)} currency={currency} />
        <Total label="Net" minor={convert(totals.income - totals.expense)} currency={currency} signed />
      </dl>

      {data.waitingCount > 0 && (
        <p className="border-l-2 border-fg pl-3 text-sm text-muted">
          {data.waitingCount} {data.waitingCount === 1 ? "entry is" : "entries are"} waiting for a rate and
          not counted yet.
        </p>
      )}

      {currency !== data.baseCurrency && data.latestRates.date && (
        <p className="text-sm text-muted">
          Shown in {currency} at the rate of {data.latestRates.date}. Totals are kept in {data.baseCurrency}.
        </p>
      )}

      {hasEntries ? (
        <>
          <MonthlyBars data={data} display={display} />
          <CategoryShare data={data} display={display} />
          <NetLine data={data} display={display} />
          <DataTable data={data} display={display} />
        </>
      ) : (
        <Empty title={`No income or expenses in ${data.year}`} />
      )}
    </div>
  );
}

function Total({
  label,
  minor,
  currency,
  signed,
}: {
  label: string;
  minor: number;
  currency: CurrencyCode;
  signed?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 border-t border-rule pt-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-3xl font-semibold tracking-tight md:text-4xl">
        <Money minor={minor} currency={currency} signed={signed} />
      </dd>
    </div>
  );
}

function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 border-t border-rule pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
  currency,
}: Partial<TooltipContentProps<TooltipValueType, string | number>> & { currency: CurrencyCode }) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => typeof p.value === "number" && p.value !== 0);
  if (rows.length === 0) return null;
  return (
    <div className="border border-rule bg-bg px-3 py-2 text-sm shadow-sm">
      <p className="mb-1 font-medium">{label}</p>
      <ul className="flex flex-col gap-0.5">
        {rows.map((p) => (
          <li key={String(p.dataKey)} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 text-muted">
              <span aria-hidden className="size-2.5" style={{ background: p.color }} />
              {p.name}
            </span>
            <span className="font-numbers">{formatMinor(p.value as number, currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MonthlyBars({ data, display }: { data: StatsResponse; display: DisplayCurrency }) {
  const [type, setType] = useState<CategoryType>("expense");
  const categories = data.byCategory.filter((c) => c.type === type);
  const rows = MONTH_LABELS.map((label, i) => {
    const row: Record<string, number | string> = { label };
    for (const c of categories) row[c.categoryId] = display.convert(c.months[i] ?? 0);
    return row;
  });

  return (
    <Section title="By month" aside={<TypeSwitch value={type} onChange={setType} />}>
      <div className="h-72" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-rule)" strokeWidth={1} />
            <XAxis dataKey="label" tickLine={false} {...AXIS} />
            <YAxis
              width={64}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => compact(v, display.currency)}
              {...AXIS}
            />
            <Tooltip
              cursor={{ fill: "var(--color-surface)" }}
              content={(props) => <ChartTooltip {...props} currency={display.currency} />}
            />
            {categories.map((c) => (
              <Bar
                key={c.categoryId}
                dataKey={c.categoryId}
                name={c.name}
                stackId="month"
                fill={c.colour}
                stroke="var(--color-bg)"
                strokeWidth={1}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted" aria-label="Legend">
        {categories.map((c) => (
          <li key={c.categoryId} className="flex items-center gap-2">
            <span aria-hidden className="size-2.5" style={{ background: c.colour }} />
            {c.name}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function TypeSwitch({ value, onChange }: { value: CategoryType; onChange: (v: CategoryType) => void }) {
  return (
    <Segmented
      aria-label="Entry type"
      value={value}
      onChange={onChange}
      options={[
        { value: "expense", label: "Expenses" },
        { value: "income", label: "Income" },
      ]}
    />
  );
}

function CategoryShare({ data, display }: { data: StatsResponse; display: DisplayCurrency }) {
  const [type, setType] = useState<CategoryType>("expense");
  const [period, setPeriod] = useState<Period>("year");
  const monthIndex = period === "year" ? null : Number(period);
  const rows = data.byCategory
    .filter((c) => c.type === type)
    .map((c) => ({ ...c, amount: monthIndex === null ? c.totalMinor : (c.months[monthIndex] ?? 0) }))
    .filter((c) => c.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
  const sum = rows.reduce((s, r) => s + r.amount, 0);
  const periodName = monthIndex === null ? String(data.year) : `${MONTH_NAMES[monthIndex]} ${data.year}`;

  return (
    <Section
      title="Share by category"
      aside={
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="share-period">
            Period
          </label>
          <select
            id="share-period"
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
            className="min-h-11 border border-rule bg-bg px-3 text-sm"
          >
            <option value="year">Whole year</option>
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={String(i)}>
                {name}
              </option>
            ))}
          </select>
          <TypeSwitch value={type} onChange={setType} />
        </div>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing in {periodName}.</p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label={`Share by category, ${periodName}`}>
          {rows.map((r) => {
            const pct = sum > 0 ? (r.amount / sum) * 100 : 0;
            return (
              <li key={r.categoryId} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-4 text-sm">
                  <span>{r.name}</span>
                  <span className="flex gap-3">
                    <Money minor={display.convert(r.amount)} currency={display.currency} />
                    <span className="w-12 text-right font-numbers text-muted">{pct.toFixed(1)}%</span>
                  </span>
                </div>
                <div className="h-2 bg-surface" aria-hidden>
                  <div className="h-full" style={{ width: `${Math.max(pct, 0)}%`, background: r.colour }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function NetLine({ data, display }: { data: StatsResponse; display: DisplayCurrency }) {
  const rows = data.months.map((m, i) => ({ label: MONTH_LABELS[i], net: display.convert(m.netMinor) }));
  return (
    <Section title="Net by month">
      <div className="h-56" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-rule)" strokeWidth={1} />
            <XAxis dataKey="label" tickLine={false} {...AXIS} />
            <YAxis
              width={64}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => compact(v, display.currency)}
              {...AXIS}
            />
            <Tooltip
              cursor={{ stroke: "var(--color-faint)" }}
              content={(props) => <ChartTooltip {...props} currency={display.currency} />}
            />
            <Line
              type="linear"
              dataKey="net"
              name="Net"
              stroke="var(--color-fg)"
              strokeWidth={2}
              dot={{ r: 3, fill: "var(--color-fg)", strokeWidth: 0 }}
              activeDot={{ r: 5, stroke: "var(--color-bg)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Section>
  );
}

/** The same numbers as the charts, as a table for screen readers and anyone who prefers one. */
function DataTable({ data, display }: { data: StatsResponse; display: DisplayCurrency }) {
  const { convert, currency } = display;
  return (
    <details className="border-t border-rule pt-4">
      <summary className="min-h-11 cursor-pointer text-sm font-medium">Show as table</summary>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Income, expenses and net by month in {data.year}, in {currency}
          </caption>
          <thead>
            <tr className="border-b border-rule text-left text-muted">
              <th scope="col" className="py-2 pr-4 font-medium">
                Month
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Income
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Expenses
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Net
              </th>
            </tr>
          </thead>
          <tbody>
            {data.months.map((m, i) => (
              <tr key={m.month} className="border-b border-rule">
                <th scope="row" className="py-2 pr-4 text-left font-normal">
                  {MONTH_NAMES[i]}
                </th>
                <td className="py-2 pr-4 text-right">
                  <Money minor={convert(m.incomeMinor)} currency={currency} />
                </td>
                <td className="py-2 pr-4 text-right">
                  <Money minor={convert(m.expenseMinor)} currency={currency} />
                </td>
                <td className="py-2 text-right">
                  <Money minor={convert(m.netMinor)} currency={currency} signed />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <table className="mt-8 w-full text-sm">
          <caption className="sr-only">
            Amounts by category and month in {data.year}, in {currency}
          </caption>
          <thead>
            <tr className="border-b border-rule text-left text-muted">
              <th scope="col" className="py-2 pr-4 font-medium">
                Category
              </th>
              {MONTH_LABELS.map((label) => (
                <th key={label} scope="col" className="py-2 pr-4 text-right font-medium">
                  {label}
                </th>
              ))}
              <th scope="col" className="py-2 text-right font-medium">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {data.byCategory.map((c) => (
              <tr key={c.categoryId} className="border-b border-rule">
                <th scope="row" className="py-2 pr-4 text-left font-normal whitespace-nowrap">
                  {c.name} <span className="text-muted">({c.type === "expense" ? "expense" : "income"})</span>
                </th>
                {c.months.map((v, i) => (
                  <td key={MONTH_LABELS[i]} className="py-2 pr-4 text-right">
                    <Money minor={convert(v)} currency={currency} />
                  </td>
                ))}
                <td className="py-2 text-right">
                  <Money minor={convert(c.totalMinor)} currency={currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
