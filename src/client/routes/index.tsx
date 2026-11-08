import { type CurrencyCode, formatMinor } from "@shared/money";
import type { MonthCategory, MonthEntry, MonthResponse } from "@shared/schemas/month";
import { IconChevronDown, IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CategoryIcon, ColourDot, iconComponent } from "../components/CategoryIcon";
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

function MonthStripe({
  selected,
  onSelect,
  kindFilter,
}: {
  selected: string;
  onSelect: (month: string) => void;
  kindFilter: KindFilter;
}) {
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

  const amountMap = useMemo(() => {
    const map = new Map<string, number>();
    if (data)
      for (const m of data.months)
        map.set(m.month, kindFilter === "expense" ? m.expenseMinor : m.incomeMinor);
    return map;
  }, [data, kindFilter]);

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
          const amount = amountMap.get(m) ?? 0;
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
                {data ? formatMinor(amount, data.baseCurrency as CurrencyCode) : "\u00A0"}
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

type KindFilter = "expense" | "income";

export function MonthPage() {
  const { month: searchMonth } = Route.useSearch();
  const navigate = useNavigate();
  const month = searchMonth ?? currentMonth();
  const setMonth = useCallback(
    (m: string) => navigate({ to: "/", search: { month: m }, replace: true }),
    [navigate],
  );
  const [kindFilter, setKindFilter] = useState<KindFilter>("expense");
  const { data, isPending, isError } = useMonth(month);
  const display = useDisplayCurrency(data);
  const { data: me } = useMe();

  const stepper = <MonthStripe selected={month} onSelect={setMonth} kindFilter={kindFilter} />;

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
        <MonthBody data={data} display={display} kindFilter={kindFilter} onKindChange={setKindFilter} />
      )}
    </Page>
  );
}

/* ---- Donut chart (ported from expense-donut.html) ---- */
const DC = 200;
const R_IN = 122;
const R_OUT = 170;
const SLICE_GAP = 0.05;
const BREATH_S = 5;
const BREATH_K = 0.022;
const WAVE_PX = 4;
const RND = 10;

function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

function sector(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const lg = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 ${lg} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${lg} 0 ${x3} ${y3}Z`;
}

const iconMarkupCache = new Map<string, string>();
function getIconMarkup(name: string): string {
  let markup = iconMarkupCache.get(name);
  if (markup !== undefined) return markup;
  const Comp = iconComponent(name);
  const html = renderToStaticMarkup(createElement(Comp, { size: 24, stroke: 2.2 }));
  // Extract the inner content (paths) from the rendered <svg>...</svg>
  const match = html.match(/<svg[^>]*>(.*)<\/svg>/s);
  markup = match?.[1] ?? "";
  iconMarkupCache.set(name, markup);
  return markup;
}

const easeOut3 = (t: number) => 1 - (1 - t) ** 3;
const prefersReduced =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function DonutChart({
  categories,
  totalMinor,
  display,
}: {
  categories: MonthCategory[];
  totalMinor: number;
  display: DisplayCurrency;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const amountRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const pinnedRef = useRef<number | null>(null);
  const stateRef = useRef({ shown: [] as number[], lift: [] as number[], t0: 0, last: 0 });

  const N = categories.length;
  const targets = useMemo(() => categories.map((c) => c.totalMinor), [categories]);

  // Reset pinned when categories change
  useEffect(() => {
    pinnedRef.current = null;
  }, [categories]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || N === 0) return;
    const ns = "http://www.w3.org/2000/svg";

    svg.innerHTML = "";

    // Defs
    const defs = document.createElementNS(ns, "defs");
    const flt = document.createElementNS(ns, "filter");
    flt.id = "dg";
    flt.setAttribute("x", "-30%");
    flt.setAttribute("y", "-30%");
    flt.setAttribute("width", "160%");
    flt.setAttribute("height", "160%");
    const blurEl = document.createElementNS(ns, "feGaussianBlur");
    blurEl.id = "dgb";
    blurEl.setAttribute("stdDeviation", "5");
    blurEl.setAttribute("result", "b");
    const mrg = document.createElementNS(ns, "feMerge");
    mrg.innerHTML = '<feMergeNode in="b"/><feMergeNode in="SourceGraphic"/>';
    flt.append(blurEl, mrg);
    defs.append(flt);
    svg.append(defs);

    const root = document.createElementNS(ns, "g");
    root.id = "dr";
    const segsG = document.createElementNS(ns, "g");
    segsG.setAttribute("filter", "url(#dg)");
    const icnsG = document.createElementNS(ns, "g");
    icnsG.setAttribute("pointer-events", "none");
    root.append(segsG, icnsG);
    svg.append(root);

    const paths: SVGPathElement[] = [];
    const iconGs: SVGGElement[] = [];

    for (let i = 0; i < N; i++) {
      const c = categories[i]!.colour || "#888";
      const p = document.createElementNS(ns, "path");
      p.setAttribute("fill", c);
      p.setAttribute("stroke", c);
      p.setAttribute("stroke-width", String(RND));
      p.setAttribute("stroke-linejoin", "round");
      p.style.cursor = "pointer";
      p.addEventListener("click", (e) => {
        e.stopPropagation();
        pinnedRef.current = pinnedRef.current === i ? null : i;
      });
      segsG.append(p);
      paths.push(p);

      const ig = document.createElementNS(ns, "g");
      ig.setAttribute("fill", "none");
      ig.setAttribute("stroke", "#fff");
      ig.setAttribute("stroke-width", "2.2");
      ig.setAttribute("stroke-linecap", "round");
      ig.setAttribute("stroke-linejoin", "round");
      ig.innerHTML = getIconMarkup(categories[i]!.icon);
      icnsG.append(ig);
      iconGs.push(ig);
    }

    // Click background to deselect
    svg.addEventListener("click", () => {
      pinnedRef.current = null;
    });

    const s = stateRef.current;
    s.shown = new Array(N).fill(0);
    s.lift = new Array(N).fill(0);
    s.t0 = performance.now();
    s.last = s.t0;

    function frame(now: number) {
      const dt = Math.min(0.05, (now - s.last) / 1000);
      s.last = now;
      const t = (now - s.t0) / 1000;
      const intro = prefersReduced ? 1 : easeOut3(Math.min(1, t / 1.2));
      const k = prefersReduced ? 1 : 1 - Math.exp(-dt * 7);
      const kl = prefersReduced ? 1 : 1 - Math.exp(-dt * 11);
      const active = pinnedRef.current;

      for (let i = 0; i < N; i++) {
        s.shown[i] = s.shown[i]! + ((targets[i] ?? 0) - s.shown[i]!) * k;
        s.lift[i] = s.lift[i]! + ((active === i ? 1 : 0) - s.lift[i]!) * kl;
      }
      const tot = s.shown.reduce((a, b) => a + b, 0);
      const breath = prefersReduced ? 0 : Math.sin((t * Math.PI * 2) / BREATH_S);

      const sc = 1 + BREATH_K * breath;
      root.setAttribute("transform", `translate(${DC} ${DC}) scale(${sc}) translate(${-DC} ${-DC})`);
      blurEl.setAttribute("stdDeviation", (5 + (3.5 * (breath + 1)) / 2).toFixed(2));

      const vis = s.shown.filter((v) => v > tot * 0.002).length;
      const sweep = intro * Math.PI * 2;
      let acc = 0;

      for (let i = 0; i < N; i++) {
        const span = tot > 0 ? (s.shown[i]! / tot) * Math.PI * 2 : 0;
        const a0 = acc;
        const a1 = Math.min(acc + span, sweep);
        acc += span;
        const g = vis > 1 ? SLICE_GAP / 2 : 0;
        const s0 = a0 + g;
        const s1 = Math.min(a1 - g, s0 + Math.PI * 2 - 0.0005);
        const pEl = paths[i]!;
        const iEl = iconGs[i]!;

        if (s1 - s0 < 0.004) {
          pEl.setAttribute("d", "");
          iEl.style.opacity = "0";
          continue;
        }

        const mid = (s0 + s1) / 2;
        const wave = prefersReduced ? 0 : Math.sin(t * 1.7 - i * 0.78) * WAVE_PX;
        const lft = s.lift[i]!;
        const off = lft * 7;
        const cx = DC + off * Math.sin(mid);
        const cy = DC - off * Math.cos(mid);
        const r0 = R_IN + RND / 2 - lft * 2;
        const r1 = R_OUT - RND / 2 + wave + lft * 12;
        pEl.setAttribute("d", sector(cx, cy, r0, r1, s0, s1));
        pEl.style.opacity = active == null || active === i ? "1" : "0.35";

        const [ix, iy] = polar(cx, cy, (r0 + r1) / 2, mid);
        const iconSc = 0.82 + lft * 0.22;
        iEl.setAttribute("transform", `translate(${ix} ${iy}) scale(${iconSc}) translate(-12 -12)`);
        iEl.style.opacity = s1 - s0 > 0.34 ? String(Math.min(1, (s1 - s0 - 0.34) * 6) * intro) : "0";
      }

      // Center readout
      if (labelRef.current && amountRef.current) {
        if (active != null && (targets[active] ?? 0) > 0) {
          const cat = categories[active]!;
          labelRef.current.textContent = cat.name;
          labelRef.current.style.color = cat.colour || "";
          amountRef.current.textContent = formatMinor(
            Math.round(display.convert(s.shown[active]!)),
            display.currency,
          );
        } else {
          labelRef.current.textContent = "";
          labelRef.current.style.color = "";
          amountRef.current.textContent = formatMinor(
            Math.round(display.convert(tot * intro)),
            display.currency,
          );
        }
      }

      rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [categories, N, targets, display]);

  if (N === 0 || totalMinor === 0) return null;

  return (
    <div className="flex justify-center">
      <div className="relative" style={{ width: "min(100%, 340px)", aspectRatio: "1" }}>
        <svg
          ref={svgRef}
          viewBox="0 0 400 400"
          className="absolute inset-0 h-full w-full overflow-visible"
          style={{ touchAction: "manipulation" }}
          role="img"
          aria-label="Category breakdown"
        />
        <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
          <div ref={labelRef} className="text-sm font-semibold transition-colors" />
          <div ref={amountRef} className="font-numbers text-2xl font-semibold tracking-tight md:text-3xl" />
        </div>
      </div>
    </div>
  );
}

function MonthBody({
  data,
  display,
  kindFilter: filter,
  onKindChange: setFilter,
}: {
  data: MonthResponse;
  display: DisplayCurrency;
  kindFilter: KindFilter;
  onKindChange: (f: KindFilter) => void;
}) {
  const { totals } = data;
  const expenseCats = data.categories.filter((c) => c.type === "expense");
  const incomeCats = data.categories.filter((c) => c.type === "income");
  const filteredCats = filter === "expense" ? expenseCats : incomeCats;

  const filteredEntries = useMemo(
    () => data.entries.filter((e) => e.kind === filter),
    [data.entries, filter],
  );
  const days = useMemo(() => groupByDay(filteredEntries), [filteredEntries]);

  const remove = useDeleteEntry();

  return (
    <div className="flex flex-col gap-10">
      <section aria-label="Totals">
        <div className="grid grid-cols-2 gap-4">
          <TotalToggle
            label="Expenses"
            minor={display.convert(totals.expenseMinor)}
            currency={display.currency}
            active={filter === "expense"}
            onClick={() => setFilter("expense")}
          />
          <TotalToggle
            label="Income"
            minor={display.convert(totals.incomeMinor)}
            currency={display.currency}
            active={filter === "income"}
            onClick={() => setFilter("income")}
          />
        </div>
        <div
          className="mt-3 flex items-baseline justify-between border-t border-rule pt-2"
          data-testid="total-net"
        >
          <span className="text-sm text-muted">Net</span>
          <Money
            minor={display.convert(totals.netMinor)}
            currency={display.currency}
            signed
            className="text-sm"
          />
        </div>
      </section>

      {filteredCats.length > 0 && (
        <DonutChart
          categories={filteredCats}
          totalMinor={filter === "expense" ? totals.expenseMinor : totals.incomeMinor}
          display={display}
        />
      )}

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
          {filter === "expense" && expenseCats.length > 0 && (
            <Breakdown
              title="Expenses"
              categories={expenseCats}
              totalMinor={totals.expenseMinor}
              display={display}
            />
          )}
          {filter === "income" && incomeCats.length > 0 && (
            <Breakdown
              title="Income"
              categories={incomeCats}
              totalMinor={totals.incomeMinor}
              display={display}
            />
          )}
          {filteredEntries.length > 0 ? (
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
          ) : (
            <p className="text-sm text-muted">
              No {filter === "expense" ? "expenses" : "income"} this month.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function TotalToggle({
  label,
  minor,
  currency,
  active,
  onClick,
}: {
  label: string;
  minor: number;
  currency: CurrencyCode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-col gap-1 rounded-lg border px-4 pt-3 pb-4 text-left transition-colors",
        active ? "border-fg bg-fg text-bg" : "border-rule bg-surface text-fg hover:border-fg",
      )}
      data-testid={`total-${label.toLowerCase()}`}
    >
      <span className={cn("text-sm", active ? "text-bg/70" : "text-muted")}>{label}</span>
      <Money minor={minor} currency={currency} className="text-2xl md:text-3xl" />
    </button>
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
