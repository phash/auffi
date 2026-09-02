import { describe, it, expect } from "vitest";
import html from "../index.html?raw";

/**
 * main.ts shows the "Neu verbinden" button by toggling the WRAPPER's inline
 * display (`showReconnect()` / `hideReconnect()`). A stylesheet rule that hides
 * the button itself behind a class nobody adds made it unreachable for every
 * disconnected sharer — the wrapper appeared, the button inside stayed
 * display:none. Whatever hides the button must be the same thing main.ts flips.
 */
describe("sharer index.html: the reconnect button can actually render", () => {
  it("has no stylesheet rule hiding #reconnect-btn behind a class", () => {
    const rules = html.match(/#reconnect-btn(?![\w-])[^{]*\{[^}]*\}/g) ?? [];
    const hiding = rules.filter((r) => /display\s*:\s*none/.test(r));
    expect(hiding, `rules that hide the button itself: ${hiding.join(" | ")}`).toEqual([]);
  });

  it("wraps the button in #reconnect-btn-wrap, which main.ts toggles", () => {
    expect(html).toMatch(/id="reconnect-btn-wrap"[^>]*>\s*<button id="reconnect-btn"/);
  });
});
