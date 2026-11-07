# Deploying Brutal Budget

The README covers the normal path. This page explains what the deployment is made of and how to check it.

## What gets created

| Cloudflare product | Name | Purpose |
|---|---|---|
| Worker | `brutal-budget` | Serves the app and the `/api` routes |
| D1 database | `brutal-budget` | All household data |
| Cron triggers | `0 16 * * *`, `0 22 * * *` (UTC) | Fetch ECB exchange rates after publication, with a retry |
| Rate limiter | `AUTH_RATE_LIMITER` | Limits login and setup attempts per IP before touching the database |
| Secrets | `AUTH_SECRET`, `SETUP_TOKEN` | Login protection and first-run ownership proof (32+ characters each) |

Manage the cron triggers in `wrangler.jsonc` only; edits made in the dashboard are overwritten by the next deploy.

## Build and deploy commands

- Build: `npm run build` (Vite builds the app and the Worker into `dist/`).
- Deploy: `npm run deploy` (applies D1 migrations to the `DB` binding remotely, then runs `wrangler deploy`).

The Deploy to Cloudflare button pre-fills both commands from `package.json`.

## Checking a deployment

1. Open `https://<your-worker>.workers.dev/api/health`. It should answer `{"ok":true}`.
2. Open the root URL. A new deployment shows the setup screen; if the secrets are missing or too short, it explains how to fix them.
3. After setup, trigger the rate fetch once instead of waiting for the cron: in the dashboard, open the Worker → **Settings → Triggers → Cron Triggers** and use **Trigger**. Or just wait for 16:00 UTC.
4. Watch CPU time while you use the app: `npx wrangler tail --format=pretty`. On the free plan each request has 10 ms of CPU; login is designed to use about 1 ms, because the slow password hashing happens on your device.

## Custom domain

Add one in the dashboard under the Worker → **Settings → Domains & Routes**. Installed home-screen apps are tied to the address you installed them from, so install again after switching.
