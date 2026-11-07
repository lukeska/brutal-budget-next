#!/usr/bin/env node
// Command-line password reset for when both partners are locked out.
//
//   AUTH_SECRET=... node scripts/reset-password.mjs [--email you@example.com] [--params '<json>']
//
// It derives the new login key on this machine exactly as the browser does, computes the stored
// verifier with AUTH_SECRET, and prints the wrangler command that applies it. It never runs it.
// `--params` must be the household's Argon2 parameters; read them with:
//   npx wrangler d1 execute DB --remote --command "SELECT argon_params FROM household"
// Without --params the app's defaults are used, which match a household set up with the defaults.

import { createHmac, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { argon2id } from "hash-wasm";

const FLOOR = { memoryKiB: 19456, iterations: 2, parallelism: 1 };
const DEFAULTS = { memoryKiB: 65536, iterations: 3, parallelism: 1, hashLength: 32 };
const MIN_SECRET_LENGTH = 32;

const { values } = parseArgs({
  options: { email: { type: "string" }, params: { type: "string" } },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

const secret = process.env.AUTH_SECRET ?? "";
if (secret.length < MIN_SECRET_LENGTH) {
  fail(
    `Set AUTH_SECRET in the environment (the deployment's value, at least ${MIN_SECRET_LENGTH} characters).`,
  );
}

const params = { ...DEFAULTS, ...(values.params ? JSON.parse(values.params) : {}) };
if (
  params.memoryKiB < FLOOR.memoryKiB ||
  params.iterations < FLOOR.iterations ||
  params.parallelism !== FLOOR.parallelism ||
  params.hashLength !== 32
) {
  fail("Argon2 parameters are below the allowed floor or malformed.");
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const email = (values.email ?? (await rl.question("Email: "))).trim().toLowerCase();
const password = process.env.NEW_PASSWORD ?? (await rl.question("New password (shown as you type): "));
rl.close();
if (!email.includes("@") || /["`$\\]/.test(email)) fail("That doesn't look like an email address.");
if (!password) fail("The password can't be empty.");

const toBase64url = (buf) => Buffer.from(buf).toString("base64url");
const salt = randomBytes(16);
const key = await argon2id({
  password,
  salt,
  memorySize: params.memoryKiB,
  iterations: params.iterations,
  parallelism: params.parallelism,
  hashLength: params.hashLength,
  outputType: "binary",
});
const verifier = createHmac("sha256", secret).update(Buffer.from("verifier")).update(key).digest("hex");

const sqlEmail = email.replaceAll("'", "''");
const now = new Date().toISOString();
const sql = [
  `UPDATE users SET salt = '${toBase64url(salt)}', verifier = '${verifier}', must_change_password = 1,`,
  `password_reset_by = NULL, password_reset_at = NULL, version = version + 1, updated_at = '${now}'`,
  `WHERE email = '${sqlEmail}';`,
  `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = '${sqlEmail}');`,
].join(" ");

console.log("\nRun this to apply the reset (it also logs that partner out everywhere):\n");
console.log(`npx wrangler d1 execute DB --remote --command "${sql}"`);
console.log("\nThen log in with the new password; the app will ask you to choose a new one.");
