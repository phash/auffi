/**
 * Pure presentation helper for the ad-hoc code's time-to-live.
 *
 * The backend stamps each `code-assigned` with `expiresInSec` (the server is
 * the single source of truth for the 10-minute cap — see
 * `backend/src/signaling.ts`). The sharer counts that value down locally and
 * renders it through this helper. Kept side-effect-free so it can be unit
 * tested without a DOM or timers.
 */
export interface ExpiryView {
  /** True once the code is no longer accepted by the backend. */
  expired: boolean;
  /** German status line shown beneath the code. */
  label: string;
}

/**
 * Map the remaining seconds to a display state. At or below zero the code is
 * treated as expired; otherwise the time is shown as `M:SS`.
 */
export function formatExpiry(remainingSec: number): ExpiryView {
  const remaining = Math.floor(remainingSec);
  if (remaining <= 0) {
    return { expired: true, label: "Code abgelaufen" };
  }
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return { expired: false, label: `Gültig noch ${minutes}:${String(seconds).padStart(2, "0")}` };
}
