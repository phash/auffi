import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../..");

// Surfaces that are migrated to design/tokens.css. Each migration task adds
// its stylesheets here; once listed, a file may not bring back its own
// palette or its own light/dark switch.
const SURFACES: string[] = [
  "viewer/public/topbar-footer.css",
  "viewer/public/feedback-fab.css",
  "viewer/public/matomo-consent.css",
  "viewer/public/compare.css",
  "viewer/public/404.css",
  "viewer/public/download/style.css",
  "viewer/public/legal/style.css",
  "viewer/src/styles.css",
  "viewer/public/site-chrome.css",
  "dashboard/src/styles.css",
  "sharer/src/styles.css",
];

const LEGACY = [
  "--paper", "--surface", "--ink", "--ink-soft", "--ink-on-brand", "--brand", "--brand-2",
  "--brand-strong", "--cyan", "--cyan-deep", "--edge", "--signal-on", "--signal-off",
  "--shadow", "--shadow-sm", "--shadow-lift", "--card-bg", "--text", "--text-secondary",
  "--accent", "--accent-hover", "--accent-active", "--border", "--paper-edge", "--focus",
  "--amber", "--amber-deep", "--amber-ink", "--rule", "--font", "--success", "--warning",
  "--error-deep", "--radius-card", "--radius-input",
];

const read = (rel: string) =>
  readFileSync(resolve(REPO, rel), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

describe("design system guard", () => {
  it("lists only existing stylesheets", () => {
    for (const f of SURFACES) expect(() => read(f), f).not.toThrow();
  });
  it.each(SURFACES)("%s has no own light/dark switch", (f) => {
    expect(read(f)).not.toMatch(/prefers-color-scheme/);
  });
  it.each(SURFACES)("%s neither defines nor uses legacy token names", (f) => {
    const css = read(f);
    const hits = LEGACY.filter((n) => new RegExp(`${n}(?![\\w-])\\s*:|var\\(\\s*${n}(?![\\w-])`).test(css));
    expect(hits).toEqual([]);
  });
  it.each(SURFACES)("%s defines no colour-valued custom properties", (f) => {
    const defs = [...read(f).matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)]
      .filter(([, , v]) => /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(v))
      .map(([, n]) => n);
    expect(defs).toEqual([]);
  });
  // Controls drawn on top of the video sit on a fixed dark overlay in both
  // modes, so their ring is white rather than --fg.
  const ON_VIDEO = /#video-controls|\.pan-btn|#input-toggle|#file-send-btn|#disconnect/;
  it.each(SURFACES)("%s draws focus rings with --fg", (f) => {
    const css = read(f);
    for (const m of css.matchAll(/([^{}]*):focus-visible[^{]*{([^}]*)}/g)) {
      const [, selector, body] = m;
      if (!/outline\s*:/.test(body) || /outline\s*:\s*(none|0)/.test(body)) continue;
      expect(body, selector.trim()).toMatch(ON_VIDEO.test(selector) ? /var\(--fg\)|#ffffff/ : /var\(--fg\)/);
    }
  });
});

// With every surface migrated, the light/dark switch lives in exactly one
// place: design/tokens.css (and its byte-copy for the static pages).
const SCAN = ["viewer/src", "viewer/public", "viewer/index.html", "viewer/en", "dashboard/src",
  "dashboard/index.html", "sharer/src", "sharer/index.html"];
const TOKEN_FILES = new Set(["design/tokens.css", "viewer/public/tokens.css"]);

function files(rel: string): string[] {
  const abs = resolve(REPO, rel);
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs).flatMap((e) => files(`${rel}/${e}`));
}

describe("one light/dark switch", () => {
  it("only the token files mention prefers-color-scheme in CSS", () => {
    const hits = SCAN.flatMap(files)
      .filter((f) => /\.(css|html|ts)$/.test(f) && !TOKEN_FILES.has(f))
      .filter((f) => {
        const text = readFileSync(resolve(REPO, f), "utf8");
        // theme-color metas legitimately carry a media query per scheme
        return /prefers-color-scheme/.test(text.replace(/<meta name="theme-color"[^>]*>/g, ""));
      });
    expect(hits).toEqual([]);
  });
});
