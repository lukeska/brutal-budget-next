import { MIN_SECRET_LENGTH } from "@shared/auth";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../lib/env";
import { jsonError } from "../lib/errors";
import { nowIso } from "../lib/time";
import { loadSession } from "./session";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Rejects cross-site writes: every non-GET request must come from this deployment's own origin and
 * carry a JSON body type, which a plain HTML form can't send.
 */
export const csrfGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const origin = c.req.header("origin");
  if (!origin || origin !== new URL(c.req.url).origin) return jsonError(c, 403, "forbidden_origin");
  const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) return jsonError(c, 415, "unsupported_media_type");
  return next();
});

/** The client's IP as Cloudflare reports it. */
export const clientIp = (c: Context) => c.req.header("cf-connecting-ip") ?? "unknown";

/** Per-IP limit on login, setup and current-key checks, checked before any database access. */
export const authRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { success } = await c.env.AUTH_RATE_LIMITER.limit({ key: clientIp(c) });
  if (!success) return jsonError(c, 429, "rate_limited");
  return next();
});

/** Refuses auth and setup requests while AUTH_SECRET or SETUP_TOKEN is too short to be safe. */
export const requireStrongSecrets = createMiddleware<AppEnv>(async (c, next) => {
  for (const name of ["AUTH_SECRET", "SETUP_TOKEN"] as const) {
    const value = c.env[name];
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) {
      return jsonError(c, 500, "misconfigured", {
        detail: `${name} must be at least ${MIN_SECRET_LENGTH} characters`,
      });
    }
  }
  return next();
});

/** Requires a valid session and exposes its user as `c.var.user`. */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const session = await loadSession(c, c.env.DB, nowIso());
  if (!session) return jsonError(c, 401, "unauthenticated");
  c.set("user", { id: session.userId, tokenHash: session.tokenHash });
  return next();
});
