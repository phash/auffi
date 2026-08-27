import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// Guards for the SoftwareApplication JSON-LD and the landing-page download
// links (review 2026-08): the structured data must not claim platforms we
// don't ship (no macOS build exists — capture/mod.rs has only Linux/Windows
// arms), and the landing pages' installer links must not lag behind the
// version the JSON-LD announces (they drifted to a deleted 0.5.0 release
// while /download/ served the current one).

type LdNode = { "@type"?: string; "@graph"?: LdNode[]; [key: string]: unknown };

const PAGES: Record<string, string> = {
  "landing (de)": "../index.html",
  "landing (en)": "../en/index.html",
  "download (de)": "../public/download/index.html",
  "download (en)": "../public/en/download/index.html",
};

function pageDoc(rel: string): Document {
  const html = readFileSync(resolve(__dirname, rel), "utf-8");
  return new JSDOM(html).window.document;
}

function softwareApp(doc: Document): LdNode {
  const scripts = Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  );
  for (const script of scripts) {
    const data = JSON.parse(script.textContent ?? "null") as LdNode | null;
    if (!data) continue;
    const graph = Array.isArray(data["@graph"]) ? data["@graph"] : [data];
    for (const node of graph) {
      if (node["@type"] === "SoftwareApplication") return node;
    }
  }
  throw new Error("no SoftwareApplication JSON-LD found");
}

function downloadAssets(doc: Document): string[] {
  return Array.from(
    doc.querySelectorAll<HTMLAnchorElement>('a[href*="/api/downloads/file/"]'),
  ).map((a) => {
    const href = a.getAttribute("href") ?? "";
    return href.slice(href.lastIndexOf("/") + 1);
  });
}

/** Asset filename with any `?tag=` pin stripped. */
const assetName = (asset: string) => asset.split("?")[0];

/** The `?tag=vX.Y.Z` pin on an asset link, if it carries one. */
const assetTag = (asset: string) => /[?&]tag=v?(\d+\.\d+\.\d+)/.exec(asset)?.[1];

describe("marketing pages: JSON-LD claims", () => {
  for (const [name, rel] of Object.entries(PAGES)) {
    it(`${name} claims only shipped operating systems`, () => {
      expect(softwareApp(pageDoc(rel)).operatingSystem).toBe("Linux, Windows");
    });
  }
});

describe("landing pages: download links stay consistent", () => {
  it("DE and EN landing pages link the same download assets", () => {
    expect(downloadAssets(pageDoc("../index.html"))).toEqual(
      downloadAssets(pageDoc("../en/index.html")),
    );
  });

  // Every page that links installers, not just the landing pages: /download/
  // was outside this loop, so a half-finished version bump there — some
  // buttons on the new release, some still on the old — shipped silently and
  // 404ed for whichever half lagged.
  for (const name of Object.keys(PAGES)) {
    it(`${name}: every linked asset is versioned and matches the JSON-LD softwareVersion`, () => {
      const doc = pageDoc(PAGES[name]);
      const declared = softwareApp(doc).softwareVersion;
      const assets = downloadAssets(doc);
      expect(assets.length).toBeGreaterThan(0);
      for (const asset of assets) {
        const version = /[_-](\d+\.\d+\.\d+)[_-]/.exec(assetName(asset))?.[1];
        expect(version, `${asset} carries no version`).toBeDefined();
        expect(version, `${asset} lags the declared ${declared}`).toBe(declared);
      }
    });

    it(`${name}: any ?tag= pin matches the asset it pins`, () => {
      // The portable exe is tag-pinned because it is not latest-tracked. A pin
      // left on the previous release turns the button into a 404 for the new
      // asset name.
      const assets = downloadAssets(pageDoc(PAGES[name]));
      for (const asset of assets) {
        const tag = assetTag(asset);
        if (!tag) continue;
        const version = /[_-](\d+\.\d+\.\d+)[_-]/.exec(assetName(asset))?.[1];
        expect(tag, `${asset}: tag pin and filename disagree`).toBe(version);
      }
    });
  }
});
