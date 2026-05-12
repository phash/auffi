/**
 * Format a monitor entry for display in the picker.
 *
 * OS-provided monitor names are usually technical noise — `\\.\DISPLAY1` on
 * Windows, `eDP-1` / `HDMI-1` on Linux, sometimes an empty string. None of
 * that is useful to a non-technical user, so we always render a friendly
 * label:
 *
 *  - For the first monitor in a multi-monitor setup → "Hauptbildschirm"
 *  - For others → "Bildschirm 2", "Bildschirm 3", …
 *  - For a single-monitor system → "Bildschirm"
 *
 * The technical name is dropped entirely; resolution moves into a secondary
 * subtitle so the user can still differentiate identical-position monitors.
 */
export interface MonitorLabel {
  /** The primary, human-friendly line shown in bold. */
  primary: string;
  /** The secondary line (resolution) shown subtler beneath. */
  secondary: string;
}

export function friendlyMonitorLabel(
  idx: number,
  total: number,
  width: number,
  height: number,
): MonitorLabel {
  const primary =
    total <= 1
      ? "Bildschirm"
      : idx === 0
        ? "Hauptbildschirm"
        : `Bildschirm ${idx + 1}`;
  return { primary, secondary: formatResolution(width, height) };
}

/**
 * Format raw pixel dimensions for display. Uses the multiplication sign (×)
 * rather than the ASCII letter x so it lines up visually.
 */
export function formatResolution(width: number, height: number): string {
  if (width <= 0 || height <= 0) return "Unbekannte Größe";
  return `${width} × ${height}`;
}
