import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { showSignupToastIfFlagged } from "../src/signup-toast.js";

describe("showSignupToastIfFlagged", () => {
  beforeEach(() => {
    // Clean DOM + storage between tests.
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    try {
      window.sessionStorage.removeItem("auffi:signup-toast");
    } catch (_) { /* ignore */ }
  });
  afterEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    try {
      window.sessionStorage.removeItem("auffi:signup-toast");
    } catch (_) { /* ignore */ }
  });

  it("is a no-op when the sessionStorage flag is unset", () => {
    showSignupToastIfFlagged();
    expect(document.getElementById("signup-confirm-toast")).toBeNull();
  });

  it("mounts the toast when the flag is set and consumes the flag", () => {
    window.sessionStorage.setItem("auffi:signup-toast", "1");
    showSignupToastIfFlagged();
    const toast = document.getElementById("signup-confirm-toast");
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain("Konto angelegt");
    expect(toast?.textContent).toContain("E-Mail-Eingang");
    // Flag must be removed so a refresh doesn't re-pop the toast.
    expect(window.sessionStorage.getItem("auffi:signup-toast")).toBeNull();
  });

  it("close button removes the toast", () => {
    window.sessionStorage.setItem("auffi:signup-toast", "1");
    showSignupToastIfFlagged();
    const toast = document.getElementById("signup-confirm-toast")!;
    const close = toast.querySelector(".signup-confirm-close") as HTMLButtonElement;
    expect(close).not.toBeNull();
    close.click();
    expect(document.getElementById("signup-confirm-toast")).toBeNull();
  });

  it("does NOT mount twice when called repeatedly with the flag re-set", () => {
    window.sessionStorage.setItem("auffi:signup-toast", "1");
    showSignupToastIfFlagged();
    // Re-set + re-call (paranoia — flag-consume should have cleared it).
    window.sessionStorage.setItem("auffi:signup-toast", "1");
    showSignupToastIfFlagged();
    const toasts = document.querySelectorAll("#signup-confirm-toast");
    expect(toasts).toHaveLength(1);
  });
});
