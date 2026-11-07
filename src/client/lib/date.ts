const todayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Today's date (YYYY-MM-DD) in `timeZone`, or in the browser's zone when it's missing or unknown. */
export function todayIn(timeZone: string | undefined, now: Date = new Date()): string {
  if (timeZone) {
    try {
      let formatter = todayFormatters.get(timeZone);
      if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
        todayFormatters.set(timeZone, formatter);
      }
      return formatter.format(now);
    } catch {
      // Unknown zone: fall through to the browser's date.
    }
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Formats a calendar date (YYYY-MM-DD) as itself, whatever the browser's zone. */
export function formatIsoDate(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { ...options, timeZone: "UTC" });
}
