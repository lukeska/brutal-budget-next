import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

// End-to-end flows run against the production build served by `vite preview`
// (workerd with a local D1 that is migrated and reset before the run).
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  // Setup claims the shared local deployment once; every other spec runs after it, signed in as its partners.
  projects: [
    { name: "setup", testMatch: /setup\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "desktop",
      testIgnore: /setup\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      testIgnore: /setup\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: `node scripts/e2e-server.mjs ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
