import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execPublicScript } from "./helpers/exec-public-script";

// download/counts.js decorates the download lists on BOTH the German and
// the English download page, so the badge copy must follow <html lang>
// like help-overlay.js does (review 2026-08).

const ASSET = "Auffi_9.9.9_x64-setup.exe";

async function badgeText(
  lang: "de" | "en",
  count: number,
): Promise<string | null> {
  document.documentElement.lang = lang;
  const item = document.createElement("li");
  item.className = "download-item";
  const meta = document.createElement("div");
  meta.className = "download-meta";
  item.appendChild(meta);
  const link = document.createElement("a");
  link.className = "download-btn";
  link.href = `/api/downloads/file/${ASSET}`;
  item.appendChild(link);
  document.body.appendChild(item);

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ counts: { [ASSET]: count } }),
    }),
  );
  execPublicScript("download/counts.js");
  await vi.waitFor(() => {
    expect(meta.querySelector(".download-count")).not.toBeNull();
  });
  return meta.querySelector(".download-count")?.textContent ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.lang = "de";
});

describe("download count badge language", () => {
  it("formats German copy on German pages", async () => {
    expect(await badgeText("de", 0)).toBe("Noch kein Download");
  });

  it("keeps German singular/plural with de-DE separators", async () => {
    expect(await badgeText("de", 1)).toBe("1 Download");
    document.body.innerHTML = "";
    expect(await badgeText("de", 1234)).toBe("1.234 Downloads");
  });

  it("formats English copy on English pages", async () => {
    expect(await badgeText("en", 0)).toBe("No downloads yet");
  });

  it("keeps English singular/plural with en-US separators", async () => {
    expect(await badgeText("en", 1)).toBe("1 download");
    document.body.innerHTML = "";
    expect(await badgeText("en", 1234)).toBe("1,234 downloads");
  });
});
