/**
 * German status copy for a lost signaling / heartbeat link.
 *
 * Both Rust WS loops (`signaling.rs` for ad-hoc, `heartbeat.rs` for
 * unattended) attach a `reason` to their `disconnected` event and document it
 * as a dbg_log diagnostic, not user-facing: "close code=1005 reason=\"\"",
 * "read: IO error …", "no pong for 31s", "backend error bad-message: …". The
 * webviews rendered it verbatim. This maps the handful of reason classes a
 * sharer-user can act on to plain sentences; the raw string belongs in the
 * console only.
 */
export function friendlyDisconnectReason(reason: string): string {
  if (/^connect(?: failed)?:|^invalid (?:signaling|ws) url|^invalid origin/.test(reason)) {
    return "Server nicht erreichbar — bitte Internetverbindung prüfen.";
  }
  if (/^no pong/.test(reason)) {
    return "Verbindung zum Server verloren — der Server antwortet nicht.";
  }
  if (/\brate-limit\b/.test(reason)) {
    return "Zu viele Verbindungen — bitte kurz warten.";
  }
  return "Verbindung zum Server getrennt.";
}
