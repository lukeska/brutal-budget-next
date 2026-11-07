import { type SetupStatus, setupRequestSchema } from "@shared/setup";
import { Hono } from "hono";
import { computeVerifier } from "../auth/password";
import { createSession } from "../auth/session";
import { DEFAULT_CATEGORIES } from "../db/default-categories";
import type { CategoryType } from "../db/schema";
import { digestsEqual, sha256Hex } from "../lib/crypto";
import type { AppEnv } from "../lib/env";
import { jsonError } from "../lib/errors";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";

async function householdExists(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM household WHERE id = 1").first()) !== null;
}

/** Hashing both sides first gives equal-length inputs, so the compare is constant-time for any token. */
async function tokenMatches(expected: string, submitted: unknown): Promise<boolean> {
  if (typeof submitted !== "string") return false;
  return digestsEqual(await sha256Hex(submitted), await sha256Hex(expected));
}

function categoryStatements(db: D1Database, now: string): D1PreparedStatement[] {
  const insert = db.prepare(
    `INSERT INTO categories (id, type, parent_id, name, icon, colour, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const statements: D1PreparedStatement[] = [];
  for (const type of ["expense", "income"] as const satisfies CategoryType[]) {
    for (const parent of DEFAULT_CATEGORIES[type]) {
      const parentId = newId();
      statements.push(insert.bind(parentId, type, null, parent.name, parent.icon, parent.colour, now, now));
      for (const child of parent.children ?? []) {
        statements.push(insert.bind(newId(), type, parentId, child.name, child.icon, null, now, now));
      }
    }
  }
  return statements;
}

/**
 * First-run setup. Works exactly once: it creates the household, both partners, the first account and
 * (optionally) the default categories in one batch, then signs in partner 1. Once a household exists,
 * only the status route still answers; everything else is a 404.
 */
export const setupRoutes = new Hono<AppEnv>()
  .get("/setup/status", async (c) => {
    const body: SetupStatus = { needsSetup: !(await householdExists(c.env.DB)) };
    return c.json(body);
  })

  .post("/setup", async (c) => {
    const db = c.env.DB;
    if (await householdExists(db)) return jsonError(c, 404, "not_found");

    const raw: unknown = await c.req.json().catch(() => null);
    const submittedToken = raw && typeof raw === "object" && "setupToken" in raw ? raw.setupToken : undefined;
    if (!(await tokenMatches(c.env.SETUP_TOKEN, submittedToken))) {
      return jsonError(c, 403, "invalid_setup_token");
    }

    const parsed = setupRequestSchema.safeParse(raw);
    if (!parsed.success) return jsonError(c, 422, "invalid_body");
    const input = parsed.data;

    const now = nowIso();
    const partnerIds = [newId(), newId()] as const;
    const insertUser = db.prepare(
      `INSERT INTO users (id, email, name, salt, verifier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const userStatements = await Promise.all(
      input.partners.map(async (p, i) =>
        insertUser.bind(
          partnerIds[i],
          p.email,
          p.name,
          p.salt,
          await computeVerifier(c.env.AUTH_SECRET, p.key),
          now,
          now,
        ),
      ),
    );

    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO household (id, base_currency, timezone, argon_params, created_at) VALUES (1, ?, ?, ?, ?)",
          )
          .bind(input.baseCurrency, input.timezone, JSON.stringify(input.argonParams), now),
        ...userStatements,
        db
          .prepare(
            `INSERT INTO accounts (id, name, currency, opening_minor, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(newId(), input.account.name, input.account.currency, input.account.openingMinor, now, now),
        ...(input.addDefaultCategories ? categoryStatements(db, now) : []),
      ]);
    } catch (err) {
      // A concurrent setup won the singleton household row: setup is closed for this request too.
      if (await householdExists(db)) return jsonError(c, 404, "not_found");
      if (err instanceof Error && err.message.includes("users.email")) {
        return jsonError(c, 409, "duplicate_email");
      }
      throw err;
    }

    await createSession(c, db, partnerIds[0], now);
    return c.json({ ok: true });
  });
