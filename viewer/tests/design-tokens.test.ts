import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../../design/tokens.css", import.meta.url)),
  "utf8",
);

type Mode = "dark" | "light";

const lightStart = css.indexOf("@media (prefers-color-scheme: light)");
const darkBlock = lightStart === -1 ? css : css.slice(0, lightStart);
const lightBlock = lightStart === -1 ? "" : css.slice(lightStart);

function find(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`(?<![\\w-])${name}(?![\\w-])\\s*:\\s*(#[0-9a-fA-F]{3,8})`));
  return m?.[1];
}

function token(name: string, mode: Mode): string {
  const v = (mode === "light" ? find(lightBlock, name) : undefined) ?? find(darkBlock, name);
  if (!v) throw new Error(`token ${name} (${mode}) not found in design/tokens.css`);
  return v;
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

describe("design tokens (design/tokens.css)", () => {
  it.each(["dark", "light"] as const)("%s: text tokens meet AA on bg and panel", (m) => {
    for (const fg of ["--fg", "--muted", "--accent-text"])
      for (const bg of ["--bg", "--panel"])
        expect(contrast(token(fg, m), token(bg, m)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["dark", "light"] as const)("%s: on-accent meets AA on both gradient ends", (m) => {
    expect(contrast(token("--on-accent", m), token("--teal", m))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("--on-accent", m), token("--mint", m))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["dark", "light"] as const)("%s: error and warn are readable on bg", (m) => {
    expect(contrast(token("--error", m), token("--bg", m))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("--warn", m), token("--bg", m))).toBeGreaterThanOrEqual(4.5);
  });
  it("dark is the default and light only overrides inside the media query", () => {
    expect(token("--bg", "dark")).toBe("#0e1311");
    expect(token("--bg", "light")).toBe("#f3f6f4");
    expect(darkBlock).toMatch(/:root\s*{[^}]*color-scheme:\s*dark/);
    expect(lightBlock).toMatch(/color-scheme:\s*light/);
  });
  it("defines only custom properties, no component selectors", () => {
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+){/g)]
      .map((m) => m[1].trim())
      .filter((s) => !s.startsWith("@media"));
    expect(new Set(selectors)).toEqual(new Set([":root"]));
  });
});
