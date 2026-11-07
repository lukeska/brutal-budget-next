CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`currency` text NOT NULL,
	`opening_minor` integer NOT NULL,
	`archived_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`icon` text NOT NULL,
	`colour` text,
	`archived_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "categories_type" CHECK("categories"."type" IN ('expense', 'income')),
	CONSTRAINT "categories_not_own_parent" CHECK("categories"."parent_id" IS NULL OR "categories"."parent_id" <> "categories"."id"),
	CONSTRAINT "categories_colour" CHECK(("categories"."parent_id" IS NULL) = ("categories"."colour" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`account_amount_minor` integer NOT NULL,
	`to_account_id` text,
	`to_amount_minor` integer,
	`orig_currency` text,
	`orig_amount_minor` integer,
	`base_amount_minor` integer,
	`fx_state` text NOT NULL,
	`rate_scaled` integer,
	`rate_date` text,
	`category_id` text,
	`project_id` text,
	`notes` text,
	`import_batch_id` text,
	`fingerprint` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`to_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "entries_kind" CHECK("entries"."kind" IN ('expense', 'income', 'transfer', 'adjustment')),
	CONSTRAINT "entries_fx_state" CHECK("entries"."fx_state" IN ('fixed', 'waiting', 'provisional')),
	CONSTRAINT "entries_transfer_target" CHECK(("entries"."kind" = 'transfer') = ("entries"."to_account_id" IS NOT NULL AND "entries"."to_amount_minor" IS NOT NULL)),
	CONSTRAINT "entries_transfer_distinct" CHECK("entries"."to_account_id" IS NULL OR "entries"."to_account_id" <> "entries"."account_id"),
	CONSTRAINT "entries_amount_sign" CHECK(CASE WHEN "entries"."kind" = 'adjustment' THEN "entries"."account_amount_minor" <> 0 ELSE "entries"."account_amount_minor" > 0 END),
	CONSTRAINT "entries_to_amount_positive" CHECK("entries"."to_amount_minor" IS NULL OR "entries"."to_amount_minor" > 0),
	CONSTRAINT "entries_category" CHECK(("entries"."kind" IN ('expense', 'income')) = ("entries"."category_id" IS NOT NULL)),
	CONSTRAINT "entries_orig_pair" CHECK(("entries"."orig_currency" IS NULL) = ("entries"."orig_amount_minor" IS NULL)),
	CONSTRAINT "entries_base_waiting" CHECK(("entries"."fx_state" = 'waiting') = ("entries"."base_amount_minor" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `entries_date_idx` ON `entries` (`date`);--> statement-breakpoint
CREATE INDEX `entries_account_date_idx` ON `entries` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `entries_to_account_date_idx` ON `entries` (`to_account_id`,`date`);--> statement-breakpoint
CREATE INDEX `entries_category_date_idx` ON `entries` (`category_id`,`date`);--> statement-breakpoint
CREATE INDEX `entries_project_idx` ON `entries` (`project_id`);--> statement-breakpoint
CREATE INDEX `entries_import_batch_idx` ON `entries` (`import_batch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `entries_fingerprint_unique` ON `entries` (`fingerprint`) WHERE "entries"."fingerprint" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`date` text NOT NULL,
	`currency` text NOT NULL,
	`rate_scaled` integer NOT NULL,
	`source_date` text NOT NULL,
	PRIMARY KEY(`date`, `currency`)
);
--> statement-breakpoint
CREATE TABLE `household` (
	`id` integer PRIMARY KEY NOT NULL,
	`base_currency` text NOT NULL,
	`timezone` text NOT NULL,
	`argon_params` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "household_singleton" CHECK("household"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`file_name` text NOT NULL,
	`file_sha256` text NOT NULL,
	`row_count` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`window_started_at` text NOT NULL,
	`locked_until` text
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`colour` text NOT NULL,
	`archived_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reconciliations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`bank_balance_minor` integer NOT NULL,
	`computed_minor` integer NOT NULL,
	`adjustment_entry_id` text,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`adjustment_entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `reconciliations_account_date_idx` ON `reconciliations` (`account_id`,`date`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`name` text NOT NULL,
	`salt` text NOT NULL,
	`verifier` text NOT NULL,
	`secondary_currency` text,
	`theme` text,
	`password_reset_by` text,
	`password_reset_at` text,
	`must_change_password` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`password_reset_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "users_theme" CHECK("users"."theme" IS NULL OR "users"."theme" IN ('system', 'light', 'dark')),
	CONSTRAINT "users_must_change_password" CHECK("users"."must_change_password" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);