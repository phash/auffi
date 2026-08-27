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

/**
 * Format an uptime given in seconds as a German duration:
 * "42 Sek", "5 Min", "3 Std 4 Min", "2 Tage 7 Std" ("1 Tag"). Pure.
 * Distinct from `formatRelative` — an uptime is a duration, not an
 * "ago"-timestamp.
 */
export function formatUptime(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  if (sec < 60) return `${sec} Sek`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} Min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const restMin = min % 60;
    return restMin === 0 ? `${hr} Std` : `${hr} Std ${restMin} Min`;
  }
  const day = Math.floor(hr / 24);
  const restHr = hr % 24;
  const days = `${day} ${day === 1 ? "Tag" : "Tage"}`;
  return restHr === 0 ? days : `${days} ${restHr} Std`;
}

/**
 * Format a unix-ms timestamp as a German date-only "DD.MM.YYYY"
 * string. Pure; used by the admin tables (created-at, last-login).
 */
export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("de-DE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/**
 * Format an absolute unix-ms timestamp as a German locale
 * "DD.MM.YYYY, HH:MM" string. Pure; used by the connection-log view.
 */
export function formatAbsolute(ts: number): string {
  return new Date(ts).toLocaleString("de-DE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format a positive byte count as "1.2 MB" / "456 KB" / "78 B" /
 * "—" for zero (p2p sessions report bytes_relayed = 0). Uses
 * binary (1024) prefixes since that's what the WebRTC layer
 * accumulates over the relay socket. Pure.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted = unit === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[unit]}`;
}

/**
 * Render a connection's wall-clock duration as "1:23 Min" /
 * "0:05 Std" / "—" for an unfinished session (ended_at = null).
 * Inputs are absolute unix-ms.
 */
export function formatDuration(startedAt: number, endedAt: number | null): string {
  if (endedAt === null) return "—";
  const sec = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mmss = `${m}:${s.toString().padStart(2, "0")}`;
  if (h === 0) return `${mmss} Min`;
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")} Std`;
}
