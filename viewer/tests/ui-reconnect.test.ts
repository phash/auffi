import { describe, it, expect, vi, beforeEach } from "vitest";

function buildTestDOM(): void {
  const app = document.createElement("div");
  app.id = "app";

  const codeInput = document.createElement("input");
  codeInput.id = "code";
  app.appendChild(codeInput);

  const connectBtn = document.createElement("button");
  connectBtn.id = "connect";
  app.appendChild(connectBtn);

  const refreshBtn = document.createElement("button");
  refreshBtn.id = "refresh-btn";
  app.appendChild(refreshBtn);

  const statusEl = document.createElement("div");
  statusEl.id = "status";
  app.appendChild(statusEl);

  const reconnectWrap = document.createElement("div");
  reconnectWrap.id = "reconnect-wrap";
  reconnectWrap.style.display = "none";
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

describe("Viewer reconnect button", () => {
  beforeEach(() => {
    buildTestDOM();
    vi.clearAllMocks();
  });

  it("reconnect-wrap is hidden on initial load", () => {
    const wrap = document.getElementById("reconnect-wrap") as HTMLElement;
    expect(wrap.style.display).toBe("none");
  });

  it("refresh button clears the code input and hides reconnect-wrap", async () => {
    const codeInput = document.getElementById("code") as HTMLInputElement;
    const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
    const reconnectWrap = document.getElementById("reconnect-wrap") as HTMLElement;

    codeInput.value = "123-456-789";
    reconnectWrap.style.display = "block";

    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fakeFetch);

    const { bindUI } = await import("../src/ui.js");
    bindUI("ws://localhost:8080");

    refreshBtn.click();

    expect(codeInput.value).toBe("");
    expect(reconnectWrap.style.display).toBe("none");

    vi.unstubAllGlobals();
  });
});
