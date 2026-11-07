import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Conventions: ids are UUIDv7 strings, timestamps are ISO-8601 text, calendar dates are
// `YYYY-MM-DD` text, money is integer minor units, and exchange rates are integers scaled by 10^10.

/** Text compared case-insensitively by SQLite, so lookups and the unique index ignore case. */
const textNoCase = customType<{ data: string; driverData: string }>({
  dataType: () => "text COLLATE NOCASE",
});

const version = () => integer("version").notNull().default(1);
const createdAt = () => text("created_at").notNull();
const updatedAt = () => text("updated_at").notNull();
const archivedAt = () => text("archived_at");

export const ENTRY_KINDS = ["expense", "income", "transfer", "adjustment"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const FX_STATES = ["fixed", "waiting", "provisional"] as const;
export type FxState = (typeof FX_STATES)[number];
export const CATEGORY_TYPES = ["expense", "income"] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** The one household this deployment serves. The CHECK on `id` makes a second row impossible. */
export const household = sqliteTable(
  "household",
  {
    id: integer("id").primaryKey(),
    baseCurrency: text("base_currency").notNull(),
    timezone: text("timezone").notNull(),
    /** JSON-encoded Argon2id parameters shared by both partners. */
    argonParams: text("argon_params").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("household_singleton", sql`${t.id} = 1`)],
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: textNoCase("email").notNull().unique(),
    name: text("name").notNull(),
    salt: text("salt").notNull(),
    verifier: text("verifier").notNull(),
    secondaryCurrency: text("secondary_currency"),
    theme: text("theme", { enum: THEMES }),
    passwordResetBy: text("password_reset_by").references((): AnySQLiteColumn => users.id, {
      onDelete: "restrict",
    }),
    passwordResetAt: text("password_reset_at"),
    mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("users_theme", sql`${t.theme} IS NULL OR ${t.theme} IN ('system', 'light', 'dark')`),
    check("users_must_change_password", sql`${t.mustChangePassword} IN (0, 1)`),
  ],
);

/** Login sessions, stored only as the SHA-256 of the cookie token. */
export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    lastUsedAt: text("last_used_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Failed-login counters keyed by e.g. `email|ip` or `email|*`. */
export const loginAttempts = sqliteTable("login_attempts", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStartedAt: text("window_started_at").notNull(),
  lockedUntil: text("locked_until"),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  currency: text("currency").notNull(),
  openingMinor: integer("opening_minor").notNull(),
  archivedAt: archivedAt(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Two-level categories. Subcategories store no colour: they always use their parent's. */
export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    type: text("type", { enum: CATEGORY_TYPES }).notNull(),
    parentId: text("parent_id").references((): AnySQLiteColumn => categories.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    icon: text("icon").notNull(),
    colour: text("colour"),
    archivedAt: archivedAt(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("categories_type", sql`${t.type} IN ('expense', 'income')`),
    check("categories_not_own_parent", sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
    check("categories_colour", sql`(${t.parentId} IS NULL) = (${t.colour} IS NOT NULL)`),
    index("categories_parent_idx").on(t.parentId),
  ],
);

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  colour: text("colour").notNull(),
  archivedAt: archivedAt(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  fileName: text("file_name").notNull(),
  fileSha256: text("file_sha256").notNull(),
  rowCount: integer("row_count").notNull(),
  createdAt: createdAt(),
});

/**
 * Every money movement. Amounts are positive and their direction comes from `kind`, except
 * adjustments, which carry a signed non-zero amount. A transfer is a single row holding both the
 * amount that left `account_id` and the amount that arrived in `to_account_id`.
 * An adjustment's reconciliation is found through `reconciliations.adjustment_entry_id`.
 */
export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ENTRY_KINDS }).notNull(),
    date: text("date").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    accountAmountMinor: integer("account_amount_minor").notNull(),
    toAccountId: text("to_account_id").references(() => accounts.id, { onDelete: "restrict" }),
    toAmountMinor: integer("to_amount_minor"),
    origCurrency: text("orig_currency"),
    origAmountMinor: integer("orig_amount_minor"),
    /** Value in the household base currency; NULL while waiting for a rate. */
    baseAmountMinor: integer("base_amount_minor"),
    fxState: text("fx_state", { enum: FX_STATES }).notNull(),
    rateScaled: integer("rate_scaled"),
    rateDate: text("rate_date"),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "restrict" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "restrict" }),
    notes: text("notes"),
    importBatchId: text("import_batch_id").references(() => importBatches.id, { onDelete: "restrict" }),
    fingerprint: text("fingerprint"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("entries_kind", sql`${t.kind} IN ('expense', 'income', 'transfer', 'adjustment')`),
    check("entries_fx_state", sql`${t.fxState} IN ('fixed', 'waiting', 'provisional')`),
    check(
      "entries_transfer_target",
      sql`(${t.kind} = 'transfer') = (${t.toAccountId} IS NOT NULL AND ${t.toAmountMinor} IS NOT NULL)`,
    ),
    check("entries_transfer_distinct", sql`${t.toAccountId} IS NULL OR ${t.toAccountId} <> ${t.accountId}`),
    check(
      "entries_amount_sign",
      sql`CASE WHEN ${t.kind} = 'adjustment' THEN ${t.accountAmountMinor} <> 0 ELSE ${t.accountAmountMinor} > 0 END`,
    ),
    check("entries_to_amount_positive", sql`${t.toAmountMinor} IS NULL OR ${t.toAmountMinor} > 0`),
    check("entries_category", sql`(${t.kind} IN ('expense', 'income')) = (${t.categoryId} IS NOT NULL)`),
    check("entries_orig_pair", sql`(${t.origCurrency} IS NULL) = (${t.origAmountMinor} IS NULL)`),
    check("entries_base_waiting", sql`(${t.fxState} = 'waiting') = (${t.baseAmountMinor} IS NULL)`),
    index("entries_date_idx").on(t.date),
    index("entries_account_date_idx").on(t.accountId, t.date),
    index("entries_to_account_date_idx").on(t.toAccountId, t.date),
    index("entries_category_date_idx").on(t.categoryId, t.date),
    index("entries_project_idx").on(t.projectId),
    index("entries_import_batch_idx").on(t.importBatchId),
    uniqueIndex("entries_fingerprint_unique").on(t.fingerprint).where(sql`${t.fingerprint} IS NOT NULL`),
  ],
);

export const reconciliations = sqliteTable(
  "reconciliations",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    date: text("date").notNull(),
    bankBalanceMinor: integer("bank_balance_minor").notNull(),
    computedMinor: integer("computed_minor").notNull(),
    adjustmentEntryId: text("adjustment_entry_id").references(() => entries.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [index("reconciliations_account_date_idx").on(t.accountId, t.date)],
);

/** One rate per calendar day and currency (EUR pivot); `source_date` is the day actually published. */
export const fxRates = sqliteTable(
  "fx_rates",
  {
    date: text("date").notNull(),
    currency: text("currency").notNull(),
    rateScaled: integer("rate_scaled").notNull(),
    sourceDate: text("source_date").notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.currency] })],
);
