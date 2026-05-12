import { describe, it, expect } from "vitest";
import { DEFAULT_ZOOM, ZOOM_STEPS, formatZoom, nextZoomLevel } from "../src/zoom.js";

describe("nextZoomLevel", () => {
  it("steps up from 100 % to 125 %", () => {
    expect(nextZoomLevel(1.0, "in")).toBe(1.25);
  });

  it("steps down from 100 % to 75 %", () => {
    expect(nextZoomLevel(1.0, "out")).toBe(0.75);
  });

  it("caps at the highest available step when zooming in past the maximum", () => {
    const max = ZOOM_STEPS[ZOOM_STEPS.length - 1];
    expect(nextZoomLevel(max, "in")).toBe(max);
  });

  it("floors at the lowest available step when zooming out past the minimum", () => {
    const min = ZOOM_STEPS[0];
    expect(nextZoomLevel(min, "out")).toBe(min);
  });

  it("tolerates floating-point drift around a step", () => {
    expect(nextZoomLevel(0.9999, "in")).toBe(1.25);
    expect(nextZoomLevel(1.0001, "in")).toBe(1.25);
  });

  it("snaps an unknown value back to default before stepping", () => {
    // 0.6 is not in ZOOM_STEPS — the function should treat it as DEFAULT_ZOOM
    // and step from there, so going "out" lands at 0.75 (the step below default).
    expect(nextZoomLevel(0.6, "out")).toBe(0.75);
  });

  it("DEFAULT_ZOOM is present in ZOOM_STEPS", () => {
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM);
  });
});

describe("formatZoom", () => {
  it("formats 100 %", () => {
    expect(formatZoom(1.0)).toBe("100 %");
  });

  it("rounds 1.234 to 123 %", () => {
    expect(formatZoom(1.234)).toBe("123 %");
  });

  it("formats 50 %", () => {
    expect(formatZoom(0.5)).toBe("50 %");
  });
});
