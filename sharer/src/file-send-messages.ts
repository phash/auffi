/**
 * German copy for a failed `pick_and_send_file`. Rust rejects with a stable
 * code (`SendFailure::code` in `src-tauri/src/files.rs`, plus
 * `file-no-session`); anything else falls back to the generic line so a raw
 * Rust or OS error never reaches the sharer-user.
 */
const MESSAGES: Record<string, string> = {
  "file-rejected": "Der Helfer hat die Datei abgelehnt.",
  "file-timeout": "Der Helfer hat die Datei nicht angenommen — bitte erneut senden.",
  "file-cancelled": "Datei nicht gesendet — die Verbindung wurde beendet.",
  "file-no-session": "Datei nicht gesendet — es besteht keine Verbindung zum Helfer.",
  "file-busy": "Es laufen schon mehrere Übertragungen — bitte warte, bis sie fertig sind.",
};

const GENERIC = "Datei konnte nicht gesendet werden.";

export function fileSendErrorMessage(err: unknown): string {
  return typeof err === "string" ? (MESSAGES[err] ?? GENERIC) : GENERIC;
}
