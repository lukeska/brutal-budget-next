import { AddButton, isNewEntryShortcut } from "@client/components/AddButton";
import { MobileMenu } from "@client/components/layout/MobileMenu";
import { TopBar } from "@client/components/layout/TopBar";
import { OfflineBanner } from "@client/components/OfflineBanner";
import { DrawerHost, drawerStore, registerDrawer, useDrawer } from "@client/drawer/store";
import { ApiError, api, setUnauthorizedHandler } from "@client/lib/api";
import { useIsDesktop } from "@client/lib/media";
import { markOffline, resetOnlineForTests, useOnline } from "@client/lib/online";
import { safeNext } from "@client/lib/safe-next";
import { resetThemeForTests, setTheme, useTheme } from "@client/lib/theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  type ErrorComponentProps,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { matches: boolean }) => void;

/** jsdom has no layout: answer media queries from a fake viewport width and a fake colour scheme. */
function mockViewport({ width, dark = false }: { width: number; dark?: boolean }) {
  window.innerWidth = width;
  const listeners = new Map<string, Set<Listener>>();
  const evaluate = (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    if (min) return width >= Number(min[1]);
    if (query.includes("prefers-color-scheme: dark")) return dark;
    return false;
  };
  window.matchMedia = vi.fn((query: string) => {
    const set = listeners.get(query) ?? new Set<Listener>();
    listeners.set(query, set);
    return {
      matches: evaluate(query),
      media: query,
      onchange: null,
      addEventListener: (_: string, cb: Listener) => set.add(cb),
      removeEventListener: (_: string, cb: Listener) => set.delete(cb),
      addListener: (cb: Listener) => set.add(cb),
      removeListener: (cb: Listener) => set.delete(cb),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  });
  return {
    setDark(next: boolean) {
      dark = next;
      for (const [query, set] of listeners) {
        if (query.includes("prefers-color-scheme")) for (const cb of set) cb({ matches: next });
      }
    },
  };
}

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
}

/** Renders a component inside a throwaway memory router so `<Link>` works. */
function renderInRouter(ui: () => ReactNode, path = "/") {
  const rootRoute = createRootRoute({
    component: ui,
    errorComponent: ({ error }: ErrorComponentProps) => <p>{String(error)}</p>,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function Layout() {
  const desktop = useIsDesktop();
  return desktop ? (
    <TopBar />
  ) : (
    <>
      <MobileMenu />
      <AddButton variant="floating" />
    </>
  );
}

beforeEach(() => {
  setNavigatorOnline(true);
  resetOnlineForTests();
  drawerStore.close();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("responsive navigation", () => {
  it("shows the hamburger and a floating add button at a phone width", async () => {
    mockViewport({ width: 390 });
    renderInRouter(Layout);
    expect(await screen.findByRole("button", { name: /open menu/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add entry/i })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: /main/i })).not.toBeInTheDocument();
  });

  it("shows the top bar with every section and '+ Add' at desktop width", async () => {
    mockViewport({ width: 1280 });
    renderInRouter(Layout);
    const nav = await screen.findByRole("navigation", { name: /main/i });
    for (const name of ["Month", "Accounts", "Statistics", "Categories", "Projects", "Settings"]) {
      expect(nav).toContainElement(screen.getByRole("link", { name }));
    }
    expect(screen.getByRole("button", { name: "+ Add" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open menu/i })).not.toBeInTheDocument();
  });

  it("marks the current section as the active page", async () => {
    mockViewport({ width: 1280 });
    renderInRouter(Layout, "/accounts");
    const link = await screen.findByRole("link", { name: "Accounts" });
    expect(link).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Month" })).not.toHaveAttribute("aria-current");
  });

  it("opens the mobile menu with the same sections and closes it with Escape", async () => {
    mockViewport({ width: 390 });
    const user = userEvent.setup();
    renderInRouter(Layout);
    const toggle = await screen.findByRole("button", { name: /open menu/i });
    await user.click(toggle);
    const dialog = screen.getByRole("dialog", { name: /menu/i });
    for (const name of ["Month", "Accounts", "Statistics", "Categories", "Projects", "Settings"]) {
      expect(dialog).toContainElement(screen.getByRole("link", { name }));
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });
});

describe("add button and offline state", () => {
  it("opens the drawer ready for an expense in one tap", async () => {
    mockViewport({ width: 390 });
    const user = userEvent.setup();
    render(<AddButton variant="floating" />);
    await user.click(screen.getByRole("button", { name: /add entry/i }));
    expect(drawerStore.get()).toMatchObject({ open: true, mode: "create", kind: "expense" });
  });

  it("still opens the drawer when offline, shows the banner and reports offline so Save can be disabled", async () => {
    setNavigatorOnline(false);
    resetOnlineForTests();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const user = userEvent.setup();
    const online = renderHook(() => useOnline());
    render(
      <>
        <OfflineBanner />
        <AddButton variant="bar" />
      </>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/offline/i);
    await user.click(screen.getByRole("button", { name: "+ Add" }));
    expect(drawerStore.get().open).toBe(true);
    expect(online.result.current).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("goes offline when a request fails on the network and recovers on the next success", async () => {
    const online = renderHook(() => useOnline());
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(api.get("/api/accounts")).rejects.toThrow(TypeError);
    expect(online.result.current).toBe(false);
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await api.get("/api/accounts");
    expect(online.result.current).toBe(true);
  });

  it("follows the browser's online and offline events", () => {
    const online = renderHook(() => useOnline());
    act(() => {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(online.result.current).toBe(false);
    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(online.result.current).toBe(true);
    act(() => markOffline());
    expect(online.result.current).toBe(false);
  });

  it("treats N as the new-expense shortcut only outside text fields and without modifiers", () => {
    const input = document.createElement("input");
    const div = document.createElement("div");
    const key = (target: EventTarget, init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", init);
      Object.defineProperty(event, "target", { value: target });
      return event;
    };
    expect(isNewEntryShortcut(key(div, { key: "n" }))).toBe(true);
    expect(isNewEntryShortcut(key(div, { key: "N", shiftKey: true }))).toBe(false);
    expect(isNewEntryShortcut(key(div, { key: "n", metaKey: true }))).toBe(false);
    expect(isNewEntryShortcut(key(input, { key: "n" }))).toBe(false);
  });
});

describe("drawer store", () => {
  it("renders nothing until a drawer is registered, then renders it", () => {
    const { container, rerender } = render(<DrawerHost />);
    expect(container).toBeEmptyDOMElement();
    registerDrawer(() => {
      const state = useDrawer();
      return state.open ? <p>drawer {state.kind}</p> : null;
    });
    act(() => drawerStore.openCreate("income"));
    rerender(<DrawerHost />);
    expect(screen.getByText("drawer income")).toBeInTheDocument();
    act(() => drawerStore.openEdit("entry-1"));
    expect(drawerStore.get()).toMatchObject({ open: true, mode: "edit", entryId: "entry-1" });
  });
});

describe("session expiry", () => {
  it("sends the user to login with the current path as next when a data request returns 401", async () => {
    window.history.replaceState(null, "", "/accounts?month=2026-10");
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );
    await expect(api.get("/api/accounts")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/accounts?month=2026-10")}`);
  });

  it("does not redirect on 401 from the auth endpoints themselves", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 401 }));
    await expect(api.get("/api/auth/me")).rejects.toBeInstanceOf(ApiError);
    await expect(api.post("/api/auth/login", {})).rejects.toBeInstanceOf(ApiError);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("safeNext", () => {
  it.each([
    ["https://evil.example", "/"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["\\\\evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["/\t/evil.example", "/"],
    ["/redirect?to=https://evil.example", "/redirect?to=https://evil.example"],
    ["/accounts?x=1", "/accounts?x=1"],
    ["/", "/"],
    [undefined, "/"],
    [42, "/"],
  ])("maps %s to %s", (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });
});

/** Node's own (file-less) localStorage global shadows jsdom's, so give each theme test a fresh one. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

describe("theme", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    document.documentElement.classList.remove("dark");
  });

  it("follows the system setting by default, live", () => {
    const viewport = mockViewport({ width: 1280, dark: false });
    resetThemeForTests();
    renderHook(() => useTheme());
    expect(document.documentElement).not.toHaveClass("dark");
    act(() => viewport.setDark(true));
    expect(document.documentElement).toHaveClass("dark");
  });

  it("adds the dark class for a dark override regardless of the system setting, and remembers it", () => {
    mockViewport({ width: 1280, dark: false });
    resetThemeForTests();
    const { result } = renderHook(() => useTheme());
    act(() => setTheme("dark"));
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("brutal-budget:theme")).toBe("dark");
  });

  it("keeps the light override even when the system is dark", () => {
    mockViewport({ width: 1280, dark: true });
    localStorage.setItem("brutal-budget:theme", "light");
    resetThemeForTests();
    renderHook(() => useTheme());
    expect(document.documentElement).not.toHaveClass("dark");
  });
});

describe("api error mapping", () => {
  it("still exposes the server's error code", async () => {
    setUnauthorizedHandler(vi.fn());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "conflict" }), { status: 409 }),
    );
    await waitFor(() => expect(api.put("/api/entries/x", {})).rejects.toMatchObject({ code: "conflict" }));
  });
});
