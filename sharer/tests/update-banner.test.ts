// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  showBanner,
  hideBanner,
  attachBannerHandlers,
} from "../src/update-banner.js";

function mountBannerDom(): {
  banner: HTMLElement;
  versionEl: HTMLElement;
  dismissBtn: HTMLButtonElement;
  downloadBtn: HTMLButtonElement;
} {
  document.body.replaceChildren();
  const banner = document.createElement("div");
  banner.id = "update-banner";
  banner.className = "update-banner";
  const versionEl = document.createElement("span");
  versionEl.id = "update-banner-version";
  versionEl.textContent = "—";
  const downloadBtn = document.createElement("button");
  downloadBtn.id = "update-banner-download";
  const dismissBtn = document.createElement("button");
  dismissBtn.id = "update-banner-dismiss";
  banner.append(versionEl, downloadBtn, dismissBtn);
  document.body.append(banner);
  return { banner, versionEl, dismissBtn, downloadBtn };
}

describe("showBanner", () => {
  it("adds the visible class and writes the version into the placeholder", () => {
    const { banner, versionEl } = mountBannerDom();
    expect(banner.classList.contains("visible")).toBe(false);
    showBanner(banner, versionEl, "0.4.5");
    expect(banner.classList.contains("visible")).toBe(true);
    expect(versionEl.textContent).toBe("0.4.5");
  });

  it("is idempotent — second call doesn't double-toggle or duplicate text", () => {
    const { banner, versionEl } = mountBannerDom();
    showBanner(banner, versionEl, "0.4.5");
    showBanner(banner, versionEl, "0.4.6");
    expect(banner.classList.contains("visible")).toBe(true);
    expect(versionEl.textContent).toBe("0.4.6");
  });
});

describe("hideBanner", () => {
  it("removes the visible class", () => {
    const { banner, versionEl } = mountBannerDom();
    showBanner(banner, versionEl, "0.4.5");
    hideBanner(banner);
    expect(banner.classList.contains("visible")).toBe(false);
  });
});

describe("attachBannerHandlers", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("hides the banner when the dismiss button is clicked", () => {
    const { banner, versionEl, dismissBtn, downloadBtn } = mountBannerDom();
    showBanner(banner, versionEl, "0.4.5");
    attachBannerHandlers({
      banner,
      dismissBtn,
      downloadBtn,
      downloadUrl: "https://auffi.app/download/",
      openUrl: vi.fn(),
    });
    dismissBtn.click();
    expect(banner.classList.contains("visible")).toBe(false);
  });

  it("calls openUrl with the configured URL when the download button is clicked", () => {
    const { banner, dismissBtn, downloadBtn } = mountBannerDom();
    const openUrl = vi.fn();
    attachBannerHandlers({
      banner,
      dismissBtn,
      downloadBtn,
      downloadUrl: "https://auffi.app/download/",
      openUrl,
    });
    downloadBtn.click();
    expect(openUrl).toHaveBeenCalledWith("https://auffi.app/download/");
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-hide the banner when the download button is clicked — user can still dismiss explicitly after navigating away", () => {
    const { banner, versionEl, dismissBtn, downloadBtn } = mountBannerDom();
    showBanner(banner, versionEl, "0.4.5");
    attachBannerHandlers({
      banner,
      dismissBtn,
      downloadBtn,
      downloadUrl: "https://auffi.app/download/",
      openUrl: vi.fn(),
    });
    downloadBtn.click();
    expect(banner.classList.contains("visible")).toBe(true);
  });
});
