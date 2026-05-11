import { SignalingClient } from "./signaling-client.js";
import { ViewerPeer } from "./webrtc-client.js";

function setStatus(text: string, kind: "ok" | "err" | "info"): void {
  const el = document.getElementById("status")!;
  el.textContent = text;
  el.className = kind;
}

function setVideoStream(stream: MediaStream | null): void {
  const video = document.getElementById("remote-video") as HTMLVideoElement;
  const wrapper = document.getElementById("video-wrapper")!;
  const disconnect = document.getElementById("disconnect")!;
  const inputGroup = document.querySelector<HTMLElement>(".input-group")!;
  const instruction = document.querySelector<HTMLElement>(".instruction")!;

  if (stream) {
    video.srcObject = stream;
    video.classList.add("active");
    wrapper.classList.add("active");
    disconnect.classList.add("active");
    inputGroup.style.display = "none";
    instruction.style.display = "none";
  } else {
    video.srcObject = null;
    video.classList.remove("active");
    wrapper.classList.remove("active");
    disconnect.classList.remove("active");
    inputGroup.style.display = "";
    instruction.style.display = "";
  }
}

export function bindUI(backendWsUrl: string): void {
  const codeInput = document.getElementById("code") as HTMLInputElement;
  const connectBtn = document.getElementById("connect") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;

  let signaling: SignalingClient | null = null;
  let peer: ViewerPeer | null = null;

  codeInput.addEventListener("input", () => {
    const digits = codeInput.value.replace(/\D/g, "").slice(0, 9);
    const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)].filter(
      (s) => s.length > 0,
    );
    codeInput.value = parts.join("-");
  });

  function teardown(reason: string, kind: "ok" | "err" | "info" = "info"): void {
    peer?.close();
    signaling?.close();
    peer = null;
    signaling = null;
    setVideoStream(null);
    setStatus(reason, kind);
    connectBtn.disabled = false;
  }

  disconnectBtn.addEventListener("click", () => teardown("Getrennt.", "info"));

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

    peer.onTrack(setVideoStream);
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
