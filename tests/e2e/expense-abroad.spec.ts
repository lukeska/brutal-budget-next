import { expect, type Page, test } from "@playwright/test";
import { v7 as uuidv7 } from "uuid";

// Runs after setup.spec.ts has claimed the deployment with these credentials.
const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery";

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

test("an expense paid in yen on the euro card books what the bank charged", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const headers = { origin: new URL(baseURL ?? "http://localhost:4173").origin };
  const apiPost = async (path: string, data: unknown) => {
    const res = await page.request.post(path, { headers, data });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
  };

  await logIn(page);

  const suffix = Date.now().toString(36);
  const card = await apiPost("/api/accounts", {
    id: uuidv7(),
    name: `Euro card ${suffix}`,
    currency: "EUR",
    openingMinor: 100_000,
  });
  const category = await apiPost("/api/categories", {
    id: uuidv7(),
    type: "expense",
    name: `Ramen ${suffix}`,
    icon: "IconTag",
    colour: "#336699",
  });

  await page.goto("/");
  await page.getByRole("button", { name: /^(\+ Add|Add entry)$/ }).click();
  const drawer = page.getByRole("dialog", { name: "New expense" });
  await expect(drawer).toBeVisible();

  const amount = drawer.getByLabel("Amount", { exact: true });
  await expect(amount).toBeFocused();
  await amount.fill("3000");
  await drawer.getByLabel("Amount currency").selectOption("JPY");
  await drawer.getByLabel("Account", { exact: true }).selectOption(card.id);

  // Prefilled from the day's rate when one is published; the partner types the bank's charge either way.
  const booked = drawer.getByLabel(`Amount on ${card.name} (EUR)`);
  await expect(booked).toBeVisible();
  await booked.fill("18.70");

  await drawer
    .getByRole("list", { name: "All categories" })
    .getByRole("button", { name: category.name })
    .click();
  await drawer.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("Saved")).toBeVisible();
  await expect(drawer).toBeHidden();

  // The month list shows both the original and the booked amount.
  await page.goto("/");
  await expect(page.getByText(/3,000/).first()).toBeVisible();
  await expect(page.getByText(/18\.70/).first()).toBeVisible();

  const after = await (await page.request.get(`/api/accounts/${card.id}`)).json();
  expect(after.balanceMinor).toBe(100_000 - 1_870);
});
