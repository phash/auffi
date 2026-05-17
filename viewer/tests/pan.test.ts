import { describe, it, expect } from "vitest";
import { PAN_STEP_FRACTION, ZERO_PAN, clampPan, maxPan, stepPan } from "../src/pan.js";

describe("maxPan", () => {
  it("returns 0 at zoom <= 1 (nothing to pan)", () => {
    expect(maxPan(1.0, 800)).toBe(0);
    expect(maxPan(0.5, 800)).toBe(0);
  });

  it("grows linearly with zoom — at zoom=2 max-pan is half the wrapper", () => {
    expect(maxPan(2.0, 800)).toBe(400);
    expect(maxPan(3.0, 800)).toBe(800);
    expect(maxPan(1.5, 800)).toBe(200);
  });
});

describe("clampPan", () => {
  it("leaves an in-range state untouched", () => {
    const r = clampPan({ panX: 100, panY: -50 }, 2.0, 800, 600);
    expect(r).toEqual({ panX: 100, panY: -50 });
  });

  it("clamps to ±maxPan in each direction", () => {
    const r = clampPan({ panX: 999, panY: -999 }, 2.0, 800, 600);
    expect(r).toEqual({ panX: 400, panY: -300 });
  });

  it("forces (0, 0) at zoom=1 (nothing to pan)", () => {
    const r = clampPan({ panX: 50, panY: 50 }, 1.0, 800, 600);
    expect(r).toEqual(ZERO_PAN);
  });
});

describe("stepPan", () => {
  it("steps by PAN_STEP_FRACTION × max in the requested direction", () => {
    const r = stepPan(ZERO_PAN, 2.0, 800, 600, 1, 0);
    expect(r.panX).toBe(400 * PAN_STEP_FRACTION);
    expect(r.panY).toBe(0);
  });

  it("supports diagonal steps (both axes at once)", () => {
    const r = stepPan(ZERO_PAN, 2.0, 800, 600, 1, -1);
    expect(r.panX).toBe(100);
    expect(r.panY).toBe(-75);
  });

  it("reaches max in exactly 1 / PAN_STEP_FRACTION steps", () => {
    const steps = Math.round(1 / PAN_STEP_FRACTION);
    let s: typeof ZERO_PAN = ZERO_PAN;
    for (let i = 0; i < steps; i++) s = stepPan(s, 2.0, 800, 600, 1, 0);
    expect(s.panX).toBe(maxPan(2.0, 800));
  });

  it("clamps when over-stepping the edge", () => {
    const atEdge = { panX: maxPan(2.0, 800), panY: 0 };
    const r = stepPan(atEdge, 2.0, 800, 600, 1, 0);
    expect(r).toEqual(atEdge);
  });

  it("does nothing at zoom=1 regardless of direction", () => {
    const r = stepPan(ZERO_PAN, 1.0, 800, 600, 1, -1);
    expect(r).toEqual(ZERO_PAN);
  });

  it("re-clamps existing state when zoom shrinks below the old pan range", () => {
    // User panned to +400 at zoom=2, then zooms out to 1.5 — max-pan
    // collapses to 200, so the existing 400 must clamp.
    const after = clampPan({ panX: 400, panY: 0 }, 1.5, 800, 600);
    expect(after.panX).toBe(200);
  });
});
