# Backup and restore

Your data lives in one Cloudflare D1 database (default name `brutal-budget`). Logins also depend on one secret, `AUTH_SECRET`.

## Point-in-time restore (last 7 days)

D1 Time Travel is always on. On the free plan you can go back up to 7 days.

```bash
npx wrangler d1 time-travel info brutal-budget
npx wrangler d1 time-travel restore brutal-budget --timestamp=<ISO time or unix seconds>
```

A restore replaces the database in place. Wrangler prints a bookmark you can use to undo the restore.

## Exports (any age)

```bash
npx wrangler d1 export brutal-budget --remote --output=brutal-budget-$(date +%F).sql
```

To load an export into a fresh database:

```bash
npx wrangler d1 execute brutal-budget --remote --file=brutal-budget-2026-11-01.sql
```

## The `AUTH_SECRET`

Passwords are hashed on your device, and the server stores only an HMAC of that hash keyed with `AUTH_SECRET`. A database export alone can't be used to log in or to crack passwords.

That is also why you need the secret to restore logins:

- Store `AUTH_SECRET` somewhere safe, such as a password manager, **separately from your backups**. If both end up in the same place, a leaked backup folder would contain everything needed to attack the passwords.
- When restoring into a new deployment, set the same `AUTH_SECRET` (`npx wrangler secret put AUTH_SECRET`).
- If the secret is lost or changed, the data is fine but both logins stop working. Reset both passwords with `node scripts/reset-password.mjs` (see the README).
