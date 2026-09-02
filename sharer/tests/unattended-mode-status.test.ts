import { describe, it, expect } from "vitest";
import { unattendedMainStatus } from "../src/unattended-mode-status.js";

// The main panel said "Unattended-Modus aktiv — Helfer verbinden sich über
// das Dashboard." purely from mode.txt == "unattended" — also for a user who
// flipped the select and never paired, and after every launch before
// Aktivieren. The 9-digit code was gone, nothing was listening, and the
// status claimed the opposite.
describe("unattendedMainStatus", () => {
  it("points an unpaired device at the settings", () => {
    const s = unattendedMainStatus({ paired: false, pwSet: false, active: false });
    expect(s).toContain("noch nicht gekoppelt");
    expect(s).toContain("Einstellungen");
  });

  it("asks for the device password when pairing is done but the password is not", () => {
    const s = unattendedMainStatus({ paired: true, pwSet: false, active: false });
    expect(s).toContain("Geräte-Passwort fehlt");
  });

  it("says the mode is ready but not activated", () => {
    expect(unattendedMainStatus({ paired: true, pwSet: true, active: false })).toContain(
      "noch nicht aktiviert",
    );
  });

  it("claims 'aktiv' only when the heartbeat actually runs", () => {
    expect(unattendedMainStatus({ paired: true, pwSet: true, active: true })).toBe(
      "Unattended-Modus aktiv — Helfer verbinden sich über das Dashboard.",
    );
    for (const s of [
      { paired: false, pwSet: false, active: false },
      { paired: true, pwSet: false, active: false },
      { paired: true, pwSet: true, active: false },
    ]) {
      expect(unattendedMainStatus(s), JSON.stringify(s)).not.toMatch(/aktiv —/);
    }
  });
});
