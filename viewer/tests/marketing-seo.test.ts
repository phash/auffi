import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";

const REPO = resolve(__dirname, "../..");
const f = (p: string) => resolve(REPO, p);

// --- CSP hash parity (mirrors the one-liner in caddy/Caddyfile) -------------
function inlineScriptHashes(absFile: string): string[] {
  const html = readFileSync(absFile, "utf-8");
  const out: string[] = [];
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const inner = m[1];
    if (inner.trim() === "" || inner.slice(0, 60).includes("src=")) continue;
    out.push("sha256-" + createHash("sha256").update(inner, "utf-8").digest("base64"));
  }
  return out;
}

// Recursively collect every index.html under a directory (mirrors the
// one-liner's `viewer/public/**/index.html` glob without relying on a
// specific Node fs.globSync availability).
function walkIndexHtml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkIndexHtml(p));
    else if (entry.name === "index.html") out.push(p);
  }
  return out;
}

function allServedPages(): string[] {
  return [
    f("viewer/index.html"),
    f("viewer/en/index.html"),
    ...walkIndexHtml(f("viewer/public")),
  ];
}

function computedHashSet(): Set<string> {
  const s = new Set<string>();
  for (const file of allServedPages()) for (const h of inlineScriptHashes(file)) s.add(h);
  return s;
}

function caddyHashSet(): Set<string> {
  const caddy = readFileSync(f("caddy/Caddyfile"), "utf-8");
  const line = caddy.split("\n").find((l) => l.includes("Content-Security-Policy")) ?? "";
  return new Set([...line.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((x) => x[1]));
}

// --- Page registry ----------------------------------------------------------
type Page = { file: string; url: string; twin: string; lang: "de" | "en"; faqSync: boolean };
const BASE = "https://auffi.app";
const PAGES: Page[] = [
  // existing static marketing pages (baseline — already correct in repo)
  { file: "viewer/public/vergleich/index.html", url: `${BASE}/vergleich/`, twin: `${BASE}/en/compare/`, lang: "de", faqSync: false },
  { file: "viewer/public/en/compare/index.html", url: `${BASE}/en/compare/`, twin: `${BASE}/vergleich/`, lang: "en", faqSync: false },
  { file: "viewer/public/vergleich/teamviewer/index.html", url: `${BASE}/vergleich/teamviewer/`, twin: `${BASE}/en/compare/teamviewer/`, lang: "de", faqSync: false },
  { file: "viewer/public/en/compare/teamviewer/index.html", url: `${BASE}/en/compare/teamviewer/`, twin: `${BASE}/vergleich/teamviewer/`, lang: "en", faqSync: false },
  { file: "viewer/public/vergleich/anydesk/index.html", url: `${BASE}/vergleich/anydesk/`, twin: `${BASE}/en/compare/anydesk/`, lang: "de", faqSync: false },
  { file: "viewer/public/en/compare/anydesk/index.html", url: `${BASE}/en/compare/anydesk/`, twin: `${BASE}/vergleich/anydesk/`, lang: "en", faqSync: false },
  { file: "viewer/public/download/index.html", url: `${BASE}/download/`, twin: `${BASE}/en/download/`, lang: "de", faqSync: false },
  { file: "viewer/public/en/download/index.html", url: `${BASE}/en/download/`, twin: `${BASE}/download/`, lang: "en", faqSync: false },
  // NEW pages are appended here by Tasks 2–5.
];

function doc(page: Page): Document {
  return new JSDOM(readFileSync(f(page.file), "utf-8")).window.document;
}

describe("marketing pages — CSP hash parity", () => {
  it("Caddyfile script-src whitelists exactly the inline JSON-LD blocks that are served", () => {
    const computed = [...computedHashSet()].sort();
    const caddy = [...caddyHashSet()].sort();
    expect(caddy).toEqual(computed);
  });
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
