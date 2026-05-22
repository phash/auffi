// gh #54 — Reusable Confirm-mit-Reason-Modal für destruktive Admin-Aktionen.
//
// Returnt eine Promise, die zu dem getypten String resolves wenn der
// User "Bestätigen" klickt (mit der Reason ≥ MIN_REASON_LEN Zeichen),
// oder zu `null` resolves wenn der User "Abbrechen" klickt / Escape
// drückt / aufs Backdrop klickt. Genau ein Modal kann gleichzeitig
// offen sein (gleicher DOM-Slot; vorherige Instanzen werden vor Open
// abgeräumt).
//
// Reason ist Pflicht (mindestens 10 Zeichen — siehe #54 spec). Der
// Bestätigen-Button bleibt disabled bis die Länge erreicht ist; bei
// Submit-Versuch unterhalb der Länge wird eine Fehlermeldung gezeigt.

export const MIN_REASON_LEN = 10;

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Label des Bestätigen-Buttons (z. B. "Suspendieren"). */
  confirmLabel: string;
  /** Optionale Variante; "danger" macht den Confirm-Button rot. */
  variant?: "danger" | "primary";
}

/**
 * Validiert eine Reason gegen die Mindest-Länge. Pure Funktion damit
 * sie isoliert testbar ist; die Modal-UI ruft das auf jedem Input ab.
 */
export function reasonIsValid(reason: string): boolean {
  return reason.trim().length >= MIN_REASON_LEN;
}

/**
 * Mountet ein Modal in document.body und resolved die Promise nach
 * Confirm (mit der Reason) oder Cancel (mit null). Aufrufer
 * disable'n den Action-Button während der Promise-Lebensdauer.
 */
export function confirmWithReason(opts: ConfirmOptions): Promise<string | null> {
  // Vorherige Instanzen abräumen — Modal ist Single-Slot.
  const existing = document.getElementById("admin-modal-backdrop");
  if (existing) existing.remove();

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.id = "admin-modal-backdrop";
    backdrop.className = "admin-modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");

    const modal = document.createElement("div");
    modal.className = "admin-modal";

    const h2 = document.createElement("h2");
    h2.textContent = opts.title;
    modal.appendChild(h2);

    const msg = document.createElement("p");
    msg.textContent = opts.message;
    modal.appendChild(msg);

    const label = document.createElement("label");
    label.style.display = "block";
    label.style.fontSize = "0.8125rem";
    label.style.color = "var(--text-secondary)";
    label.textContent = `Grund (mindestens ${MIN_REASON_LEN} Zeichen)`;
    modal.appendChild(label);

    const textarea = document.createElement("textarea");
    textarea.className = "admin-modal-reason";
    textarea.required = true;
    textarea.maxLength = 500;
    textarea.setAttribute("aria-label", "Grund für die Aktion");
    modal.appendChild(textarea);

    const error = document.createElement("p");
    error.className = "admin-modal-error";
    error.style.display = "none";
    modal.appendChild(error);

    const actions = document.createElement("div");
    actions.className = "admin-modal-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Abbrechen";
    actions.appendChild(cancel);

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className =
      "btn " + (opts.variant === "danger" ? "danger" : "primary");
    confirm.textContent = opts.confirmLabel;
    confirm.disabled = true;
    actions.appendChild(confirm);

    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    textarea.focus();

    function close(value: string | null): void {
      // Detach listeners to avoid leaks if the Promise is GC'd before
      // close (defensive — JS doesn't really need this but it's tidy).
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(value);
    }

    textarea.addEventListener("input", () => {
      const ok = reasonIsValid(textarea.value);
      confirm.disabled = !ok;
      if (ok && error.style.display !== "none") {
        error.style.display = "none";
      }
    });

    confirm.addEventListener("click", () => {
      const v = textarea.value.trim();
      if (!reasonIsValid(v)) {
        error.textContent = `Grund braucht mindestens ${MIN_REASON_LEN} Zeichen.`;
        error.style.display = "block";
        textarea.focus();
        return;
      }
      close(v);
    });

    cancel.addEventListener("click", () => close(null));

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") close(null);
    }
    document.addEventListener("keydown", onKey);
  });
}
