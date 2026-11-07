import { dismissToast, Toaster } from "@client/components/ui/toast";
import { EntryDrawer, NO_RATE_MESSAGE } from "@client/drawer/EntryDrawer";
import {
  type EntryForm,
  errorsFromIssues,
  formFromEntry,
  toEntryCreate,
  toEntryPatch,
} from "@client/drawer/form";
import { drawerStore } from "@client/drawer/store";
import { resetOnlineForTests } from "@client/lib/online";
import type { CurrencyCode } from "@shared/money";
import { CONFLICT_MESSAGE, type Entry } from "@shared/schemas/entry";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = { id: "u1", name: "Alice" };
const PARTNER = { id: "u2", name: "Bob" };

const ACCOUNTS = [
  { id: "a1", name: "Joint", currency: "EUR", archivedAt: null },
  { id: "a2", name: "Card", currency: "EUR", archivedAt: null },
  { id: "a3", name: "Savings", currency: "DKK", archivedAt: null },
  { id: "a4", name: "Old", currency: "EUR", archivedAt: "2026-01-01T00:00:00Z" },
].map((a) => ({
  ...a,
  openingMinor: 0,
  version: 1,
  balanceMinor: 0,
  hasEntries: true,
  changedSinceReconcile: null,
}));

function category(id: string, name: string, type: "expense" | "income", parentId: string | null = null) {
  return {
    id,
    name,
    type,
    parentId,
    icon: "tag",
    colour: "#3366ff",
    archived: false,
    archivedAt: null,
    entryCount: 0,
    version: 1,
  };
}

const EXPENSE_TREE = [
  { ...category("c1", "Food", "expense"), children: [category("c2", "Groceries", "expense", "c1")] },
  { ...category("c3", "Transport", "expense"), children: [] },
  { ...category("c4", "Fun", "expense"), children: [] },
  { ...category("c5", "Gone", "expense"), archived: true, children: [] },
];
const INCOME_TREE = [
  { ...category("i1", "Salary", "income"), children: [] },
  { ...category("i2", "Gifts", "income"), children: [] },
];

const SAVED: Entry = {
  id: "0190f5a2-1111-7000-8000-000000000001",
  kind: "expense",
  date: "2026-11-05",
  userId: "u1",
  amountMinor: 1250,
  currency: "EUR",
  accountId: "a1",
  accountCurrency: "EUR",
  accountAmountMinor: 1250,
  toAccountId: null,
  toCurrency: null,
  toAmountMinor: null,
  baseAmountMinor: 1250,
  fxState: "fixed",
  rateScaled: null,
  rateDate: null,
  categoryId: "c3",
  projectId: null,
  notes: null,
  fingerprint: null,
  importBatchId: null,
  version: 3,
  createdAt: "2026-11-05T10:00:00Z",
  updatedAt: "2026-11-05T10:00:00Z",
};

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;
type Call = { method: string; url: string; body: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let routes: Map<string, Handler>;
let calls: Call[];

/** Answers "METHOD /path?query" keys; anything unrouted is a test bug and fails loudly. */
function mockApi(overrides: Record<string, Handler> = {}) {
  routes = new Map<string, Handler>(
    Object.entries({
      "GET /api/auth/me": () =>
        json({
          ...ME,
          email: "alice@example.com",
          secondaryCurrency: null,
          theme: null,
          mustChangePassword: false,
        }),
      "GET /api/settings": () =>
        json({
          me: { ...ME, email: "alice@example.com", secondaryCurrency: null, theme: "system" },
          partner: PARTNER,
          household: { baseCurrency: "EUR", timezone: "Europe/Rome" },
        }),
      "GET /api/accounts": () => json(ACCOUNTS),
      "GET /api/entries/defaults": () =>
        json({
          lastAccountByKind: { expense: "a2", income: "a1" },
          topCategories: { expense: ["c2", "c3"], income: ["i1"] },
        }),
      "GET /api/categories?type=expense": () => json(EXPENSE_TREE),
      "GET /api/categories?type=income": () => json(INCOME_TREE),
      "GET /api/projects": () => json([]),
      // 160 yen per euro.
      "GET /api/rates?date=2026-11-07": () =>
        json({
          status: "ok",
          days: [
            {
              date: "2026-11-07",
              rates: { JPY: { rateScaled: 1_600_000_000_000, sourceDate: "2026-11-06" } },
            },
          ],
        }),
      [`GET /api/entries/${SAVED.id}`]: () => json(SAVED),
      ...overrides,
    }),
  );
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const handler = routes.get(`${method} ${url}`);
    if (!handler) throw new Error(`Unrouted request: ${method} ${url}`);
    return handler(init);
  });
}

function posts(): Call[] {
  return calls.filter((c) => c.method === "POST" && c.url === "/api/entries");
}

function renderDrawer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EntryDrawer />
      <Toaster />
    </QueryClientProvider>,
  );
}

async function openNew() {
  renderDrawer();
  act(() => drawerStore.openCreate("expense"));
  return screen.findByLabelText("Amount");
}

async function openSaved() {
  renderDrawer();
  act(() => drawerStore.openEdit(SAVED.id));
  return screen.findByLabelText("Amount");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-07T10:00:00Z"));
  sessionStorage.clear();
  resetOnlineForTests();
  mockApi();
});

afterEach(() => {
  act(() => drawerStore.close());
  // Toasts live in a module-level store; clear them so one test's "Saved" can't satisfy the next.
  act(() => {
    for (let id = 1; id < 1000; id++) dismissToast(id);
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("entry drawer", () => {
  it("opens on an expense for today with the amount focused and the partner's last expense account", async () => {
    const amount = await openNew();
    expect(screen.getByRole("heading", { name: "New expense" })).toBeInTheDocument();
    await waitFor(() => expect(amount).toHaveFocus());
    expect(screen.getByRole("radio", { name: "Expense" })).toBeChecked();
    expect(screen.getByLabelText("Date")).toHaveValue("2026-11-07");
    expect(screen.getByLabelText("Account")).toHaveValue("a2");
    expect(screen.getByLabelText("Partner")).toHaveValue("u1");
    // Archived accounts are not offered.
    expect(within(screen.getByLabelText("Account")).queryByText(/Old/)).toBeNull();
  });

  it("offers the partner's most used categories as chips, and switching to income swaps them and clears the choice", async () => {
    const user = userEvent.setup();
    await openNew();
    const chips = await screen.findByRole("group", { name: "Most used categories" });
    expect(
      within(chips)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Groceries", "Transport"]);
    expect(screen.queryByRole("button", { name: "Gone" })).toBeNull();

    await user.click(within(chips).getByRole("button", { name: "Groceries" }));
    expect(within(chips).getByRole("button", { name: "Groceries" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("radio", { name: "Income" }));
    const incomeChips = await screen.findByRole("group", { name: "Most used categories" });
    await waitFor(() =>
      expect(
        within(incomeChips)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual(["Salary"]),
    );
    expect(screen.queryByRole("button", { name: "Groceries" })).toBeNull();
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "New income" })).toBeInTheDocument();
    expect(screen.getByLabelText("Account")).toHaveValue("a1");
  });

  it("prefills the account amount for yen on a euro account and saves the amount the partner typed instead", async () => {
    const user = userEvent.setup();
    mockApi({ "POST /api/entries": () => json(SAVED, 201) });
    const amount = await openNew();
    await user.type(amount, "3000");
    await user.selectOptions(screen.getByLabelText("Amount currency"), "JPY");

    const booked = await screen.findByLabelText("Amount on Card (EUR)");
    await waitFor(() => expect(booked).toHaveValue("18.75"));
    await user.clear(booked);
    await user.type(booked, "18.70");
    await user.click(
      within(await screen.findByRole("group", { name: "Most used categories" })).getByRole("button", {
        name: "Transport",
      }),
    );
    // Enter in a field saves.
    await user.type(booked, "{Enter}");

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toMatchObject({
      kind: "expense",
      amountMinor: 3000,
      currency: "JPY",
      accountId: "a2",
      accountAmountMinor: 1870,
      categoryId: "c3",
      date: "2026-11-07",
      userId: "u1",
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still saves when no rate is available once the account amount is typed, sending no base value", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/rates?date=2026-11-07": () => json({ status: "unavailable", days: [] }),
      "POST /api/entries": () => json({ ...SAVED, fxState: "waiting", baseAmountMinor: null }, 201),
    });
    const amount = await openNew();
    await user.type(amount, "40");
    await user.selectOptions(screen.getByLabelText("Amount currency"), "USD");
    expect(await screen.findByText(NO_RATE_MESSAGE)).toBeInTheDocument();
    const booked = screen.getByLabelText("Amount on Card (EUR)");
    expect(booked).toHaveValue("");

    await user.click(screen.getAllByRole("button", { name: "Transport" })[0] as HTMLElement);
    await user.type(booked, "37.10");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = posts()[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ amountMinor: 4000, currency: "USD", accountAmountMinor: 3710 });
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(["baseAmountMinor"]));
    expect(body).not.toHaveProperty("fxState");
    expect(body).not.toHaveProperty("rateScaled");
  });

  it("hides the type switch when editing a saved entry", async () => {
    const amount = await openSaved();
    expect(screen.getByRole("heading", { name: "Edit expense" })).toBeInTheDocument();
    expect(amount).toHaveValue("12.50");
    expect(screen.queryByRole("radiogroup", { name: "Entry type" })).toBeNull();
  });

  it("keeps the typed values and offers a reload when the entry changed since it was opened", async () => {
    const user = userEvent.setup();
    mockApi({
      [`PATCH /api/entries/${SAVED.id}`]: () =>
        json({ error: "conflict", message: CONFLICT_MESSAGE, current: { ...SAVED, version: 4 } }, 409),
    });
    const amount = await openSaved();
    await user.clear(amount);
    await user.type(amount, "99");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(CONFLICT_MESSAGE)).toBeInTheDocument();
    expect(amount).toHaveValue("99");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toMatchObject({ version: 3, amountMinor: 9900 });

    const loadsBefore = calls.filter(
      (c) => c.url === `/api/entries/${SAVED.id}` && c.method === "GET",
    ).length;
    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url === `/api/entries/${SAVED.id}` && c.method === "GET").length).toBe(
        loadsBefore + 1,
      ),
    );
    expect(amount).toHaveValue("99");
  });

  it("on reload keeps the partner's own edits but takes the other partner's changes to untouched fields", async () => {
    const user = userEvent.setup();
    let patches = 0;
    const changed: Entry = { ...SAVED, version: 4, categoryId: "c4" };
    mockApi({
      [`PATCH /api/entries/${SAVED.id}`]: () => {
        patches += 1;
        return patches === 1
          ? json({ error: "conflict", message: CONFLICT_MESSAGE, current: changed }, 409)
          : json({ ...changed, version: 5, amountMinor: 9900 });
      },
    });
    const amount = await openSaved();
    // The other partner moves it to "Fun" while this drawer is open.
    routes.set(`GET /api/entries/${SAVED.id}`, () => json(changed));
    await user.clear(amount);
    await user.type(amount, "99");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(CONFLICT_MESSAGE)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByText(CONFLICT_MESSAGE)).toBeNull());
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PATCH")[1]?.body).toMatchObject({
      version: 4,
      amountMinor: 9900,
      categoryId: "c4",
    });
  });

  it("waits for the rate of a newly picked date before saving a prefilled account amount", async () => {
    const user = userEvent.setup();
    let releaseRates: (r: Response) => void = () => {};
    mockApi({
      "GET /api/rates?date=2026-11-06": () =>
        new Promise<Response>((resolve) => {
          releaseRates = resolve;
        }),
      "POST /api/entries": () => json(SAVED, 201),
    });
    const amount = await openNew();
    await user.type(amount, "3000");
    await user.selectOptions(screen.getByLabelText("Amount currency"), "JPY");
    const booked = await screen.findByLabelText("Amount on Card (EUR)");
    await waitFor(() => expect(booked).toHaveValue("18.75"));
    await user.click(screen.getAllByRole("button", { name: "Transport" })[0] as HTMLElement);

    // Picking yesterday starts a fresh rates fetch; the old day's conversion must not be saved meanwhile.
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-06" } });
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeDisabled());
    await user.click(save);
    expect(posts()).toHaveLength(0);

    // 150 yen per euro on the 6th.
    act(() =>
      releaseRates(
        json({
          status: "ok",
          days: [
            {
              date: "2026-11-06",
              rates: { JPY: { rateScaled: 1_500_000_000_000, sourceDate: "2026-11-06" } },
            },
          ],
        }),
      ),
    );
    await waitFor(() => expect(booked).toHaveValue("20.00"));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toMatchObject({ date: "2026-11-06", accountAmountMinor: 2000 });
  });

  it("keeps the drawer open after a network failure, and Retry resends the same id", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    mockApi({
      "POST /api/entries": () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError("Failed to fetch");
        return json(SAVED, 201);
      },
    });
    const amount = await openNew();
    await user.type(amount, "12.50");
    await user.click(screen.getAllByRole("button", { name: "Transport" })[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Couldn't reach the server")).toBeInTheDocument();
    expect(screen.getByLabelText("Amount")).toHaveValue("12.50");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    const ids = posts().map((c) => (c.body as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it("disables saving while offline and says so", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    try {
      await openNew();
      expect(screen.getByText("You're offline — this entry can't be saved yet")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    } finally {
      Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
    }
  });

  it("restores an unsaved draft when the drawer comes back, and drops it on cancel", async () => {
    const user = userEvent.setup();
    const first = renderDrawer();
    act(() => drawerStore.openCreate("expense"));
    await user.type(await screen.findByLabelText("Amount"), "7.20");
    // The shell unmounts the drawer (e.g. on the way to the login screen) without cancelling it.
    first.unmount();
    renderDrawer();
    expect(await screen.findByLabelText("Amount")).toHaveValue("7.20");

    await user.click(screen.getByRole("button", { name: "Close" }));
    act(() => drawerStore.openCreate("expense"));
    expect(await screen.findByLabelText("Amount")).toHaveValue("");
  });

  it("tells the partner when a delete fails offline", async () => {
    const user = userEvent.setup();
    mockApi({
      [`DELETE /api/entries/${SAVED.id}?version=3`]: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await openSaved();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Not deleted — offline")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a read-only note for balance adjustments", async () => {
    mockApi({
      [`GET /api/entries/${SAVED.id}`]: () => json({ ...SAVED, kind: "adjustment", categoryId: null }),
    });
    renderDrawer();
    act(() => drawerStore.openEdit(SAVED.id));
    expect(
      await screen.findByText("Adjustments are changed from the account's reconciliation."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Amount")).toBeNull();
  });
});

describe("drawer form mapping", () => {
  const currencies: Record<string, CurrencyCode> = { eur: "EUR", dkk: "DKK" };
  const currencyOf = (id: string) => currencies[id];
  const base: EntryForm = {
    kind: "expense",
    id: "0190f5a2-1111-7000-8000-000000000009",
    version: 0,
    amount: "12,50",
    currency: "EUR",
    accountId: "eur",
    accountAmount: "",
    accountAmountTouched: false,
    toAccountId: "",
    toAmount: "",
    toAmountTouched: false,
    categoryId: "c1",
    date: "2026-11-07",
    userId: "u1",
    projectId: "",
    notes: "  ",
  };

  it("builds a same-currency expense without an account amount", () => {
    expect(toEntryCreate(base, currencyOf)).toEqual({
      ok: true,
      value: {
        kind: "expense",
        id: base.id,
        date: "2026-11-07",
        accountId: "eur",
        userId: "u1",
        notes: null,
        amountMinor: 1250,
        currency: "EUR",
        categoryId: "c1",
        projectId: null,
      },
    });
  });

  it("requires the account amount for a foreign currency and sends it", () => {
    const foreign = { ...base, amount: "3000", currency: "JPY" as const };
    expect(toEntryCreate(foreign, currencyOf)).toEqual({
      ok: false,
      errors: { accountAmountMinor: "Enter the amount in EUR" },
    });
    const result = toEntryCreate({ ...foreign, accountAmount: "18.70" }, currencyOf);
    expect(result.ok && result.value).toMatchObject({
      amountMinor: 3000,
      currency: "JPY",
      accountAmountMinor: 1870,
    });
  });

  it("reports every missing field", () => {
    const result = toEntryCreate(
      { ...base, amount: "", categoryId: "", accountId: "", date: "" },
      currencyOf,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual([
      "accountId",
      "amountMinor",
      "categoryId",
      "date",
    ]);
    const decimals = toEntryCreate({ ...base, amount: "1.234" }, currencyOf);
    expect(!decimals.ok && decimals.errors.amountMinor).toBe("Too many decimals");
  });

  it("builds a transfer, asking for the arrived amount only across currencies", () => {
    const transfer = { ...base, kind: "transfer" as const, amount: "500", toAccountId: "dkk" };
    expect(!toEntryCreate(transfer, currencyOf).ok).toBe(true);
    const result = toEntryCreate({ ...transfer, toAmount: "3725" }, currencyOf);
    expect(result.ok && result.value).toEqual({
      kind: "transfer",
      id: base.id,
      date: "2026-11-07",
      accountId: "eur",
      userId: "u1",
      notes: null,
      toAccountId: "dkk",
      amountMinor: 50_000,
      toAmountMinor: 372_500,
    });
    const same = toEntryCreate({ ...transfer, toAccountId: "eur" }, currencyOf);
    expect(!same.ok && same.errors.toAccountId).toBe("Choose two different accounts");
  });

  it("round-trips a saved entry into a patch carrying its version", () => {
    const form = formFromEntry({ ...SAVED, accountId: "eur" });
    const result = toEntryPatch({ ...form, notes: "bus" }, currencyOf);
    expect(result).toEqual({
      ok: true,
      value: {
        version: 3,
        kind: "expense",
        date: "2026-11-05",
        userId: "u1",
        accountId: "eur",
        amountMinor: 1250,
        notes: "bus",
        currency: "EUR",
        categoryId: "c3",
        projectId: null,
      },
    });
  });

  it("maps validation issues to fields", () => {
    expect(
      errorsFromIssues([
        { path: ["categoryId"], message: "Category is archived" },
        { path: [], message: "Something else" },
      ]),
    ).toEqual({ categoryId: "Category is archived", form: "Something else" });
  });
});
