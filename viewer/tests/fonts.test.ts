import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../..");
const WEIGHTS = [300, 400, 500, 600];

// Each nginx container ships its own asset set, so every surface keeps its
// own copy of the font files.
const SURFACES = [
  { fonts: "viewer/public/fonts", files: ["viewer/public", "viewer/src", "viewer/index.html", "viewer/en"] },
  { fonts: "dashboard/public/fonts", files: ["dashboard/src", "dashboard/index.html"] },
  { fonts: "sharer/public/fonts", files: ["sharer/src", "sharer/index.html"] },
];

function walk(rel: string): string[] {
  const abs = join(REPO, rel);
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs).flatMap((e) => walk(join(rel, e)));
}
const styled = (rels: string[]) =>
  rels.flatMap(walk).filter((f) => /\.(css|html)$/.test(f));

describe.each(SURFACES)("fonts for $fonts", ({ fonts, files }) => {
  it("ships the four Manrope weights", () => {
    for (const w of WEIGHTS) expect(existsSync(join(REPO, fonts, `Manrope-${w}.woff2`)), `Manrope-${w}`).toBe(true);
  });
  it("no longer references IBM Plex Sans", () => {
    const hits = styled(files).filter((f) => /Plex Sans|IBMPlexSans/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
  it("every /fonts/ url and preload points at an existing file", () => {
    for (const f of styled(files)) {
      for (const m of readFileSync(f, "utf8").matchAll(/["(]\/fonts\/([\w.-]+\.woff2)/g))
        expect(existsSync(join(REPO, fonts, m[1])), `${f} → ${m[1]}`).toBe(true);
    }
  });
});
