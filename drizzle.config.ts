import { defineConfig } from "drizzle-kit";

// Migrations are generated here and applied only by `wrangler d1 migrations apply`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/worker/db/schema.ts",
  out: "./migrations",
});
