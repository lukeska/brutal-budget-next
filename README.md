# Brutal Budget

A household budget for two people. You type in every expense and every income by hand, see where the month's money went, and keep each account in line with the bank.

It runs entirely on your own Cloudflare account, on the free plan. There is no sign-up page and no shared service: one deployment belongs to one couple.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lukeska/brutal-budget-next)

## What it does

- **Month view.** Income, expenses and the net result for the month, totals by category and subcategory, and every entry grouped by day.
- **Fast entry.** One always-visible button opens a drawer ready for an expense. Amount, a category chip, save.
- **Accounts.** Each account has one currency and a running balance. Record transfers between accounts and reconcile against the real bank balance; any gap is booked as an adjustment that never pollutes your statistics.
- **Many currencies.** Pay in yen with a euro card: the entry keeps both amounts, and its value in your household currency is fixed at that day's ECB rate.
- **Categories, subcategories and projects**, with icons and colours.
- **Statistics** for the year, optionally shown in a second currency.
- **CSV import** for bringing your history over.
- **Installable app** on iPhone and Android, and a full desktop layout.

## Deploy

### With the button (recommended)

1. Click **Deploy to Cloudflare** above and sign in to Cloudflare (a free account is enough).
2. When asked for the secrets, enter two random strings of at least 32 characters each:
   - `AUTH_SECRET` protects stored logins. Generate one with `openssl rand -base64 48`.
   - `SETUP_TOKEN` proves you own the deployment the first time you open it. Generate one with `openssl rand -base64 32`.

   Keep a copy of `AUTH_SECRET` somewhere safe, such as a password manager. See [Backups](#backups-and-restore).
3. When asked where to create the D1 database, pick a location close to where you live. Most of the app's response time is the trip between Cloudflare and the database.
4. Wait for the first build to finish, then open your new `*.workers.dev` address.

Cloudflare copies this repository into your GitHub account and redeploys on every push, so updates are a merge away.

### By hand

You need Node.js 22 or newer.

```bash
git clone https://github.com/<you>/brutal-budget-next.git
cd brutal-budget-next
npm install
npx wrangler login
npx wrangler d1 create brutal-budget          # pick a location near you
npx wrangler secret put AUTH_SECRET            # paste the output of: openssl rand -base64 48
npx wrangler secret put SETUP_TOKEN            # paste the output of: openssl rand -base64 32
npm run build
npm run deploy                                  # applies database migrations, then deploys
```

## First-run setup

Open your deployment. The setup screen asks for:

1. the `SETUP_TOKEN` you chose;
2. your household currency and timezone (both are fixed afterwards);
3. a name, email and password for each of you;
4. your first account and its opening balance;
5. whether to start with a set of default categories.

Passwords are hashed on your device before they are sent. After setup, the setup screen is gone for good and nobody else can create a login.

## Install on your phone

- **iPhone / iPad:** open the address in Safari, tap **Share → Add to Home Screen**. The installed app keeps its own login, separate from Safari, so log in once more inside it.
- **Android:** open it in Chrome and accept the install prompt (or use **⋮ → Install app**).

The app needs a connection to save entries. Without one it still opens and tells you it is offline.

## Bring your history

See [docs/csv-format.md](docs/csv-format.md) for the file format and [docs/migrating-from-brutal-budget.md](docs/migrating-from-brutal-budget.md) for exporting from the old Laravel version.

## Forgotten password

Either partner can reset the other's password in **Settings → Partner**. If you are both locked out, run this on your computer and follow the printed instructions:

```bash
AUTH_SECRET='<your AUTH_SECRET>' node scripts/reset-password.mjs --email you@example.com
```

It asks for a new password and prints the one `wrangler d1 execute` command that applies it. You'll be asked to choose a new password at your next login.

## Backups and restore

D1 keeps a point-in-time history of your database for 7 days on the free plan:

```bash
npx wrangler d1 time-travel info brutal-budget
npx wrangler d1 time-travel restore brutal-budget --timestamp=2026-11-01T12:00:00Z
```

For longer retention, export the database now and then:

```bash
npx wrangler d1 export brutal-budget --remote --output=brutal-budget-$(date +%F).sql
```

**`AUTH_SECRET` is needed to restore logins.** Keep it safe, but store it separately from your backup files (for example in a password manager), never in the same folder as an export. Restoring into a new deployment needs the same value. If you lose it, or ever change it, both of you need a password reset with the command above.

More detail: [docs/backup-and-restore.md](docs/backup-and-restore.md).

## Free plan limits

One household is far inside Cloudflare's free plan: 100,000 requests a day (opening the app's files doesn't count), 5 million database rows read and 100,000 written per day, and 5 GB of storage. Exchange rates are fetched twice a day from the European Central Bank via [Frankfurter](https://frankfurter.dev); no API key is needed.

## Development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in two 32+ character values
npm run db:migrate:local
npm run dev                      # http://localhost:5173
```

| Command               | What it does                                                                     |
| --------------------- | -------------------------------------------------------------------------------- |
| `npm test`            | Unit and API tests (the API tests run in the Workers runtime against a local D1) |
| `npm run test:e2e`    | Browser tests against a locally served build                                     |
| `npm run typecheck`   | TypeScript                                                                       |
| `npm run lint`        | Biome                                                                            |
| `npm run db:generate` | Generate a migration after changing `src/worker/db/schema.ts`                    |

The stack: one Cloudflare Worker serves a [Hono](https://hono.dev) API under `/api` and the React single-page app as static assets; data lives in D1; a cron trigger refreshes exchange rates.

> **Writing migrations by hand.** If a schema change needs SQLite to rebuild a table, drizzle-kit's generated SQL (create `__new_x`, copy, drop, rename) fails D1's foreign-key checks. Rewrite it as: start with `PRAGMA defer_foreign_keys = ON;`, copy the table to `x_old`, drop `x`, create `x` with the new shape, copy the rows back, drop `x_old`, then recreate every index `x` had (dropping a table drops its indexes; copy them from `migrations/0000_init.sql`, including partial ones such as `entries_fingerprint_unique`, which CSV duplicate detection relies on). `PRAGMA foreign_key_check` should return no rows afterwards. Rebuilding `users` deletes every session through `ON DELETE CASCADE`, so everyone is signed out.

## License

Not chosen yet.
