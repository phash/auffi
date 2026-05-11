import { SignalingClient } from "./signaling-client.js";
import { ViewerPeer } from "./webrtc-client.js";
import { InputCapture } from "./input-capture.js";

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

export function bindUI(backendWsUrl: string): void {
  const codeInput = document.getElementById("code") as HTMLInputElement;
  const connectBtn = document.getElementById("connect") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;
  const inputToggleBtn = document.getElementById("input-toggle") as HTMLButtonElement;

  let signaling: SignalingClient | null = null;
  let peer: ViewerPeer | null = null;
  let capture: InputCapture | null = null;

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

    signaling = new SignalingClient(backendWsUrl);
    peer = new ViewerPeer();

    const videoEl = document.getElementById("remote-video") as HTMLVideoElement;

    peer.onTrack((stream) => {
      setVideoStream(stream);
      const hub = peer!.getDataHub();
      hub.ready().then(() => {
        capture = new InputCapture(videoEl, (ev) => hub.sendInput(ev));
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
}
