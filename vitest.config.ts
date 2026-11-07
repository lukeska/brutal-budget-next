import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const alias = {
  "@shared": path.resolve(import.meta.dirname, "src/shared"),
  "@client": path.resolve(import.meta.dirname, "src/client"),
};

// Test-only secrets: long enough to pass the 32-character checks.
const TEST_AUTH_SECRET = "test-auth-secret-0123456789abcdefghijklmnopqrstuv";
const TEST_SETUP_TOKEN = "test-setup-token-0123456789abcdefghijklmnopqrstuv";

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "shared",
          environment: "node",
          include: ["tests/shared/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "client",
          environment: "jsdom",
          include: ["tests/client/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/client/setup.ts"],
        },
      },
      {
        resolve: { alias },
        plugins: [
          cloudflareTest(async () => {
            const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
            return {
              main: "./src/worker/index.ts",
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  AUTH_SECRET: TEST_AUTH_SECRET,
                  SETUP_TOKEN: TEST_SETUP_TOKEN,
                },
              },
            };
          }),
        ],
        test: {
          name: "worker",
          include: ["tests/worker/**/*.test.ts"],
          setupFiles: ["tests/worker/apply-migrations.ts"],
        },
      },
    ],
  },
});
