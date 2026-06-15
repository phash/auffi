import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

function loadDOM(): Document {
  const html = readFileSync(
    resolve(__dirname, "../index.html"),
    "utf-8"
  );
  const dom = new JSDOM(html);
  return dom.window.document;
}

describe("Viewer top bar", () => {
  let doc: Document;

  beforeEach(() => {
    doc = loadDOM();
  });

  it("Sharer-Download sits in the prominent topbar centre and links to /download/", () => {
    // The download moved out of the right-hand action cluster into the
    // centre zone next to Verbinden (2026-06-15) to make it prominent.
    const btn = doc.getElementById("topbar-sharer") as HTMLAnchorElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("href")).toBe("/download/");
    // No target=_blank — same-tab navigation is the expected default.
    expect(btn!.getAttribute("target")).toBe(null);
    // Lives in the centre zone, not the right-hand actions.
    expect(btn!.closest(".topbar-center")).not.toBeNull();
  });

  it("the old right-hand #topbar-download anchor is gone (moved to centre)", () => {
    expect(doc.getElementById("topbar-download")).toBeNull();
  });

  it("Verbinden CTA sits in the centre and targets the code field", () => {
    const cta = doc.getElementById("notch-connect") as HTMLAnchorElement | null;
    expect(cta).not.toBeNull();
    expect(cta!.getAttribute("href")).toBe("#code");
    expect(cta!.classList.contains("topbar-cta-connect")).toBe(true);
    expect(cta!.closest(".topbar-center")).not.toBeNull();
  });

  it("hero secondary CTA offers the Sharer download below Verbinden", () => {
    const heroCta = doc.getElementById("hero-sharer-cta") as HTMLAnchorElement | null;
    expect(heroCta).not.toBeNull();
    expect(heroCta!.getAttribute("href")).toBe("/download/");
  });

  it("coffee button exists with correct href and target=_blank", () => {
    const btn = doc.getElementById("topbar-coffee") as HTMLAnchorElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.href).toBe("https://buymeacoffee.com/phash");
    expect(btn!.target).toBe("_blank");
    expect(btn!.rel).toContain("noopener");
    expect(btn!.rel).toContain("noreferrer");
  });

  it("the prominent buttons all carry aria-label attributes", () => {
    const sharer = doc.getElementById("topbar-sharer") as HTMLAnchorElement;
    const connect = doc.getElementById("notch-connect") as HTMLAnchorElement;
    const coffee = doc.getElementById("topbar-coffee") as HTMLAnchorElement;
    expect(sharer.getAttribute("aria-label")).toBeTruthy();
    expect(connect.getAttribute("aria-label")).toBeTruthy();
    expect(coffee.getAttribute("aria-label")).toBeTruthy();
  });

  it("top bar is rendered as a header element", () => {
    const bar = doc.getElementById("top-bar");
    expect(bar).not.toBeNull();
    expect(bar!.tagName.toLowerCase()).toBe("header");
  });
});
