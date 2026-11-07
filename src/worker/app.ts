import { Hono } from "hono";

export type AppEnv = { Bindings: Env };

export function createApp() {
  const app = new Hono<AppEnv>().basePath("/api");

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    console.error("unhandled error", err.message);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
