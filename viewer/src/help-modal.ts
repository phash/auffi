// „?"-Hilfe-Modal: erklärt die Funktion der App (So funktioniert Auffi).
// Trigger sitzt in der Topbar; das Modal-Markup liegt statisch in index.html
// (und in der vanilla `help-overlay.js` für die statischen Seiten). Diese
// Funktion verdrahtet nur Öffnen/Schließen + Focus-Management.

import { FOCUSABLE_SELECTOR, trapFocus } from "./focus-trap.js";

/**
 * Verdrahtet den Hilfe-Trigger mit dem Modal: Klick öffnet, Escape /
 * Backdrop-Klick / Schließen-Button schließen. Der Fokus wird beim Öffnen
 * in den Dialog gezogen und beim Schließen auf den Trigger zurückgegeben
 * (via `trapFocus`, das das zuvor fokussierte Element wiederherstellt).
 * No-op, wenn Trigger oder Modal fehlt.
 */
export function wireHelpModal(
  trigger: HTMLElement | null,
  modal: HTMLElement | null,
): void {
  if (!trigger || !modal) return;
  const dialog = modal.querySelector<HTMLElement>(".help-modal-dialog") ?? modal;
  let release: (() => void) | null = null;

  const close = (): void => {
    if (modal.hidden) return;
    modal.hidden = true;
    release?.();
    release = null;
  };

  const open = (): void => {
    if (!modal.hidden) return;
    modal.hidden = false;
    release = trapFocus(dialog, close);
    const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? dialog).focus();
  };

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    open();
  });
  modal.querySelectorAll<HTMLElement>("[data-help-close]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      close();
    }),
  );
}
