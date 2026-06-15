import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// The help copy lives in two places by necessity: the app modal markup in
// index.html (Vite bundle) and the standalone help-overlay.js (static pages,
// which can't import the bundle). This guard fails if the German section
// titles drift apart, so security/usage claims (TTL, lockout, DTLS) can't
// silently disagree between the app and the static pages.

function appSummaries(): string[] {
  const html = readFileSync(resolve(__dirname, "../index.html"), "utf-8");
  const doc = new JSDOM(html).window.document;
  return Array.from(
    doc.querySelectorAll<HTMLElement>("#help-modal .help-section > summary"),
  ).map((s) => (s.textContent ?? "").trim());
}

function overlayDeTitles(): string[] {
  const src = readFileSync(resolve(__dirname, "../public/help-overlay.js"), "utf-8");
  const deBlock = src.slice(src.indexOf("de: {"), src.indexOf("en: {"));
  return Array.from(deBlock.matchAll(/q:\s*"([^"]+)"/g)).map((m) => m[1]);
}

describe("help content stays in sync (app modal ↔ static overlay)", () => {
  it("German section titles match between index.html and help-overlay.js", () => {
    const app = appSummaries();
    expect(app).toHaveLength(5);
    expect(overlayDeTitles()).toEqual(app);
  });
});
