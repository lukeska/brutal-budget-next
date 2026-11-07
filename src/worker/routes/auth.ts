import { zValidator } from "@hono/zod-validator";
import {
  argonParamsSchema,
  changePasswordRequestSchema,
  DEFAULT_ARGON2,
  loginRequestSchema,
  type MeResponse,
  resetPartnerRequestSchema,
  saltRequestSchema,
} from "@shared/auth";
import { Hono } from "hono";
import type { ZodType } from "zod";
import { authRateLimit, clientIp, requireSession } from "../auth/middleware";
import {
  checkCurrentKey,
  clearLoginFailures,
  computeVerifier,
  fakeSalt,
  keyMatches,
  readAttempts,
  recordLoginFailure,
  waitLoginDelay,
} from "../auth/password";
import { clearSessionCookie, createSession, deleteSession } from "../auth/session";
import type { AppEnv } from "../lib/env";
import { jsonError } from "../lib/errors";
import { nowIso } from "../lib/time";

type UserRow = {
  id: string;
  email: string;
  name: string;
  salt: string;
  verifier: string;
  secondary_currency: string | null;
  theme: MeResponse["theme"];
  must_change_password: number;
  password_reset_at: string | null;
  reset_by_name: string | null;
};

const json = <T extends ZodType>(schema: T) =>
  zValidator("json", schema, (result, c) => {
    if (!result.success) return jsonError(c, 400, "invalid_body");
  });

/** Compared against when the email is unknown, so a miss costs the same work as a hit. */
const NO_USER_VERIFIER = "0".repeat(64);

async function householdParams(db: D1Database) {
  const row = await db
    .prepare("SELECT argon_params FROM household WHERE id = 1")
    .first<{ argon_params: string }>();
  if (!row) return DEFAULT_ARGON2;
  return argonParamsSchema.parse(JSON.parse(row.argon_params));
}

function findUserByEmail(db: D1Database, email: string) {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
}

async function findUserById(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT u.*, r.name AS reset_by_name FROM users u
       LEFT JOIN users r ON r.id = u.password_reset_by WHERE u.id = ?`,
    )
    .bind(id)
    .first<UserRow>();
}

export const authRoutes = new Hono<AppEnv>()
  .post("/salt", authRateLimit, json(saltRequestSchema), async (c) => {
    const { email } = c.req.valid("json");
    const [user, params] = await Promise.all([findUserByEmail(c.env.DB, email), householdParams(c.env.DB)]);
    const salt = user?.salt ?? (await fakeSalt(c.env.AUTH_SECRET, email));
    return c.json({ salt, params });
  })

  .post("/login", authRateLimit, json(loginRequestSchema), async (c) => {
    const { email, key } = c.req.valid("json");
    const db = c.env.DB;
    const ip = clientIp(c);
    const attempts = await readAttempts(db, email, ip, nowIso());
    if (attempts.pairLocked) return jsonError(c, 429, "locked_out");
    await waitLoginDelay(attempts.emailFailures);

    const user = await findUserByEmail(db, email);
    const ok = await keyMatches(c.env.AUTH_SECRET, key, user?.verifier ?? NO_USER_VERIFIER);
    const now = nowIso();
    if (!user || !ok) {
      await recordLoginFailure(db, email, ip, now);
      return jsonError(c, 401, "invalid_credentials");
    }
    await clearLoginFailures(db, email, ip);
    await createSession(c, db, user.id, now);
    return c.json({ ok: true });
  })

  .post("/logout", requireSession, async (c) => {
    await deleteSession(c.env.DB, c.var.user.tokenHash);
    clearSessionCookie(c);
    return c.json({ ok: true });
  })

  .get("/me", requireSession, async (c) => {
    const user = await findUserById(c.env.DB, c.var.user.id);
    if (!user) return jsonError(c, 401, "unauthenticated");
    const body: MeResponse = {
      id: user.id,
      name: user.name,
      email: user.email,
      secondaryCurrency: user.secondary_currency,
      theme: user.theme,
      mustChangePassword: user.must_change_password === 1,
    };
    if (user.reset_by_name) body.passwordResetBy = { name: user.reset_by_name };
    if (user.password_reset_at) body.passwordResetAt = user.password_reset_at;
    return c.json(body);
  })

  .post("/password", requireSession, json(changePasswordRequestSchema), async (c) => {
    const { currentKey, newSalt, newVerifierKey } = c.req.valid("json");
    const db = c.env.DB;
    const { id, tokenHash } = c.var.user;
    const user = await findUserById(db, id);
    const check = await checkCurrentKey(db, c.env.AUTH_SECRET, user, currentKey, clientIp(c));
    if (check === "locked") return jsonError(c, 429, "locked_out");
    if (check === "invalid") return jsonError(c, 401, "invalid_credentials");
    const now = nowIso();
    await db.batch([
      db
        .prepare(
          `UPDATE users SET salt = ?, verifier = ?, must_change_password = 0, password_reset_by = NULL,
           password_reset_at = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .bind(newSalt, await computeVerifier(c.env.AUTH_SECRET, newVerifierKey), now, id),
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").bind(id, tokenHash),
    ]);
    return c.json({ ok: true });
  })

  .post("/password/reset-partner", requireSession, json(resetPartnerRequestSchema), async (c) => {
    const { currentKey, partnerNewSalt, partnerNewKey } = c.req.valid("json");
    const db = c.env.DB;
    const actor = await findUserById(db, c.var.user.id);
    const check = await checkCurrentKey(db, c.env.AUTH_SECRET, actor, currentKey, clientIp(c));
    if (check === "locked") return jsonError(c, 429, "locked_out");
    if (check === "invalid" || !actor) return jsonError(c, 401, "invalid_credentials");
    const partner = await db
      .prepare("SELECT id FROM users WHERE id <> ?")
      .bind(actor.id)
      .first<{ id: string }>();
    if (!partner) return jsonError(c, 404, "not_found");
    const now = nowIso();
    await db.batch([
      db
        .prepare(
          `UPDATE users SET salt = ?, verifier = ?, must_change_password = 1, password_reset_by = ?,
           password_reset_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .bind(
          partnerNewSalt,
          await computeVerifier(c.env.AUTH_SECRET, partnerNewKey),
          actor.id,
          now,
          now,
          partner.id,
        ),
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(partner.id),
    ]);
    return c.json({ ok: true });
  });
