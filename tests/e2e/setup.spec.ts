import { expect, type Page, test } from "@playwright/test";

const SETUP_TOKEN = "e2e-setup-token-0123456789abcdefghijklmnopqrstuv";

async function fillPartner(page: Page, name: string, email: string, password: string) {
  await page.getByLabel(/^Name/).fill(name);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByLabel(/^Repeat password/).fill(password);
  await page.getByRole("button", { name: "Next" }).click();
}

test("a fresh deployment is claimed through the wizard, which signs in partner 1 and then closes", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);

  const before = await page.request.get("/api/setup/status");
  expect(await before.json()).toEqual({ needsSetup: true });

  await page.goto("/setup");

  await page.getByLabel(/^Setup token/).fill(SETUP_TOKEN);
  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByRole("heading", { name: "Household" })).toBeVisible();
  await page.getByLabel(/^Base currency/).selectOption("EUR");
  await page.getByLabel(/^Time zone/).fill("Europe/Rome");
  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByRole("heading", { name: /Partner 1/ })).toBeVisible();
  await fillPartner(page, "Alice", "alice@example.com", "correct horse battery");

  await expect(page.getByRole("heading", { name: "Partner 2" })).toBeVisible();
  await fillPartner(page, "Bob", "bob@example.com", "staple battery horse");

  await expect(page.getByRole("heading", { name: "First account" })).toBeVisible();
  await page.getByLabel(/^Account name/).fill("Joint");
  await page.getByLabel(/^Opening balance/).fill("1250.50");
  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByRole("heading", { name: "Categories" })).toBeVisible();
  await expect(page.getByLabel("Add default expense and income categories")).toBeChecked();
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });

  const me = await page.request.get("/api/auth/me");
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ name: "Alice", email: "alice@example.com" });

  const after = await page.request.get("/api/setup/status");
  expect(await after.json()).toEqual({ needsSetup: false });

  const again = await page.request.post("/api/setup", {
    headers: { origin: new URL(baseURL ?? "http://localhost:4173").origin },
    data: {
      setupToken: SETUP_TOKEN,
      baseCurrency: "EUR",
      timezone: "Europe/Rome",
      argonParams: { memoryKiB: 65536, iterations: 3, parallelism: 1, hashLength: 32 },
      partners: [
        { name: "Eve", email: "eve@example.com", salt: "A".repeat(22), key: "A".repeat(43) },
        { name: "Mallory", email: "mallory@example.com", salt: "B".repeat(22), key: "B".repeat(43) },
      ],
      account: { name: "Other", currency: "EUR", openingMinor: 0 },
      addDefaultCategories: false,
    },
  });
  expect(again.status()).toBe(404);
});
