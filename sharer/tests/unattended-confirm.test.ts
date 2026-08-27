import { describe, it, expect } from "vitest";
import { UNATTENDED_CONFIRM_OPTIONS } from "../src/unattended-confirm.js";

describe("UNATTENDED_CONFIRM_OPTIONS", () => {
  it("uses German copy with explicit Erlauben/Ablehnen choices", () => {
    expect(UNATTENDED_CONFIRM_OPTIONS.confirmLabel).toBe("Erlauben");
    expect(UNATTENDED_CONFIRM_OPTIONS.cancelLabel).toBe("Ablehnen");
    expect(UNATTENDED_CONFIRM_OPTIONS.title).toContain("Fernzugriff");
  });

  it("is honest about what is known: password verified, identity unknown, 60 s auto-decline", () => {
    // The pw-check carries no viewer IP/name — the dialog must not
    // pretend otherwise, and it must warn about the auto-decline.
    const msg = UNATTENDED_CONFIRM_OPTIONS.message;
    expect(msg).toContain("Geräte-Passwort");
    expect(msg).toContain("nicht feststellen");
    expect(msg).toContain("60 Sekunden");
  });
});
