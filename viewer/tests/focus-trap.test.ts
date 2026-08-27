import { describe, it, expect, vi, beforeEach } from "vitest";
import { trapFocus } from "../src/focus-trap.js";

function tab(shift = false): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
}

describe("trapFocus", () => {
  let modal: HTMLElement;
  let first: HTMLButtonElement;
  let last: HTMLButtonElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    modal = document.createElement("div");
    first = document.createElement("button");
    last = document.createElement("button");
    modal.append(first, last);
    document.body.append(modal);
  });

  it("wraps Tab from the last focusable to the first", () => {
    const release = trapFocus(modal);
    last.focus();
    modal.dispatchEvent(tab());
    expect(document.activeElement).toBe(first);
    release();
  });

  it("wraps Shift+Tab from the first focusable to the last", () => {
    const release = trapFocus(modal);
    first.focus();
    modal.dispatchEvent(tab(true));
    expect(document.activeElement).toBe(last);
    release();
  });

  it("invokes onEscape and prevents default on Escape", () => {
    const onEscape = vi.fn();
    const release = trapFocus(modal, onEscape);
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    modal.dispatchEvent(ev);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    release();
  });

  it("treats <summary> as focusable so a button before it is not the trap's last stop", () => {
    // The help modal is built from <details><summary> rows. If the selector
    // omits <summary>, the only focusable becomes the close button → the
    // trap pins focus to it and Tab can never reach the accordion (gh review).
    document.body.innerHTML = "";
    const c = document.createElement("div");
    const btn = document.createElement("button");
    const details = document.createElement("details");
    details.append(document.createElement("summary"));
    c.append(btn, details);
    document.body.append(c);
    const release = trapFocus(c);
    btn.focus();
    const ev = tab();
    c.dispatchEvent(ev);
    // btn is NOT the last focusable (the summary is), so the trap must not
    // force-wrap here — Tab is free to advance to the summary.
    expect(ev.defaultPrevented).toBe(false);
    release();
  });

  it("restores focus to the previously-focused element on release", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const release = trapFocus(modal);
    first.focus();
    release();
    expect(document.activeElement).toBe(opener);
  });

  // The guarded toasts are position:fixed without a backdrop — one click on
  // the page behind them moves focus outside the container. A container-scoped
  // keydown listener then never fires again and the trap (plus Escape) is
  // dead, despite aria-modal="true" promising confinement. The listener must
  // live on document so these events still reach the trap.
  it("pulls focus back into the container when Tab is pressed while focus escaped", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const release = trapFocus(modal);
    outside.focus();
    const ev = tab();
    outside.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    release();
  });

  it("pulls focus back to the last focusable on Shift+Tab while focus escaped", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const release = trapFocus(modal);
    outside.focus();
    const ev = tab(true);
    outside.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    release();
  });

  it("still invokes onEscape when focus has left the container", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const onEscape = vi.fn();
    const release = trapFocus(modal, onEscape);
    outside.focus();
    outside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(onEscape).toHaveBeenCalledTimes(1);
    release();
  });

  it("release removes the document-level listener", () => {
    const onEscape = vi.fn();
    const release = trapFocus(modal, onEscape);
    release();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(onEscape).not.toHaveBeenCalled();
  });
});
