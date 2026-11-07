import { env, exports } from "cloudflare:workers";
import { bytesToBase64url, DEFAULT_ARGON2 } from "@shared/auth";
import type { SetupRequest } from "@shared/setup";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/worker/app";
import { computeVerifier } from "../../src/worker/auth/password";
import { sha256Hex } from "../../src/worker/lib/crypto";

const ORIGIN = "https://app.test";
const db = env.DB;

const keyOf = (fill: number) => bytesToBase64url(new Uint8Array(32).fill(fill));
const saltOf = (fill: number) => bytesToBase64url(new Uint8Array(16).fill(fill));

let ipCounter = 0;
/** A fresh client IP per call keeps tests clear of each other's per-IP rate limit. */
const freshIp = () => `198.51.100.${++ipCounter}`;

function validBody(overrides: Partial<SetupRequest> = {}): SetupRequest {
  return {
    setupToken: env.SETUP_TOKEN,
    baseCurrency: "EUR",
    timezone: "Europe/Rome",
    argonParams: DEFAULT_ARGON2,
    partners: [
      { name: "Alice", email: "Alice@Example.com", salt: saltOf(1), key: keyOf(1) },
      { name: "Bob", email: "bob@example.com", salt: saltOf(2), key: keyOf(2) },
    ],
    account: { name: "Joint", currency: "EUR", openingMinor: 123456 },
    addDefaultCategories: true,
    ...overrides,
  };
}

function postSetup(body: unknown) {
  return exports.default.fetch(`${ORIGIN}/api/setup`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": freshIp() },
    body: JSON.stringify(body),
  });
}

async function status() {
  const res = await exports.default.fetch(`${ORIGIN}/api/setup/status`, {
    headers: { "cf-connecting-ip": freshIp() },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { needsSetup: boolean };
}

async function count(table: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function expectEmpty() {
  for (const table of ["household", "users", "accounts", "categories", "sessions"]) {
    expect(await count(table), table).toBe(0);
  }
}

beforeEach(async () => {
  await db.batch(
    [
      "DELETE FROM sessions",
      "DELETE FROM categories WHERE parent_id IS NOT NULL",
      "DELETE FROM categories",
      "DELETE FROM accounts",
      "DELETE FROM users",
      "DELETE FROM household",
    ].map((sql) => db.prepare(sql)),
  );
});

describe("setup status", () => {
  it("says setup is needed on a fresh deployment and not after setup", async () => {
    expect(await status()).toEqual({ needsSetup: true });
    expect((await postSetup(validBody())).status).toBe(200);
    expect(await status()).toEqual({ needsSetup: false });
  });
});

describe("setup status rate limiting", () => {
  it("answers every page load from one IP, since only setup attempts are rate-limited", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await exports.default.fetch("https://app.test/api/setup/status", {
        headers: { "cf-connecting-ip": "203.0.113.77" },
      });
      statuses.push(res.status);
    }
    expect(new Set(statuses)).toEqual(new Set([200]));
  });
});

describe("POST /api/setup", () => {
  it("creates the household, both partners, the account and default categories, and signs in partner 1", async () => {
    const res = await postSetup(validBody());
    expect(res.status).toBe(200);

    const household = await db
      .prepare("SELECT id, base_currency, timezone, argon_params FROM household")
      .first<{ id: number; base_currency: string; timezone: string; argon_params: string }>();
    expect(household).toMatchObject({ id: 1, base_currency: "EUR", timezone: "Europe/Rome" });
    expect(JSON.parse(household?.argon_params ?? "null")).toEqual(DEFAULT_ARGON2);

    const { results: users } = await db
      .prepare("SELECT id, email, name, salt, verifier FROM users ORDER BY name")
      .all<{ id: string; email: string; name: string; salt: string; verifier: string }>();
    expect(users.map((u) => [u.name, u.email, u.salt])).toEqual([
      ["Alice", "alice@example.com", saltOf(1)],
      ["Bob", "bob@example.com", saltOf(2)],
    ]);
    expect(users[0]?.verifier).toBe(await computeVerifier(env.AUTH_SECRET, keyOf(1)));
    expect(users[1]?.verifier).toBe(await computeVerifier(env.AUTH_SECRET, keyOf(2)));

    const account = await db
      .prepare("SELECT name, currency, opening_minor FROM accounts")
      .first<{ name: string; currency: string; opening_minor: number }>();
    expect(account).toEqual({ name: "Joint", currency: "EUR", opening_minor: 123456 });

    const { results: categories } = await db
      .prepare("SELECT id, type, parent_id, name, colour FROM categories")
      .all<{ id: string; type: string; parent_id: string | null; name: string; colour: string | null }>();
    const groceries = categories.find((c) => c.name === "Groceries");
    const food = categories.find((c) => c.name === "Food");
    expect(food).toMatchObject({ type: "expense", parent_id: null, colour: "#e8590c" });
    expect(groceries).toMatchObject({ type: "expense", parent_id: food?.id, colour: null });
    expect(categories.some((c) => c.type === "income" && c.name === "Salary")).toBe(true);

    const cookie = /__Host-bb_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    expect(cookie).toBeDefined();
    const session = await db
      .prepare("SELECT user_id FROM sessions WHERE token_hash = ?")
      .bind(await sha256Hex(cookie ?? ""))
      .first<{ user_id: string }>();
    expect(session?.user_id).toBe(users[0]?.id);

    const me = await exports.default.fetch(`${ORIGIN}/api/auth/me`, {
      headers: { cookie: `__Host-bb_session=${cookie}` },
    });
    expect(((await me.json()) as { name: string }).name).toBe("Alice");
  });

  it("skips the default categories when they are not wanted", async () => {
    expect((await postSetup(validBody({ addDefaultCategories: false }))).status).toBe(200);
    expect(await count("categories")).toBe(0);
    expect(await count("users")).toBe(2);
  });

  it("returns 404 and creates no user once setup is done, even with the valid token", async () => {
    expect((await postSetup(validBody())).status).toBe(200);
    const again = await postSetup(
      validBody({
        partners: [
          { name: "Eve", email: "eve@example.com", salt: saltOf(3), key: keyOf(3) },
          { name: "Mallory", email: "mallory@example.com", salt: saltOf(4), key: keyOf(4) },
        ],
      }),
    );
    expect(again.status).toBe(404);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(await count("users")).toBe(2);
    expect(await count("household")).toBe(1);
  });

  it("rejects a wrong setup token with 403 and writes nothing", async () => {
    const res = await postSetup(validBody({ setupToken: `${env.SETUP_TOKEN.slice(0, -1)}X` }));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    await expectEmpty();
  });

  it("rejects a token of a different length the same way, without an error", async () => {
    for (const setupToken of ["x", `${env.SETUP_TOKEN}-and-more`]) {
      const res = await postSetup(validBody({ setupToken }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "invalid_setup_token" });
    }
    await expectEmpty();
  });

  it("rejects Argon2 parameters below the floor with 422", async () => {
    for (const argonParams of [
      { ...DEFAULT_ARGON2, memoryKiB: 19455 },
      { ...DEFAULT_ARGON2, iterations: 1 },
      { ...DEFAULT_ARGON2, parallelism: 2 },
    ]) {
      expect((await postSetup({ ...validBody(), argonParams })).status).toBe(422);
    }
    await expectEmpty();
  });

  it("rejects an unknown time zone with 422", async () => {
    expect((await postSetup(validBody({ timezone: "Mars/Olympus_Mons" }))).status).toBe(422);
    await expectEmpty();
  });

  it("lets only one of two concurrent setups through", async () => {
    const [a, b] = await Promise.all([postSetup(validBody()), postSetup(validBody())]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(await count("household")).toBe(1);
    expect(await count("users")).toBe(2);
    expect(await count("accounts")).toBe(1);
    expect(await count("sessions")).toBe(1);
  });

  it("rolls everything back when a partner email is used twice", async () => {
    const res = await postSetup(
      validBody({
        partners: [
          { name: "Alice", email: "alice@example.com", salt: saltOf(1), key: keyOf(1) },
          { name: "Alice 2", email: "ALICE@example.com", salt: saltOf(2), key: keyOf(2) },
        ],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "duplicate_email" });
    await expectEmpty();
    expect(await status()).toEqual({ needsSetup: true });
  });
});

describe("weak secrets", () => {
  async function postWith(overrides: Partial<Env>) {
    return createApp().fetch(
      new Request(`${ORIGIN}/api/setup`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": freshIp() },
        body: JSON.stringify(validBody({ setupToken: "short" })),
      }),
      { ...env, ...overrides },
    );
  }

  it("accepts no setup and explains the fix when SETUP_TOKEN is under 32 characters", async () => {
    const res = await postWith({ SETUP_TOKEN: "short" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "misconfigured",
      detail: "SETUP_TOKEN must be at least 32 characters",
    });
    await expectEmpty();
  });

  it("blocks setup with a configuration error when AUTH_SECRET is under 32 characters", async () => {
    const res = await postWith({ AUTH_SECRET: "short" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("misconfigured");
    await expectEmpty();
  });
});
