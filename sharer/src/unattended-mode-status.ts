/**
 * Main-panel status line while the persisted mode is "unattended".
 *
 * The mode select persists "unattended" unconditionally — it has to, because
 * the pairing and password blocks in Settings only render in that mode. So
 * the mode alone says nothing about whether a helper can reach this device;
 * "aktiv" is reserved for a running heartbeat. Pure so the table is testable.
 */
export interface UnattendedReadiness {
  paired: boolean;
  pwSet: boolean;
  active: boolean;
}

export function unattendedMainStatus(s: UnattendedReadiness): string {
  if (!s.paired) {
    return "Unattended-Modus — Gerät noch nicht gekoppelt. Bitte in den Einstellungen koppeln.";
  }
  if (!s.pwSet) {
    return "Unattended-Modus — Geräte-Passwort fehlt. Bitte in den Einstellungen setzen.";
  }
  if (!s.active) {
    return "Unattended-Modus — noch nicht aktiviert.";
  }
  return "Unattended-Modus aktiv — Helfer verbinden sich über das Dashboard.";
}
