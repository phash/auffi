import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel));

// Icon A (Matrix-style phosphor monitor). The sharer's app-icon.svg is the
// source; every surface ships the same mark.
const MARKS = [
  "sharer/src-tauri/icons/app-icon.svg",
  "viewer/public/brand-mark.svg",
  "dashboard/public/brand-mark.svg",
  "sharer/public/brand-mark.svg",
];

describe("Icon A", () => {
  it("draws its glyphs as shapes, not font-dependent <text>", () => {
    for (const f of MARKS) expect(read(f).toString("utf8"), f).not.toMatch(/<text\b/);
  });

  it("is the same file on every surface", () => {
    const source = read(MARKS[0]);
    for (const f of MARKS.slice(1)) expect(read(f).equals(source), f).toBe(true);
  });

  it("the web manifest uses the dark ground as theme and background", () => {
    const m = JSON.parse(read("viewer/public/site.webmanifest").toString("utf8"));
    expect(m.theme_color).toBe("#0e1311");
    expect(m.background_color).toBe("#0e1311");
  });

  it("raster icons have the sizes their names promise", () => {
    const size = (f: string) => {
      const b = read(f);
      return [b.readUInt32BE(16), b.readUInt32BE(20)];
    };
    expect(size("viewer/public/favicon-32x32.png")).toEqual([32, 32]);
    expect(size("viewer/public/favicon-128x128.png")).toEqual([128, 128]);
    expect(size("viewer/public/apple-touch-icon.png")).toEqual([256, 256]);
    expect(size("sharer/src-tauri/icons/32x32.png")).toEqual([32, 32]);
    expect(size("sharer/src-tauri/icons/128x128.png")).toEqual([128, 128]);
    expect(size("sharer/src-tauri/icons/128x128@2x.png")).toEqual([256, 256]);
  });
});
