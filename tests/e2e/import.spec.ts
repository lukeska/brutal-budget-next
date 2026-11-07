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

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function upload(page: Page, name: string, content: string) {
  await page.goto("/import");
  await expect(page.getByRole("heading", { name: "Import", exact: true })).toBeVisible();
  await page
    .getByLabel("CSV file")
    .setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(content) });
}

test("a CSV imports into the month view, and uploading it again adds nothing", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const headers = { origin: new URL(baseURL ?? "http://localhost:4173").origin };
  await logIn(page);

  const suffix = Date.now().toString(36);
  const accountName = `Import ${suffix}`;
  const res = await page.request.post("/api/accounts", {
    headers,
    data: { id: uuidv7(), name: accountName, currency: "EUR", openingMinor: 0 },
  });
  expect(res.status(), await res.text()).toBe(201);

  const category = `Climbing ${suffix}`;
  const date = today();
  const csv = [
    "date,type,amount,currency,account,category,subcategory,partner,notes",
    `${date},expense,42.50,EUR,${accountName},${category},Gym,${EMAIL},Chalk ${suffix}`,
    `${date},expense,3.20,EUR,${accountName},${category},,${EMAIL},Coffee ${suffix}`,
    `${date},expense,3.20,EUR,${accountName},${category},,${EMAIL},Coffee ${suffix}`,
  ].join("\n");

  // First upload: the file's account and partner match by name and email.
  await upload(page, "history.csv", csv);
  await expect(page.getByLabel(`Account “${accountName}”`)).toHaveValue(/.+/);
  await page.getByRole("button", { name: "Check for duplicates" }).click();
  const summary = page.getByLabel("Import summary");
  await expect(summary).toContainText("New3");
  await expect(summary).toContainText("Already imported0");
  await page.getByRole("button", { name: "Import 3 entries" }).click();
  await expect(page.getByText("Imported 3 entries")).toBeVisible();

  await page.getByRole("link", { name: "Open the month view" }).click();
  await expect(page.getByText(category).first()).toBeVisible();
  const entries: { notes: string | null }[] = await (
    await page.request.get(`/api/entries?month=${date.slice(0, 7)}`)
  ).json();
  expect(entries.filter((e) => e.notes?.endsWith(suffix))).toHaveLength(3);

  // Second upload of the same file: every row is already imported and nothing is added.
  await upload(page, "history.csv", csv);
  await page.getByRole("button", { name: "Check for duplicates" }).click();
  await expect(summary).toContainText("New0");
  await expect(summary).toContainText("Already imported3");
  await page.getByRole("button", { name: "Import 0 entries" }).click();
  await expect(page.getByText("Imported 0 entries")).toBeVisible();
  await expect(page.getByText(/skipped 3 already/)).toBeVisible();
});
