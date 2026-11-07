import { useSyncExternalStore } from "react";

/** Tailwind's `md` breakpoint. */
export const DESKTOP_QUERY = "(min-width: 768px)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** True at Tailwind `md` and wider: top bar layout instead of the hamburger. */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
