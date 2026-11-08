#!/usr/bin/env node
// Seed the local D1 database with users, categories, and realistic entries.
//
//   node scripts/seed.mjs [--seed 42]
//
// Creates two users (renzo@example.com / lucia@example.com, password "password"),
// one shared account, default categories, and ~25 months of entries (12 past + 12 future).
// Wipes all existing data first. Uses a seeded PRNG for deterministic output.
// Reads AUTH_SECRET from .dev.vars.

import { createHmac, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { argon2id } from "hash-wasm";

const { values } = parseArgs({
  options: { seed: { type: "string", default: "42" } },
});

const SEED = Number(values.seed);

// ---------- Read AUTH_SECRET from .dev.vars ----------

function readAuthSecret() {
  try {
    const content = readFileSync(".dev.vars", "utf-8");
    const match = content.match(/^AUTH_SECRET=(.+)$/m);
    if (match) return match[1].trim();
  } catch {}
  console.error("Could not read AUTH_SECRET from .dev.vars");
  process.exit(1);
}

const AUTH_SECRET = readAuthSecret();

// ---------- Argon2 key derivation (same as browser + reset-password.mjs) ----------

const ARGON_PARAMS = { memoryKiB: 65536, iterations: 3, parallelism: 1, hashLength: 32 };

const toBase64url = (buf) => Buffer.from(buf).toString("base64url");

async function deriveCredentials(email, password) {
  const salt = randomBytes(16);
  const key = await argon2id({
    password,
    salt,
    memorySize: ARGON_PARAMS.memoryKiB,
    iterations: ARGON_PARAMS.iterations,
    parallelism: ARGON_PARAMS.parallelism,
    hashLength: ARGON_PARAMS.hashLength,
    outputType: "binary",
  });
  const verifier = createHmac("sha256", AUTH_SECRET)
    .update(Buffer.from("verifier"))
    .update(key)
    .digest("hex");
  return { salt: toBase64url(salt), verifier };
}

// ---------- Seeded PRNG (mulberry32) ----------

function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);

function randInt(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

// ---------- Deterministic ID generator ----------

let idCounter = 0;

function seedId() {
  idCounter++;
  const hex = (n, len) => n.toString(16).padStart(len, "0");
  const a = ((SEED * 2654435761 + idCounter * 2246822519) >>> 0);
  const b = ((idCounter * 3266489917 + SEED * 668265263) >>> 0);
  const c = ((a ^ b) * 2246822519 >>> 0);
  const d = ((b ^ a) * 3266489917 >>> 0);
  return `${hex(a, 8)}-${hex(b & 0xffff, 4)}-4${hex((b >>> 16) & 0xfff, 3)}-${hex(0x8000 | (c & 0x3fff), 4)}-${hex(d, 8)}${hex(c & 0xffff, 4)}`;
}

// ---------- Default categories (mirrors src/worker/db/default-categories.ts) ----------

const DEFAULT_CATEGORIES = {
  expense: [
    { name: "Housing", icon: "IconHome2", colour: "#1971c2", children: [
      { name: "Rent & mortgage", icon: "IconKey" },
      { name: "Maintenance", icon: "IconTool" },
    ]},
    { name: "Food", icon: "IconToolsKitchen2", colour: "#e8590c", children: [
      { name: "Groceries", icon: "IconShoppingCart" },
      { name: "Restaurants", icon: "IconToolsKitchen2" },
    ]},
    { name: "Transport", icon: "IconBus", colour: "#0c8599" },
    { name: "Bills & Utilities", icon: "IconReceipt2", colour: "#5f3dc4" },
    { name: "Health", icon: "IconFirstAidKit", colour: "#c2255c" },
    { name: "Shopping", icon: "IconShirt", colour: "#9c36b5" },
    { name: "Leisure", icon: "IconMovie", colour: "#f08c00" },
    { name: "Travel", icon: "IconPlaneTilt", colour: "#1098ad" },
    { name: "Gifts", icon: "IconGift", colour: "#e03131" },
    { name: "Other", icon: "IconTag", colour: "#868e96" },
  ],
  income: [
    { name: "Salary", icon: "IconCash", colour: "#2f9e44" },
    { name: "Bonus", icon: "IconTrophy", colour: "#66a80f" },
    { name: "Interest", icon: "IconPigMoney", colour: "#099268" },
    { name: "Gifts received", icon: "IconGift", colour: "#d6336c" },
    { name: "Other income", icon: "IconTag", colour: "#868e96" },
  ],
};

// ---------- Build SQL ----------

const esc = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const now = new Date().toISOString();

console.log("Deriving credentials (Argon2id — may take a moment)...");

const [renzoCreds, luciaCreds] = await Promise.all([
  deriveCredentials("renzo@example.com", "password"),
  deriveCredentials("lucia@example.com", "password"),
]);

const renzoId = seedId();
const luciaId = seedId();
const accountId = seedId();
const userIds = [renzoId, luciaId];

// -- Wipe + household + users + account
const setupSql = [
  // Wipe everything (child categories before parents)
  `DELETE FROM reconciliations`,
  `DELETE FROM entries`,
  `DELETE FROM import_batches`,
  `DELETE FROM sessions`,
  `DELETE FROM login_attempts`,
  `DELETE FROM fx_rates`,
  `DELETE FROM projects`,
  `DELETE FROM categories WHERE parent_id IS NOT NULL`,
  `DELETE FROM categories`,
  `DELETE FROM accounts`,
  `DELETE FROM users WHERE password_reset_by IS NOT NULL`,
  `DELETE FROM users`,
  `DELETE FROM household`,

  // Household
  `INSERT INTO household (id, base_currency, timezone, argon_params, created_at) VALUES (1, 'EUR', 'Europe/Rome', '${JSON.stringify(ARGON_PARAMS).replace(/'/g, "''")}', ${esc(now)})`,

  // Users
  `INSERT INTO users (id, email, name, salt, verifier, created_at, updated_at) VALUES (${esc(renzoId)}, 'renzo@example.com', 'Renzo', ${esc(renzoCreds.salt)}, ${esc(renzoCreds.verifier)}, ${esc(now)}, ${esc(now)})`,
  `INSERT INTO users (id, email, name, salt, verifier, created_at, updated_at) VALUES (${esc(luciaId)}, 'lucia@example.com', 'Lucia', ${esc(luciaCreds.salt)}, ${esc(luciaCreds.verifier)}, ${esc(now)}, ${esc(now)})`,

  // Account
  `INSERT INTO accounts (id, name, currency, opening_minor, created_at, updated_at) VALUES (${esc(accountId)}, 'Joint account', 'EUR', 0, ${esc(now)}, ${esc(now)})`,
];

// -- Categories
const categoryIds = { expense: [], income: [] };

for (const type of ["expense", "income"]) {
  for (const parent of DEFAULT_CATEGORIES[type]) {
    const parentId = seedId();
    categoryIds[type].push({ id: parentId, name: parent.name });
    setupSql.push(
      `INSERT INTO categories (id, type, parent_id, name, icon, colour, created_at, updated_at) VALUES (${esc(parentId)}, ${esc(type)}, NULL, ${esc(parent.name)}, ${esc(parent.icon)}, ${esc(parent.colour)}, ${esc(now)}, ${esc(now)})`,
    );
    for (const child of parent.children ?? []) {
      const childId = seedId();
      categoryIds[type].push({ id: childId, name: child.name });
      setupSql.push(
        `INSERT INTO categories (id, type, parent_id, name, icon, colour, created_at, updated_at) VALUES (${esc(childId)}, ${esc(type)}, ${esc(parentId)}, ${esc(child.name)}, ${esc(child.icon)}, NULL, ${esc(now)}, ${esc(now)})`,
      );
    }
  }
}

const expenseCats = categoryIds.expense;
const incomeCats = categoryIds.income;

// ---------- Define realistic patterns ----------

const EXPENSE_PATTERNS = [
  { match: "Rent", min: 80000, max: 150000, freq: 1, notes: ["Rent"] },
  { match: "Groceries", min: 2000, max: 12000, freq: 10, notes: ["Supermarket", "Farmers market", "Weekly shop", "Quick grocery run"] },
  { match: "Restaurants", min: 1500, max: 8000, freq: 4, notes: ["Dinner out", "Lunch", "Brunch", "Pizza night", "Sushi", "Thai food"] },
  { match: "Transport", min: 500, max: 5000, freq: 5, notes: ["Bus pass", "Fuel", "Taxi", "Parking", "Train ticket"] },
  { match: "Bills", min: 3000, max: 15000, freq: 3, notes: ["Electricity", "Water", "Internet", "Phone bill", "Gas bill"] },
  { match: "Health", min: 1500, max: 8000, freq: 1, notes: ["Pharmacy", "Doctor visit", "Dentist", "Vitamins"] },
  { match: "Shopping", min: 2000, max: 15000, freq: 2, notes: ["Clothes", "Shoes", "Electronics", "Home supplies"] },
  { match: "Leisure", min: 1000, max: 6000, freq: 3, notes: ["Cinema", "Concert", "Gym membership", "Streaming", "Books"] },
  { match: "Travel", min: 10000, max: 80000, freq: 0.3, notes: ["Flights", "Hotel", "Airbnb", "Car rental"] },
  { match: "Gifts", min: 2000, max: 10000, freq: 0.5, notes: ["Birthday gift", "Wedding gift", "Christmas present"] },
  { match: "Other", min: 500, max: 5000, freq: 1, notes: ["Miscellaneous", "ATM withdrawal", "Bank fee"] },
  { match: "Maintenance", min: 3000, max: 20000, freq: 0.3, notes: ["Plumber", "Electrician", "Appliance repair"] },
];

const INCOME_PATTERNS = [
  { match: "Salary", min: 250000, max: 450000, freq: 1, notes: ["Monthly salary"] },
  { match: "Bonus", min: 50000, max: 200000, freq: 0.15, notes: ["Quarterly bonus", "Performance bonus"] },
  { match: "Interest", min: 500, max: 5000, freq: 0.5, notes: ["Savings interest", "Investment return"] },
  { match: "Gifts received", min: 5000, max: 30000, freq: 0.2, notes: ["Birthday money", "Holiday gift"] },
  { match: "Other income", min: 2000, max: 15000, freq: 0.3, notes: ["Freelance work", "Refund", "Cash back"] },
];

function findCategory(patterns, allCats) {
  const totalFreq = patterns.reduce((s, p) => s + p.freq, 0);
  let r = rand() * totalFreq;
  let pattern;
  for (const p of patterns) {
    r -= p.freq;
    if (r <= 0) { pattern = p; break; }
  }
  if (!pattern) pattern = patterns[0];

  const matchStr = pattern.match.toLowerCase();
  const cat = allCats.find((c) => c.name.toLowerCase().includes(matchStr)) ?? pick(allCats);
  const amount = randInt(pattern.min, pattern.max);
  const note = pick(pattern.notes);
  return { categoryId: cat.id, amount, note };
}

// ---------- Generate entries ----------

const currentDate = new Date();
const currentYear = currentDate.getFullYear();
const currentMonthIdx = currentDate.getMonth();

const entrySql = [];

for (let offset = -12; offset <= 12; offset++) {
  const monthDate = new Date(currentYear, currentMonthIdx + offset, 1);
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Expenses: 15-30 per month
  const expenseCount = randInt(15, 30);
  for (let i = 0; i < expenseCount; i++) {
    const { categoryId, amount, note } = findCategory(EXPENSE_PATTERNS, expenseCats);
    const day = randInt(1, daysInMonth);
    const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const userId = pick(userIds);

    entrySql.push(
      `INSERT OR IGNORE INTO entries (id, kind, date, user_id, account_id, account_amount_minor, to_account_id, to_amount_minor, orig_currency, orig_amount_minor, base_amount_minor, fx_state, rate_scaled, rate_date, category_id, project_id, notes, fingerprint, import_batch_id, version, created_at, updated_at) VALUES (${esc(seedId())}, 'expense', ${esc(date)}, ${esc(userId)}, ${esc(accountId)}, ${amount}, NULL, NULL, NULL, NULL, ${amount}, 'fixed', NULL, NULL, ${esc(categoryId)}, NULL, ${esc(note)}, NULL, NULL, 1, ${esc(now)}, ${esc(now)})`,
    );
  }

  // Income: 1-3 per month
  const incomeCount = randInt(1, 3);
  for (let i = 0; i < incomeCount; i++) {
    const { categoryId, amount, note } = findCategory(INCOME_PATTERNS, incomeCats);
    const day = i === 0 ? Math.min(25, daysInMonth) : randInt(1, daysInMonth);
    const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const userId = pick(userIds);

    entrySql.push(
      `INSERT OR IGNORE INTO entries (id, kind, date, user_id, account_id, account_amount_minor, to_account_id, to_amount_minor, orig_currency, orig_amount_minor, base_amount_minor, fx_state, rate_scaled, rate_date, category_id, project_id, notes, fingerprint, import_batch_id, version, created_at, updated_at) VALUES (${esc(seedId())}, 'income', ${esc(date)}, ${esc(userId)}, ${esc(accountId)}, ${amount}, NULL, NULL, NULL, NULL, ${amount}, 'fixed', NULL, NULL, ${esc(categoryId)}, NULL, ${esc(note)}, NULL, NULL, 1, ${esc(now)}, ${esc(now)})`,
    );
  }
}

// ---------- Execute ----------

const allSql = [...setupSql, ...entrySql];
const tmpDir = mkdtempSync(join(tmpdir(), "bb-seed-"));
const sqlFile = join(tmpDir, "seed.sql");
writeFileSync(sqlFile, allSql.join(";\n") + ";\n");

console.log(`Seed: ${SEED}`);
console.log(`Users: renzo@example.com, lucia@example.com (password: "password")`);
console.log(`Account: Joint account (EUR)`);
console.log(`Categories: ${expenseCats.length} expense, ${incomeCats.length} income`);
console.log(`Entries: ${entrySql.length} across 25 months`);

try {
  execSync(`npx wrangler d1 execute DB --local --file "${sqlFile}"`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  console.log("\nDone! Log in at http://localhost:5173 with renzo@example.com / password");
} catch (err) {
  console.error("Failed to execute seed SQL:", err.stderr || err.message);
  process.exit(1);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
