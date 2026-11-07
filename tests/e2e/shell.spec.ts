import { expect, test } from "@playwright/test";

test("a deep link is served the SPA, not a 404", async ({ page }) => {
  const res = await page.goto("/accounts");
  expect(res?.status()).toBe(200);
  await expect(page.locator("#root")).toBeAttached();
});

test("an unknown API route returns JSON from the Worker, not SPA HTML", async ({ request }) => {
  const res = await request.get("/api/does-not-exist");
  expect(res.status()).toBe(404);
  expect(res.headers()["content-type"]).toContain("application/json");
});
