import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// The Datenschutzerklärung is a legal document that has to describe what the
// backend actually does. These pins tie its wording to the live processing
// steps that have drifted before: the GeoIP country lookup on the full viewer
// IP (backend/src/geoip.ts), the immediate hard-delete of accounts
// (migration 0013 dropped the never-wired soft-delete), and the Matomo
// consent script being loaded on every static page, not just four.

const html = readFileSync(resolve(__dirname, "../public/datenschutz/index.html"), "utf-8");
const doc = new JSDOM(html).window.document;

function sectionText(headingPrefix: string): string {
  const heading = Array.from(doc.querySelectorAll("h2")).find((h) =>
    (h.textContent ?? "").trim().startsWith(headingPrefix),
  );
  if (!heading) throw new Error(`no section starting with "${headingPrefix}"`);
  return (heading.closest("section")?.textContent ?? "").replace(/\s+/g, " ");
}

describe("Datenschutzerklärung matches the live processing", () => {
  it("§5 discloses the GeoIP country lookup on the full viewer IP", () => {
    const s5 = sectionText("5.");
    expect(s5).toContain("Herkunftsland");
    expect(s5).toContain("DB-IP");
    expect(s5).toContain("vollständigen IP-Adresse");
    expect(s5).toContain("Art. 6 Abs. 1 lit. f");
    // The old wording implied the truncated prefix is all that is ever used.
    expect(s5).not.toMatch(/wird nur das gekürzte IP-Prefix \(84\.xxx\) angezeigt, nie die volle Adresse/);
  });

  it("§6 retention describes the immediate account hard-delete, not a 30-day grace", () => {
    const s6 = sectionText("6.");
    expect(s6).not.toContain("Soft-gelöschte Konten");
    expect(s6).not.toMatch(/30 Tage Karenz/);
    expect(s6).toMatch(/Konto-Löschung: sofort/);
  });

  it("§9 covers every static page that loads the consent script", () => {
    const s9 = sectionText("9. Reichweitenmessung");
    expect(s9).not.toMatch(/Aufrufe der statischen Seiten — Startseite, Impressum, Datenschutz, Download/);
    expect(s9).toMatch(/Vergleichs/);
    expect(s9).toMatch(/nicht die laufende Sitzung/);
  });

  it("carries a current 'Stand' date", () => {
    expect(html).not.toContain("Stand: Mai 2026");
    expect(html).toMatch(/Stand: September 2026/);
  });
});
