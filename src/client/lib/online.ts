import { useSyncExternalStore } from "react";

let fetchFailed = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
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
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("online", onBrowserChange);
      window.removeEventListener("offline", onBrowserChange);
    }
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

export function isOnline(): boolean {
  return snapshot();
}

/** False when the browser is offline or the last request failed on the network. Disable saving on false. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}

export function resetOnlineForTests(): void {
  fetchFailed = false;
  emit();
}
