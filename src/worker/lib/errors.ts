import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** An error that maps directly to a JSON response `{ error: code, ...extra }`. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "HttpError";
  }
}

export function jsonError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  extra: Record<string, unknown> = {},
) {
  return c.json({ error: code, ...extra }, status);
}

export function invalid(path: string, message: string): HttpError {
  return new HttpError(422, "validation_failed", { issues: [{ path: [path], message }] });
}
