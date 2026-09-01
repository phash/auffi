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

/// Asset links that must track the current release.
///
/// Excludes the previous-release fallback block, whose whole purpose is to
/// point at an older version — it is checked separately, and by its own
/// version, in "the previous release stays reachable" below. Scoping it here
/// rather than at each call site means a new consumer of this helper cannot
/// forget the exemption and start reporting the fallback as drift.
function downloadAssets(doc: Document): string[] {
  return Array.from(
    doc.querySelectorAll<HTMLAnchorElement>('a[href*="/api/downloads/file/"]'),
  )
    .filter((a) => !a.closest("[data-previous-release]"))
    .map((a) => {
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

    it(`${name}: every asset link is tag-pinned`, () => {
      // The proxy default resolves releases/latest/download/<asset>, but the
      // filename embeds the version — so an unpinned link is only valid while
      // `latest` still points at that exact release. CI promotes the new
      // release to latest before the bumped page is deployed, which 502'd
      // every unpinned button for the whole window in between.
      const assets = downloadAssets(pageDoc(PAGES[name]));
      for (const asset of assets) {
        expect(assetTag(asset), `${asset} is not tag-pinned`).toBeDefined();
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

// The version bump rewrites the download pages with a blanket string replace,
// which silently dragged the newest changelog heading along with it: after
// three releases the page announced "0.6.7 (2026-07-02)" above 0.6.4's release
// notes, and 0.6.5/0.6.6/0.6.7 were undocumented. Shipping assets for a
// version without saying what changed in it is the defect; pin that.
describe("download pages document every version they ship", () => {
  const shipped = (): string[] => {
    const src = readFileSync(resolve(__dirname, "../../backend/src/downloads/handlers.ts"), "utf-8");
    return [...new Set(Array.from(src.matchAll(/Auffi[_-](\d+\.\d+\.\d+)/g)).map((m) => m[1]))];
  };
  const changelog = (rel: string): string[] =>
    Array.from(pageDoc(rel).querySelectorAll("h3"))
      .map((h) => /^(\d+\.\d+\.\d+)\s*\(/.exec((h.textContent ?? "").trim())?.[1])
      .filter((v): v is string => v !== undefined);

  for (const [name, rel] of [
    ["download (de)", "../public/download/index.html"],
    ["download (en)", "../public/en/download/index.html"],
  ] as const) {
    it(`${name}: every version in KNOWN_ASSETS has release notes`, () => {
      const documented = new Set(changelog(rel));
      const missing = shipped().filter((v) => !documented.has(v));
      expect(missing, `undocumented shipped versions: ${missing.join(", ")}`).toEqual([]);
    });

    it(`${name}: the newest entry is the version the page advertises`, () => {
      const declared = softwareApp(pageDoc(rel)).softwareVersion;
      expect(changelog(rel)[0], "top changelog entry must be the current release").toBe(declared);
    });

    it(`${name}: no two entries claim the same version`, () => {
      const all = changelog(rel);
      expect(all.length, "duplicate version headings").toBe(new Set(all).size);
    });
  }
});

// The bump script rewrites href= and the JSON-LD softwareVersion, and nothing
// else. Everything a reader is told to *type* — `msiexec /i Auffi_X.Y.Z…`,
// `dpkg -i`, `rpm -i`, the AppImage chmod — plus the version badge and the
// release-notes tag link stayed on the previous release, so the page handed
// out a 0.6.9 download alongside a 0.6.7 install command. Prose is part of the
// release, not decoration around it.
describe("download pages: prose and links follow the shipped version", () => {
  for (const [name, rel] of [
    ["download (de)", "../public/download/index.html"],
    ["download (en)", "../public/en/download/index.html"],
  ] as const) {
    it(`${name}: no element outside the changelog names an older version`, () => {
      const doc = pageDoc(rel);
      const current = softwareApp(doc).softwareVersion;
      // The changelog is one place older versions legitimately appear.
      for (const h of Array.from(doc.querySelectorAll("h3"))) {
        if (/^\d+\.\d+\.\d+\s*\(/.test((h.textContent ?? "").trim())) {
          h.closest("li, section, div, article")?.remove();
        }
      }
      // The fallback block is the other. It is removed by its own marker
      // rather than by "anything that mentions an old version", so drift
      // anywhere else on the page still fails this test.
      doc.querySelector("[data-previous-release]")?.remove();
      const stale = new Set(
        Array.from((doc.body.textContent ?? "").matchAll(/\b(\d+\.\d+\.\d+)\b/g))
          .map((m) => m[1])
          .filter((v) => v !== current),
      );
      expect([...stale], `stale versions in prose (current ${current})`).toEqual([]);
    });

    it(`${name}: every release-notes link points at the shipped tag`, () => {
      const doc = pageDoc(rel);
      const current = softwareApp(doc).softwareVersion;
      const doc2 = pageDoc(rel);
      doc2.querySelector("[data-previous-release]")?.remove();
      const wrong = Array.from(doc2.querySelectorAll<HTMLAnchorElement>("a[href*='/releases/tag/']"))
        .map((a) => a.href)
        .filter((h) => !h.endsWith(`/releases/tag/v${current}`));
      expect(wrong, "release-notes links must follow the bump").toEqual([]);
    });
  }
});

// A release that changes how streaming behaves needs a way back that a
// non-technical helper can find. 0.7.0 replaces the fixed send rate with
// congestion control, and that had never run against a real link when it
// shipped — so the previous build stays one click away rather than only
// reachable by digging through GitHub's release list.
describe("download pages: the previous release stays reachable", () => {
  const KINDS = ["x64-setup.exe", "x64_portable.exe", "x64_en-US.msi", "amd64.deb", "x86_64.rpm", "amd64.AppImage"];

  for (const [name, rel] of [
    ["download (de)", "../public/download/index.html"],
    ["download (en)", "../public/en/download/index.html"],
  ] as const) {
    const block = () => {
      const el = pageDoc(rel).querySelector("[data-previous-release]");
      if (!el) throw new Error("no [data-previous-release] block on the page");
      return el;
    };

    it(`${name}: offers the previous version the backend still serves`, () => {
      const version = block().getAttribute("data-previous-release");
      const src = readFileSync(resolve(__dirname, "../../backend/src/downloads/handlers.ts"), "utf-8");
      const shipped = [...new Set(Array.from(src.matchAll(/Auffi[_-](\d+\.\d+\.\d+)/g)).map((m) => m[1]))];
      // Second entry: the newest is the current release, the one below it is
      // what the fallback must point at. Offering a version the allow-list
      // dropped would 404 every button in the block.
      expect(version, `KNOWN_ASSETS order: ${shipped.join(", ")}`).toBe(shipped[1]);
    });

    it(`${name}: every fallback link is tag-pinned to that version`, () => {
      const version = block().getAttribute("data-previous-release");
      const hrefs = Array.from(block().querySelectorAll<HTMLAnchorElement>("a[href*='/api/downloads/file/']"))
        .map((a) => a.getAttribute("href") ?? "");
      // Pinning matters more here than for the current release: the previous
      // version is by definition not what /releases/latest resolves to.
      for (const href of hrefs) {
        expect(href, `${href} must name ${version}`).toContain(version);
        expect(href, `${href} must be tag-pinned`).toContain(`?tag=v${version}`);
      }
      expect(hrefs.length, "one link per package kind").toBe(KINDS.length);
    });

    it(`${name}: covers every package kind the current release offers`, () => {
      const hrefs = Array.from(block().querySelectorAll<HTMLAnchorElement>("a[href*='/api/downloads/file/']"))
        .map((a) => a.getAttribute("href") ?? "");
      for (const kind of KINDS) {
        expect(hrefs.some((h) => h.includes(kind)), `no fallback for ${kind}`).toBe(true);
      }
    });
  }
});
