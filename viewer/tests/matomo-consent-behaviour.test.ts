import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execPublicScript } from "./helpers/exec-public-script";
import { stubLocalStorage } from "./helpers/local-storage-stub";

// The consent × DNT decision table lives only in the vanilla
// public/matomo-consent.js (the static pages cannot import the Vite
// bundle), so it is pinned by executing that file under each of the four
// input combinations and observing what it does: inject matomo.js, show
// the banner, or stay silent.

type MatomoWindow = Window & { doNotTrack?: string; __matomoLoaded?: boolean; _paq?: unknown[] };
const win = window as MatomoWindow;

const banner = (): HTMLElement | null => document.getElementById("matomo-consent-banner");
const matomoScript = (): HTMLScriptElement | null =>
  document.head.querySelector('script[src$="matomo.js"]');

let store: Map<string, string>;

beforeEach(() => {
  store = stubLocalStorage();
  document.body.innerHTML = "";
  document.documentElement.lang = "de";
});

afterEach(() => {
  matomoScript()?.remove();
  document.body.innerHTML = "";
  document.body.classList.remove("matomo-consent-shown");
  delete win.doNotTrack;
  delete win.__matomoLoaded;
  delete win._paq;
});

describe("matomo-consent.js decision table", () => {
  it("Do-Not-Track wins over any stored consent: no banner, no Matomo", () => {
    win.doNotTrack = "1";
    store.set("auffi_matomo_consent", "ok");
    execPublicScript("matomo-consent.js");
    expect(banner()).toBeNull();
    expect(matomoScript()).toBeNull();
  });

  it("stored 'ok' loads Matomo cookieless without a banner", () => {
    store.set("auffi_matomo_consent", "ok");
    execPublicScript("matomo-consent.js");
    expect(banner()).toBeNull();
    expect(matomoScript()?.src).toBe("https://musikersuche.org/matomo/matomo.js");
    expect(win._paq).toContainEqual(["disableCookies"]);
    expect(win._paq).toContainEqual(["trackPageView"]);
  });

  it("stored 'no' stays silent: no banner (no nagging), no Matomo", () => {
    store.set("auffi_matomo_consent", "no");
    execPublicScript("matomo-consent.js");
    expect(banner()).toBeNull();
    expect(matomoScript()).toBeNull();
  });

  it("unknown consent shows the banner and loads Matomo only after 'Statistik OK'", () => {
    execPublicScript("matomo-consent.js");
    expect(banner()).not.toBeNull();
    expect(matomoScript()).toBeNull();
    expect(document.body.classList.contains("matomo-consent-shown")).toBe(true);

    banner()!.querySelector<HTMLButtonElement>(".matomo-consent-ok")!.click();
    expect(store.get("auffi_matomo_consent")).toBe("ok");
    expect(banner()).toBeNull();
    expect(document.body.classList.contains("matomo-consent-shown")).toBe(false);
    expect(matomoScript()).not.toBeNull();
  });
});
