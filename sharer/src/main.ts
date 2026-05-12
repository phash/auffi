import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { load } from "@tauri-apps/plugin-store";
import type { TrustedPeer } from "./trusted-peers.js";
import { matchesTrustedPeer, addPeerToList, removePeerFromList } from "./trusted-peers.js";
import { friendlyMonitorLabel } from "./monitor-display.js";
import { setupTabs } from "./tabs.js";

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
const fileOfferDialog = document.getElementById("file-offer-dialog")!;
const fileOfferText = document.getElementById("file-offer-text")!;
const fileOfferAcceptBtn = document.getElementById("file-offer-accept")! as HTMLButtonElement;
const fileOfferRejectBtn = document.getElementById("file-offer-reject")! as HTMLButtonElement;
const stopConfirmDialog = document.getElementById("stop-confirm")!;
const stopConfirmYesBtn = document.getElementById("stop-confirm-yes")! as HTMLButtonElement;
const stopConfirmNoBtn = document.getElementById("stop-confirm-no")! as HTMLButtonElement;
const peerRemoveConfirmDialog = document.getElementById("peer-remove-confirm")!;
const peerRemoveConfirmText = document.getElementById("peer-remove-confirm-text")!;
const peerRemoveConfirmYesBtn = document.getElementById("peer-remove-confirm-yes")! as HTMLButtonElement;
const peerRemoveConfirmNoBtn = document.getElementById("peer-remove-confirm-no")! as HTMLButtonElement;
const acceptBtn = document.getElementById("accept")! as HTMLButtonElement;
const declineBtn = document.getElementById("decline")! as HTMLButtonElement;

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
  trustedPeersList.innerHTML = "";
  if (peers.length === 0) {
    const empty = document.createElement("li");
    empty.className = "trusted-empty";
    empty.textContent = "Keine bekannten Helfer gespeichert.";
    trustedPeersList.appendChild(empty);
    return;
  }
  for (const peer of peers) {
    const item = document.createElement("li");
    item.className = "trusted-peer-item";

    const label = document.createElement("div");
    label.className = "trusted-peer-label";

    const aliasText = peer.label || "Unbekannt";
    const alias = document.createElement("span");
    alias.className = "trusted-peer-alias";
    alias.textContent = aliasText;

    const ip = document.createElement("span");
    ip.className = "trusted-peer-ip";
    ip.textContent = peer.ipPrefix;

    label.appendChild(alias);
    label.appendChild(ip);

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove-peer";
    removeBtn.textContent = "Entfernen";
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", `${aliasText} (${peer.ipPrefix}) entfernen`);
    removeBtn.addEventListener("click", () => {
      askRemovePeer(peer.ipPrefix, aliasText);
    });

    item.appendChild(label);
    item.appendChild(removeBtn);
    trustedPeersList.appendChild(item);
  }
}

let pendingPeerRemoval: { ipPrefix: string; trigger: HTMLElement | null } | null = null;

function askRemovePeer(ipPrefix: string, aliasText: string): void {
  pendingPeerRemoval = { ipPrefix, trigger: document.activeElement as HTMLElement | null };
  peerRemoveConfirmText.textContent = `${aliasText} (${ipPrefix}) wird aus der Liste der bekannten Helfer entfernt. Beim nächsten Verbindungsversuch musst du wieder manuell zustimmen.`;
  peerRemoveConfirmDialog.classList.add("visible");
  peerRemoveConfirmNoBtn.focus();
}

function closePeerRemoveConfirm(): void {
  peerRemoveConfirmDialog.classList.remove("visible");
  const trigger = pendingPeerRemoval?.trigger;
  pendingPeerRemoval = null;
  if (trigger && document.contains(trigger)) trigger.focus();
}

peerRemoveConfirmYesBtn.addEventListener("click", () => {
  const ipPrefix = pendingPeerRemoval?.ipPrefix;
  closePeerRemoveConfirm();
  if (ipPrefix) removeTrustedPeer(ipPrefix).catch(() => {});
});

peerRemoveConfirmNoBtn.addEventListener("click", () => {
  closePeerRemoveConfirm();
});

// ── UI helpers ───────────────────────────────────────────────────────────────

function setStatus(text: string, kind: "idle" | "waiting" | "success" | "error"): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

/**
 * Friendly user-facing message for a failed operation. The underlying error
 * object is logged to the console for diagnostics but is not displayed in the
 * UI — most viewer-side errors are protocol-level (SDP, ICE, DataChannel)
 * which a non-technical sharer cannot act on, so showing the raw text only
 * adds noise.
 */
function showFriendlyError(message: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`${message} — detail:`, err);
  setStatus(message, "error");
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

setupTabs({
  tabs: Array.from(document.querySelectorAll<HTMLButtonElement>(".tab-btn")),
  onActivate: (panelKey) => {
    if (panelKey === "settings") renderTrustedPeers().catch(() => {});
  },
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
  restartSignaling().catch((e: unknown) => {
    setStatus(`Fehler: ${String(e)}`, "error");
    showReconnect();
  });
});

// ── Reconnect button ─────────────────────────────────────────────────────────

reconnectBtn.addEventListener("click", () => {
  hideReconnect();
  resetCode();
  setStatus("Verbinde neu…", "waiting");
  restartSignaling().catch((e: unknown) => {
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
        invoke("start_streaming", { monitorId: 0, sessionCode: currentCode ?? "" })
          .then(async () => {
            streamingReady = true;
            if (pendingOffer) {
              const sdp = pendingOffer;
              pendingOffer = null;
              await invoke("receive_offer", { sdp }).catch((err: unknown) => {
                showFriendlyError("Verbindung konnte nicht aufgebaut werden. Bitte erneut versuchen.", err);
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
            showFriendlyError("Streamen konnte nicht gestartet werden. Bitte erneut versuchen.", err);
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

// The monitor-pick modal serves two flows: initial start, and runtime switch
// during an active session. The mode is set right before the modal opens and
// reset to "start" on close.
let monitorSelectMode: "start" | "switch" = "start";

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

  if (monitorSelectMode === "switch") {
    setStatus("Bildschirm wird gewechselt…", "waiting");
    invoke("switch_monitor", { monitorId })
      .then(() => {
        setStatus("Streaming läuft.", "success");
        streamBtn.disabled = false;
        monitorSelectMode = "start";
      })
      .catch((err: unknown) => {
        showFriendlyError("Bildschirm-Wechsel fehlgeschlagen. Bitte erneut versuchen.", err);
        streamBtn.disabled = false;
        monitorSelectMode = "start";
      });
    return;
  }

  setStatus("Stream wird gestartet…", "waiting");

  invoke("start_streaming", { monitorId, sessionCode: currentCode ?? "" })
    .then(async () => {
      streamingReady = true;
      // Replay anything the viewer sent while we were waiting for the user to
      // pick a monitor. Offer first (must precede ICE candidates per WebRTC).
      if (pendingOffer) {
        const sdp = pendingOffer;
        pendingOffer = null;
        await invoke("receive_offer", { sdp }).catch((err: unknown) => {
          showFriendlyError("Verbindung konnte nicht aufgebaut werden. Bitte erneut versuchen.", err);
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
      showFriendlyError("Streamen konnte nicht gestartet werden. Bitte erneut versuchen.", err);
      streamBtn.disabled = false;
      monitorSelectEl.classList.add("visible");
    });
});

// Runtime monitor-switch. On Wayland the portal owns selection so we
// invoke directly and let the system dialog handle it; on X11 we re-show
// the local picker in "switch" mode.
const switchMonitorBtn = document.getElementById("switch-monitor-btn") as HTMLButtonElement | null;
switchMonitorBtn?.addEventListener("click", async () => {
  switchMonitorBtn.disabled = true;
  try {
    const usesPortal = await invoke<boolean>("capture_backend_uses_portal");
    if (usesPortal) {
      setStatus("Bildschirm wechseln — wähle im System-Dialog…", "waiting");
      await invoke("switch_monitor", { monitorId: 0 });
      setStatus("Streaming läuft.", "success");
      return;
    }
    const monitors = await invoke<DisplayInfo[]>("list_monitors");
    monitorSelectMode = "switch";
    renderMonitorChoices(monitors);
    monitorSelectEl.classList.add("visible");
    streamBtn.disabled = false;
  } catch (err) {
    showFriendlyError("Bildschirm-Wechsel fehlgeschlagen. Bitte erneut versuchen.", err);
  } finally {
    switchMonitorBtn.disabled = false;
  }
});

// ── Stop streaming ───────────────────────────────────────────────────────────

stopStreamingBtn.addEventListener("click", () => {
  // Two-step confirm: one accidental click should not tear down the helper's
  // session. The styled dialog matches the rest of the in-app dialogs and
  // closes on Escape via the global focus-trap handler below. Focus the
  // safer "Abbrechen" choice so a habit-pressed Enter does not actually
  // end the stream.
  stopConfirmDialog.classList.add("visible");
  stopConfirmNoBtn.focus();
});

stopConfirmYesBtn.addEventListener("click", () => {
  stopConfirmDialog.classList.remove("visible");
  invoke("disconnect_streaming").catch(() => {});
  hideStreamingActions();
  setStatus(
    "Stream beendet. Du kannst den Code erneut weitergeben oder einen neuen erzeugen.",
    "idle",
  );
  newCodeBtn.classList.add("visible");
});

stopConfirmNoBtn.addEventListener("click", () => {
  stopConfirmDialog.classList.remove("visible");
  stopStreamingBtn.focus();
});

// Global Escape-key handler for in-app dialogs. Each dialog escapes to its
// safer choice: connection-confirm → Ablehnen, file-offer → Ablehnen,
// stop-confirm → Abbrechen. This is the standard keyboard expectation and
// prevents users from getting stuck in a modal they don't know how to close.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (confirmEl.classList.contains("visible")) {
    e.preventDefault();
    declineBtn.click();
    return;
  }
  if (fileOfferDialog.classList.contains("visible")) {
    e.preventDefault();
    fileOfferRejectBtn.click();
    return;
  }
  if (stopConfirmDialog.classList.contains("visible")) {
    e.preventDefault();
    stopConfirmNoBtn.click();
    return;
  }
  if (peerRemoveConfirmDialog.classList.contains("visible")) {
    e.preventDefault();
    peerRemoveConfirmNoBtn.click();
  }
});

// ── Send file ────────────────────────────────────────────────────────────────

sendFileBtn.addEventListener("click", () => {
  invoke("pick_and_send_file").catch((err: unknown) => {
    showFriendlyError("Datei konnte nicht gesendet werden.", err);
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
  // If a previous helper was still attached when this new join arrived
  // (e.g., the prior viewer dropped the WS without us being notified)
  // tear down before accepting the new session. Otherwise start_streaming
  // below stacks a second WebRTC peer + portal dialog on top of the
  // live one, which on Plasma manifests as a hung "wähle Bildschirm…"
  // status because the compositor refuses to surface a second portal
  // dialog while the first source is active.
  if (streamingReady || pendingOffer || pendingIce.length > 0) {
    // Tear down ONLY the streaming state. The signaling channel that
    // delivered this peer-joined must stay alive — without it the
    // confirm_peer / receive_offer calls below would fail with
    // "signaling not started" and the new helper would get stranded.
    //
    // Clear the flags BEFORE awaiting disconnect_streaming. The kept-alive
    // WS may already start delivering relay frames from the new viewer
    // while we await — and the relay handler at line below dispatches
    // based on `streamingReady`. With the flag still true it would call
    // receive_offer against the just-cleared rtc_state and lose the offer.
    streamingReady = false;
    pendingOffer = null;
    pendingIce = [];
    hideStreamingActions();
    await invoke("disconnect_streaming", { keepSignaling: true }).catch(() => {});
  }
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
          invoke("start_streaming", { monitorId: 0, sessionCode: currentCode ?? "" })
            .then(async () => {
              streamingReady = true;
              if (pendingOffer) {
                const sdp = pendingOffer;
                pendingOffer = null;
                await invoke("receive_offer", { sdp }).catch((err: unknown) => {
                  showFriendlyError("Verbindung konnte nicht aufgebaut werden. Bitte erneut versuchen.", err);
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
              showFriendlyError("Streamen konnte nicht gestartet werden. Bitte erneut versuchen.", err);
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
      showFriendlyError("Verbindung konnte nicht aufgebaut werden. Bitte erneut versuchen.", err);
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

let pendingFileOfferId: string | null = null;

function showFileOfferDialog(id: string, name: string, size: number): void {
  pendingFileOfferId = id;
  const human = formatBytes(size);
  fileOfferText.textContent = `Der Helfer möchte dir „${name}" (${human}) senden.`;
  fileOfferDialog.classList.add("visible");
  fileOfferAcceptBtn.focus();
}

function hideFileOfferDialog(): void {
  pendingFileOfferId = null;
  fileOfferDialog.classList.remove("visible");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

fileOfferAcceptBtn.addEventListener("click", () => {
  const id = pendingFileOfferId;
  hideFileOfferDialog();
  if (id === null) return;
  invoke("accept_file", { id }).catch(() => {
    setStatus("Datei konnte nicht angenommen werden.", "error");
  });
});

fileOfferRejectBtn.addEventListener("click", () => {
  const id = pendingFileOfferId;
  hideFileOfferDialog();
  if (id === null) return;
  invoke("reject_file", { id }).catch(() => {
    /* benign: viewer side already cleans up on its end */
  });
});

listen<FileOfferPayload>("file-offer", (e) => {
  const { id, name, size } = e.payload;
  showFileOfferDialog(id, name, size);
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

/**
 * Tear down any in-flight session before requesting a fresh signaling
 * channel. The backend guard (gh #64) rejects start_signaling while
 * SignalingState / WebRtcState / InputControllerState / FileTransferState
 * are still populated — call this from Neuer-Code and Reconnect, where
 * the user explicitly wants a clean restart.
 */
async function restartSignaling(): Promise<void> {
  await invoke("disconnect_streaming").catch(() => {});
  streamingReady = false;
  pendingOffer = null;
  pendingIce = [];
  signalingActive = false;
  await invoke("start_signaling");
}

loadSettings().catch(() => {});
renderTrustedPeers().catch(() => {});
// Use restartSignaling on bootstrap too: a webview reload (e.g. dev
// hot-reload, or user F5) does not restart the Rust process, so any
// prior session's SignalingState still sits in Rust-side state and
// would trip the #64 guard. disconnect_streaming is idempotent.
restartSignaling().catch((e: unknown) => {
  setStatus(`Backend nicht erreichbar: ${String(e)}`, "error");
  showReconnect();
});
