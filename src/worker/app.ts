import { Hono } from "hono";
import { authRateLimit, csrfGuard, requireSession, requireStrongSecrets } from "./auth/middleware";
import type { AppEnv } from "./lib/env";
import { HttpError } from "./lib/errors";
import { authRoutes } from "./routes/auth";
import { entriesRoutes } from "./routes/entries";
import { ratesRoutes } from "./routes/rates";
import { settingsRoutes } from "./routes/settings";
import { setupRoutes } from "./routes/setup";
import { statsRoutes } from "./routes/stats";

export type { AppEnv } from "./lib/env";

export function createApp() {
  const app = new Hono<AppEnv>().basePath("/api");

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.use("*", csrfGuard);

  app.get("/health", (c) => c.json({ ok: true }));

  // Auth and setup refuse to run with weak secrets; setup shares the login rate limit.
  app.use("/auth/*", requireStrongSecrets);
  app.use("/setup", requireStrongSecrets, authRateLimit);
  app.use("/setup/*", requireStrongSecrets, authRateLimit);
  app.route("/auth", authRoutes);
  app.route("/", setupRoutes);

  // Everything below needs a signed-in partner.
  app.use("/rates", requireSession);
  app.use("/rates/*", requireSession);
  app.route("/", ratesRoutes);
  app.use("/entries", requireSession);
  app.use("/entries/*", requireSession);
  app.route("/", entriesRoutes);
  app.use("/settings", requireSession);
  app.use("/settings/*", requireSession);
  app.route("/", settingsRoutes);
  app.use("/stats", requireSession);
  app.use("/stats/*", requireSession);
  app.route("/", statsRoutes);

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, ...err.extra }, err.status);
    console.error("unhandled error", err.message);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
