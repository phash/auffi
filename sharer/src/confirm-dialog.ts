// In-app confirm dialog for the sharer webview — replaces native
// window.confirm() so destructive actions stay on-brand and accessible.
// Resolves true on confirm, false on cancel / Escape / backdrop-click.
// Confines Tab to the dialog and restores focus to the opener on close.

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

const FOCUSABLE = "button:not([disabled])";

// Single-slot: at most one confirm dialog exists. Closing the previous one
// through its own close() (instead of just removing its DOM) resolves the
// displaced promise with false — otherwise a caller awaiting it would hang
// forever.
let closeActive: ((value: boolean) => void) | null = null;

/**
 * Programmatically close the open dialog as if the user had cancelled.
 * Used when the question expired elsewhere (e.g. the Rust-side 60 s
 * unattended auto-decline) — the answer would be a dead-id no-op, so
 * leaving the dialog standing only misleads the user.
 */
export function dismissConfirmDialog(): void {
  closeActive?.(false);
}

export function confirmDialog(opts: ConfirmDialogOptions): Promise<boolean> {
  closeActive?.(false);

  return new Promise((resolve) => {
    const opener = document.activeElement as HTMLElement | null;

    const backdrop = document.createElement("div");
    backdrop.id = "sharer-confirm-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "sharer-confirm-title");
    backdrop.setAttribute("aria-describedby", "sharer-confirm-desc");
    backdrop.style.cssText =
      "position:fixed;inset:0;z-index:1000;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(0,0,0,0.45);padding:1rem;";

    const modal = document.createElement("div");
    modal.style.cssText =
      "background:var(--card-bg);color:var(--text);border:1px solid var(--border);" +
      "border-radius:var(--radius);box-shadow:var(--shadow-lift);max-width:24rem;" +
      "width:100%;padding:1.25rem;";

    const h = document.createElement("h2");
    h.id = "sharer-confirm-title";
    h.textContent = opts.title;
    h.style.cssText = "font-size:1rem;margin-bottom:0.5rem;";

    const p = document.createElement("p");
    p.id = "sharer-confirm-desc";
    p.textContent = opts.message;
    p.style.cssText = "font-size:0.875rem;color:var(--text-secondary);margin-bottom:1rem;";

    const row = document.createElement("div");
    row.className = "btn-row";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-secondary";
    cancel.style.flex = "1";
    cancel.textContent = opts.cancelLabel ?? "Abbrechen";

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = opts.danger ? "btn btn-danger" : "btn btn-primary";
    confirm.style.flex = "1";
    confirm.style.width = "auto";
    confirm.textContent = opts.confirmLabel;

    row.append(cancel, confirm);
    modal.append(h, p, row);
    backdrop.append(modal);
    document.body.append(backdrop);
    // Every caller gates access or destroys state, and Rust focuses the
    // window right before the unattended prompt — a keystroke already in
    // flight must land on the declining choice, like the ad-hoc peer-confirm.
    cancel.focus();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(backdrop.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !backdrop.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !backdrop.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    function close(value: boolean): void {
      if (closeActive === close) closeActive = null;
      backdrop.removeEventListener("keydown", onKey);
      backdrop.remove();
      opener?.focus?.();
      resolve(value);
    }

    closeActive = close;
    backdrop.addEventListener("keydown", onKey);
    confirm.addEventListener("click", () => close(true));
    cancel.addEventListener("click", () => close(false));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(false);
    });
  });
}
