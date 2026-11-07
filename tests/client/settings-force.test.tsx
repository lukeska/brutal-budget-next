import { SettingsPage } from "@client/routes/settings/index";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real Argon2id at 64 MiB is too slow for jsdom; the key derivation has its own tests.
vi.mock("@client/features/auth/derive-key", () => ({
  deriveKey: vi.fn(async (password: string) => `key-of-${password}`),
  newSalt: () => "fresh-salt",
}));

const ME = {
  id: "u-alice",
  name: "Alice",
  email: "alice@example.com",
  secondaryCurrency: null,
  theme: null,
  mustChangePassword: true,
  passwordResetBy: { name: "Bob" },
  passwordResetAt: "2026-11-05T10:00:00.000Z",
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let me: typeof ME;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderAt(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const routes = [
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <p>Month home</p> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  calls = [];
  me = { ...ME };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/auth/me") return json(me);
    if (url === "/api/auth/salt")
      return json({
        salt: "old-salt",
        params: { memoryKiB: 65536, iterations: 3, parallelism: 1, hashLength: 32 },
      });
    if (url === "/api/auth/password") {
      me = { ...me, mustChangePassword: false };
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("forced password change", () => {
  it("shows only the password form and the reset notice", async () => {
    renderAt("/settings?force-password=1");
    const notice = await screen.findByText(/Your password was reset by Bob on/);
    expect(notice).toHaveTextContent(/Choose a new password to continue\.$/);
    expect(screen.getByRole("form", { name: "Change password" })).toBeInTheDocument();
    for (const section of ["Profile", "Display", "Partner", "Household"]) {
      expect(screen.queryByRole("heading", { name: section })).not.toBeInTheDocument();
    }
    expect(calls.some((c) => c.url === "/api/settings")).toBe(false);
  });

  it("is forced by the session flag even without the URL parameter", async () => {
    renderAt("/settings");
    expect(await screen.findByText(/Your password was reset by Bob on/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Profile" })).not.toBeInTheDocument();
  });

  it("changes the password, refreshes the session user and goes home", async () => {
    const user = userEvent.setup();
    const router = renderAt("/settings?force-password=1");
    await user.type(await screen.findByLabelText("Current password"), "temporary1");
    await user.type(screen.getByLabelText("New password"), "brand-new-pass");
    await user.type(screen.getByLabelText("Confirm new password"), "brand-new-pass");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText("Month home")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(calls.find((c) => c.url === "/api/auth/password")?.body).toEqual({
      currentKey: "key-of-temporary1",
      newSalt: "fresh-salt",
      newVerifierKey: "key-of-brand-new-pass",
    });
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/auth/me").length).toBeGreaterThan(1));
  });

  it("refuses a new password shorter than 8 characters", async () => {
    const user = userEvent.setup();
    renderAt("/settings?force-password=1");
    await user.type(await screen.findByLabelText("Current password"), "temporary1");
    await user.type(screen.getByLabelText("New password"), "short");
    await user.type(screen.getByLabelText("Confirm new password"), "short");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 8 characters/);
    expect(calls.some((c) => c.url === "/api/auth/password")).toBe(false);
  });
});
