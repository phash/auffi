import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execPublicScript } from "./helpers/exec-public-script";
import { stubLocalStorage } from "./helpers/local-storage-stub";

// matomo-consent.js is loaded by German AND English marketing pages. An
// opt-in banner is only informed consent if the visitor can read it, so
// the copy must follow <html lang> like help-overlay.js does (review
// 2026-08). The decision table itself is pinned by
// matomo-consent-decision.test.ts.

function showBanner(lang: "de" | "en"): HTMLElement {
  document.documentElement.lang = lang;
  execPublicScript("matomo-consent.js");
  const banner = document.getElementById("matomo-consent-banner");
  expect(banner).not.toBeNull();
  return banner as HTMLElement;
}

beforeEach(() => {
  stubLocalStorage();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.lang = "de";
});

describe("matomo consent banner language", () => {
  it("renders German copy on German pages", () => {
    const banner = showBanner("de");
    expect(banner.getAttribute("aria-label")).toBe(
      "Datenschutz-Hinweis zur Reichweitenmessung",
    );
    expect(banner.querySelector(".matomo-consent-text")?.textContent).toContain(
      "Wir messen anonym",
    );
    expect(banner.querySelector(".matomo-consent-link")?.textContent).toBe(
      "Mehr Info",
    );
    expect(banner.querySelector(".matomo-consent-no")?.textContent).toBe(
      "Ablehnen",
    );
    expect(banner.querySelector(".matomo-consent-ok")?.textContent).toBe(
      "Statistik OK",
    );
  });

  it("renders English copy on English pages", () => {
    const banner = showBanner("en");
    expect(banner.getAttribute("aria-label")).toBe(
      "Privacy notice about anonymous usage statistics",
    );
    expect(banner.querySelector(".matomo-consent-text")?.textContent).toContain(
      "We measure anonymously",
    );
    expect(banner.querySelector(".matomo-consent-link")?.textContent).toBe(
      "More info",
    );
    expect(banner.querySelector(".matomo-consent-no")?.textContent).toBe(
      "Decline",
    );
    expect(banner.querySelector(".matomo-consent-ok")?.textContent).toBe(
      "Allow statistics",
    );
  });

  it("declining stores the decision and removes the banner in any language", () => {
    const banner = showBanner("en");
    banner.querySelector<HTMLButtonElement>(".matomo-consent-no")?.click();
    expect(localStorage.getItem("auffi_matomo_consent")).toBe("no");
    expect(document.getElementById("matomo-consent-banner")).toBeNull();
  });
});
