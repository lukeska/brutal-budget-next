import { base64urlToBytes, bytesToBase64url, SALT_BYTES } from "@shared/auth";
import { digestsEqual, hmacSha256, hmacSha256Hex } from "../lib/crypto";
import { addMs } from "../lib/time";

/** The stored verifier for a browser-derived key: hex(HMAC-SHA256(AUTH_SECRET, "verifier" ‖ key)). */
export function computeVerifier(secret: string, key: string): Promise<string> {
  return hmacSha256Hex(secret, "verifier", base64urlToBytes(key));
}

export async function keyMatches(secret: string, key: string, verifier: string): Promise<boolean> {
  return digestsEqual(await computeVerifier(secret, key), verifier);
}

/** A stable salt for an email with no account, so the salt endpoint can't reveal which emails exist. */
export async function fakeSalt(secret: string, email: string): Promise<string> {
  const mac = await hmacSha256(secret, "fake-salt", new TextEncoder().encode(email.toLowerCase()));
  return bytesToBase64url(new Uint8Array(mac, 0, SALT_BYTES));
}

// Failed-login throttling. Two counter rows per email and IP: `email|ip` locks that pair after too many
// failures, and `email|*` slows every attempt for that email without ever refusing a correct key.
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const LOCKOUT_FAILURES = 10;
const FREE_FAILURES = 5;
const MAX_DELAY_MS = 30_000;

/** Delay before checking a login, given the failures recorded for that email across all IPs. */
export function loginDelayMs(failures: number): number {
  if (failures <= FREE_FAILURES) return 0;
  return Math.min(2 ** (failures - FREE_FAILURES) * 1000, MAX_DELAY_MS);
}

export const pairKey = (email: string, ip: string) => `${email.toLowerCase()}|${ip}`;
export const emailKey = (email: string) => `${email.toLowerCase()}|*`;

type AttemptRow = { key: string; failures: number; window_started_at: string; locked_until: string | null };

export type AttemptState = { pairLocked: boolean; emailFailures: number };

export async function readAttempts(db: D1Database, email: string, ip: string, now: string) {
  const { results } = await db
    .prepare("SELECT key, failures, window_started_at, locked_until FROM login_attempts WHERE key IN (?, ?)")
    .bind(pairKey(email, ip), emailKey(email))
    .all<AttemptRow>();
  const windowStart = addMs(now, -ATTEMPT_WINDOW_MS);
  const pair = results.find((r) => r.key === pairKey(email, ip));
  const all = results.find((r) => r.key === emailKey(email));
  return {
    pairLocked: pair?.locked_until != null && pair.locked_until > now,
    emailFailures: all && all.window_started_at > windowStart ? all.failures : 0,
  } satisfies AttemptState;
}

/**
 * Counts one failed login with one upsert per counter row, so any number of failures for the same
 * email and IP leaves exactly two rows. A counter whose window has passed restarts at 1.
 */
export async function recordLoginFailure(db: D1Database, email: string, ip: string, now: string) {
  const windowStart = addMs(now, -ATTEMPT_WINDOW_MS);
  const lockUntil = addMs(now, LOCKOUT_MS);
  const upsert = `INSERT INTO login_attempts (key, failures, window_started_at, locked_until)
    VALUES (?1, 1, ?2, NULL)
    ON CONFLICT (key) DO UPDATE SET
      failures = CASE WHEN window_started_at <= ?3 THEN 1 ELSE failures + 1 END,
      locked_until = CASE
        WHEN ?5 = 1 AND window_started_at > ?3 AND failures + 1 >= ${LOCKOUT_FAILURES} THEN ?4
        WHEN window_started_at <= ?3 THEN NULL
        ELSE locked_until END,
      window_started_at = CASE WHEN window_started_at <= ?3 THEN ?2 ELSE window_started_at END`;
  await db.batch([
    db.prepare(upsert).bind(pairKey(email, ip), now, windowStart, lockUntil, 1),
    db.prepare(upsert).bind(emailKey(email), now, windowStart, lockUntil, 0),
  ]);
}

export async function clearLoginFailures(db: D1Database, email: string, ip: string) {
  await db
    .prepare("DELETE FROM login_attempts WHERE key IN (?, ?)")
    .bind(pairKey(email, ip), emailKey(email))
    .run();
}
