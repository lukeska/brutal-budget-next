import type { ValidationIssue } from "@shared/schemas/entry";
import {
  emailChangeSchema,
  profilePatchSchema,
  type SettingsResponse,
  type ThemeChoice,
} from "@shared/schemas/settings";
import { Hono } from "hono";
import { keyMatches } from "../auth/password";
import { readHouseholdRow } from "../db/household";
import type { AppEnv } from "../lib/env";
import { jsonError } from "../lib/errors";
import { nowIso } from "../lib/time";
import { validate } from "../lib/validate";

type UserRow = {
  id: string;
  name: string;
  email: string;
  verifier: string;
  secondary_currency: string | null;
  theme: ThemeChoice | null;
};

function findUser(db: D1Database, id: string) {
  return db
    .prepare("SELECT id, name, email, verifier, secondary_currency, theme FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
}

async function readSettings(db: D1Database, userId: string): Promise<SettingsResponse | null> {
  const [me, partner, house] = await Promise.all([
    findUser(db, userId),
    db.prepare("SELECT id, name FROM users WHERE id <> ?").bind(userId).first<{ id: string; name: string }>(),
    readHouseholdRow(db),
  ]);
  if (!me || !house) return null;
  return {
    me: {
      id: me.id,
      name: me.name,
      email: me.email,
      secondaryCurrency: me.secondary_currency,
      theme: me.theme ?? "system",
    },
    partner,
    household: { baseCurrency: house.base_currency, timezone: house.timezone },
  };
}

/**
 * The signed-in partner's own settings. The household base currency and time zone are read-only:
 * there is no endpoint that changes them.
 */
export const settingsRoutes = new Hono<AppEnv>()
  .get("/settings", async (c) => {
    const body = await readSettings(c.env.DB, c.var.user.id);
    if (!body) return jsonError(c, 404, "not_found");
    return c.json(body);
  })

  .patch("/settings/profile", validate("json", profilePatchSchema), async (c) => {
    const patch = c.req.valid("json");
    const db = c.env.DB;
    const id = c.var.user.id;

    if (patch.secondaryCurrency) {
      const house = await readHouseholdRow(db);
      if (house && patch.secondaryCurrency === house.base_currency) {
        const issues: ValidationIssue[] = [
          { path: ["secondaryCurrency"], message: "must differ from the base currency" },
        ];
        return c.json({ error: "validation_failed", issues }, 422);
      }
    }

    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      values.push(patch.name);
    }
    if (patch.secondaryCurrency !== undefined) {
      sets.push("secondary_currency = ?");
      values.push(patch.secondaryCurrency);
    }
    if (patch.theme !== undefined) {
      sets.push("theme = ?");
      values.push(patch.theme);
    }
    if (sets.length > 0) {
      await db
        .prepare(`UPDATE users SET ${sets.join(", ")}, version = version + 1, updated_at = ? WHERE id = ?`)
        .bind(...values, nowIso(), id)
        .run();
    }
    const body = await readSettings(db, id);
    if (!body) return jsonError(c, 404, "not_found");
    return c.json(body);
  })

  .post("/settings/email", validate("json", emailChangeSchema), async (c) => {
    const { currentKey, email } = c.req.valid("json");
    const db = c.env.DB;
    const id = c.var.user.id;
    const user = await findUser(db, id);
    if (!user || !(await keyMatches(c.env.AUTH_SECRET, currentKey, user.verifier))) {
      return jsonError(c, 401, "invalid_credentials");
    }
    // `email` is a NOCASE column, so the clash check is case-insensitive and races nothing.
    const result = await db
      .prepare(
        `UPDATE users SET email = ?1, version = version + 1, updated_at = ?2
         WHERE id = ?3 AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?1 AND id <> ?3)`,
      )
      .bind(email, nowIso(), id)
      .run();
    if (result.meta.changes === 0) return jsonError(c, 409, "email_taken");
    return c.json({ ok: true, email });
  });
