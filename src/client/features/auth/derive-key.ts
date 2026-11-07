import { type ArgonParams, argonParamsSchema, base64urlToBytes, bytesToBase64url } from "@shared/auth";
import { argon2id } from "hash-wasm";

/**
 * Derives the login key from a password with Argon2id, on this device, so the password never leaves it.
 * Refuses parameters below the shared floor. Returns the 32-byte key as base64url.
 */
export async function deriveKey(password: string, salt: string, params: ArgonParams): Promise<string> {
  const checked = argonParamsSchema.parse(params);
  const key = await argon2id({
    password,
    salt: base64urlToBytes(salt),
    memorySize: checked.memoryKiB,
    iterations: checked.iterations,
    parallelism: checked.parallelism,
    hashLength: checked.hashLength,
    outputType: "binary",
  });
  return bytesToBase64url(key);
}

/** A fresh random salt for a new password, base64url. */
export function newSalt(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
}
