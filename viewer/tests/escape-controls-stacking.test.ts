import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// While the viewer waits for the first decoded frame — up to 30 s on a bad
// TURN relay — #video-loading-overlay covers the video area opaquely at
// z-index 5. The "Abbrechen" button is hidden in that phase (it lives inside
// .input-group, which gets .hidden), so "Beenden" is the only escape left.
// Both #disconnect and #video-toolbar were position:absolute with NO z-index,
// which paints them under the overlay: the user was left staring at a spinner
// with no reachable way out, contradicting the documented intent that a
// visible control is always the primary escape.

const CSS = readFileSync(resolve(__dirname, "../src/styles.css"), "utf-8");

/** z-index declared in the first rule block for exactly this selector. */
function zIndexOf(selector: string): number | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m").exec(CSS);
  if (!block) throw new Error(`no rule block for ${selector}`);
  const z = /z-index:\s*(-?\d+)/.exec(block[1]);
  return z ? Number(z[1]) : undefined;
}

describe("video-area escape controls stack above the loading overlay", () => {
  const overlay = () => zIndexOf("#video-loading-overlay");

  it("the loading overlay declares the z-index this guard is relative to", () => {
    expect(overlay()).toBeTypeOf("number");
  });

  for (const selector of ["#disconnect", "#video-toolbar"]) {
    it(`${selector} paints above the loading overlay`, () => {
      const z = zIndexOf(selector);
      expect(z, `${selector} declares no z-index, so it paints under the overlay`).toBeTypeOf(
        "number",
      );
      expect(z!).toBeGreaterThan(overlay()!);
    });
  }

  it("stays below the zoom/fullscreen controls so those keep priority", () => {
    const controls = zIndexOf("#video-controls")!;
    for (const selector of ["#disconnect", "#video-toolbar"]) {
      expect(zIndexOf(selector)!).toBeLessThan(controls);
    }
  });
});
