import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
