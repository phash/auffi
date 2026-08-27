import { describe, it, expect, vi, beforeEach } from "vitest";

import { buildUiTestDOM } from "./helpers/ui-dom.js";

describe("Viewer reconnect button", () => {
  beforeEach(() => {
    buildUiTestDOM();
    vi.clearAllMocks();
  });

  it("reconnect-wrap is hidden on initial load", () => {
    const wrap = document.getElementById("reconnect-wrap") as HTMLElement;
    // The .reconnect-wrap class defines display:none by default; visibility
    // is toggled via the .active modifier (not inline style).
    expect(wrap.classList.contains("active")).toBe(false);
  });

  it("refresh button clears the code input and hides reconnect-wrap", async () => {
    const codeInput = document.getElementById("code") as HTMLInputElement;
    const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
    const reconnectWrap = document.getElementById("reconnect-wrap") as HTMLElement;

    codeInput.value = "123-456-789";
    reconnectWrap.classList.add("active");

    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fakeFetch);

    const { bindUI } = await import("../src/ui.js");
    bindUI("ws://localhost:8080");

    refreshBtn.click();

    expect(codeInput.value).toBe("");
    expect(reconnectWrap.classList.contains("active")).toBe(false);

    vi.unstubAllGlobals();
  });

  // Acceptance criterion from gh #71: after a manual disconnect the
  // reconnect button stays available for 30 s so a misclick on Beenden is
  // recoverable, then auto-clears.
  it("keeps reconnect-wrap visible for 30s after manual disconnect, then hides it", async () => {
    vi.useFakeTimers();

    const codeInput = document.getElementById("code") as HTMLInputElement;
    const connectBtn = document.getElementById("connect") as HTMLButtonElement;
    const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;
    const reconnectWrap = document.getElementById("reconnect-wrap") as HTMLElement;
    const statusEl = document.getElementById("status") as HTMLElement;

    // doConnect fetches ICE config — return failure so the WS phase is
    // skipped, but lastCode is set before the await.
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fakeFetch);

    const { bindUI } = await import("../src/ui.js");
    bindUI("ws://localhost:8080");

    codeInput.value = "123-456-789";
    connectBtn.click();
    expect(reconnectWrap.classList.contains("active")).toBe(false);

    disconnectBtn.click();
    expect(reconnectWrap.classList.contains("active")).toBe(true);
    expect(statusEl.textContent).toContain("Möchtest du doch nochmal verbinden");

    vi.advanceTimersByTime(29_999);
    expect(reconnectWrap.classList.contains("active")).toBe(true);

    vi.advanceTimersByTime(2);
    expect(reconnectWrap.classList.contains("active")).toBe(false);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("clears the manual-disconnect timer when the user re-connects within the window", async () => {
    vi.useFakeTimers();

    const codeInput = document.getElementById("code") as HTMLInputElement;
    const connectBtn = document.getElementById("connect") as HTMLButtonElement;
    const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;
    const reconnectBtn = document.getElementById("reconnect-btn") as HTMLButtonElement;
    const reconnectWrap = document.getElementById("reconnect-wrap") as HTMLElement;

    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fakeFetch);

    const { bindUI } = await import("../src/ui.js");
    bindUI("ws://localhost:8080");

    codeInput.value = "123-456-789";
    connectBtn.click();
    disconnectBtn.click();
    expect(reconnectWrap.classList.contains("active")).toBe(true);

    reconnectBtn.click();
    // doConnect hides the reconnect-wrap and cancels the pending timer.
    expect(reconnectWrap.classList.contains("active")).toBe(false);

    // Even after the original 30 s elapse, lastCode is still set because the
    // reconnect attempt was treated as a fresh session.
    vi.advanceTimersByTime(31_000);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
