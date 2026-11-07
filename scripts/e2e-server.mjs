// Builds the app, resets and migrates a throwaway local D1, then serves it with `vite preview`.
// Used by Playwright's webServer; never touches the remote database.
import { execSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const port = process.argv[2] ?? "4173";
const persist = ".wrangler/e2e-state";

rmSync(persist, { recursive: true, force: true });
mkdirSync(persist, { recursive: true });

writeFileSync(
  ".dev.vars.e2e",
  [
    "AUTH_SECRET=e2e-auth-secret-0123456789abcdefghijklmnopqrstuv",
    "SETUP_TOKEN=e2e-setup-token-0123456789abcdefghijklmnopqrstuv",
    "",
  ].join("\n"),
);

const env = { ...process.env, CLOUDFLARE_ENV: "", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false" };
execSync("npx vite build", { stdio: "inherit", env });
execSync(`npx wrangler d1 migrations apply DB --local --persist-to ${persist}`, { stdio: "inherit", env });

const child = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--port",
    port,
    "--persist-to",
    persist,
    "--env-file",
    ".dev.vars.e2e",
    "-c",
    "dist/worker/wrangler.json",
  ],
  { stdio: "inherit", env },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
