// Styled yes/no confirm — the no-reason sibling of confirmWithReason.
//
// Replaces native window.confirm()/alert() for destructive actions that
// don't capture an audit reason (feedback delete, device unpair), so the
// whole dashboard shares one on-brand, accessible confirm surface instead
// of three different patterns. Resolves `true` on confirm, `false` on
// cancel / Escape / backdrop-click.

import { trapFocus } from "../focus-trap.js";

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  /** Label of the confirm button (e.g. "Löschen"). */
  confirmLabel: string;
  /** Label of the cancel button. Defaults to "Abbrechen". */
  cancelLabel?: string;
  /** "danger" makes the confirm button red. */
  variant?: "danger" | "primary";
}

export function confirmDialog(opts: ConfirmDialogOptions): Promise<boolean> {
  // Single-slot: drop any prior instance first.
  document.getElementById("admin-modal-backdrop")?.remove();

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.id = "admin-modal-backdrop";
    backdrop.className = "admin-modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "admin-modal-title");
    backdrop.setAttribute("aria-describedby", "admin-modal-desc");

    const modal = document.createElement("div");
    modal.className = "admin-modal";

    const h2 = document.createElement("h2");
    h2.id = "admin-modal-title";
    h2.textContent = opts.title;
    modal.appendChild(h2);

    const msg = document.createElement("p");
    msg.id = "admin-modal-desc";
    msg.textContent = opts.message;
    modal.appendChild(msg);

    const actions = document.createElement("div");
    actions.className = "admin-modal-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = opts.cancelLabel ?? "Abbrechen";
    actions.appendChild(cancel);

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "btn " + (opts.variant === "danger" ? "danger" : "primary");
    confirm.textContent = opts.confirmLabel;
    actions.appendChild(confirm);

    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Trap first, then move focus in — the trap records the opener to
    // return focus to on close.
    const releaseTrap = trapFocus(backdrop, () => close(false));
    confirm.focus();

    function close(value: boolean): void {
      releaseTrap();
      backdrop.remove();
      resolve(value);
    }

    confirm.addEventListener("click", () => close(true));
    cancel.addEventListener("click", () => close(false));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(false);
    });
  });
}
