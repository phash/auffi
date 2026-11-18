import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

const REPO = resolve(__dirname, "../..");
const CSS = readFileSync(resolve(REPO, "viewer/src/styles.css"), "utf8");
const BMC = "https://buymeacoffee.com/phash";
const PAYPAL = "https://www.paypal.com/paypalme/mroedig";

const PAGES = [
  {
    file: "viewer/index.html",
    download: "/download/",
    donate:
      "Server, Relay und Domain zahlt ein einzelner Entwickler. Wenn Auffi dir geholfen hat, freut sich das Projekt über einen Kaffee.",
  },
  {
    file: "viewer/en/index.html",
    download: "/en/download/",
    donate:
      "One developer pays for the server, relay and domain. If Auffi helped you, the project appreciates a coffee.",
  },
];

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

describe.each(PAGES)("start page $file", ({ file, download, donate }) => {
  const html = readFileSync(resolve(REPO, file), "utf8");
  const doc = new JSDOM(html).window.document;

  it("puts the existing connect form into the left half of the entry box", () => {
    const help = doc.querySelector(".hero .entry > #app.entry-help");
    expect(help).not.toBeNull();
    expect(help!.querySelector("#code")).not.toBeNull();
    expect(help!.querySelector("#connect")).not.toBeNull();
    const first = doc.querySelector("input, button#connect");
    expect(first?.id).toBe("code");
  });

  it("offers the sharer download in the right half of the entry box", () => {
    const need = doc.querySelector(".hero .entry > .entry-need");
    expect(need).not.toBeNull();
    expect(need!.querySelector("a#hero-sharer-cta")?.getAttribute("href")).toBe(download);
    expect(need!.querySelector(`a[href="${download}#linux"]`)).not.toBeNull();
    const version = JSON.parse(
      doc.querySelector('script[type="application/ld+json"]')!.textContent!,
    );
    const softwareVersion = JSON.stringify(version).match(/"softwareVersion":"([^"]+)"/)![1];
    expect(norm(need!.querySelector(".entry-version")?.textContent)).toContain(softwareVersion);
  });

  it("drops the old 'oder / ask someone else' block", () => {
    expect(doc.querySelector(".hero-alt-cta")).toBeNull();
  });

  it("shows the flow diagram as one labelled image", () => {
    const svg = doc.querySelector("figure.flow svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(norm(svg?.getAttribute("aria-label")).length).toBeGreaterThan(10);
  });

  it("keeps the why-bento with the cross links", () => {
    const why = doc.querySelector("section.why");
    expect(why).not.toBeNull();
    expect(why!.querySelectorAll(".why-fact").length).toBe(4);
    expect(why!.querySelectorAll("a[href]").length).toBeGreaterThanOrEqual(7);
  });

  it("has the donation strip with the agreed text and both buttons", () => {
    const strip = doc.querySelector("section.support");
    expect(norm(strip?.querySelector("p")?.textContent)).toBe(donate);
    const hrefs = [...strip!.querySelectorAll("a.donate-btn")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([BMC, PAYPAL]);
  });

  it("invents no '<10 seconds' figure", () => {
    expect(html).not.toMatch(/&lt;\s*10 (Sekunden|seconds)|<\s*10 (Sekunden|seconds)/);
  });

  it("the flow, bento and strip sit inside the landing sections that hide while streaming", () => {
    for (const sel of ["figure.flow", "section.why", "section.support"])
      expect(doc.querySelector(`.landing-sections ${sel}`), sel).not.toBeNull();
  });
});

describe("start page CSS while a stream runs", () => {
  it("hides the download half of the entry box and the landing sections", () => {
    expect(CSS).toMatch(/body\.streaming \.entry-need\s*{\s*display:\s*none/);
    expect(CSS).toMatch(/body\.streaming \.landing-sections\s*{\s*display:\s*none/);
  });
});
