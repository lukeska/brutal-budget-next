import { env, exports } from "cloudflare:workers";
import { bytesToBase64url, DEFAULT_ARGON2 } from "@shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/worker/app";
import { computeVerifier, loginDelayMs, recordLoginFailure } from "../../src/worker/auth/password";
import { sha256Hex } from "../../src/worker/lib/crypto";

const ORIGIN = "https://app.test";
const DAY = 24 * 60 * 60 * 1000;
const db = env.DB;

const keyOf = (fill: number) => bytesToBase64url(new Uint8Array(32).fill(fill));
const saltOf = (fill: number) => bytesToBase64url(new Uint8Array(16).fill(fill));

const ALICE = { id: "01900000-0000-7000-8000-00000000000a", email: "alice@example.com", key: keyOf(1) };
const BOB = { id: "01900000-0000-7000-8000-00000000000b", email: "bob@example.com", key: keyOf(2) };
const WRONG_KEY = keyOf(9);
const PARAMS = { memoryKiB: 47104, iterations: 2, parallelism: 1, hashLength: 32 };

let ipCounter = 0;
/** A fresh client IP per call keeps tests clear of each other's per-IP rate limit. */
const freshIp = () => `203.0.113.${++ipCounter}`;

type Init = { body?: unknown; cookie?: string; ip?: string; headers?: Record<string, string> };

function call(method: string, path: string, init: Init = {}) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    "content-type": "application/json",
    "cf-connecting-ip": init.ip ?? freshIp(),
    ...init.headers,
  };
  if (init.cookie) headers.cookie = init.cookie;
  return exports.default.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
  });
}

const post = (path: string, init: Init = {}) => call("POST", path, init);
const get = (path: string, init: Init = {}) => call("GET", path, init);

function sessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = /__Host-bb_session=([^;]+)/.exec(header);
  if (!match) throw new Error(`no session cookie in ${header}`);
  return `__Host-bb_session=${match[1]}`;
}

async function login(user: { email: string; key: string }, ip = freshIp()) {
  const res = await post("/api/auth/login", { body: { email: user.email, key: user.key }, ip });
  expect(res.status).toBe(200);
  return sessionCookie(res);
}

async function seedSession(
  token: string,
  userId: string,
  createdAt: number,
  lastUsedAt: number,
  expiresAt: number,
) {
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      await sha256Hex(token),
      userId,
      new Date(createdAt).toISOString(),
      new Date(lastUsedAt).toISOString(),
      new Date(expiresAt).toISOString(),
    )
    .run();
  return `__Host-bb_session=${token}`;
}

async function attemptRows() {
  const { results } = await db
    .prepare("SELECT key, failures, locked_until FROM login_attempts ORDER BY key")
    .all<{ key: string; failures: number; locked_until: string | null }>();
  return results;
}

beforeEach(async () => {
  const now = new Date().toISOString();
  await db.batch(
    [
      "DELETE FROM login_attempts",
      "DELETE FROM sessions",
      // A partner reset points one user at the other; clear it so the users can go.
      "UPDATE users SET password_reset_by = NULL",
      "DELETE FROM users",
      "DELETE FROM household",
    ].map((s) => db.prepare(s)),
  );
  const insertUser = db.prepare(
    `INSERT INTO users (id, email, name, salt, verifier, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch([
    db
      .prepare(
        "INSERT INTO household (id, base_currency, timezone, argon_params, created_at) VALUES (1, 'EUR', 'Europe/Rome', ?, ?)",
      )
      .bind(JSON.stringify(PARAMS), now),
    insertUser.bind(
      ALICE.id,
      ALICE.email,
      "Alice",
      saltOf(1),
      await computeVerifier(env.AUTH_SECRET, ALICE.key),
      now,
      now,
    ),
    insertUser.bind(
      BOB.id,
      BOB.email,
      "Bob",
      saltOf(2),
      await computeVerifier(env.AUTH_SECRET, BOB.key),
      now,
      now,
    ),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("login", () => {
  it("creates a session in a __Host- HttpOnly cookie and /me returns the partner", async () => {
    const res = await post("/api/auth/login", { body: { email: "Alice@Example.com", key: ALICE.key } });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-bb_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=2592000/);

    const me = await get("/api/auth/me", { cookie: sessionCookie(res) });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      id: ALICE.id,
      name: "Alice",
      email: ALICE.email,
      secondaryCurrency: null,
      theme: null,
      mustChangePassword: false,
    });
  });

  it("stores only the SHA-256 of the session token", async () => {
    const cookie = await login(ALICE);
    const token = cookie.split("=")[1]!;
    const row = await db.prepare("SELECT token_hash FROM sessions").first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(await sha256Hex(token));
  });

  it("rejects a wrong key with 401 and records the attempt", async () => {
    const ip = freshIp();
    const res = await post("/api/auth/login", { body: { email: ALICE.email, key: WRONG_KEY }, ip });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await attemptRows()).toEqual([
      { key: "alice@example.com|*", failures: 1, locked_until: null },
      { key: `alice@example.com|${ip}`, failures: 1, locked_until: null },
    ]);
  });

  it("counts unknown emails the same way", async () => {
    const ip = freshIp();
    const res = await post("/api/auth/login", { body: { email: "nobody@example.com", key: WRONG_KEY }, ip });
    expect(res.status).toBe(401);
    expect((await attemptRows()).map((r) => r.key)).toEqual([
      "nobody@example.com|*",
      `nobody@example.com|${ip}`,
    ]);
  });

  it("locks the email and IP pair after 10 failures: the 11th attempt gets 429 even with the right key", async () => {
    const waits = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const res = await post("/api/auth/login", { body: { email: ALICE.email, key: WRONG_KEY }, ip });
      expect(res.status).toBe(401);
    }
    const res = await post("/api/auth/login", { body: { email: ALICE.email, key: ALICE.key }, ip });
    expect(res.status).toBe(429);
    expect(waits).toHaveBeenCalled();
  });

  it("lets a correct key from another IP in after failures elsewhere, delayed at most 30 s and never 429", async () => {
    const waits = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
    const attackerIp = freshIp();
    for (let i = 0; i < 10; i++) {
      await post("/api/auth/login", { body: { email: ALICE.email, key: WRONG_KEY }, ip: attackerIp });
    }
    waits.mockClear();
    const res = await post("/api/auth/login", { body: { email: ALICE.email, key: ALICE.key } });
    expect(res.status).toBe(200);
    expect(waits).toHaveBeenCalledTimes(1);
    expect(waits.mock.calls[0]![0]).toBeLessThanOrEqual(30_000);
    // Success clears the email's cross-IP counter; the attacker's pair stays locked.
    expect((await attemptRows()).map((r) => r.key)).toEqual([`alice@example.com|${attackerIp}`]);
  });

  it("adds no delay while an email has at most 5 recent failures", async () => {
    const waits = vi.spyOn(scheduler, "wait");
    for (let i = 0; i < 5; i++) {
      await post("/api/auth/login", { body: { email: ALICE.email, key: WRONG_KEY } });
    }
    expect((await post("/api/auth/login", { body: { email: ALICE.email, key: ALICE.key } })).status).toBe(
      200,
    );
    expect(waits).not.toHaveBeenCalled();
  });

  it("grows the per-email delay exponentially and caps it at 30 s", () => {
    expect([0, 5, 6, 7, 9, 10, 1000].map(loginDelayMs)).toEqual([0, 0, 2000, 4000, 16000, 30000, 30000]);
  });

  it("keeps 1,000 failed logins against one email to two upserted counter rows", async () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 1000; i++) await recordLoginFailure(db, ALICE.email, "198.51.100.7", now);
    const rows = await attemptRows();
    expect(rows.map((r) => [r.key, r.failures])).toEqual([
      ["alice@example.com|*", 1000],
      ["alice@example.com|198.51.100.7", 1000],
    ]);
    expect(rows[0]!.locked_until).toBeNull();
    expect(rows[1]!.locked_until).not.toBeNull();
  });

  it("refuses requests from one IP beyond the per-IP limit", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await post("/api/auth/salt", { body: { email: ALICE.email }, ip })).status);
    }
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
  });
});

describe("salt", () => {
  it("returns the user's salt with the household parameters", async () => {
    const res = await post("/api/auth/salt", { body: { email: ALICE.email } });
    expect(await res.json()).toEqual({ salt: saltOf(1), params: PARAMS });
  });

  it("returns a stable fake salt for an unknown email, shaped like a real one", async () => {
    const first = (await (await post("/api/auth/salt", { body: { email: "ghost@example.com" } })).json()) as {
      salt: string;
      params: unknown;
    };
    const again = await (await post("/api/auth/salt", { body: { email: "GHOST@example.com" } })).json();
    const other = (await (
      await post("/api/auth/salt", { body: { email: "wraith@example.com" } })
    ).json()) as {
      salt: string;
    };
    expect(again).toEqual(first);
    expect(first.params).toEqual(PARAMS);
    expect(first.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(other.salt).not.toBe(first.salt);
  });

  it("returns the default parameters before setup has created the household", async () => {
    await db.prepare("DELETE FROM household").run();
    const body = (await (await post("/api/auth/salt", { body: { email: "ghost@example.com" } })).json()) as {
      params: unknown;
    };
    expect(body.params).toEqual(DEFAULT_ARGON2);
  });
});

describe("weak secrets", () => {
  it("makes login return a configuration error, not a session, when AUTH_SECRET is under 32 characters", async () => {
    const res = await createApp().fetch(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": freshIp() },
        body: JSON.stringify({ email: ALICE.email, key: ALICE.key }),
      }),
      { ...env, AUTH_SECRET: "too-short" },
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({
      error: "misconfigured",
      detail: "AUTH_SECRET must be at least 32 characters",
    });
  });

  it("applies the same check to setup when SETUP_TOKEN is under 32 characters", async () => {
    const res = await createApp().fetch(
      new Request(`${ORIGIN}/api/setup/status`, { headers: { "cf-connecting-ip": freshIp() } }),
      { ...env, SETUP_TOKEN: "short" },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "misconfigured",
      detail: "SETUP_TOKEN must be at least 32 characters",
    });
  });
});

describe("CSRF", () => {
  it("rejects a POST without an Origin header", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
      body: JSON.stringify({ email: ALICE.email, key: ALICE.key }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a cross-origin POST to reset-partner even with a valid session", async () => {
    const cookie = await login(ALICE);
    const res = await post("/api/auth/password/reset-partner", {
      cookie,
      headers: { origin: "https://evil.test" },
      body: { currentKey: ALICE.key, partnerNewSalt: saltOf(7), partnerNewKey: keyOf(7) },
    });
    expect(res.status).toBe(403);
    expect((await post("/api/auth/login", { body: { email: BOB.email, key: BOB.key } })).status).toBe(200);
  });

  it("rejects a text/plain POST with 415", async () => {
    const res = await post("/api/auth/login", {
      headers: { "content-type": "text/plain" },
      body: { email: ALICE.email, key: ALICE.key },
    });
    expect(res.status).toBe(415);
  });
});

describe("sessions", () => {
  it("rejects a session older than 90 days even if it was used yesterday", async () => {
    const now = Date.now();
    const cookie = await seedSession("old-but-busy", ALICE.id, now - 91 * DAY, now - DAY, now + 29 * DAY);
    expect((await get("/api/auth/me", { cookie })).status).toBe(401);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(0);
  });

  it("rejects an expired session and deletes it", async () => {
    const now = Date.now();
    const cookie = await seedSession("expired", ALICE.id, now - 40 * DAY, now - 31 * DAY, now - DAY);
    expect((await get("/api/auth/me", { cookie })).status).toBe(401);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(0);
  });

  it("extends a session used within 30 days to 30 days from now", async () => {
    const now = Date.now();
    const cookie = await seedSession("recent", ALICE.id, now - 2 * DAY, now - 2 * DAY, now + 28 * DAY);
    expect((await get("/api/auth/me", { cookie })).status).toBe(200);
    const expires = await db.prepare("SELECT expires_at FROM sessions").first<string>("expires_at");
    expect(Date.parse(expires!)).toBeGreaterThan(now + 29.9 * DAY);
  });

  it("logout deletes the session", async () => {
    const cookie = await login(ALICE);
    expect((await post("/api/auth/logout", { cookie })).status).toBe(200);
    expect((await get("/api/auth/me", { cookie })).status).toBe(401);
  });

  it("requires a session for /me", async () => {
    expect((await get("/api/auth/me")).status).toBe(401);
  });
});

describe("password change", () => {
  it("keeps the current session, revokes the user's others, and swaps the key", async () => {
    const current = await login(ALICE);
    const other = await login(ALICE);
    const bobs = await login(BOB);
    const newKey = keyOf(5);
    const res = await post("/api/auth/password", {
      cookie: current,
      body: { currentKey: ALICE.key, newSalt: saltOf(5), newVerifierKey: newKey },
    });
    expect(res.status).toBe(200);
    expect((await get("/api/auth/me", { cookie: current })).status).toBe(200);
    expect((await get("/api/auth/me", { cookie: other })).status).toBe(401);
    expect((await get("/api/auth/me", { cookie: bobs })).status).toBe(200);
    expect((await post("/api/auth/login", { body: { email: ALICE.email, key: ALICE.key } })).status).toBe(
      401,
    );
    expect((await post("/api/auth/login", { body: { email: ALICE.email, key: newKey } })).status).toBe(200);
    const salt = await (await post("/api/auth/salt", { body: { email: ALICE.email } })).json();
    expect(salt).toMatchObject({ salt: saltOf(5) });
  });

  it("requires the current key", async () => {
    const cookie = await login(ALICE);
    const res = await post("/api/auth/password", {
      cookie,
      body: { currentKey: WRONG_KEY, newSalt: saltOf(5), newVerifierKey: keyOf(5) },
    });
    expect(res.status).toBe(401);
  });
});

describe("current-key checks", () => {
  const endpoints = [
    {
      path: "/api/auth/password",
      body: (key: string) => ({ currentKey: key, newSalt: saltOf(5), newVerifierKey: keyOf(5) }),
    },
    {
      path: "/api/auth/password/reset-partner",
      body: (key: string) => ({ currentKey: key, partnerNewSalt: saltOf(7), partnerNewKey: keyOf(7) }),
    },
    { path: "/api/settings/email", body: (key: string) => ({ currentKey: key, email: "new@example.com" }) },
  ];

  it.each(endpoints)(
    "$path counts wrong keys like logins: the 11th from one IP gets 429",
    async ({ path, body }) => {
      vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
      const cookie = await login(ALICE);
      const ip = freshIp();
      for (let i = 0; i < 10; i++) {
        expect((await post(path, { cookie, ip, body: body(WRONG_KEY) })).status).toBe(401);
      }
      expect((await post(path, { cookie, ip, body: body(ALICE.key) })).status).toBe(429);
      // The partner's own login from elsewhere still works.
      expect((await post("/api/auth/login", { body: { email: ALICE.email, key: ALICE.key } })).status).toBe(
        200,
      );
    },
  );

  it.each(endpoints)("$path shares the per-IP auth rate limit", async ({ path, body }) => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await post(path, { ip, body: body(WRONG_KEY) })).status);
    expect(statuses).toContain(429);
  });
});

describe("partner reset", () => {
  it("returns 401 without the acting partner's current key", async () => {
    const cookie = await login(ALICE);
    const res = await post("/api/auth/password/reset-partner", {
      cookie,
      body: { currentKey: WRONG_KEY, partnerNewSalt: saltOf(7), partnerNewKey: keyOf(7) },
    });
    expect(res.status).toBe(401);
    expect((await post("/api/auth/login", { body: { email: BOB.email, key: BOB.key } })).status).toBe(200);
  });

  it("makes the partner's old key fail and the new key work, revokes their sessions and flags the reset", async () => {
    const alice = await login(ALICE);
    const bobOld = await login(BOB);
    const bobNewKey = keyOf(7);
    const res = await post("/api/auth/password/reset-partner", {
      cookie: alice,
      body: { currentKey: ALICE.key, partnerNewSalt: saltOf(7), partnerNewKey: bobNewKey },
    });
    expect(res.status).toBe(200);
    expect((await get("/api/auth/me", { cookie: bobOld })).status).toBe(401);
    expect((await get("/api/auth/me", { cookie: alice })).status).toBe(200);
    expect((await post("/api/auth/login", { body: { email: BOB.email, key: BOB.key } })).status).toBe(401);
    const bobNew = await login({ email: BOB.email, key: bobNewKey });
    const me = (await (await get("/api/auth/me", { cookie: bobNew })).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ mustChangePassword: true, passwordResetBy: { name: "Alice" } });
    expect(typeof me.passwordResetAt).toBe("string");
  });
});
