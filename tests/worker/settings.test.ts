import { env } from "cloudflare:workers";
import { bytesToBase64url } from "@shared/auth";
import type { SettingsResponse } from "@shared/schemas/settings";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { csrfGuard, requireSession } from "../../src/worker/auth/middleware";
import { computeVerifier } from "../../src/worker/auth/password";
import { sha256Hex } from "../../src/worker/lib/crypto";
import type { AppEnv } from "../../src/worker/lib/env";
import { HttpError } from "../../src/worker/lib/errors";
import { settingsRoutes } from "../../src/worker/routes/settings";

const db = env.DB;
const ORIGIN = "https://app.test";
const NOW = new Date().toISOString();

const keyOf = (fill: number) => bytesToBase64url(new Uint8Array(32).fill(fill));
const ALICE = { id: "01900000-0000-7000-8000-00000000000a", token: "alice-token", key: keyOf(1) };
const BOB = { id: "01900000-0000-7000-8000-00000000000b", token: "bob-token", key: keyOf(2) };
const WRONG_KEY = keyOf(9);

/** Mirrors how `src/worker/app.ts` mounts a data router. */
function makeApp() {
  const app = new Hono<AppEnv>().basePath("/api");
  app.use("*", csrfGuard);
  app.use("/settings", requireSession);
  app.use("/settings/*", requireSession);
  app.route("/", settingsRoutes);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, ...err.extra }, err.status);
    throw err;
  });
  return app;
}
const app = makeApp();

function call(method: string, path: string, body?: unknown, token: string | null = ALICE.token) {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
  if (token) headers.cookie = `__Host-bb_session=${token}`;
  return app.request(
    `${ORIGIN}/api${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
}
const get = (path: string, token?: string | null) => call("GET", path, undefined, token);
const patch = (path: string, body: unknown) => call("PATCH", path, body);
const post = (path: string, body: unknown) => call("POST", path, body);

async function settings(): Promise<SettingsResponse> {
  const res = await get("/settings");
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(async () => {
  await db.batch(
    ["DELETE FROM sessions", "DELETE FROM users", "DELETE FROM household"].map((s) => db.prepare(s)),
  );
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  const user = db.prepare(
    "INSERT INTO users (id, email, name, salt, verifier, created_at, updated_at) VALUES (?1, ?2, ?3, 's', ?4, ?5, ?5)",
  );
  const session = db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)",
  );
  await db.batch([
    db
      .prepare(
        "INSERT INTO household (id, base_currency, timezone, argon_params, created_at) VALUES (1, 'EUR', 'Europe/Rome', '{}', ?)",
      )
      .bind(NOW),
    user.bind(ALICE.id, "alice@example.com", "Alice", await computeVerifier(env.AUTH_SECRET, ALICE.key), NOW),
    user.bind(BOB.id, "bob@example.com", "Bob", await computeVerifier(env.AUTH_SECRET, BOB.key), NOW),
    session.bind(await sha256Hex(ALICE.token), ALICE.id, NOW, expires),
    session.bind(await sha256Hex(BOB.token), BOB.id, NOW, expires),
  ]);
});

describe("reading settings", () => {
  it("returns my profile, my partner and the household", async () => {
    expect(await settings()).toEqual({
      me: {
        id: ALICE.id,
        name: "Alice",
        email: "alice@example.com",
        secondaryCurrency: null,
        theme: "system",
      },
      partner: { id: BOB.id, name: "Bob" },
      household: { baseCurrency: "EUR", timezone: "Europe/Rome" },
    });
  });

  it("needs a session", async () => {
    expect((await get("/settings", null)).status).toBe(401);
  });
});

describe("profile", () => {
  it("persists the secondary currency and returns it, per partner", async () => {
    const res = await patch("/settings/profile", { secondaryCurrency: "DKK" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SettingsResponse).me.secondaryCurrency).toBe("DKK");
    expect((await settings()).me.secondaryCurrency).toBe("DKK");
    const bob: SettingsResponse = await (await get("/settings", BOB.token)).json();
    expect(bob.me.secondaryCurrency).toBeNull();
  });

  it("clears the secondary currency with null", async () => {
    await patch("/settings/profile", { secondaryCurrency: "USD" });
    expect((await patch("/settings/profile", { secondaryCurrency: null })).status).toBe(200);
    expect((await settings()).me.secondaryCurrency).toBeNull();
  });

  it("refuses a secondary currency equal to the base currency or unsupported", async () => {
    expect((await patch("/settings/profile", { secondaryCurrency: "EUR" })).status).toBe(422);
    expect((await patch("/settings/profile", { secondaryCurrency: "XXX" })).status).toBe(422);
    expect((await settings()).me.secondaryCurrency).toBeNull();
  });

  it("persists the theme and the name", async () => {
    expect((await patch("/settings/profile", { theme: "dark", name: "Ali" })).status).toBe(200);
    const { me } = await settings();
    expect(me).toMatchObject({ theme: "dark", name: "Ali" });
    expect((await patch("/settings/profile", { theme: "purple" })).status).toBe(422);
  });

  it("refuses to change the household base currency", async () => {
    const res = await patch("/settings/profile", { baseCurrency: "USD" });
    expect(res.status).toBe(422);
    expect((await settings()).household.baseCurrency).toBe("EUR");
  });
});

describe("email change", () => {
  it("changes my email with my current key", async () => {
    const res = await post("/settings/email", { currentKey: ALICE.key, email: "Alice.New@Example.com" });
    expect(res.status).toBe(200);
    expect((await settings()).me.email).toBe("alice.new@example.com");
  });

  it("returns 409 when the email is my partner's, whatever its case", async () => {
    const res = await post("/settings/email", { currentKey: ALICE.key, email: "BOB@example.com" });
    expect(res.status).toBe(409);
    expect((await settings()).me.email).toBe("alice@example.com");
  });

  it("returns 401 without the right current key", async () => {
    const res = await post("/settings/email", { currentKey: WRONG_KEY, email: "new@example.com" });
    expect(res.status).toBe(401);
    expect((await settings()).me.email).toBe("alice@example.com");
  });

  it("refuses a body with no current key", async () => {
    expect((await post("/settings/email", { email: "new@example.com" })).status).toBe(422);
  });
});
