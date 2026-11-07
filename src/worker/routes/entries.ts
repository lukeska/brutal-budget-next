import {
  entryCreateSchema,
  entryDeleteQuerySchema,
  entryListQuerySchema,
  entryPatchSchema,
} from "@shared/schemas/entry";
import { Hono } from "hono";
import type { AppEnv } from "../lib/env";
import { HttpError } from "../lib/errors";
import { validate } from "../lib/validate";
import {
  createEntry,
  deleteEntry,
  entryDefaults,
  getEntry,
  listEntries,
  updateEntry,
} from "../services/entries";

/** Expenses, income and transfers. */
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
