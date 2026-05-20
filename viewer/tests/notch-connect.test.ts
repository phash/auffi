import { describe, it, expect, beforeEach, vi } from "vitest";
import { attachNotchHandler, focusCodeInput } from "../src/notch-connect.js";

function mountNotchAndCode(): {
  notch: HTMLAnchorElement;
  code: HTMLInputElement;
} {
  document.body.replaceChildren();
  const notch = document.createElement("a");
  notch.id = "notch-connect";
  notch.href = "#code";
  notch.textContent = "Verbinden";
  const code = document.createElement("input");
  code.id = "code";
  code.value = "123-456-789";
  document.body.append(notch, code);
  // jsdom does not implement scrollIntoView; stub so the call doesn't throw.
  code.scrollIntoView = vi.fn();
  return { notch, code };
}

describe("focusCodeInput", () => {
  it("focuses the input, selects its content, and scrolls smoothly", () => {
    const { code } = mountNotchAndCode();
    focusCodeInput(code, true);
    expect(document.activeElement).toBe(code);
    expect(code.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(code.selectionStart).toBe(0);
    expect(code.selectionEnd).toBe(code.value.length);
  });

  it("uses auto-scroll behaviour when smooth=false (initial hash-load case)", () => {
    const { code } = mountNotchAndCode();
    focusCodeInput(code, false);
    expect(code.scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "center",
    });
  });
});

describe("attachNotchHandler", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/");
  });

  it("focuses the code input on click and prevents the default hash jump", () => {
    const { notch, code } = mountNotchAndCode();
    attachNotchHandler(notch, code);

    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    notch.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(code);
  });

  it("updates the URL hash to #code via replaceState (no extra history entry)", () => {
    const { notch, code } = mountNotchAndCode();
    attachNotchHandler(notch, code);

    const beforeLen = history.length;
    notch.click();

    expect(window.location.hash).toBe("#code");
    expect(history.length).toBe(beforeLen);
  });

  it("is a no-op when either element is missing", () => {
    const { notch, code } = mountNotchAndCode();
    // Missing notch → no error, no focus change.
    attachNotchHandler(null, code);
    // Missing code → no error, no focus change.
    attachNotchHandler(notch, null);
    expect(document.activeElement).not.toBe(code);
  });
});
