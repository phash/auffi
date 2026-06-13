import { describe, it, expect, vi, beforeEach } from "vitest";
import { trapFocus } from "../src/focus-trap.js";

function tab(shift = false): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
}

describe("trapFocus (dashboard)", () => {
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

  it("wraps Tab from last to first and Shift+Tab from first to last", () => {
    const release = trapFocus(modal);
    last.focus();
    modal.dispatchEvent(tab());
    expect(document.activeElement).toBe(first);
    modal.dispatchEvent(tab(true));
    expect(document.activeElement).toBe(last);
    release();
  });

  it("invokes onEscape on Escape", () => {
    const onEscape = vi.fn();
    const release = trapFocus(modal, onEscape);
    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onEscape).toHaveBeenCalledTimes(1);
    release();
  });

  it("restores focus to the opener on release", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const release = trapFocus(modal);
    first.focus();
    release();
    expect(document.activeElement).toBe(opener);
  });
});
