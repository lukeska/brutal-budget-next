import type { SaltResponse } from "@shared/auth";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { deriveKey } from "../features/auth/derive-key";
import { meQueryKey } from "../features/auth/use-me";
import { ApiError, api } from "../lib/api";
import { safeNext } from "../lib/safe-next";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    search.next === undefined ? {} : { next: safeNext(search.next) },
  component: LoginPage,
});

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Wrong email or password.";
    if (err.status === 429) return "Too many attempts. Wait a few minutes and try again.";
    if (err.code === "misconfigured") return "This deployment is misconfigured. Check its secrets.";
  }
  return "Something went wrong. Try again.";
}

function LoginPage() {
  const { next } = Route.useSearch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { salt, params } = await api.post<SaltResponse>("/api/auth/salt", { email });
      const key = await deriveKey(password, salt, params);
      await api.post("/api/auth/login", { email, key });
      // "all": the login screen has no observer of this query, so the default "active" would leave a
      // cached signed-out answer in place and the root gate would send the user straight back here.
      await queryClient.invalidateQueries({ queryKey: meQueryKey, refetchType: "all" });
      router.history.push(safeNext(next));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="font-numbers text-4xl font-semibold tracking-tight">Brutal Budget</h1>
      <form className="mt-10 flex flex-col gap-5" onSubmit={onSubmit}>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Email
          <input
            className="border-b border-rule bg-transparent py-2 text-lg text-fg outline-none focus:border-fg"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Password
          <input
            className="border-b border-rule bg-transparent py-2 text-lg text-fg outline-none focus:border-fg"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="mt-4 bg-fg py-3 text-base font-medium text-bg disabled:opacity-50"
        >
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
    </main>
  );
}
