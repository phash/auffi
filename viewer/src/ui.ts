import { SignalingClient } from "./signaling-client.js";
import { ViewerPeer } from "./webrtc-client.js";
import { fetchIceServers } from "./turn-config.js";
import { InputCapture } from "./input-capture.js";
import { FileTransferManager } from "./file-transfer.js";
import type { FileOffer } from "./file-transfer.js";

function setStatus(text: string, kind: "ok" | "err" | "info"): void {
  const el = document.getElementById("status")!;
  el.textContent = text;
  el.className = kind;
}

function setVideoStream(stream: MediaStream | null): void {
  const video = document.getElementById("remote-video") as HTMLVideoElement;
  const wrapper = document.getElementById("video-wrapper")!;
  const disconnect = document.getElementById("disconnect")!;
  const toolbar = document.getElementById("video-toolbar")!;
  const inputGroup = document.querySelector<HTMLElement>(".input-group")!;
  const instruction = document.querySelector<HTMLElement>(".instruction")!;

  if (stream) {
    video.srcObject = stream;
    video.classList.add("active");
    wrapper.classList.add("active");
    disconnect.classList.add("active");
    toolbar.classList.add("active");
    inputGroup.style.display = "none";
    instruction.style.display = "none";
  } else {
    video.srcObject = null;
    video.classList.remove("active");
    wrapper.classList.remove("active");
    disconnect.classList.remove("active");
    toolbar.classList.remove("active");
    inputGroup.style.display = "";
    instruction.style.display = "";
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

export function bindUI(backendWsUrl: string): void {
  const codeInput = document.getElementById("code") as HTMLInputElement;
  const connectBtn = document.getElementById("connect") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;
  const inputToggleBtn = document.getElementById("input-toggle") as HTMLButtonElement;

  const fileSendBtn = document.getElementById("file-send-btn") as HTMLButtonElement;
  const fileInput = document.getElementById("file-input") as HTMLInputElement;
  const fileOfferToast = document.getElementById("file-offer-toast")!;
  const fileOfferBody = document.getElementById("file-offer-body")!;
  const fileOfferAccept = document.getElementById("file-offer-accept") as HTMLButtonElement;
  const fileOfferReject = document.getElementById("file-offer-reject") as HTMLButtonElement;
  const videoWrapper = document.getElementById("video-wrapper")!;

  let signaling: SignalingClient | null = null;
  let peer: ViewerPeer | null = null;
  let capture: InputCapture | null = null;
  let fileManager: FileTransferManager | null = null;

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

  function teardown(reason: string, kind: "ok" | "err" | "info" = "info"): void {
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
    setVideoStream(null);
    setStatus(reason, kind);
    connectBtn.disabled = false;
  }

  disconnectBtn.addEventListener("click", () => teardown("Getrennt.", "info"));

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

  connectBtn.addEventListener("click", () => {
    const code = codeInput.value.trim();
    if (!/^\d{3}-\d{3}-\d{3}$/.test(code)) {
      setStatus("Bitte 9-stelligen Code eingeben.", "err");
      return;
    }
    setStatus("Warte auf Bestätigung durch den Sharer…", "info");
    connectBtn.disabled = true;

    const backendHttpUrl = wsUrlToHttpUrl(backendWsUrl);

    void fetchIceServers(backendHttpUrl).then((iceServers) => {
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
          teardown("Verbindung verloren.", "err");
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
        }
      });

      signaling.onDisconnect((reason) => teardown(`Verbindung beendet: ${reason}`, "err"));

      signaling
        .join(code)
        .then(async () => {
          if (!peer || !signaling) return;
          const offer = await peer.start();
          signaling.sendRelay({ kind: "sdp", sdp: offer });
          setStatus("Verbunden — empfange Stream…", "ok");
        })
        .catch((e: unknown) =>
          teardown(`Fehler: ${e instanceof Error ? e.message : String(e)}`, "err"),
        );
    });
  });
}
