// Small pure-function helpers shared across views.

/**
 * Format a unix-ms timestamp as "vor 3 Min" / "vor 2 Std" / "vor 4 Tagen" /
 * absolute date. Null → "—". Pure for trivial unit-pinning.
 *
 * `now` is injectable so tests don't drift on real-clock.
 */
export function formatRelative(ts: number | null, now: number = Date.now()): string {
  if (ts === null) return "—";
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `vor ${hr} Std`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `vor ${day} ${day === 1 ? "Tag" : "Tagen"}`;
  // Beyond a week, drop the relative form — the absolute date is
  // more informative.
  return new Date(ts).toLocaleDateString("de-DE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}
