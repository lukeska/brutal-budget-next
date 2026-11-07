import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("api shell", () => {
  it("answers /api/health with JSON from the Worker", async () => {
    const res = await exports.default.fetch("https://app.test/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses data routes without a session", async () => {
    const res = await exports.default.fetch("https://app.test/api/rates/latest");
    expect(res.status).toBe(401);
  });

  it("returns a JSON 404 for unknown API routes instead of the SPA", async () => {
    const res = await exports.default.fetch("https://app.test/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
