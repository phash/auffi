import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { execPublicScript } from "./helpers/exec-public-script";

// The help copy lives in two places by necessity: the app modal markup in
// index.html / en/index.html (Vite bundle) and the standalone
// help-overlay.js (static pages, which can't import the bundle). This
// guard runs the overlay for both languages and fails if section titles OR
// body copy drift from the app modal, so security/usage claims (TTL,
// rate-limit, DTLS) can't silently disagree between the app and the
// static pages.

interface HelpSection {
  q: string;
  a: string;
}

function normalize(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function sectionsOf(root: ParentNode): HelpSection[] {
  return Array.from(root.querySelectorAll("#help-modal .help-section")).map(
    (section) => ({
      q: normalize(section.querySelector("summary")?.textContent),
      a: normalize(section.querySelector("p")?.textContent),
    }),
  );
}

function appSections(lang: "de" | "en"): HelpSection[] {
  const file = lang === "de" ? "../index.html" : "../en/index.html";
  const html = readFileSync(resolve(__dirname, file), "utf-8");
  return sectionsOf(new JSDOM(html).window.document);
}

function overlaySections(lang: "de" | "en"): HelpSection[] {
  document.documentElement.lang = lang;
  const topbar = document.createElement("header");
  topbar.id = "top-bar";
  const actions = document.createElement("nav");
  actions.className = "topbar-actions";
  topbar.appendChild(actions);
  document.body.appendChild(topbar);
  execPublicScript("help-overlay.js");
  return sectionsOf(document);
}

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.lang = "de";
});

describe("help content stays in sync (app modal ↔ static overlay)", () => {
  for (const lang of ["de", "en"] as const) {
    it(`${lang}: section titles and body copy match between the app modal and help-overlay.js`, () => {
      const app = appSections(lang);
      expect(app).toHaveLength(5);
      expect(overlaySections(lang)).toEqual(app);
    });
  }
});
