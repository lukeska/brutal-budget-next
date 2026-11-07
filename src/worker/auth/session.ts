import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomToken, sha256Hex } from "../lib/crypto";
import { addMs, DAY_MS, HOUR_MS } from "../lib/time";

export const SESSION_COOKIE = "__Host-bb_session";
export const SESSION_TTL_MS = 30 * DAY_MS;
/** A session can never outlive this, however often it is used. */
export const SESSION_MAX_AGE_MS = 90 * DAY_MS;
/** Sliding the expiry costs a D1 write, so it happens at most this often per session. */
const SLIDE_INTERVAL_MS = HOUR_MS;

type SessionRow = {
  token_hash: string;
  user_id: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
};

function expiryFrom(now: string, createdAt: string): string {
  const sliding = Date.parse(now) + SESSION_TTL_MS;
  const cap = Date.parse(createdAt) + SESSION_MAX_AGE_MS;
  return new Date(Math.min(sliding, cap)).toISOString();
}

function writeCookie(c: Context, token: string, expiresAt: string, now: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.max(0, Math.floor((Date.parse(expiresAt) - Date.parse(now)) / 1000)),
  });
}

export async function createSession(c: Context, db: D1Database, userId: string, now: string) {
  const token = randomToken(32);
  const expiresAt = expiryFrom(now, now);
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(await sha256Hex(token), userId, now, now, expiresAt)
    .run();
  writeCookie(c, token, expiresAt, now);
}

/**
 * Resolves the request's session, sliding its expiry when due. Returns null (and deletes the row and
 * cookie) when the session is missing, expired, or past the absolute cap.
 */
export async function loadSession(c: Context, db: D1Database, now: string) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT * FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<SessionRow>();
  if (!row) {
    clearSessionCookie(c);
    return null;
  }
  if (row.expires_at <= now || addMs(row.created_at, SESSION_MAX_AGE_MS) <= now) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    clearSessionCookie(c);
    return null;
  }
  if (addMs(row.last_used_at, SLIDE_INTERVAL_MS) <= now) {
    const expiresAt = expiryFrom(now, row.created_at);
    await db
      .prepare("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?")
      .bind(now, expiresAt, tokenHash)
      .run();
    writeCookie(c, token, expiresAt, now);
  }
  return { tokenHash, userId: row.user_id };
}

export async function deleteSession(db: D1Database, tokenHash: string) {
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}
