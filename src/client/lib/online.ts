import { useSyncExternalStore } from "react";

let fetchFailed = false;
const listeners = new Set<() => void>();

const PROBE_FIRST_MS = 2000;
const PROBE_MAX_MS = 30_000;
let probeTimer: ReturnType<typeof setTimeout> | undefined;
let probeDelay = PROBE_FIRST_MS;

function emit() {
  for (const listener of listeners) listener();
  syncProbe();
}

function stopProbe() {
  clearTimeout(probeTimer);
  probeTimer = undefined;
  probeDelay = PROBE_FIRST_MS;
}

/** While a request has failed and someone is watching, keep asking the server whether it's back. */
function syncProbe() {
  if (!fetchFailed || listeners.size === 0) stopProbe();
  else if (probeTimer === undefined) scheduleProbe();
}

function scheduleProbe() {
  probeTimer = setTimeout(async () => {
    const ok = await probeServer();
    probeTimer = undefined;
    if (!ok) {
      probeDelay = Math.min(probeDelay * 2, PROBE_MAX_MS);
      syncProbe();
    }
  }, probeDelay);
}

/**
 * Asks the server whether it is reachable, marking the app online when it answers. Uses plain fetch so a
 * failure doesn't loop back through the API client's offline tracking.
 */
export async function probeServer(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) return false;
    markOnline();
    return true;
  } catch {
    return false;
  }
}

function browserOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function snapshot(): boolean {
  return browserOnline() && !fetchFailed;
}

function onBrowserChange() {
  // A fresh "online" event is a reason to try again; the next failing request re-marks us offline.
  fetchFailed = false;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("online", onBrowserChange);
    window.addEventListener("offline", onBrowserChange);
  }
  syncProbe();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("online", onBrowserChange);
      window.removeEventListener("offline", onBrowserChange);
    }
    syncProbe();
  };
}

/** Called when a request fails on the network, even though `navigator.onLine` may still say online. */
export function markOffline(): void {
  if (fetchFailed) return;
  fetchFailed = true;
  emit();
}

/** Called after any successful response. */
export function markOnline(): void {
  if (!fetchFailed) return;
  fetchFailed = false;
  emit();
}

/** False when the browser is offline or the last request failed on the network. Disable saving on false. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}

export function resetOnlineForTests(): void {
  fetchFailed = false;
  stopProbe();
  emit();
}
