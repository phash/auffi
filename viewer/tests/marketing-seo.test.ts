import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import {
  computeServedHashes,
  caddyScriptSrcHashes,
  CADDYFILE_REL,
} from "../scripts/csp-hashes";

const REPO = resolve(__dirname, "../..");
const f = (p: string) => resolve(REPO, p);

// CSP hash parity: the recipe (which inline scripts hash to what) lives in
// scripts/csp-hashes.ts — the SAME module the `npm run csp:sync` regenerator
// uses, so the guard and the fixer can never disagree.

// --- Page registry ----------------------------------------------------------
type Page = { file: string; url: string; twin: string; lang: "de" | "en"; faqSync: boolean };
const BASE = "https://auffi.app";
const PAGES: Page[] = [
  // existing static marketing pages (baseline — already correct in repo)
  { file: "viewer/public/vergleich/index.html", url: `${BASE}/vergleich/`, twin: `${BASE}/en/compare/`, lang: "de", faqSync: true },
  { file: "viewer/public/en/compare/index.html", url: `${BASE}/en/compare/`, twin: `${BASE}/vergleich/`, lang: "en", faqSync: true },
  { file: "viewer/public/vergleich/teamviewer/index.html", url: `${BASE}/vergleich/teamviewer/`, twin: `${BASE}/en/compare/teamviewer/`, lang: "de", faqSync: false },
  { file: "viewer/public/en/compare/teamviewer/index.html", url: `${BASE}/en/compare/teamviewer/`, twin: `${BASE}/vergleich/teamviewer/`, lang: "en", faqSync: false },
  { file: "viewer/public/vergleich/anydesk/index.html", url: `${BASE}/vergleich/anydesk/`, twin: `${BASE}/en/compare/anydesk/`, lang: "de", faqSync: false },
  { file: "viewer/public/en/compare/anydesk/index.html", url: `${BASE}/en/compare/anydesk/`, twin: `${BASE}/vergleich/anydesk/`, lang: "en", faqSync: false },
  { file: "viewer/public/download/index.html", url: `${BASE}/download/`, twin: `${BASE}/en/download/`, lang: "de", faqSync: false },
  { file: "viewer/public/en/download/index.html", url: `${BASE}/en/download/`, twin: `${BASE}/download/`, lang: "en", faqSync: false },
  { file: "viewer/public/vergleich/teamviewer-kommerzielle-nutzung/index.html", url: `${BASE}/vergleich/teamviewer-kommerzielle-nutzung/`, twin: `${BASE}/en/compare/teamviewer-commercial-use/`, lang: "de", faqSync: true },
  { file: "viewer/public/en/compare/teamviewer-commercial-use/index.html", url: `${BASE}/en/compare/teamviewer-commercial-use/`, twin: `${BASE}/vergleich/teamviewer-kommerzielle-nutzung/`, lang: "en", faqSync: true },
  { file: "viewer/public/vergleich/rustdesk/index.html", url: `${BASE}/vergleich/rustdesk/`, twin: `${BASE}/en/compare/rustdesk/`, lang: "de", faqSync: true },
  { file: "viewer/public/en/compare/rustdesk/index.html", url: `${BASE}/en/compare/rustdesk/`, twin: `${BASE}/vergleich/rustdesk/`, lang: "en", faqSync: true },
  { file: "viewer/public/vergleich/chrome-remote-desktop/index.html", url: `${BASE}/vergleich/chrome-remote-desktop/`, twin: `${BASE}/en/compare/chrome-remote-desktop/`, lang: "de", faqSync: true },
  { file: "viewer/public/en/compare/chrome-remote-desktop/index.html", url: `${BASE}/en/compare/chrome-remote-desktop/`, twin: `${BASE}/vergleich/chrome-remote-desktop/`, lang: "en", faqSync: true },
  { file: "viewer/public/bildschirm-teilen-ohne-installation/index.html", url: `${BASE}/bildschirm-teilen-ohne-installation/`, twin: `${BASE}/en/screen-sharing-without-install/`, lang: "de", faqSync: true },
  { file: "viewer/public/en/screen-sharing-without-install/index.html", url: `${BASE}/en/screen-sharing-without-install/`, twin: `${BASE}/bildschirm-teilen-ohne-installation/`, lang: "en", faqSync: true },
  { file: "viewer/public/fernwartung-open-source/index.html", url: `${BASE}/fernwartung-open-source/`, twin: `${BASE}/en/open-source-remote-support/`, lang: "de", faqSync: true },
  { file: "viewer/public/en/open-source-remote-support/index.html", url: `${BASE}/en/open-source-remote-support/`, twin: `${BASE}/fernwartung-open-source/`, lang: "en", faqSync: true },
  { file: "viewer/public/fernwartung-kostenlos/index.html", url: `${BASE}/fernwartung-kostenlos/`, twin: `${BASE}/en/free-remote-support/`, lang: "de", faqSync: true },
  { file: "viewer/public/en/free-remote-support/index.html", url: `${BASE}/en/free-remote-support/`, twin: `${BASE}/fernwartung-kostenlos/`, lang: "en", faqSync: true },
];

function doc(page: Page): Document {
  return new JSDOM(readFileSync(f(page.file), "utf-8")).window.document;
}

describe("marketing pages — CSP hash parity", () => {
  it("Caddyfile script-src whitelists exactly the inline JSON-LD blocks that are served", () => {
    const computed = computeServedHashes(REPO);
    const caddy = caddyScriptSrcHashes(readFileSync(f(CADDYFILE_REL), "utf-8"));
    expect(caddy).toEqual(computed);
  });
});

describe("llms.txt lists the comparison surface (GEO)", () => {
  const llms = readFileSync(f("viewer/public/llms.txt"), "utf-8");
  const mustContain = [
    "https://auffi.app/vergleich/",
    "https://auffi.app/vergleich/teamviewer/",
    "https://auffi.app/vergleich/anydesk/",
    "https://auffi.app/vergleich/rustdesk/",
    "https://auffi.app/vergleich/chrome-remote-desktop/",
    "https://auffi.app/vergleich/teamviewer-kommerzielle-nutzung/",
    "https://auffi.app/bildschirm-teilen-ohne-installation/",
  ];
  for (const url of mustContain) {
    it(`mentions ${url}`, () => expect(llms).toContain(url));
  }
  it("states free for commercial use", () => {
    expect(llms.toLowerCase()).toContain("gewerblich");
  });
});

// --- Hub/spoke keyword targeting -------------------------------------------
// Search Console (2026-07-26) showed the hub /vergleich/ taking 190 impressions at
// position 51 for "teamviewer alternative" while its own spoke /vergleich/teamviewer/
// sat at position 8 with 3 impressions: the hub title led with the head term and every
// spoke title led with the near-zero-volume "Auffi vs X", so Google kept picking the
// hub. Contract: exactly one page per intent — the hub owns list intent, each spoke
// owns one "<tool> alternative" head term — and the hub passes equity down with
// exact-match anchors.
type Target = { path: string; lang: "de" | "en"; role: "hub" | "spoke"; keyword: string };

const TARGETS: Target[] = [
  { path: "/vergleich/", lang: "de", role: "hub", keyword: "fernwartungssoftware im vergleich" },
  { path: "/vergleich/teamviewer/", lang: "de", role: "spoke", keyword: "teamviewer alternative" },
  { path: "/vergleich/anydesk/", lang: "de", role: "spoke", keyword: "anydesk alternative" },
  { path: "/vergleich/rustdesk/", lang: "de", role: "spoke", keyword: "rustdesk alternative" },
  { path: "/vergleich/chrome-remote-desktop/", lang: "de", role: "spoke", keyword: "chrome remote desktop alternative" },
  { path: "/vergleich/teamviewer-kommerzielle-nutzung/", lang: "de", role: "spoke", keyword: "teamviewer kommerzielle nutzung" },
  { path: "/bildschirm-teilen-ohne-installation/", lang: "de", role: "spoke", keyword: "bildschirm teilen ohne installation" },
  { path: "/fernwartung-open-source/", lang: "de", role: "spoke", keyword: "fernwartung open source" },
  { path: "/fernwartung-kostenlos/", lang: "de", role: "spoke", keyword: "fernwartung kostenlos" },
  { path: "/en/compare/", lang: "en", role: "hub", keyword: "remote support software compared" },
  { path: "/en/compare/teamviewer/", lang: "en", role: "spoke", keyword: "teamviewer alternative" },
  { path: "/en/compare/anydesk/", lang: "en", role: "spoke", keyword: "anydesk alternative" },
  { path: "/en/compare/rustdesk/", lang: "en", role: "spoke", keyword: "rustdesk alternative" },
  { path: "/en/compare/chrome-remote-desktop/", lang: "en", role: "spoke", keyword: "chrome remote desktop alternative" },
  { path: "/en/compare/teamviewer-commercial-use/", lang: "en", role: "spoke", keyword: "teamviewer commercial use" },
  { path: "/en/screen-sharing-without-install/", lang: "en", role: "spoke", keyword: "screen sharing without installation" },
  { path: "/en/open-source-remote-support/", lang: "en", role: "spoke", keyword: "open source remote support" },
  { path: "/en/free-remote-support/", lang: "en", role: "spoke", keyword: "free remote support" },
];

const targetFile = (t: Target) => `viewer/public${t.path}index.html`;
const targetDoc = (t: Target) => new JSDOM(readFileSync(f(targetFile(t)), "utf-8")).window.document;

/** Case- and separator-insensitive so "TeamViewer-Alternative" matches "teamviewer alternative". */
const norm = (s: string) =>
  s.toLowerCase().replace(/[-–—_/&:,.?!"'|]/g, " ").replace(/\s+/g, " ").trim();

const titleOf = (t: Target) => norm(targetDoc(t).querySelector("title")?.textContent ?? "");
const h1Of = (t: Target) => norm(targetDoc(t).querySelector("h1")?.textContent ?? "");

describe("comparison cluster — hub/spoke keyword targeting", () => {
  for (const t of TARGETS) {
    describe(t.path, () => {
      it("title carries its own primary keyword", () => {
        expect(titleOf(t), `title of ${t.path}`).toContain(t.keyword);
      });

      it("h1 carries its own primary keyword", () => {
        expect(h1Of(t), `h1 of ${t.path}`).toContain(t.keyword);
      });

      it("does not claim another page's primary keyword in title or h1", () => {
        const foreign = TARGETS.filter(
          (o) => o.lang === t.lang && o.path !== t.path && !t.keyword.includes(o.keyword),
        );
        const title = titleOf(t);
        const h1 = h1Of(t);
        for (const o of foreign) {
          expect(title, `${t.path} title must not target ${o.path}`).not.toContain(o.keyword);
          expect(h1, `${t.path} h1 must not target ${o.path}`).not.toContain(o.keyword);
        }
      });
    });
  }

  for (const lang of ["de", "en"] as const) {
    const hub = TARGETS.find((t) => t.lang === lang && t.role === "hub")!;
    const spokes = TARGETS.filter((t) => t.lang === lang && t.role === "spoke");

    describe(`${hub.path} passes equity to its spokes`, () => {
      for (const spoke of spokes) {
        it(`links to ${spoke.path} with an anchor containing "${spoke.keyword}"`, () => {
          const anchors = Array.from(targetDoc(hub).querySelectorAll(`a[href="${spoke.path}"]`));
          expect(anchors.length, `hub links to ${spoke.path}`).toBeGreaterThan(0);
          const texts = anchors.map((a) => norm(a.textContent ?? ""));
          expect(texts.some((x) => x.includes(spoke.keyword)), `anchor texts: ${texts.join(" | ")}`).toBe(true);
        });
      }

      it("declares itself a list page via ItemList schema covering every spoke", () => {
        const schema = Array.from(targetDoc(hub).querySelectorAll('script[type="application/ld+json"]'))
          .map((s) => JSON.parse(s.textContent ?? "{}"))
          .find((j) => j["@type"] === "ItemList");
        expect(schema, "ItemList schema present").toBeTruthy();
        const urls = schema.itemListElement.map((e: { url: string }) => e.url);
        for (const spoke of spokes) expect(urls).toContain(`${BASE}${spoke.path}`);
      });
    });

    describe(`${hub.path} spokes link back`, () => {
      for (const spoke of spokes) {
        it(`${spoke.path} links up to the hub`, () => {
          const up = targetDoc(spoke).querySelectorAll(`a[href="${hub.path}"]`);
          expect(up.length, `${spoke.path} → ${hub.path}`).toBeGreaterThan(0);
        });
      }

      // Search engines render breadcrumbs from this markup; a middle crumb
      // that points at the spoke itself loses the hub link exactly where it
      // matters most.
      for (const spoke of spokes.filter((s) => s.path.startsWith(hub.path))) {
        it(`${spoke.path} BreadcrumbList routes the middle crumb to the hub`, () => {
          const crumbs = Array.from(targetDoc(spoke).querySelectorAll('script[type="application/ld+json"]'))
            .map((s) => JSON.parse(s.textContent ?? "{}"))
            .find((j) => j["@type"] === "BreadcrumbList");
          expect(crumbs, "BreadcrumbList schema present").toBeTruthy();
          const items = crumbs.itemListElement as Array<{ position: number; item: string }>;
          expect(items).toHaveLength(3);
          expect(items[1].item).toBe(`${BASE}${hub.path}`);
          expect(items[2].item).toBe(`${BASE}${spoke.path}`);
        });
      }
    });
  }
});

// --- Hub/spoke authority balance -------------------------------------------
// Search Console (2026-08-25) showed the split from the 2026-07-26 title fix had not
// landed: the hub /vergleich/ still drew 509 impressions at position 51 with 0 clicks
// while its spoke /vergleich/teamviewer/ sat at position 7 with 4 impressions. The
// body text explained why — the hub ran 998 words and said "TeamViewer-Alternative"
// three times; the spoke ran 486 words and said it once. Google was picking the
// stronger page, and that was the hub. Contract: for its own head term the spoke must
// be both the heavier page and the one that says it more often.
// A spoke below this is a stub that Google will pass over for the hub; the hub is
// allowed to run longer than its spokes — it legitimately carries an 8-tool table —
// but not so much longer that it becomes the better answer for a spoke's head term.
const SPOKE_MIN_WORDS = 700;
const HUB_MAX_RATIO = 1.3;

const mainOf = (t: Target) => targetDoc(t).querySelector("main");
const bodyTextOf = (t: Target) => norm(mainOf(t)?.textContent ?? "");
const wordsOf = (t: Target) => bodyTextOf(t).split(" ").filter(Boolean).length;
const keywordHitsOf = (t: Target, keyword: string) =>
  bodyTextOf(t).split(norm(keyword)).length - 1;

describe("comparison cluster — the spoke outweighs its hub", () => {
  for (const lang of ["de", "en"] as const) {
    const hub = TARGETS.find((t) => t.lang === lang && t.role === "hub")!;
    const spokes = TARGETS.filter((t) => t.lang === lang && t.role === "spoke");

    it(`${hub.path} does not dwarf its thinnest spoke`, () => {
      const thinnest = Math.min(...spokes.map(wordsOf));
      expect(
        wordsOf(hub),
        `hub ${wordsOf(hub)} words vs thinnest spoke ${thinnest}`,
      ).toBeLessThanOrEqual(Math.round(thinnest * HUB_MAX_RATIO));
    });

    for (const spoke of spokes) {
      describe(spoke.path, () => {
        it(`says "${spoke.keyword}" in its body more often than ${hub.path} does`, () => {
          const mine = keywordHitsOf(spoke, spoke.keyword);
          const hubs = keywordHitsOf(hub, spoke.keyword);
          expect(mine, `${spoke.path} must use its own head term`).toBeGreaterThan(0);
          expect(
            mine,
            `${spoke.path} says it ${mine}x, hub says it ${hubs}x`,
          ).toBeGreaterThan(hubs);
        });

        it("carries enough body text to stand on its own", () => {
          const mine = wordsOf(spoke);
          expect(mine, `${spoke.path} has ${mine} words`).toBeGreaterThanOrEqual(SPOKE_MIN_WORDS);
        });
      });
    }
  }
});

describe("marketing pages — on-page SEO invariants", () => {
  for (const page of PAGES) {
    describe(page.url, () => {
      it("file exists", () => expect(existsSync(f(page.file)), page.file).toBe(true));

      it("canonical equals its own URL", () => {
        const c = doc(page).querySelector('link[rel="canonical"]')?.getAttribute("href");
        expect(c).toBe(page.url);
      });

      it("has reciprocal hreflang (self, twin, x-default→de)", () => {
        const d = doc(page);
        const alts = Array.from(d.querySelectorAll('link[rel="alternate"][hreflang]')).map((l) => ({
          lang: l.getAttribute("hreflang"),
          href: l.getAttribute("href"),
        }));
        const self = page.url;
        const twin = page.twin;
        const de = page.lang === "de" ? self : twin;
        expect(alts).toEqual(
          expect.arrayContaining([
            { lang: "de", href: de },
            { lang: "en", href: page.lang === "en" ? self : twin },
            { lang: "x-default", href: de },
          ]),
        );
      });

      it("has a non-empty title and a non-trivial description", () => {
        const d = doc(page);
        const title = d.querySelector("title")?.textContent?.trim() ?? "";
        const desc = d.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ?? "";
        expect(title.length).toBeGreaterThan(10);
        // No upper bound: the existing pages deliberately run 200–270 chars.
        // Google truncates the SERP snippet; over-length is not an error.
        expect(desc.length).toBeGreaterThanOrEqual(50);
      });

      it("is listed in sitemap.xml and indexnow-ping.sh", () => {
        const sitemap = readFileSync(f("viewer/public/sitemap.xml"), "utf-8");
        const indexnow = readFileSync(f("ops/indexnow-ping.sh"), "utf-8");
        expect(sitemap, "sitemap").toContain(`<loc>${page.url}</loc>`);
        expect(indexnow, "indexnow").toContain(`"${page.url}"`);
      });

      if (page.faqSync) {
        it("every visible FAQ <h3>/<p> pair matches the FAQPage schema verbatim", () => {
          const d = doc(page);
          const schema = Array.from(d.querySelectorAll('script[type="application/ld+json"]'))
            .map((s) => JSON.parse(s.textContent ?? "{}"))
            .find((j) => j["@type"] === "FAQPage");
          expect(schema, "FAQPage schema present").toBeTruthy();
          const pairs = new Map<string, string>();
          for (const q of schema.mainEntity) pairs.set(q.name.trim(), q.acceptedAnswer.text.trim());
          const faqSection = Array.from(d.querySelectorAll("section")).find((s) =>
            /Häufige Fragen|Frequently asked|FAQ/i.test(s.querySelector("h2")?.textContent ?? ""),
          );
          expect(faqSection, "visible FAQ section present").toBeTruthy();
          const h3s = Array.from(faqSection!.querySelectorAll("h3"));
          expect(h3s.length).toBeGreaterThan(0);
          for (const h3 of h3s) {
            const q = (h3.textContent ?? "").trim();
            const a = (h3.nextElementSibling?.textContent ?? "").trim();
            expect(pairs.has(q), `schema has question: ${q}`).toBe(true);
            expect(pairs.get(q)).toBe(a);
          }
        });
      }
    });
  }
});

// --- CSP style-src parity -----------------------------------------------------
// The Caddyfile sends `style-src 'self'` for every page, so an inline <style>
// block is silently dropped in production (the comparison tables shipped
// unstyled for weeks that way). Styles belong in a file the page links.
describe("static pages — CSP style-src 'self'", () => {
  const caddy = readFileSync(f(CADDYFILE_REL), "utf8");
  it("the Caddyfile still forbids inline styles (or this guard is moot)", () => {
    expect(caddy).toMatch(/style-src 'self'[;"]/);
  });

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = resolve(dir, e.name);
      return e.isDirectory() ? walk(p) : p.endsWith(".html") ? [p] : [];
    });
  const pages = [f("viewer/index.html"), f("viewer/en/index.html"), ...walk(f("viewer/public"))];
  it("covers the marketing surface", () => {
    expect(pages.length).toBeGreaterThan(20);
  });
  for (const page of pages) {
    it(`${page.slice(REPO.length + 1)} has no inline <style> block`, () => {
      expect(readFileSync(page, "utf8")).not.toMatch(/<style[\s>]/);
    });
  }
});
