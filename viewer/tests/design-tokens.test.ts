import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../src/styles.css", import.meta.url)),
  "utf8",
);

function token(name: string): string {
  const m = css.match(new RegExp(`${name}(?![\\w-])\\s*:\\s*(#[0-9a-fA-F]{3,8})`));
  if (!m) throw new Error(`token ${name} not found in styles.css`);
  return m[1];
}
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const lin = [0, 2, 4]
    .map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number {
  const ls = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (ls[0] + 0.05) / (ls[1] + 0.05);
}

describe("design tokens", () => {
  it("defines the emerald/mint palette", () => {
    expect(token("--brand")).toBe("#10b981");
    expect(token("--brand-strong")).toBe("#047857");
  });
  it("primary button (brand-strong bg + white text) meets WCAG AA", () => {
    expect(contrast(token("--brand-strong"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
  it("body text (ink on paper) meets WCAG AA", () => {
    expect(contrast(token("--ink"), token("--paper"))).toBeGreaterThanOrEqual(4.5);
  });
});
