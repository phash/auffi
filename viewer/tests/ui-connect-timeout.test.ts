import { describe, it, expect, vi, beforeEach } from "vitest";

import { buildUiTestDOM } from "./helpers/ui-dom.js";

describe("Viewer connect timeout + cancel", () => {
  beforeEach(() => {
    buildUiTestDOM();
    vi.clearAllMocks();
  });

  it("shows the Abbrechen button while connecting and hides it initially", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fakeFetch);
    const { bindUI } = await import("../src/ui.js");
    bindUI("ws://localhost:8080");

    const cancelBtn = document.getElementById("cancel-connect") as HTMLButtonElement;
    expect(cancelBtn.hidden).toBe(true);

    const codeInput = document.getElementById("code") as HTMLInputElement;
    codeInput.value = "123-456-789";
    (document.getElementById("connect") as HTMLButtonElement).click();
    expect(cancelBtn.hidden).toBe(false);

    vi.unstubAllGlobals();
  });

  it("tears down with a 'confirmation' message and offers reconnect after the confirm timeout", async () => {
    vi.useFakeTimers();
    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fakeFetch);
    const { bindUI, CONNECT_CONFIRM_TIMEOUT_MS } = await import("../src/ui.js");
    bindUI("ws://localhost:8080");

    const codeInput = document.getElementById("code") as HTMLInputElement;
    const connectBtn = document.getElementById("connect") as HTMLButtonElement;
    const statusEl = document.getElementById("status") as HTMLElement;
    const reconnectWrap = document.getElementById("reconnect-wrap") as HTMLElement;

    codeInput.value = "123-456-789";
    connectBtn.click();
    expect(reconnectWrap.classList.contains("active")).toBe(false);

    vi.advanceTimersByTime(CONNECT_CONFIRM_TIMEOUT_MS + 1);

    expect(statusEl.textContent?.toLowerCase()).toContain("bestätigt");
    expect(reconnectWrap.classList.contains("active")).toBe(true);
    expect(connectBtn.disabled).toBe(false);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("cancel button tears down and clears the timeout so it never fires later", async () => {
    vi.useFakeTimers();
    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fakeFetch);
    const { bindUI, CONNECT_CONFIRM_TIMEOUT_MS } = await import("../src/ui.js");
    bindUI("ws://localhost:8080");

    const codeInput = document.getElementById("code") as HTMLInputElement;
    const connectBtn = document.getElementById("connect") as HTMLButtonElement;
    const cancelBtn = document.getElementById("cancel-connect") as HTMLButtonElement;
    const statusEl = document.getElementById("status") as HTMLElement;
    const reconnectWrap = document.getElementById("reconnect-wrap") as HTMLElement;

    codeInput.value = "123-456-789";
    connectBtn.click();
    cancelBtn.click();

    expect(statusEl.textContent?.toLowerCase()).toContain("abgebrochen");
    expect(reconnectWrap.classList.contains("active")).toBe(true);
    expect(cancelBtn.hidden).toBe(true);
    const afterCancel = statusEl.textContent;

    // The armed confirm-timeout must have been cleared — advancing past it
    // must NOT overwrite the status with the timeout message.
    vi.advanceTimersByTime(CONNECT_CONFIRM_TIMEOUT_MS + 1);
    expect(statusEl.textContent).toBe(afterCancel);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
