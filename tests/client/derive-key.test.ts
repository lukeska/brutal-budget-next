import { ARGON2_FLOOR, type ArgonParams, base64urlToBytes, bytesToBase64url, KEY_BYTES } from "@shared/auth";
import { describe, expect, it } from "vitest";
import { deriveKey } from "../../src/client/features/auth/derive-key";

// The floor itself: the cheapest settings the client will derive with, which keeps the test fast.
const PARAMS: ArgonParams = { ...ARGON2_FLOOR, hashLength: KEY_BYTES };
const saltOf = (fill: number) => bytesToBase64url(new Uint8Array(16).fill(fill));

describe("deriveKey", () => {
  it("derives the same 32 bytes from the same password and salt", async () => {
    const first = await deriveKey("correct horse", saltOf(1), PARAMS);
    const second = await deriveKey("correct horse", saltOf(1), PARAMS);
    expect(second).toBe(first);
    expect(base64urlToBytes(first)).toHaveLength(32);
  });

  it("derives a different key from a different salt", async () => {
    const a = await deriveKey("correct horse", saltOf(1), PARAMS);
    const b = await deriveKey("correct horse", saltOf(2), PARAMS);
    expect(b).not.toBe(a);
  });

  it("refuses parameters below the shared floor", async () => {
    await expect(deriveKey("pw", saltOf(1), { ...PARAMS, memoryKiB: 1024 })).rejects.toThrow();
  });
});
