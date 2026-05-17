/**
 * Pure pan-state helpers for the zoomed video viewport.
 *
 * pan(X|Y) is the viewport offset in unzoomed CSS pixels — positive panX
 * means "user has shifted the visible window to the right" (which the UI
 * implements as a NEGATIVE translate on the video element).
 *
 * Max pan in each direction is half of the cropped overhang
 * (wrapperSize * (zoom - 1) / 2), so the user can scroll exactly far
 * enough to see either edge of the scaled video but never reveal empty
 * space beyond it.
 */

/** One D-pad click moves 25 % of the way from current to the edge. */
export const PAN_STEP_FRACTION = 0.25;

export interface PanState {
  panX: number;
  panY: number;
}

export function maxPan(zoom: number, wrapperSize: number): number {
  if (zoom <= 1) return 0;
  return (wrapperSize * (zoom - 1)) / 2;
}

/**
 * Clamp pan to the valid range for the current zoom + wrapper. Returns
 * a NEW PanState; callers should treat the input as immutable.
 */
export function clampPan(
  state: PanState,
  zoom: number,
  wrapperWidth: number,
  wrapperHeight: number,
): PanState {
  const mx = maxPan(zoom, wrapperWidth);
  const my = maxPan(zoom, wrapperHeight);
  return {
    panX: Math.max(-mx, Math.min(mx, state.panX)),
    panY: Math.max(-my, Math.min(my, state.panY)),
  };
}

/**
 * Step pan in the given direction. `dirX` / `dirY` are unit-vector
 * components: +1 (forward), 0 (no change), -1 (backward). Diagonal pans
 * are allowed (both non-zero); they step both axes simultaneously.
 *
 * The step size is `PAN_STEP_FRACTION` of the max-pan, so the user
 * reaches an edge in `1 / PAN_STEP_FRACTION` clicks (default: 4).
 * Clamps the result so over-stepping the edge is a no-op.
 */
export function stepPan(
  state: PanState,
  zoom: number,
  wrapperWidth: number,
  wrapperHeight: number,
  dirX: -1 | 0 | 1,
  dirY: -1 | 0 | 1,
): PanState {
  const mx = maxPan(zoom, wrapperWidth);
  const my = maxPan(zoom, wrapperHeight);
  return clampPan(
    {
      panX: state.panX + dirX * mx * PAN_STEP_FRACTION,
      panY: state.panY + dirY * my * PAN_STEP_FRACTION,
    },
    zoom,
    wrapperWidth,
    wrapperHeight,
  );
}

export const ZERO_PAN: PanState = { panX: 0, panY: 0 };
