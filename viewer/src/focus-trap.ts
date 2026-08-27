/**
 * Keep keyboard focus inside an open modal and wire Escape-to-close.
 *
 * The viewer's overlay toasts (file-offer, pw-prompt) carry
 * `aria-modal="true"`, which promises assistive tech that focus is
 * confined — but a CSS overlay alone does not confine Tab. Without a trap,
 * Tab walks straight into the (visually hidden) page behind the modal.
 *
 * `trapFocus` returns a release function: call it when the modal closes to
 * remove the listener and restore focus to whatever was focused before.
 */
// `summary` is the native focusable toggle of a <details>; the help modal is
// built entirely from <details><summary> rows, so it must be in the set or the
// trap pins focus to the close button and Tab never reaches the accordion.
// Exported as the single source of truth for "what is focusable" — help-modal
// uses it for its initial-focus query (previously a drifted inline copy).
export const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

export function trapFocus(container: HTMLElement, onEscape?: () => void): () => void {
  const previouslyFocused = document.activeElement as HTMLElement | null;

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

  // Document-level, not container-level: the guarded toasts are
  // position:fixed dialogs without a backdrop, so one click on the page
  // behind them moves focus outside the container — a container-scoped
  // listener would then never fire again and both the Tab-trap and
  // Escape-to-close would be dead while aria-modal still promises
  // confinement. The `!container.contains(active)` branches above pull
  // focus back in exactly that case.
  document.addEventListener("keydown", onKeydown);
  return () => {
    document.removeEventListener("keydown", onKeydown);
    previouslyFocused?.focus?.();
  };
}
