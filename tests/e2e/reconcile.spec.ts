import { expect, type Page, test } from "@playwright/test";
import { v7 as uuidv7 } from "uuid";

// Runs after setup.spec.ts has claimed the deployment with these credentials.
const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery";

type Totals = { income: number; expense: number };
type EntryLite = { kind: string; baseAmountMinor: number | null };

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

test("reconciling books the gap as an adjustment without changing any income or expense total", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const headers = { origin: new URL(baseURL ?? "http://localhost:4173").origin };
  const apiPost = async (path: string, data: unknown) => {
    const res = await page.request.post(path, { headers, data });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
  };
  const month = today().slice(0, 7);
  const monthTotals = async (): Promise<Totals> => {
    const entries: EntryLite[] = await (await page.request.get(`/api/entries?month=${month}`)).json();
    const sum = (kind: string) =>
      entries.filter((e) => e.kind === kind).reduce((total, e) => total + (e.baseAmountMinor ?? 0), 0);
    return { income: sum("income"), expense: sum("expense") };
  };

  await logIn(page);

  // Joint shows €2,410.00: a €2,500.00 opening and a €90.00 transfer out.
  const suffix = Date.now().toString(36);
  const joint = await apiPost("/api/accounts", {
    id: uuidv7(),
    name: `Joint ${suffix}`,
    currency: "EUR",
    openingMinor: 250_000,
  });
  const savings = await apiPost("/api/accounts", {
    id: uuidv7(),
    name: `Savings ${suffix}`,
    currency: "EUR",
    openingMinor: 0,
  });
  await apiPost("/api/entries", {
    id: uuidv7(),
    kind: "transfer",
    date: today(),
    accountId: joint.id,
    toAccountId: savings.id,
    amountMinor: 9_000,
  });
  const before = await monthTotals();

  await page.goto(`/accounts/${joint.id}`);
  await expect(page.getByRole("heading", { name: `Joint ${suffix}` })).toBeVisible();
  await page.getByRole("button", { name: "Reconcile", exact: true }).click();
  await page.getByLabel(/^Bank balance/).fill("2385");
  await expect(page.getByTestId("reconcile-gap")).toContainText("25");
  await page.getByRole("button", { name: "Book adjustment" }).click();
  await expect(page.getByText("Adjustment booked")).toBeVisible();

  await expect(page.getByText("Balance adjustment")).toBeVisible();
  const after = await (await page.request.get(`/api/accounts/${joint.id}`)).json();
  expect(after.balanceMinor).toBe(238_500);
  const history = await (await page.request.get(`/api/accounts/${joint.id}/history`)).json();
  expect(history.rows[0]).toMatchObject({ kind: "adjustment", deltaMinor: -2_500 });

  expect(await monthTotals()).toEqual(before);
});
