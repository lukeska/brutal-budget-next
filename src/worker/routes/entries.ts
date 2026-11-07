import { zValidator } from "@hono/zod-validator";
import {
  entryCreateSchema,
  entryDeleteQuerySchema,
  entryListQuerySchema,
  entryPatchSchema,
  type ValidationIssue,
} from "@shared/schemas/entry";
import type { Context } from "hono";
import { Hono } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../lib/env";
import { HttpError } from "../lib/errors";
import {
  createEntry,
  deleteEntry,
  entryDefaults,
  getEntry,
  listEntries,
  updateEntry,
} from "../services/entries";

type Target = "json" | "query";

/** Validates a request part, answering 422 with field issues when it doesn't parse. */
function validate<T extends z.ZodType>(target: Target, schema: T) {
  return zValidator(target, schema, (result, c: Context) => {
    if (result.success) return;
    const issues: ValidationIssue[] = result.error.issues.map((i) => ({
      path: i.path.map((p) => (typeof p === "number" ? p : String(p))),
      message: i.message,
    }));
    return c.json({ error: "validation_failed", issues }, 422);
  });
}

/** Expenses, income and transfers. Paths carry their own prefix; mount at "/". */
export const entriesRoutes = new Hono<AppEnv>()
  .get("/entries", validate("query", entryListQuerySchema), async (c) => {
    return c.json(await listEntries(c.env.DB, c.req.valid("query")));
  })
  .post("/entries", validate("json", entryCreateSchema), async (c) => {
    const { status, entry } = await createEntry(c.env.DB, c.var.user.id, c.req.valid("json"));
    return c.json(entry, status);
  })
  .get("/entries/defaults", async (c) => {
    return c.json(await entryDefaults(c.env.DB, c.var.user.id));
  })
  .get("/entries/:id", async (c) => {
    const entry = await getEntry(c.env.DB, c.req.param("id"));
    if (!entry) throw new HttpError(404, "not_found");
    return c.json(entry);
  })
  .patch("/entries/:id", validate("json", entryPatchSchema), async (c) => {
    return c.json(await updateEntry(c.env.DB, c.req.param("id"), c.req.valid("json")));
  })
  .delete("/entries/:id", validate("query", entryDeleteQuerySchema), async (c) => {
    await deleteEntry(c.env.DB, c.req.param("id"), c.req.valid("query").version);
    return c.body(null, 204);
  });
