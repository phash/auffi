// Copy for the app-global unattended manual-confirm dialog (auto_accept
// off). Rendered through the same confirmDialog() surface the other
// destructive confirmations use, so the prompt is visible regardless of
// which tab is active — the old toast lived inside the hidden Settings
// panel and silently auto-declined after 60 s.

import type { ConfirmDialogOptions } from "./confirm-dialog.js";

// The pw-check carries no viewer identity (no IP, no name — only the
// fact that the device password verified), so the copy says exactly
// that instead of pretending to know who is asking.
export const UNATTENDED_CONFIRM_OPTIONS: ConfirmDialogOptions = {
  title: "Fernzugriff erlauben?",
  message:
    "Jemand möchte auf diesen Bildschirm zugreifen und hat das richtige " +
    "Geräte-Passwort eingegeben. Wer es ist, kann Auffi nicht feststellen. " +
    "Ohne Antwort wird der Zugriff nach 60 Sekunden automatisch abgelehnt.",
  confirmLabel: "Erlauben",
  cancelLabel: "Ablehnen",
};
