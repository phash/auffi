import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { JSDOM } from "jsdom";

const REPO = resolve(__dirname, "../..");
const BMC = "https://buymeacoffee.com/phash";
const PAYPAL = "https://www.paypal.com/paypalme/mroedig";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".html") ? [p] : [];
  });
}

// Static pages load the token copy themselves; the two SPA entry pages get
// the tokens through viewer/src/styles.css (Vite @import).
const STATIC = walk(join(REPO, "viewer/public")).map((p) => relative(REPO, p));
const ALL = ["viewer/index.html", "viewer/en/index.html", ...STATIC];

const dom = (rel: string) => new JSDOM(readFileSync(join(REPO, rel), "utf8")).window.document;

describe.each(STATIC)("static page %s", (rel) => {
  it("loads /tokens.css before /topbar-footer.css", () => {
    const hrefs = [...dom(rel).querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href"));
    const tokens = hrefs.indexOf("/tokens.css");
    expect(tokens).toBeGreaterThanOrEqual(0);
    expect(tokens).toBeLessThan(hrefs.indexOf("/topbar-footer.css"));
  });
});

describe.each(ALL)("page %s", (rel) => {
  const doc = dom(rel);
  const en = doc.documentElement.lang === "en";

  it("has the dark and light theme-color metas", () => {
    const metas = [...doc.querySelectorAll('meta[name="theme-color"]')].map((m) => [
      m.getAttribute("content"),
      m.getAttribute("media"),
    ]);
    expect(metas).toEqual([
      ["#0e1311", "(prefers-color-scheme: dark)"],
      ["#f3f6f4", "(prefers-color-scheme: light)"],
    ]);
  });

  it("has the coffee button in the topbar actions", () => {
    const btn = doc.querySelector<HTMLAnchorElement>("#top-bar .topbar-actions a#topbar-coffee");
    expect(btn?.getAttribute("href")).toBe(BMC);
    expect(btn?.getAttribute("target")).toBe("_blank");
    expect(btn?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(btn?.getAttribute("aria-label")).toBe(
      en ? "Buy me a coffee — support Auffi" : "Buy me a coffee — Auffi unterstützen",
    );
  });

  it("has both donation buttons in the footer and no old coffee text link", () => {
    const links = [...doc.querySelectorAll<HTMLAnchorElement>("#site-footer .footer-donate a.donate-btn")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([BMC, PAYPAL]);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(doc.querySelector(`#site-footer .legal-links a[href="${BMC}"]`)).toBeNull();
  });
});
