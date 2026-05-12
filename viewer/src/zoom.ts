/**
 * Discrete zoom levels offered to the user, in ascending order. Picked to feel
 * natural for non-technical helpers: 50 % to fit more on a small laptop screen,
 * 300 % so they can read small text on a 4K shared desktop.
 */
export const ZOOM_STEPS: readonly number[] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0] as const;

export const DEFAULT_ZOOM = 1.0;

/**
 * Return the next zoom value in `ZOOM_STEPS` going in the requested direction.
 * Clamps at the ends so a user can't tear the zoom off-scale.
 *
 * Tolerant to floating-point drift on `current` (snaps to the closest step
 * within ±1 percentage point); falls back to `DEFAULT_ZOOM` if `current` is
 * outside the table entirely (e.g. someone passed a stale value).
 */
export function nextZoomLevel(current: number, direction: "in" | "out"): number {
  let idx = ZOOM_STEPS.findIndex((s) => Math.abs(s - current) < 0.01);
  if (idx === -1) idx = ZOOM_STEPS.indexOf(DEFAULT_ZOOM);

  const target = direction === "in" ? idx + 1 : idx - 1;
  const clamped = Math.min(Math.max(target, 0), ZOOM_STEPS.length - 1);
  return ZOOM_STEPS[clamped];
}

/**
 * Format a zoom value for display on the reset button — e.g. 1.25 → "125 %".
 */
export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)} %`;
}
