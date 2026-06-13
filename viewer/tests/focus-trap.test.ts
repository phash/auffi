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

  it("restores focus to the previously-focused element on release", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const release = trapFocus(modal);
    first.focus();
    release();
    expect(document.activeElement).toBe(opener);
  });
});
