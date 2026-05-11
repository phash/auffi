import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface DisplayInfo {
  id: number;
  title: string;
  width: number;
  height: number;
}

interface RelayPayload {
  kind: "sdp" | "ice" | string;
  sdp?: { type: string; sdp: string };
  candidate?: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    usernameFragment: string | null;
  };
}

const codeEl = document.getElementById("code")!;
const statusEl = document.getElementById("status")!;
const confirmEl = document.getElementById("confirm")!;
const confirmTextEl = document.getElementById("confirm-text")!;
const monitorSelectEl = document.getElementById("monitor-select")!;
const monitorListEl = document.getElementById("monitor-list")!;
const streamBtn = document.getElementById("stream-btn")! as HTMLButtonElement;

listen<{ code: string }>("code-assigned", (e) => {
  codeEl.textContent = e.payload.code;
  statusEl.textContent = "Warte auf Verbindung…";
});

listen<{ ipPrefix: string }>("peer-joined", (e) => {
  confirmTextEl.textContent = `Verbindungsanfrage von ${e.payload.ipPrefix}`;
  confirmEl.style.display = "block";
});

listen<{ payload: RelayPayload }>("relay", (e) => {
  const p = e.payload.payload;
  if (p.kind === "sdp" && p.sdp) {
    invoke("receive_offer", { sdp: p.sdp.sdp }).catch((err: unknown) => {
      statusEl.textContent = `SDP-Fehler: ${String(err)}`;
    });
  } else if (p.kind === "ice" && p.candidate) {
    invoke("receive_ice_candidate", {
      candidate: p.candidate.candidate,
      sdpMid: p.candidate.sdpMid,
      sdpMlineIndex: p.candidate.sdpMLineIndex,
      usernameFragment: p.candidate.usernameFragment,
    }).catch(() => {
      // Benign: ICE candidate may arrive before remote description is set.
    });
  }
});

listen<{ reason: string }>("disconnected", (e) => {
  statusEl.textContent = "Getrennt: " + e.payload.reason;
  confirmEl.style.display = "none";
  monitorSelectEl.style.display = "none";
});

document.getElementById("accept")!.addEventListener("click", () => {
  invoke("confirm_peer", { accepted: true });
  confirmEl.style.display = "none";
  statusEl.textContent = "Verbindung akzeptiert — Monitor auswählen…";

  invoke<DisplayInfo[]>("list_monitors")
    .then((monitors) => {
      const nodes: Node[] = monitors.map((m, idx) => {
        const label = document.createElement("label");
        label.style.display = "block";
        label.style.margin = "0.3rem 0";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "monitor";
        radio.value = String(m.id);
        if (idx === 0) radio.checked = true;
        label.appendChild(radio);
        label.appendChild(document.createTextNode(` ${m.title} (${m.width}×${m.height})`));
        return label;
      });
      monitorListEl.replaceChildren(...nodes);
      monitorSelectEl.style.display = "block";
    })
    .catch((err: unknown) => {
      statusEl.textContent = `Monitor-Liste fehlgeschlagen: ${String(err)}`;
    });
});

document.getElementById("decline")!.addEventListener("click", () => {
  invoke("confirm_peer", { accepted: false });
  confirmEl.style.display = "none";
  statusEl.textContent = "Abgelehnt.";
});

streamBtn.addEventListener("click", () => {
  const checked = monitorListEl.querySelector<HTMLInputElement>(
    'input[name="monitor"]:checked',
  );
  if (!checked) {
    statusEl.textContent = "Bitte einen Monitor auswählen.";
    return;
  }
  const monitorId = parseInt(checked.value, 10);
  monitorSelectEl.style.display = "none";
  streamBtn.disabled = true;
  statusEl.textContent = "Stream wird gestartet…";

  invoke("start_streaming", { monitorId })
    .then(() => {
      statusEl.textContent = "Streaming läuft.";
    })
    .catch((err: unknown) => {
      statusEl.textContent = `Stream-Fehler: ${String(err)}`;
      streamBtn.disabled = false;
      monitorSelectEl.style.display = "block";
    });
});

invoke("start_signaling");
