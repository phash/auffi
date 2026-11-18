import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const doc = new DOMParser().parseFromString(html, "text/html");

describe("dashboard index.html head", () => {
  it("carries the dark and light theme-color pair", () => {
    const metas = [...doc.querySelectorAll('meta[name="theme-color"]')].map((m) => [
      m.getAttribute("content"),
      m.getAttribute("media"),
    ]);
    expect(metas).toEqual([
      ["#0e1311", "(prefers-color-scheme: dark)"],
      ["#f3f6f4", "(prefers-color-scheme: light)"],
    ]);
  });

  it("uses the site favicon (Icon A) served from the site root", () => {
    expect(doc.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/favicon-32x32.png");
  });
});
