import { describe, it, expect } from "vitest";
import { formatResolution, friendlyMonitorLabel, monitorPickerView } from "../src/monitor-display.js";

describe("friendlyMonitorLabel", () => {
  it("single monitor is just 'Bildschirm'", () => {
    expect(friendlyMonitorLabel(0, 1, 1920, 1080)).toEqual({
      primary: "Bildschirm",
      secondary: "1920 × 1080",
    });
  });

  it("first of many is 'Hauptbildschirm'", () => {
    expect(friendlyMonitorLabel(0, 2, 2560, 1440).primary).toBe("Hauptbildschirm");
  });

  it("second monitor is 'Bildschirm 2'", () => {
    expect(friendlyMonitorLabel(1, 2, 1920, 1080).primary).toBe("Bildschirm 2");
  });

  it("third monitor is 'Bildschirm 3'", () => {
    expect(friendlyMonitorLabel(2, 3, 1920, 1080).primary).toBe("Bildschirm 3");
  });

  it("never returns the raw OS-supplied technical name", () => {
    // Regression: previous UI displayed names like "\\\\.\\DISPLAY1" — we
    // never expose those to the user. friendlyMonitorLabel doesn't even
    // accept the OS name as a parameter, but assert the contract here.
    const result = friendlyMonitorLabel(0, 2, 1920, 1080);
    expect(result.primary).not.toMatch(/\\|DISPLAY|eDP|HDMI/);
  });
});

describe("monitorPickerView", () => {
  it("start mode: CTA 'Stream starten', no cancel (aborting a start would strand the waiting helper)", () => {
    expect(monitorPickerView("start")).toEqual({ cta: "Stream starten", showCancel: false });
  });

  it("switch mode: CTA 'Bildschirm wechseln' with a cancel path", () => {
    expect(monitorPickerView("switch")).toEqual({ cta: "Bildschirm wechseln", showCancel: true });
  });
});

describe("formatResolution", () => {
  it("uses the multiplication sign, not 'x'", () => {
    expect(formatResolution(1920, 1080)).toBe("1920 × 1080");
    expect(formatResolution(1920, 1080)).not.toContain("x");
  });

  it("returns a fallback label for zero dimensions", () => {
    expect(formatResolution(0, 0)).toBe("Unbekannte Größe");
    expect(formatResolution(1920, 0)).toBe("Unbekannte Größe");
  });

  it("returns a fallback label for negative dimensions", () => {
    expect(formatResolution(-1, 1080)).toBe("Unbekannte Größe");
  });
});
