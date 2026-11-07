import { expect, test } from "@playwright/test";

// Runs after setup.spec.ts has claimed the deployment with these credentials.
const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery";

test("every page carries a strict Content-Security-Policy, and login still works under it", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const res = await page.goto("/login");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res?.headers()["x-content-type-options"]).toBe("nosniff");

  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
  });
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
  expect(violations).toEqual([]);
});

test("the service worker caches the app shell but never API responses", async ({ page }) => {
  await page.goto("/");
  // The app registers the worker itself on load.
  const registered = await page.evaluate(async () => {
    const reg = await window.navigator.serviceWorker.ready;
    return reg.active?.scriptURL ?? "";
  });
  expect(registered).toContain("/sw.js");

  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await window.caches.keys()) {
      const cache = await window.caches.open(name);
      for (const req of await cache.keys()) urls.push(new URL(req.url).pathname);
    }
    return urls;
  });
  expect(cached.some((u) => u === "/index.html" || u.startsWith("/assets/"))).toBe(true);
  expect(cached.filter((u) => u.startsWith("/api/"))).toEqual([]);
});
