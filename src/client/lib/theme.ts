import { useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "brutal-budget:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

function readStored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : "system";
  } catch {
    return "system";
  }
}

let current: Theme | null = null;
let systemMql: MediaQueryList | null = null;
let systemIsDark = false;
const listeners = new Set<() => void>();

function systemDark(): boolean {
  if (systemMql) return systemIsDark;
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

function resolved(theme: Theme): "light" | "dark" {
  if (theme === "system") return systemDark() ? "dark" : "light";
  return theme;
}

function apply() {
  document.documentElement.classList.toggle("dark", resolved(getTheme()) === "dark");
}

function onSystemChange(event: { matches: boolean }) {
  systemIsDark = event.matches;
  apply();
  for (const listener of listeners) listener();
}

function watchSystem() {
  if (systemMql || typeof window.matchMedia !== "function") return;
  systemMql = window.matchMedia(DARK_QUERY);
  systemIsDark = systemMql.matches;
  systemMql.addEventListener("change", onSystemChange);
}

export function getTheme(): Theme {
  current ??= readStored();
  return current;
}

/** Stores the theme for this device and applies it to <html> immediately. */
export function setTheme(theme: Theme): void {
  current = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode or blocked storage: the choice lasts for this page load only.
  }
  apply();
  for (const listener of listeners) listener();
}

/** Applies the stored theme and starts following the system setting. Safe to call repeatedly. */
export function initTheme(): void {
  watchSystem();
  apply();
}

function subscribe(listener: () => void) {
  initTheme();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The per-device theme choice, what it resolves to now, and a setter. */
export function useTheme(): { theme: Theme; resolved: "light" | "dark"; setTheme: (theme: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, getTheme, getTheme);
  // Subscribing re-renders on system changes, so `resolved` stays live.
  useSyncExternalStore(subscribe, systemDark, () => false);
  return { theme, resolved: resolved(theme), setTheme };
}

export function resetThemeForTests(): void {
  systemMql?.removeEventListener("change", onSystemChange);
  systemMql = null;
  current = null;
}
