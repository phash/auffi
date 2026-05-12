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

  it("download button exists with correct href and target=_blank", () => {
    const btn = doc.getElementById("topbar-download") as HTMLAnchorElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.href).toMatch(/\/download\/$/);
    expect(btn!.target).toBe("_blank");
    expect(btn!.rel).toContain("noopener");
    expect(btn!.rel).toContain("noreferrer");
  });

  it("coffee button exists with correct href and target=_blank", () => {
    const btn = doc.getElementById("topbar-coffee") as HTMLAnchorElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.href).toBe("https://buymeacoffee.com/phash");
    expect(btn!.target).toBe("_blank");
    expect(btn!.rel).toContain("noopener");
    expect(btn!.rel).toContain("noreferrer");
  });

  it("both buttons have aria-label attributes", () => {
    const download = doc.getElementById("topbar-download") as HTMLAnchorElement;
    const coffee = doc.getElementById("topbar-coffee") as HTMLAnchorElement;
    expect(download.getAttribute("aria-label")).toBeTruthy();
    expect(coffee.getAttribute("aria-label")).toBeTruthy();
  });

  it("top bar is rendered as a header element", () => {
    const bar = doc.getElementById("top-bar");
    expect(bar).not.toBeNull();
    expect(bar!.tagName.toLowerCase()).toBe("header");
  });
});
