import { SignalingClient } from "./signaling-client.js";
import { ViewerPeer } from "./webrtc-client.js";
import type { ConnectionType } from "./webrtc-client.js";
import { fetchIceServers } from "./turn-config.js";
import { FreeTierTimer } from "./free-tier-timer.js";
import { InputCapture } from "./input-capture.js";
import { FileTransferManager } from "./file-transfer.js";
import type { FileOffer } from "./file-transfer.js";
import { DEFAULT_ZOOM, ZOOM_STEPS, formatZoom, nextZoomLevel } from "./zoom.js";

function setStatus(text: string, kind: "ok" | "err" | "info"): void {
  const el = document.getElementById("status")!;
  el.textContent = text;
  el.className = kind;
}

function setConnectionType(type: ConnectionType | null): void {
  const el = document.getElementById("connection-type")!;
  if (type === null) {
    el.textContent = "";
    el.className = "";
    return;
  }
  el.classList.add("active");
  if (type === "relay") {
    el.textContent = "Über Relay";
    el.classList.add("relay");
    el.classList.remove("p2p");
  } else {
    el.textContent = "Direkt";
    el.classList.remove("relay");
    el.classList.add("p2p");
  }
}

type VideoElementWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};

function setVideoStream(stream: MediaStream | null): void {
  const video = document.getElementById("remote-video") as VideoElementWithFrameCallback;
  const wrapper = document.getElementById("video-wrapper")!;
  const disconnect = document.getElementById("disconnect")!;
  const toolbar = document.getElementById("video-toolbar")!;
  const controls = document.getElementById("video-controls");
  const inputGroup = document.querySelector<HTMLElement>(".input-group")!;
  const instruction = document.querySelector<HTMLElement>(".instruction")!;
  const app = document.getElementById("app")!;

  if (stream) {
    video.srcObject = stream;
    video.classList.add("active");
    wrapper.classList.add("active");
    // Show the "Verbindung wird hergestellt …" overlay until the first
    // decoded frame arrives. WebRTC ICE/DTLS handshake completes before
    // any media is actually decoded, so the gap can be a few seconds.
    wrapper.classList.add("awaiting-frames");
    disconnect.classList.add("active");
    toolbar.classList.add("active");
    controls?.classList.add("active");
    inputGroup.classList.add("hidden");
    instruction.classList.add("hidden");
    app.classList.add("streaming");
    // Prevent any user-initiated PiP from auto-detaching the video.
    if ("disablePictureInPicture" in video) {
      (video as HTMLVideoElement & { disablePictureInPicture: boolean }).disablePictureInPicture = true;
    }

    const clearOverlay = (): void => {
      wrapper.classList.remove("awaiting-frames");
    };

    // Prefer requestVideoFrameCallback — fires exactly when the first
    // composited frame is ready. Falls back to `playing` for browsers
    // without it (Firefox < 132). `playing` can fire before the very
    // first frame is painted, but the gap is imperceptible.
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => clearOverlay());
    } else {
      video.addEventListener("playing", clearOverlay, { once: true });
    }
  } else {
    video.srcObject = null;
    video.classList.remove("active");
    wrapper.classList.remove("active");
    wrapper.classList.remove("awaiting-frames");
    disconnect.classList.remove("active");
    toolbar.classList.remove("active");
    controls?.classList.remove("active");
    inputGroup.classList.remove("hidden");
    instruction.classList.remove("hidden");
    app.classList.remove("streaming");
  }
}

function setInputTogglePressed(btn: HTMLButtonElement, pressed: boolean): void {
  btn.setAttribute("aria-pressed", String(pressed));
  const label = btn.querySelector<HTMLElement>("#input-toggle-label")!;
  label.textContent = pressed
    ? "Steuerung aktiv (Esc zum Beenden)"
    : "Steuerung aktivieren";
}

function wsUrlToHttpUrl(wsUrl: string): string {
  return wsUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://")
    .replace(/\/signal$/, "");
}

function showFreeTierWarning(): void {
  const el = document.getElementById("free-tier-warning-toast");
  if (el) el.classList.add("active");
}

function hideFreeTierWarning(): void {
  const el = document.getElementById("free-tier-warning-toast");
  if (el) el.classList.remove("active");
}

export function bindUI(backendWsUrl: string): void {
  const codeInput = document.getElementById("code") as HTMLInputElement;
  const connectBtn = document.getElementById("connect") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;
  const inputToggleBtn = document.getElementById("input-toggle") as HTMLButtonElement;
  const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement | null;
  const reconnectWrap = document.getElementById("reconnect-wrap") as HTMLElement | null;
  const reconnectBtn = document.getElementById("reconnect-btn") as HTMLButtonElement | null;

  const fileSendBtn = document.getElementById("file-send-btn") as HTMLButtonElement;
  const fileInput = document.getElementById("file-input") as HTMLInputElement;
  const fileOfferToast = document.getElementById("file-offer-toast")!;
  const fileOfferBody = document.getElementById("file-offer-body")!;
  const fileOfferAccept = document.getElementById("file-offer-accept") as HTMLButtonElement;
  const fileOfferReject = document.getElementById("file-offer-reject") as HTMLButtonElement;
  const videoWrapper = document.getElementById("video-wrapper")!;
  const zoomInBtn = document.getElementById("zoom-in") as HTMLButtonElement | null;
  const zoomOutBtn = document.getElementById("zoom-out") as HTMLButtonElement | null;
  const zoomResetBtn = document.getElementById("zoom-reset") as HTMLButtonElement | null;
  const zoomLevelLabel = document.getElementById("zoom-level");
  const fullscreenBtn = document.getElementById("fullscreen-btn") as HTMLButtonElement | null;

  let currentZoom = DEFAULT_ZOOM;

  function applyZoom(): void {
    const remote = document.getElementById("remote-video") as HTMLVideoElement | null;
    if (!remote) return;
    remote.style.setProperty("--zoom", String(currentZoom));
    if (zoomLevelLabel) zoomLevelLabel.textContent = formatZoom(currentZoom);
    if (zoomInBtn) zoomInBtn.disabled = currentZoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
    if (zoomOutBtn) zoomOutBtn.disabled = currentZoom <= ZOOM_STEPS[0];
    if (zoomResetBtn) zoomResetBtn.disabled = currentZoom === DEFAULT_ZOOM;
  }

  function resetZoom(): void {
    currentZoom = DEFAULT_ZOOM;
    applyZoom();
  }

  zoomInBtn?.addEventListener("click", () => {
    currentZoom = nextZoomLevel(currentZoom, "in");
    applyZoom();
  });

  zoomOutBtn?.addEventListener("click", () => {
    currentZoom = nextZoomLevel(currentZoom, "out");
    applyZoom();
  });

  zoomResetBtn?.addEventListener("click", () => {
    resetZoom();
  });

  fullscreenBtn?.addEventListener("click", () => {
    const root = document.getElementById("video-wrapper");
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      const req = root.requestFullscreen?.bind(root);
      if (req) void req();
    }
  });

  document.addEventListener("fullscreenchange", () => {
    if (!fullscreenBtn) return;
    fullscreenBtn.setAttribute("aria-pressed", String(!!document.fullscreenElement));
    fullscreenBtn.title = document.fullscreenElement ? "Vollbild verlassen" : "Vollbild";
    fullscreenBtn.setAttribute(
      "aria-label",
      document.fullscreenElement ? "Vollbild verlassen" : "Vollbild",
    );
  });

  applyZoom();

  let signaling: SignalingClient | null = null;
  let peer: ViewerPeer | null = null;
  let capture: InputCapture | null = null;
  let fileManager: FileTransferManager | null = null;
  let freeTierTimer: FreeTierTimer | null = null;
  let lastCode: string | null = null;

  let pendingOfferResolve: ((accepted: boolean) => void) | null = null;

  const escapeHandler = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && inputToggleBtn.getAttribute("aria-pressed") === "true") {
      capture?.disable();
      setInputTogglePressed(inputToggleBtn, false);
    }
  };

  codeInput.addEventListener("input", () => {
    const digits = codeInput.value.replace(/\D/g, "").slice(0, 9);
    const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)].filter(
      (s) => s.length > 0,
    );
    codeInput.value = parts.join("-");
  });

  // Pressing Enter in the code input is the same as clicking Verbinden.
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !connectBtn.disabled) {
      e.preventDefault();
      connectBtn.click();
    }
  });

  function showReconnect(): void {
    if (reconnectWrap) reconnectWrap.classList.add("active");
  }

  function hideReconnect(): void {
    if (reconnectWrap) reconnectWrap.classList.remove("active");
  }

  function teardown(reason: string, kind: "ok" | "err" | "info" = "info", canReconnect = false): void {
    freeTierTimer?.stop();
    freeTierTimer = null;
    hideFreeTierWarning();
    capture?.disable();
    capture = null;
    fileManager?.cancelAll();
    fileManager = null;
    pendingOfferResolve?.(false);
    pendingOfferResolve = null;
    fileOfferToast.classList.remove("active");
    setInputTogglePressed(inputToggleBtn, false);
    peer?.close();
    signaling?.close();
    peer = null;
    signaling = null;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {
        // Ignore — fullscreen may already be exiting via user gesture.
      });
    }
    resetZoom();
    setVideoStream(null);
    setConnectionType(null);
    setStatus(reason, kind);
    connectBtn.disabled = false;
    if (canReconnect && lastCode) {
      showReconnect();
    }
  }

  disconnectBtn.addEventListener("click", () => {
    lastCode = null;
    hideReconnect();
    teardown("Getrennt.", "info");
  });

  refreshBtn?.addEventListener("click", () => {
    lastCode = null;
    hideReconnect();
    codeInput.value = "";
    codeInput.focus();
    setStatus("", "info");
  });

  fileOfferAccept.addEventListener("click", () => {
    pendingOfferResolve?.(true);
    pendingOfferResolve = null;
    fileOfferToast.classList.remove("active");
  });

  fileOfferReject.addEventListener("click", () => {
    pendingOfferResolve?.(false);
    pendingOfferResolve = null;
    fileOfferToast.classList.remove("active");
  });

  fileSendBtn.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file && fileManager) {
      fileManager.send(file).catch(() => {
        // Transfer was rejected or failed; no user-visible error needed here
      });
    }
    fileInput.value = "";
  });

  videoWrapper.addEventListener("dragover", (e) => {
    if (!fileManager) return;
    e.preventDefault();
    videoWrapper.classList.add("drop-over");
  });

  videoWrapper.addEventListener("dragleave", () => {
    videoWrapper.classList.remove("drop-over");
  });

  videoWrapper.addEventListener("drop", (e) => {
    videoWrapper.classList.remove("drop-over");
    if (!fileManager) return;
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) {
      fileManager.send(file).catch(() => {
        // Transfer was rejected or failed; no user-visible error needed here
      });
    }
  });

  inputToggleBtn.addEventListener("click", () => {
    if (inputToggleBtn.getAttribute("aria-pressed") === "true") {
      capture?.disable();
      setInputTogglePressed(inputToggleBtn, false);
    } else {
      const videoEl = document.getElementById("remote-video") as HTMLVideoElement;
      capture?.enable();
      setInputTogglePressed(inputToggleBtn, true);
      videoEl.focus();
    }
  });

  document.addEventListener("keydown", escapeHandler);

  function doConnect(code: string): void {
    lastCode = code;
    hideReconnect();
    setStatus("Warte auf Bestätigung durch den Sharer…", "info");
    connectBtn.disabled = true;

    const backendHttpUrl = wsUrlToHttpUrl(backendWsUrl);

    void fetchIceServers(backendHttpUrl, code).then((iceServers) => {
      signaling = new SignalingClient(backendWsUrl);
      peer = new ViewerPeer({ iceServers });

      const videoEl = document.getElementById("remote-video") as HTMLVideoElement;

      peer.onTrack((stream) => {
        setVideoStream(stream);
        const hub = peer!.getDataHub();
        hub.ready().then(() => {
          capture = new InputCapture(videoEl, (ev) => hub.sendInput(ev));

          fileManager = new FileTransferManager(
            (ev) => hub.sendFile(ev),
            (buf) => hub.sendFileChunk(buf),
            () => hub.filesBufferedAmount(),
            (threshold) => hub.awaitFilesBufferedLow(threshold),
          );

          fileManager.onIncomingOffer((offer: FileOffer) => {
            return new Promise<boolean>((resolve) => {
              pendingOfferResolve = resolve;
              const sizeMb = (offer.size / (1024 * 1024)).toFixed(2);
              fileOfferBody.textContent = `"${offer.name}" (${sizeMb} MB)`;
              fileOfferToast.classList.add("active");
            });
          });

          fileManager.onIncomingComplete((file: File) => {
            const url = URL.createObjectURL(file);
            const a = document.createElement("a");
            a.href = url;
            a.download = file.name;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          });

          hub.onFile((ev) => fileManager?.handle(ev));
          hub.onFileChunk((buf) => fileManager?.handleChunk(buf));
        }).catch(() => {
          // DataChannel setup failed; input control unavailable
        });
      });
      peer.onIceCandidate((candidate) => {
        if (candidate) signaling?.sendRelay({ kind: "ice", candidate });
      });
      peer.onIceState((state) => {
        if (state === "failed" || state === "disconnected") {
          teardown("Verbindung verloren.", "err", true);
        }
      });
      peer.onConnectionType((type) => {
        setConnectionType(type);
        if (type === "relay") {
          freeTierTimer = new FreeTierTimer();
          freeTierTimer.start({
            onWarning: () => {
              showFreeTierWarning();
            },
            onCutoff: () => {
              teardown("Relay-Limit erreicht — Premium kommt bald.", "info");
            },
          });
        }
      });

      signaling.onRelay((payload) => {
        if (payload.kind === "sdp") {
          peer?.acceptAnswer(payload.sdp).catch((e: unknown) =>
            teardown(`SDP-Fehler: ${e instanceof Error ? e.message : String(e)}`, "err"),
          );
        } else if (payload.kind === "ice") {
          peer?.addRemoteIceCandidate(payload.candidate).catch(() => {
            teardown("ICE-Fehler.", "err");
          });
        } else if (payload.kind === "bye") {
          teardown("Der Sharer hat den Stream beendet.", "info", true);
        }
      });

      signaling.onDisconnect((reason) => teardown(`Verbindung beendet: ${reason}`, "err", true));

      signaling
        .join(code)
        .then(async () => {
          if (!peer || !signaling) return;
          const offer = await peer.start();
          signaling.sendRelay({ kind: "sdp", sdp: offer });
          setStatus("Verbunden — empfange Stream…", "ok");
        })
        .catch((e: unknown) =>
          teardown(`Fehler: ${e instanceof Error ? e.message : String(e)}`, "err", true),
        );
    });
  }

  connectBtn.addEventListener("click", () => {
    const code = codeInput.value.trim();
    if (!/^\d{3}-\d{3}-\d{3}$/.test(code)) {
      setStatus("Bitte 9-stelligen Code eingeben.", "err");
      return;
    }
    doConnect(code);
  });

  reconnectBtn?.addEventListener("click", () => {
    if (!lastCode) return;
    hideReconnect();
    doConnect(lastCode);
  });
}
