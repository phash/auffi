/**
 * Keep keyboard focus inside an open modal and wire Escape-to-close.
 *
 * The dashboard's modals (confirm-with-reason, feedback FAB) declare
 * `role="dialog" aria-modal="true"`, which promises assistive tech that
 * focus is confined — but the overlay alone doesn't confine Tab. Without a
 * trap, Tab walks into the background page behind the modal.
 *
 * Returns a release function: call it on close to drop the listener and
 * restore focus to whatever was focused before the modal opened.
 *
 * (Sibling of viewer/src/focus-trap.ts — the dashboard ships a separate
 * bundle and cannot import across packages.)
 */
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function trapFocus(container: HTMLElement, onEscape?: () => void): () => void {
  // Only an element OUTSIDE the modal counts as the opener: a caller that
  // already moved focus into the dialog must not have its own button recorded
  // as the place to return to (it is gone once the modal is removed).
  const active = document.activeElement;
  const previouslyFocused =
    active instanceof HTMLElement && !container.contains(active) ? active : null;

  const focusable = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && onEscape) {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusable();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !container.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !container.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  container.addEventListener("keydown", onKeydown);
  return () => {
    container.removeEventListener("keydown", onKeydown);
    previouslyFocused?.focus();
  };
}
