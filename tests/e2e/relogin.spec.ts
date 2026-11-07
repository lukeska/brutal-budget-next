import { expect, type Page, test } from "@playwright/test";

// Runs after setup.spec.ts has claimed the deployment with these credentials.
const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery";

async function logIn(page: Page) {
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

async function logOut(page: Page) {
  const menu = page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

test("logging out and back in in the same tab reaches the app", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");
  await logIn(page);
  await logOut(page);
  await logIn(page);
  await expect(
    page.getByRole("button", { name: "Log out" }).or(page.getByRole("button", { name: "Open menu" })),
  ).toBeVisible();
});
