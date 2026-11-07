import { registerSW } from "virtual:pwa-register";
import { toast } from "./components/ui/toast";

/**
 * Registers the app-shell service worker. When a new version has been deployed, offers a reload
 * instead of swapping code under an open drawer.
 */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  const update = registerSW({
    onNeedRefresh() {
      toast("A new version is available", {
        action: { label: "Reload", onClick: () => void update(true) },
        durationMs: 60_000,
      });
    },
  });
}
