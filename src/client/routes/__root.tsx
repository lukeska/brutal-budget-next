import type { MeResponse } from "@shared/auth";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Outlet,
  redirect,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { AddButton, isNewEntryShortcut } from "../components/AddButton";
import { MobileMenu } from "../components/layout/MobileMenu";
import { TopBar } from "../components/layout/TopBar";
import { OfflineBanner } from "../components/OfflineBanner";
import { Toaster } from "../components/ui/toast";
import { DrawerHost, openCreate } from "../drawer/store";
import { meQueryKey, meQueryOptions } from "../features/auth/use-me";
import { ApiError, api, loginHref, setUnauthorizedHandler } from "../lib/api";
import { useIsDesktop } from "../lib/media";
import { initTheme } from "../lib/theme";

type SetupStatus = { needsSetup: boolean };

/** Screens shown without the app chrome and reachable without a session. */
const PUBLIC_PATHS = new Set(["/login", "/setup"]);

const setupStatusQuery = {
  queryKey: ["setup", "status"] as const,
  queryFn: () => api.get<SetupStatus>("/api/setup/status"),
  // Setup happens once; after it, the answer never changes for this page load.
  staleTime: Number.POSITIVE_INFINITY,
};

initTheme();

/** Reads a cached-or-fetched value; a network failure yields undefined so the shell still loads offline. */
async function loadOrOffline<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return undefined;
  }
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  beforeLoad: async ({ context: { queryClient }, location }) => {
    const path = location.pathname;
    const status = await loadOrOffline(() => queryClient.ensureQueryData(setupStatusQuery));
    if (status?.needsSetup) {
      if (path !== "/setup") throw redirect({ href: "/setup" });
      return;
    }
    if (PUBLIC_PATHS.has(path)) return;

    const me: MeResponse | null | undefined = await loadOrOffline(() =>
      queryClient.ensureQueryData(meQueryOptions),
    );
    if (me === null) throw redirect({ href: loginHref(location.href) });
    if (me?.mustChangePassword && path !== "/settings") {
      throw redirect({ href: "/settings?force-password=1" });
    }
  },
  component: RootLayout,
});

function RootLayout() {
  const router = useRouter();
  const { queryClient } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const desktop = useIsDesktop();
  const chrome = !PUBLIC_PATHS.has(pathname);

  useEffect(() => {
    setUnauthorizedHandler((href) => {
      queryClient.setQueryData(meQueryKey, null);
      void router.navigate({ href });
    });
  }, [router, queryClient]);

  useEffect(() => {
    if (!chrome) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!isNewEntryShortcut(event)) return;
      event.preventDefault();
      openCreate("expense");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chrome]);

  if (!chrome) {
    return (
      <>
        <OfflineBanner />
        <Outlet />
        <Toaster />
      </>
    );
  }

  return (
    <div className="min-h-dvh">
      <OfflineBanner />
      {desktop ? <TopBar /> : <MobileMenu />}
      {/* On phones, leave room below the content for the floating add button. */}
      <div className={desktop ? undefined : "pb-28"}>
        <Outlet />
      </div>
      {!desktop && <AddButton variant="floating" />}
      <DrawerHost />
      <Toaster />
    </div>
  );
}
