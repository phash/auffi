import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

function buildDOM(): void {
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
  const refreshBtn = document.createElement("button");
  refreshBtn.id = "refresh-btn";
  inputGroup.appendChild(refreshBtn);
  app.appendChild(inputGroup);

  const statusEl = document.createElement("div");
  statusEl.id = "status";
  app.appendChild(statusEl);

  const reconnectWrap = document.createElement("div");
  reconnectWrap.id = "reconnect-wrap";
  const reconnectBtn = document.createElement("button");
  reconnectBtn.id = "reconnect-btn";
  reconnectWrap.appendChild(reconnectBtn);
  app.appendChild(reconnectWrap);

  const videoWrapper = document.createElement("div");
  videoWrapper.id = "video-wrapper";
  const video = document.createElement("video");
  video.id = "remote-video";
  video.tabIndex = 0;
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
  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.id = "fullscreen-btn";
  videoWrapper.appendChild(fullscreenBtn);
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

function dispatchKey(key: string, target: EventTarget = document): boolean {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  return target.dispatchEvent(ev);
}

describe("Fullscreen 'f' shortcut (gh #75)", () => {
  let requestFullscreen: ReturnType<typeof vi.fn>;
  let exitFullscreen: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    buildDOM();

    requestFullscreen = vi.fn().mockResolvedValue(undefined);
    exitFullscreen = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      writable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      writable: true,
      value: exitFullscreen,
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => null,
    });

    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fakeFetch);

    const { bindUI } = await import("../src/ui.js");
    bindUI("ws://localhost:8080");
  });

  beforeEach(() => {
    requestFullscreen.mockClear();
    exitFullscreen.mockClear();
    const wrapper = document.getElementById("video-wrapper") as HTMLElement;
    wrapper.classList.remove("active");
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("video has tabindex=0 so it can take keyboard focus", () => {
    const video = document.getElementById("remote-video") as HTMLVideoElement;
    expect(video.tabIndex).toBe(0);
  });

  it("'f' does nothing while no stream is active", () => {
    dispatchKey("f");
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it("'f' enters fullscreen when a stream is active", () => {
    const wrapper = document.getElementById("video-wrapper") as HTMLElement;
    wrapper.classList.add("active");
    dispatchKey("f");
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("'F' (capital) also works", () => {
    const wrapper = document.getElementById("video-wrapper") as HTMLElement;
    wrapper.classList.add("active");
    dispatchKey("F");
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("'f' typed in the code input does NOT trigger fullscreen", () => {
    const wrapper = document.getElementById("video-wrapper") as HTMLElement;
    wrapper.classList.add("active");
    const codeInput = document.getElementById("code") as HTMLInputElement;
    codeInput.focus();
    dispatchKey("f", codeInput);
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it("'f' on the focused video (no control) still enters fullscreen", () => {
    const wrapper = document.getElementById("video-wrapper") as HTMLElement;
    wrapper.classList.add("active");
    const video = document.getElementById("remote-video") as HTMLVideoElement;
    video.focus();
    dispatchKey("f", video);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  // While Steuerung is active every key typed on the video is forwarded to
  // the remote machine (InputCapture binds on the video and lets the event
  // bubble). Typing "firefox" over there must not flip the local viewer in
  // and out of fullscreen on each 'f'.
  it("'f' while Steuerung is active is forwarded, not a local fullscreen toggle", () => {
    const wrapper = document.getElementById("video-wrapper") as HTMLElement;
    wrapper.classList.add("active");
    const toggle = document.getElementById("input-toggle") as HTMLButtonElement;
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const video = document.getElementById("remote-video") as HTMLVideoElement;
    dispatchKey("f", video);
    dispatchKey("F", video);
    expect(requestFullscreen).not.toHaveBeenCalled();
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("a keydown another handler already claimed (defaultPrevented) is left alone", () => {
    const wrapper = document.getElementById("video-wrapper") as HTMLElement;
    wrapper.classList.add("active");
    const video = document.getElementById("remote-video") as HTMLVideoElement;
    const claim = (e: Event): void => e.preventDefault();
    video.addEventListener("keydown", claim);
    dispatchKey("f", video);
    video.removeEventListener("keydown", claim);
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it("Ctrl+f / Cmd+f does NOT trigger fullscreen (preserves browser find)", () => {
    const wrapper = document.getElementById("video-wrapper") as HTMLElement;
    wrapper.classList.add("active");
    const ev = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(requestFullscreen).not.toHaveBeenCalled();
  });
});
