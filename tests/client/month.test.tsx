import { Toaster } from "@client/components/ui/toast";
import { MonthPage } from "@client/routes/index";
import type { MonthEntry, MonthResponse } from "@shared/schemas/month";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "u-alice";
const BOB = "u-bob";

function entry(over: Partial<MonthEntry>): MonthEntry {
  return {
    id: "e-1",
    kind: "expense",
    date: "2026-11-05",
    userId: ALICE,
    amountMinor: 4_000,
    currency: "EUR",
    accountId: "acc-joint",
    accountCurrency: "EUR",
    accountAmountMinor: 4_000,
    toAccountId: null,
    toCurrency: null,
    toAmountMinor: null,
    baseAmountMinor: 4_000,
    fxState: "fixed",
    rateScaled: null,
    rateDate: null,
    categoryId: "cat-groceries",
    projectId: null,
    notes: null,
    importBatchId: null,
    version: 1,
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    userName: "Alice",
    accountName: "Joint",
    toAccountName: null,
    categoryName: "Groceries",
    categoryIcon: "IconBasket",
    categoryColour: "#e8590c",
    projectName: null,
    projectColour: null,
    ...over,
  };
}

const MONTH: MonthResponse = {
  month: "2026-11",
  baseCurrency: "EUR",
  totals: { incomeMinor: 3_000, expenseMinor: 5_870, netMinor: -2_870 },
  categories: [
    {
      id: "cat-food",
      type: "expense",
      name: "Food",
      icon: "IconBread",
      colour: "#e8590c",
      totalMinor: 5_870,
      ownMinor: 1_870,
      children: [
        { id: "cat-groceries", name: "Groceries", icon: "IconBasket", colour: "#e8590c", totalMinor: 4_000 },
      ],
    },
  ],
  entries: [
    entry({
      id: "e-ramen",
      date: "2026-11-10",
      amountMinor: 3_000,
      currency: "JPY",
      accountAmountMinor: 1_870,
      baseAmountMinor: 1_870,
      categoryId: "cat-food",
      categoryName: "Food",
      categoryIcon: "IconBread",
      notes: "Ramen",
    }),
    entry({ id: "e-groceries" }),
  ],
  waitingCount: 1,
  latestRates: { date: "2026-11-06", rates: {} },
};

type Call = { url: string; method: string };
let calls: Call[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderMonth() {
  const rootRoute = createRootRoute({ component: Outlet });
  const routes = [
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: MonthPage }),
    createRoute({ getParentRoute: () => rootRoute, path: "/accounts/$accountId", component: () => null }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url === "/api/auth/me")
      return json({ id: ALICE, name: "Alice", email: "a@example.com", secondaryCurrency: null });
    if (url === "/api/settings")
      return json({
        me: { id: ALICE, name: "Alice", email: "a@example.com", secondaryCurrency: null, theme: "system" },
        partner: { id: BOB, name: "Bob" },
        household: { baseCurrency: "EUR", timezone: "Europe/Rome" },
      });
    if (url.startsWith("/api/month/")) return json(MONTH);
    if (method === "DELETE" && url.startsWith("/api/entries/")) return new Response(null, { status: 204 });
    return json({ error: "not_found" }, 404);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const deletes = () => calls.filter((c) => c.method === "DELETE");

async function groceriesRow() {
  const section = await screen.findByRole("region", { name: "Entries" });
  return within(section).getByRole("button", { name: /Groceries/ });
}

function touch(type: "pointerDown" | "pointerMove" | "pointerUp", el: Element, x: number, y: number) {
  fireEvent[type](el, { pointerId: 7, pointerType: "touch", clientX: x, clientY: y, isPrimary: true });
}

describe("month view", () => {
  it("shows the totals with a signed net", async () => {
    renderMonth();
    const net = await screen.findByTestId("total-net");
    expect(net).toHaveTextContent("−€28.70");
    expect(screen.getByTestId("total-income")).toHaveTextContent("€30.00");
    expect(screen.getByTestId("total-expenses")).toHaveTextContent("€58.70");
    expect(screen.getByText("1 entry waiting for a rate")).toBeInTheDocument();
  });

  it("shows both the original and the booked amount for a foreign entry", async () => {
    renderMonth();
    const section = await screen.findByRole("region", { name: "Entries" });
    expect(within(section).getByText("¥3,000 · €18.70")).toBeInTheDocument();
  });

  it("never deletes on a mostly vertical gesture", async () => {
    renderMonth();
    const row = await groceriesRow();
    touch("pointerDown", row, 200, 100);
    touch("pointerMove", row, 196, 130);
    touch("pointerMove", row, 150, 260);
    touch("pointerUp", row, 150, 260);
    await new Promise((r) => setTimeout(r, 20));
    expect(deletes()).toHaveLength(0);
  });

  it("deletes on a horizontal swipe past the threshold and offers Undo", async () => {
    renderMonth();
    const row = await groceriesRow();
    touch("pointerDown", row, 300, 100);
    touch("pointerMove", row, 285, 102);
    touch("pointerMove", row, 120, 104);
    touch("pointerUp", row, 120, 104);
    await waitFor(() => expect(deletes().map((c) => c.url)).toEqual(["/api/entries/e-groceries?version=1"]));
    expect(await screen.findByText("Entry deleted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("does not delete on a short horizontal swipe", async () => {
    renderMonth();
    const row = await groceriesRow();
    touch("pointerDown", row, 300, 100);
    touch("pointerMove", row, 260, 101);
    touch("pointerUp", row, 260, 101);
    await new Promise((r) => setTimeout(r, 20));
    expect(deletes()).toHaveLength(0);
  });
});
