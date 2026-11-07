import { z } from "zod";

/** Lowest Argon2id settings anyone may derive keys with. Setup rejects less; the client refuses less. */
export const ARGON2_FLOOR = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

/** Length in bytes of the key the browser derives and sends instead of the password. */
export const KEY_BYTES = 32;
export const SALT_BYTES = 16;
/** Minimum length of AUTH_SECRET and SETUP_TOKEN. */
export const MIN_SECRET_LENGTH = 32;

export const argonParamsSchema = z.object({
  memoryKiB: z.number().int().min(ARGON2_FLOOR.memoryKiB),
  iterations: z.number().int().min(ARGON2_FLOOR.iterations),
  parallelism: z.literal(ARGON2_FLOOR.parallelism),
  hashLength: z.literal(KEY_BYTES).default(KEY_BYTES),
});
export type ArgonParams = z.infer<typeof argonParamsSchema>;

export const DEFAULT_ARGON2: ArgonParams = {
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: KEY_BYTES,
};

const base64urlLength = (bytes: number) => Math.ceil((bytes * 4) / 3);
const base64urlOf = (bytes: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${base64urlLength(bytes)}}$`), "invalid encoding");

/** A derived key, base64url without padding. */
export const keySchema = base64urlOf(KEY_BYTES);
/** A per-user salt, base64url without padding. */
export const saltSchema = base64urlOf(SALT_BYTES);
const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const saltRequestSchema = z.object({ email: emailSchema });
export const saltResponseSchema = z.object({ salt: saltSchema, params: argonParamsSchema });
export type SaltResponse = z.infer<typeof saltResponseSchema>;

export const loginRequestSchema = z.object({ email: emailSchema, key: keySchema });
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentKey: keySchema,
  newSalt: saltSchema,
  newVerifierKey: keySchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const resetPartnerRequestSchema = z.object({
  currentKey: keySchema,
  partnerNewSalt: saltSchema,
  partnerNewKey: keySchema,
});
export type ResetPartnerRequest = z.infer<typeof resetPartnerRequestSchema>;

export const meResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  secondaryCurrency: z.string().nullable(),
  theme: z.enum(["system", "light", "dark"]).nullable(),
  mustChangePassword: z.boolean(),
  passwordResetBy: z.object({ name: z.string() }).optional(),
  passwordResetAt: z.string().optional(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
