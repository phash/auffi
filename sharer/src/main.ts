import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { load } from "@tauri-apps/plugin-store";
import type { TrustedPeer } from "./trusted-peers.js";
import { matchesTrustedPeer, addPeerToList, removePeerFromList } from "./trusted-peers.js";
import { friendlyMonitorLabel } from "./monitor-display.js";

interface FileOfferPayload {
  id: string;
  name: string;
  size: number;
  mime: string;
}

interface FileReceivedPayload {
  path: string;
}

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

// ── DOM refs ────────────────────────────────────────────────────────────────

const codeEl = document.getElementById("code")!;
const statusEl = document.getElementById("status")!;
const confirmEl = document.getElementById("confirm")!;
const confirmTextEl = document.getElementById("confirm-text")!;
const rememberPeerCheckbox = document.getElementById("remember-peer") as HTMLInputElement;
const monitorSelectEl = document.getElementById("monitor-select")!;
const monitorListEl = document.getElementById("monitor-list")!;
const streamBtn = document.getElementById("stream-btn")! as HTMLButtonElement;
const copyBtn = document.getElementById("copy-btn")! as HTMLButtonElement;
const newCodeBtn = document.getElementById("new-code-btn")! as HTMLButtonElement;
const pauseBannerEl = document.getElementById("pause-banner")!;
const streamingActionsEl = document.getElementById("streaming-actions")!;
const stopStreamingBtn = document.getElementById("stop-streaming-btn")! as HTMLButtonElement;
const sendFileBtn = document.getElementById("send-file-btn")! as HTMLButtonElement;
const reconnectBtnWrap = document.getElementById("reconnect-btn-wrap")!;
const reconnectBtn = document.getElementById("reconnect-btn")! as HTMLButtonElement;
const connTypeInfoEl = document.getElementById("connection-type-info")!;

// Settings
const trustedPeersList = document.getElementById("trusted-peers-list")!;
const largeCodeToggle = document.getElementById("large-code-toggle") as HTMLInputElement;

// About
const bmcBtn = document.getElementById("bmc-btn")! as HTMLButtonElement;
const linkPhash = document.getElementById("link-phash")! as HTMLButtonElement;
const linkMrd = document.getElementById("link-mrd")! as HTMLButtonElement;
const aboutVersionEl = document.getElementById("about-version")!;

// ── State ───────────────────────────────────────────────────────────────────

let currentIpPrefix: string | null = null;
let currentCode: string | null = null;
let isStreaming = false;
let signalingActive = false;

// SDP+ICE arrive immediately after `peer-confirmed` but the WebRTC peer is
// only constructed when start_streaming runs (after the user picks a monitor).
// Buffer them until the peer exists, then replay in order.
let streamingReady = false;
let pendingOffer: string | null = null;
type IcePayload = {
  candidate: string;
  sdpMid: string | null;
  sdpMlineIndex: number | null;
  usernameFragment: string | null;
};
let pendingIce: IcePayload[] = [];

// ── Persistent store ────────────────────────────────────────────────────────

async function getStore() {
  return load("auffi-settings.json", { autoSave: true });
}

async function loadTrustedPeers(): Promise<TrustedPeer[]> {
  const store = await getStore();
  return (await store.get<TrustedPeer[]>("trustedPeers")) ?? [];
}

async function saveTrustedPeers(peers: TrustedPeer[]): Promise<void> {
  const store = await getStore();
  await store.set("trustedPeers", peers);
}

async function addTrustedPeer(ipPrefix: string, label: string): Promise<void> {
  const peers = await loadTrustedPeers();
  await saveTrustedPeers(addPeerToList(peers, ipPrefix, label));
  await renderTrustedPeers();
}

async function removeTrustedPeer(ipPrefix: string): Promise<void> {
  const peers = await loadTrustedPeers();
  await saveTrustedPeers(removePeerFromList(peers, ipPrefix));
  await renderTrustedPeers();
}

async function isTrustedPeer(ipPrefix: string): Promise<boolean> {
  const peers = await loadTrustedPeers();
  return matchesTrustedPeer(ipPrefix, peers);
}

async function loadSettings(): Promise<void> {
  const store = await getStore();
  const largeCode = (await store.get<boolean>("largeCode")) ?? false;
  largeCodeToggle.checked = largeCode;
  applyLargeCode(largeCode);
}

function applyLargeCode(enabled: boolean): void {
  if (enabled) {
    codeEl.style.fontSize = "2.75rem";
  } else {
    codeEl.style.fontSize = "";
  }
}

async function renderTrustedPeers(): Promise<void> {
  const peers = await loadTrustedPeers();
  if (peers.length === 0) {
    trustedPeersList.innerHTML = '<p class="trusted-empty">Keine bekannten Helfer gespeichert.</p>';
    return;
  }
  trustedPeersList.innerHTML = "";
  for (const peer of peers) {
    const item = document.createElement("div");
    item.className = "trusted-peer-item";

    const label = document.createElement("div");
    label.className = "trusted-peer-label";

    const ip = document.createElement("span");
    ip.className = "trusted-peer-ip";
    ip.textContent = peer.ipPrefix;

    const alias = document.createElement("span");
    alias.className = "trusted-peer-alias";
    alias.textContent = peer.label || "Unbekannt";

    label.appendChild(ip);
    label.appendChild(alias);

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove-peer";
    removeBtn.textContent = "Entfernen";
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", `${peer.ipPrefix} entfernen`);
    removeBtn.addEventListener("click", () => {
      removeTrustedPeer(peer.ipPrefix).catch(() => {});
    });

    item.appendChild(label);
    item.appendChild(removeBtn);
    trustedPeersList.appendChild(item);
  }
}

// ── UI helpers ───────────────────────────────────────────────────────────────

function setStatus(text: string, kind: "idle" | "waiting" | "success" | "error"): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function showCode(code: string): void {
  codeEl.textContent = code;
  codeEl.classList.remove("placeholder");
  currentCode = code;
}

function resetCode(): void {
  codeEl.textContent = "— — —";
  codeEl.classList.add("placeholder");
  currentCode = null;
  newCodeBtn.classList.remove("visible");
}

function showReconnect(): void {
  reconnectBtnWrap.style.display = "block";
}

function hideReconnect(): void {
  reconnectBtnWrap.style.display = "none";
}

function showStreamingActions(): void {
  streamingActionsEl.classList.add("visible");
  isStreaming = true;
}

function hideStreamingActions(): void {
  streamingActionsEl.classList.remove("visible");
  isStreaming = false;
  // Clear buffered SDP/ICE — the next session starts fresh
  streamingReady = false;
  pendingOffer = null;
  pendingIce = [];
}

// ── Tab navigation ───────────────────────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    const panelId = `panel-${btn.dataset.panel}`;
    document.getElementById(panelId)?.classList.add("active");

    if (btn.dataset.panel === "settings") {
      renderTrustedPeers().catch(() => {});
    }
  });
});

// ── Copy code ────────────────────────────────────────────────────────────────

copyBtn.addEventListener("click", () => {
  const code = currentCode ?? "";
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    copyBtn.textContent = "Kopiert!";
    setTimeout(() => { copyBtn.textContent = "Kopieren"; }, 1500);
  }).catch(() => {});
});

// ── New code button ──────────────────────────────────────────────────────────

newCodeBtn.addEventListener("click", () => {
  newCodeBtn.classList.remove("visible");
  resetCode();
  setStatus("Neuer Code wird angefragt…", "waiting");
  startSignaling().catch((e: unknown) => {
    setStatus(`Fehler: ${String(e)}`, "error");
    showReconnect();
  });
});

// ── Reconnect button ─────────────────────────────────────────────────────────

reconnectBtn.addEventListener("click", () => {
  hideReconnect();
  resetCode();
  setStatus("Verbinde neu…", "waiting");
  startSignaling().catch((e: unknown) => {
    setStatus(`Fehler: ${String(e)}`, "error");
    showReconnect();
  });
});

// ── Accept / Decline ─────────────────────────────────────────────────────────

document.getElementById("accept")!.addEventListener("click", () => {
  const ip = currentIpPrefix ?? "";
  const rememberIt = rememberPeerCheckbox.checked;

  invoke("confirm_peer", { accepted: true, ipPrefix: ip })
    .then(async () => {
      confirmEl.classList.remove("visible");

      if (rememberIt && ip) {
        await addTrustedPeer(ip, "Helfer");
      }
      rememberPeerCheckbox.checked = false;

      // On Wayland the compositor's portal dialog handles monitor selection;
      // our own monitor-list step is redundant and confusing. Skip it.
      const usesPortal = await invoke<boolean>("capture_backend_uses_portal");
      if (usesPortal) {
        setStatus("Wähle den Bildschirm im System-Dialog…", "waiting");
        streamBtn.disabled = true;
        invoke("start_streaming", { monitorId: 0 })
          .then(async () => {
            streamingReady = true;
            if (pendingOffer) {
              const sdp = pendingOffer;
              pendingOffer = null;
              await invoke("receive_offer", { sdp }).catch((err: unknown) => {
                setStatus(`SDP-Fehler: ${String(err)}`, "error");
              });
            }
            const ice = pendingIce.splice(0);
            for (const c of ice) {
              await invoke("receive_ice_candidate", c).catch(() => {});
            }
            setStatus("Streaming läuft.", "success");
            showStreamingActions();
          })
          .catch((err: unknown) => {
            setStatus(`Stream-Fehler: ${String(err)}`, "error");
            streamBtn.disabled = false;
          });
        return;
      }

      setStatus("Verbindung akzeptiert — Bildschirm auswählen…", "waiting");
      const monitors = await invoke<DisplayInfo[]>("list_monitors");
      renderMonitorChoices(monitors);
      monitorSelectEl.classList.add("visible");
    })
    .catch((err: unknown) => {
      setStatus(`Fehler: ${String(err)}`, "error");
    });
});

function renderMonitorChoices(monitors: DisplayInfo[]): void {
  const nodes: Node[] = monitors.map((m, idx) => {
    const label = document.createElement("label");
    label.className = "monitor-card";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "monitor";
    radio.value = String(m.id);
    if (idx === 0) radio.checked = true;
    label.appendChild(radio);

    const meta = friendlyMonitorLabel(idx, monitors.length, m.width, m.height);

    const text = document.createElement("div");
    text.className = "monitor-card-text";

    const primary = document.createElement("span");
    primary.className = "monitor-card-primary";
    primary.textContent = meta.primary;
    text.appendChild(primary);

    const secondary = document.createElement("span");
    secondary.className = "monitor-card-secondary";
    secondary.textContent = meta.secondary;
    text.appendChild(secondary);

    label.appendChild(text);
    return label;
  });
  monitorListEl.replaceChildren(...nodes);
}

document.getElementById("decline")!.addEventListener("click", () => {
  invoke("confirm_peer", { accepted: false });
  confirmEl.classList.remove("visible");
  rememberPeerCheckbox.checked = false;
  currentIpPrefix = null;
  setStatus("Abgelehnt. Warte auf neue Verbindung…", "waiting");
  newCodeBtn.classList.add("visible");
  startSignaling().catch(() => {});
});

// ── Start streaming ──────────────────────────────────────────────────────────

streamBtn.addEventListener("click", () => {
  const checked = monitorListEl.querySelector<HTMLInputElement>(
    'input[name="monitor"]:checked',
  );
  if (!checked) {
    setStatus("Bitte einen Monitor auswählen.", "error");
    return;
  }
  const monitorId = parseInt(checked.value, 10);
  monitorSelectEl.classList.remove("visible");
  streamBtn.disabled = true;
  setStatus("Stream wird gestartet…", "waiting");

  invoke("start_streaming", { monitorId })
    .then(async () => {
      streamingReady = true;
      // Replay anything the viewer sent while we were waiting for the user to
      // pick a monitor. Offer first (must precede ICE candidates per WebRTC).
      if (pendingOffer) {
        const sdp = pendingOffer;
        pendingOffer = null;
        await invoke("receive_offer", { sdp }).catch((err: unknown) => {
          setStatus(`SDP-Fehler: ${String(err)}`, "error");
        });
      }
      const ice = pendingIce.splice(0);
      for (const c of ice) {
        await invoke("receive_ice_candidate", c).catch(() => {
          /* benign: candidate may be stale */
        });
      }
      setStatus("Streaming läuft.", "success");
      showStreamingActions();
    })
    .catch((err: unknown) => {
      setStatus(`Stream-Fehler: ${String(err)}`, "error");
      streamBtn.disabled = false;
      monitorSelectEl.classList.add("visible");
    });
});

// ── Stop streaming ───────────────────────────────────────────────────────────

stopStreamingBtn.addEventListener("click", () => {
  invoke("disconnect_streaming").catch(() => {});
  hideStreamingActions();
  setStatus("Stream beendet. Warte auf neue Verbindung…", "waiting");
  newCodeBtn.classList.add("visible");
});

// ── Send file ────────────────────────────────────────────────────────────────

sendFileBtn.addEventListener("click", () => {
  invoke("pick_and_send_file").catch((err: unknown) => {
    setStatus(`Datei-Fehler: ${String(err)}`, "error");
  });
});

// ── About page buttons ───────────────────────────────────────────────────────

bmcBtn.addEventListener("click", () => {
  openUrl("https://buymeacoffee.com/phash").catch(() => {});
});

linkPhash.addEventListener("click", () => {
  openUrl("https://phash.de").catch(() => {});
});

linkMrd.addEventListener("click", () => {
  openUrl("https://mr-development.de").catch(() => {});
});

// ── Settings toggles ─────────────────────────────────────────────────────────

largeCodeToggle.addEventListener("change", async () => {
  const enabled = largeCodeToggle.checked;
  applyLargeCode(enabled);
  const store = await getStore();
  await store.set("largeCode", enabled);
});

// ── Signaling events ─────────────────────────────────────────────────────────

listen<{ code: string }>("code-assigned", (e) => {
  showCode(e.payload.code);
  setStatus("Warte auf Verbindung…", "waiting");
  newCodeBtn.classList.add("visible");
  signalingActive = true;
});

listen<{ ipPrefix: string }>("peer-joined", async (e) => {
  currentIpPrefix = e.payload.ipPrefix;
  newCodeBtn.classList.remove("visible");

  const trusted = await isTrustedPeer(e.payload.ipPrefix);
  if (trusted) {
    invoke("confirm_peer", { accepted: true, ipPrefix: currentIpPrefix })
      .then(async () => {
        // Same Wayland-skip logic as the manual-accept path: on Wayland
        // the compositor's portal dialog handles monitor selection and
        // showing our own picker would mean 2 dialogs for one share.
        const usesPortal = await invoke<boolean>("capture_backend_uses_portal");
        if (usesPortal) {
          setStatus(`Bekannter Helfer (${e.payload.ipPrefix}) — wähle den Bildschirm im System-Dialog…`, "waiting");
          streamBtn.disabled = true;
          invoke("start_streaming", { monitorId: 0 })
            .then(async () => {
              streamingReady = true;
              if (pendingOffer) {
                const sdp = pendingOffer;
                pendingOffer = null;
                await invoke("receive_offer", { sdp }).catch((err: unknown) => {
                  setStatus(`SDP-Fehler: ${String(err)}`, "error");
                });
              }
              const ice = pendingIce.splice(0);
              for (const c of ice) {
                await invoke("receive_ice_candidate", c).catch(() => {});
              }
              setStatus("Streaming läuft.", "success");
              showStreamingActions();
            })
            .catch((err: unknown) => {
              setStatus(`Stream-Fehler: ${String(err)}`, "error");
              streamBtn.disabled = false;
            });
          return;
        }
        setStatus(`Bekannter Helfer (${e.payload.ipPrefix}) — Bildschirm auswählen…`, "waiting");
        const monitors = await invoke<DisplayInfo[]>("list_monitors");
        renderMonitorChoices(monitors);
        monitorSelectEl.classList.add("visible");
      })
      .catch((err: unknown) => {
        setStatus(`Fehler: ${String(err)}`, "error");
      });
  } else {
    confirmTextEl.textContent = `Verbindungsanfrage von ${e.payload.ipPrefix}`;
    confirmEl.classList.add("visible");
  }
});

listen<{ payload: RelayPayload }>("relay", (e) => {
  const p = e.payload.payload;
  if (p.kind === "sdp" && p.sdp) {
    if (!streamingReady) {
      pendingOffer = p.sdp.sdp;
      return;
    }
    invoke("receive_offer", { sdp: p.sdp.sdp }).catch((err: unknown) => {
      setStatus(`SDP-Fehler: ${String(err)}`, "error");
    });
  } else if (p.kind === "ice" && p.candidate) {
    const ice: IcePayload = {
      candidate: p.candidate.candidate ?? "",
      sdpMid: p.candidate.sdpMid ?? null,
      sdpMlineIndex: p.candidate.sdpMLineIndex ?? null,
      usernameFragment: p.candidate.usernameFragment ?? null,
    };
    if (!streamingReady) {
      pendingIce.push(ice);
      return;
    }
    invoke("receive_ice_candidate", ice).catch(() => {
      // Benign: candidate may be stale (e.g. remote description not yet set).
    });
  }
});

listen<{ reason: string }>("disconnected", (e) => {
  setStatus("Getrennt: " + e.payload.reason, "error");
  confirmEl.classList.remove("visible");
  monitorSelectEl.classList.remove("visible");
  hideStreamingActions();
  signalingActive = false;
  showReconnect();
});

listen<{ paused: boolean }>("input-paused-changed", (e) => {
  if (e.payload.paused) {
    pauseBannerEl.classList.add("visible");
  } else {
    pauseBannerEl.classList.remove("visible");
  }
});

listen("streaming-stopped", () => {
  setStatus("Stream beendet.", "idle");
  streamBtn.disabled = false;
  pauseBannerEl.classList.remove("visible");
  currentIpPrefix = null;
  connTypeInfoEl.textContent = "";
  connTypeInfoEl.className = "";
  hideStreamingActions();
  newCodeBtn.classList.add("visible");
  // Reset the WebRTC handshake buffers so the next session can register
  // its own offer + ICE candidates. Without this reset, a stale
  // streamingReady=true from the previous session causes the relay
  // handler to invoke receive_offer on a peer that hasn't been built yet.
  streamingReady = false;
  pendingOffer = null;
  pendingIce.length = 0;
});

listen<string>("connection-type", (e) => {
  connTypeInfoEl.classList.add("visible");
  if (e.payload === "relay") {
    connTypeInfoEl.textContent = "Verbindung: über Relay";
    connTypeInfoEl.classList.add("relay");
    connTypeInfoEl.classList.remove("direct");
  } else {
    connTypeInfoEl.textContent = "Verbindung: direkt";
    connTypeInfoEl.classList.remove("relay");
    connTypeInfoEl.classList.add("direct");
  }
});

listen<FileOfferPayload>("file-offer", (e) => {
  const { id, name, size } = e.payload;
  const sizeKb = (size / 1024).toFixed(1);
  const confirmed = window.confirm(
    `Helfer möchte „${name}" (${sizeKb} KB) senden — annehmen?`,
  );
  if (confirmed) {
    invoke("accept_file", { id }).catch((err: unknown) => {
      setStatus(`Annehmen fehlgeschlagen: ${String(err)}`, "error");
    });
  } else {
    invoke("reject_file", { id }).catch((err: unknown) => {
      setStatus(`Ablehnen fehlgeschlagen: ${String(err)}`, "error");
    });
  }
});

listen<FileReceivedPayload>("file-received", (e) => {
  setStatus(`Datei empfangen: ${e.payload.path}`, "success");
});

// ── About: version ───────────────────────────────────────────────────────────

const appVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "dev";
aboutVersionEl.textContent = `Version ${appVersion}`;

// ── Start ────────────────────────────────────────────────────────────────────

async function startSignaling(): Promise<void> {
  await invoke("start_signaling");
}

loadSettings().catch(() => {});
renderTrustedPeers().catch(() => {});
startSignaling().catch((e: unknown) => {
  setStatus(`Backend nicht erreichbar: ${String(e)}`, "error");
  showReconnect();
});
