import { probeServer, useOnline } from "../lib/online";

/** Shown whenever the app can't reach the server. Saving is disabled everywhere meanwhile. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      className="sticky top-0 z-50 border-b border-rule bg-fg px-4 py-2 text-center text-sm text-bg"
    >
      You're offline. You can look around, but nothing can be saved until the connection is back.{" "}
      <button type="button" onClick={() => void probeServer()} className="underline underline-offset-2">
        Try again
      </button>
    </div>
  );
}
