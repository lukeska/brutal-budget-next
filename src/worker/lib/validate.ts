import { zValidator } from "@hono/zod-validator";
import type { ValidationIssue } from "@shared/schemas/entry";
import type { Context } from "hono";
import type { z } from "zod";

/** Validates a request part, answering 422 with field issues when it doesn't parse. */
export function validate<T extends z.ZodType, Target extends "json" | "query" | "param">(
  target: Target,
  schema: T,
) {
  return zValidator(target, schema, (result, c: Context) => {
    if (result.success) return;
    const issues: ValidationIssue[] = result.error.issues.map((i) => ({
      path: i.path.map((p) => (typeof p === "number" ? p : String(p))),
      message: i.message,
    }));
    return c.json({ error: "validation_failed", issues }, 422);
  });
}
