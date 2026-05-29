import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal DOM the viewer's bindUI() touches during the connect phase.
// Mirrors tests/ui-reconnect.test.ts plus the gh-review cancel-connect button.
function buildTestDOM(): void {
  const app = document.createElement("div");
  app.id = "app";

  const instruction = document.createElement("p");
  instruction.className = "instruction";
  app.appendChild(instruction);

  const inputGroup = document.createElement("div");
  inputGroup.className = "input-group";
  const codeInput = document.createElement("input");
  codeInput.id = "code";
  inputGroup.appendChild(codeInput);
  const connectBtn = document.createElement("button");
  connectBtn.id = "connect";
  inputGroup.appendChild(connectBtn);
  const cancelBtn = document.createElement("button");
  cancelBtn.id = "cancel-connect";
  cancelBtn.hidden = true;
  inputGroup.appendChild(cancelBtn);
  const refreshBtn = document.createElement("button");
  refreshBtn.id = "refresh-btn";
  inputGroup.appendChild(refreshBtn);
  app.appendChild(inputGroup);

  const statusEl = document.createElement("div");
  statusEl.id = "status";
  app.appendChild(statusEl);

  const reconnectWrap = document.createElement("div");
  reconnectWrap.id = "reconnect-wrap";
  reconnectWrap.classList.add("reconnect-wrap");
  const reconnectBtn = document.createElement("button");
  reconnectBtn.id = "reconnect-btn";
  reconnectWrap.appendChild(reconnectBtn);
  app.appendChild(reconnectWrap);

  const videoWrapper = document.createElement("div");
  videoWrapper.id = "video-wrapper";
  const video = document.createElement("video");
  video.id = "remote-video";
  videoWrapper.appendChild(video);
  const toolbar = document.createElement("div");
  toolbar.id = "video-toolbar";
  videoWrapper.appendChild(toolbar);
  const disconnectBtn = document.createElement("button");
  disconnectBtn.id = "disconnect";
  videoWrapper.appendChild(disconnectBtn);
  const connType = document.createElement("div");
  connType.id = "connection-type";
  videoWrapper.appendChild(connType);
  app.appendChild(videoWrapper);

  const inputToggle = document.createElement("button");
  inputToggle.id = "input-toggle";
  inputToggle.setAttribute("aria-pressed", "false");
  const label = document.createElement("span");
  label.id = "input-toggle-label";
  inputToggle.appendChild(label);
  app.appendChild(inputToggle);

  const fileSendBtn = document.createElement("button");
  fileSendBtn.id = "file-send-btn";
  app.appendChild(fileSendBtn);
  const fileInput = document.createElement("input");
  fileInput.id = "file-input";
  fileInput.type = "file";
  app.appendChild(fileInput);
  const fileOfferToast = document.createElement("div");
  fileOfferToast.id = "file-offer-toast";
  const fileOfferBody = document.createElement("div");
  fileOfferBody.id = "file-offer-body";
  fileOfferToast.appendChild(fileOfferBody);
  const acceptBtn = document.createElement("button");
  acceptBtn.id = "file-offer-accept";
  fileOfferToast.appendChild(acceptBtn);
  const rejectBtn = document.createElement("button");
  rejectBtn.id = "file-offer-reject";
  fileOfferToast.appendChild(rejectBtn);
  app.appendChild(fileOfferToast);

  const freeTierToast = document.createElement("div");
  freeTierToast.id = "free-tier-warning-toast";
  app.appendChild(freeTierToast);

  document.body.replaceChildren(app);
}

describe("Viewer connect timeout + cancel", () => {
  beforeEach(() => {
    buildTestDOM();
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
