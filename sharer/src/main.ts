import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
// gh #20: side-effect import wires the unattended-mode settings UI.
// Pure UI handlers + Tauri command bindings; safe to import even when
// the user never enters unattended mode.
import "./unattended.js";
import { refreshFeedbackFab } from "./feedback-fab.js";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { load } from "@tauri-apps/plugin-store";
import type { TrustedPeer } from "./trusted-peers.js";
import { matchesTrustedPeer, addPeerToList, removePeerFromList } from "./trusted-peers.js";
import { friendlyMonitorLabel, monitorPickerView } from "./monitor-display.js";
import { planStreamingStopped, streamingFailedMessage } from "./streaming-stopped-policy.js";
import { SignalingBuffer } from "./signaling-buffer.js";
import { setupTabs } from "./tabs.js";
import { attachBannerHandlers, showBanner, type UpdateInfo } from "./update-banner.js";
import { formatConnectionRequest } from "./connect-format.js";
import { formatExpiry, remainingSeconds } from "./code-expiry.js";
import {
  planIceState,
  iceLossFollowUp,
  ICE_DISCONNECTED_GRACE_MS,
  type IceState,
} from "./ice-teardown-policy.js";
import { resetSessionIndicators } from "./session-indicators.js";
import { planViewerBye } from "./viewer-bye-policy.js";
import { unattendedMainStatus } from "./unattended-mode-status.js";
import { planSignalingLost } from "./signaling-lost-policy.js";

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

// Mirrors the backend's RELAY_KINDS allow-list. Adding `| string` would
// widen the type to all strings and the literal members become decorative
// — keep the tagged union narrow so a typo in one branch fails to compile.
type RelayPayload =
  | { kind: "sdp"; sdp: { type: string; sdp: string } }
  | {
      kind: "ice";
      candidate: {
        candidate: string;
        sdpMid: string | null;
        sdpMLineIndex: number | null;
        usernameFragment: string | null;
      };
    }
  | { kind: "hello" }
  | { kind: "bye" };

// ── DOM refs ────────────────────────────────────────────────────────────────

const codeEl = document.getElementById("code")!;
const codeExpiryEl = document.getElementById("code-expiry")!;
const statusEl = document.getElementById("status")!;
const confirmEl = document.getElementById("confirm")!;
const confirmTextEl = document.getElementById("confirm-text")!;
const rememberPeerCheckbox = document.getElementById("remember-peer") as HTMLInputElement;
const monitorSelectEl = document.getElementById("monitor-select")!;
const monitorListEl = document.getElementById("monitor-list")!;
const streamBtn = document.getElementById("stream-btn")! as HTMLButtonElement;
const monitorCancelBtn = document.getElementById("monitor-cancel-btn")! as HTMLButtonElement;
const copyBtn = document.getElementById("copy-btn")! as HTMLButtonElement;
const newCodeBtn = document.getElementById("new-code-btn")! as HTMLButtonElement;
const pauseBannerEl = document.getElementById("pause-banner")!;
const freeTierBannerEl = document.getElementById("free-tier-banner")!;
const streamingActionsEl = document.getElementById("streaming-actions")!;
const stopStreamingBtn = document.getElementById("stop-streaming-btn")! as HTMLButtonElement;
const sendFileBtn = document.getElementById("send-file-btn")! as HTMLButtonElement;
const reconnectBtnWrap = document.getElementById("reconnect-btn-wrap")!;
const reconnectBtn = document.getElementById("reconnect-btn")! as HTMLButtonElement;
const howtoCardEl = document.getElementById("howto-card")!;
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
const declineBtn = document.getElementById("decline")! as HTMLButtonElement;

// Settings
const trustedPeersList = document.getElementById("trusted-peers-list")!;
const largeCodeToggle = document.getElementById("large-code-toggle") as HTMLInputElement;
const debugLogToggle = document.getElementById("debug-log-toggle") as HTMLInputElement;
const openLogBtn = document.getElementById("open-log-btn") as HTMLButtonElement;

// About
const bmcBtn = document.getElementById("bmc-btn")! as HTMLButtonElement;
const linkPhash = document.getElementById("link-phash")! as HTMLButtonElement;
const linkMrd = document.getElementById("link-mrd")! as HTMLButtonElement;
const aboutVersionEl = document.getElementById("about-version")!;

// ── Modal focus trap ──────────────────────────────────────────────────────────
// The sharer's dialogs (peer-confirm, peer-remove, stop-confirm, file-offer,
// plus the dynamically mounted confirm-dialog and feedback modal) all carry
// role="dialog" aria-modal but toggle via a class / inline display. (The
// monitor picker is an inline card section, not a modal — it is deliberately
// not role="dialog".) One global handler confines Tab to whichever dialog
// is actually rendered (getClientRects() is true only for an on-screen element,
// and unlike offsetParent it also works for position:fixed overlays). This
// avoids per-dialog wiring and stale listeners.
const DIALOG_FOCUSABLE =
  'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const open = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
    (d) => d.getClientRects().length > 0,
  );
  const modal = open[open.length - 1];
  if (!modal) return;
  const items = Array.from(modal.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !modal.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !modal.contains(active))) {
    e.preventDefault();
    first.focus();
  }
});

// ── State ───────────────────────────────────────────────────────────────────

let currentIpPrefix: string | null = null;
let currentCode: string | null = null;

// One-shot: set by paths that show their own stop/restart status
// (stop-confirm, streaming-failed, decline via restartSignaling, mode switch)
// right before they trigger a FULL disconnect_streaming. The streaming-stopped
// listener consumes it and skips the generic "Stream beendet." so the specific
// message survives. keepSignaling teardowns never consume it — don't set it.
let specificStopStatusPending = false;

// True while the ad-hoc surface (9-digit code + signaling WS) is meant to be
// running. Rust keeps ONE OutboundSink, so running the ad-hoc signaling
// while Unattended mode is active would steal the heartbeat's sink — relay
// answers would route into the wrong channel and break the session.
let adhocSurfaceActive = false;

// Relay free-tier cutoff arrived — the viewer ends the session next; lets
// the bye branch show the real reason instead of "Helfer hat…".
let freeTierCutoffSeen = false;

// SDP+ICE arrive immediately after `peer-confirmed` but the WebRTC peer is
// only constructed when start_streaming runs (after the user picks a monitor).
// The shared SignalingBuffer holds them until the peer exists, then replays
// in order (same module the unattended path uses — both must normalize the
// ICE key casing identically).
const signalBuffer = new SignalingBuffer({
  sendOffer: async (sdp) => {
    await invoke("receive_offer", { sdp }).catch((err: unknown) => {
      showFriendlyError("Verbindung konnte nicht aufgebaut werden. Bitte erneut versuchen.", err);
    });
  },
  sendIce: async (ice) => {
    await invoke("receive_ice_candidate", ice).catch(() => {
      // Benign: candidate may be stale (e.g. remote description not yet set).
    });
  },
});

// ── Persistent store ────────────────────────────────────────────────────────

async function getStore() {
  // `defaults: {}` seeds no keys — identical runtime behaviour to omitting it,
  // but @tauri-apps/plugin-store's StoreOptions types `defaults` as required.
  return load("auffi-settings.json", { autoSave: true, defaults: {} });
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

  // Diagnostic logging: the store is the persisted source of truth; the
  // `--debug` launch flag is a transient override already applied Rust-side.
  // Effective = stored OR --debug. We push the effective value back into Rust
  // so a stored "on" survives restarts without a CLI flag.
  const storedDebug = (await store.get<boolean>("debugLogging")) ?? false;
  const cliDebug = await invoke<boolean>("get_debug_logging");
  const effectiveDebug = storedDebug || cliDebug;
  await invoke("set_debug_logging", { enabled: effectiveDebug });
  debugLogToggle.checked = effectiveDebug;
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
  console.warn(`${message} — detail:`, err);
  setStatus(message, "error");
}

// Code-Ablauf: der Server schickt expiresInSec mit jedem code-assigned. Wir
// zählen lokal runter und markieren den Code bei 0 als abgelaufen, damit der
// Sharer-User nicht stumm einen toten Code vorliest.
let expiryTimer: ReturnType<typeof setInterval> | null = null;
let expiryRemaining = 0;
// Absolute deadline of the current code. peer-joined pauses the countdown for
// the handshake; when that helper leaves again the code is still valid and the
// countdown resumes from here instead of restarting.
let codeDeadlineMs: number | null = null;

function renderExpiry(): void {
  const view = formatExpiry(expiryRemaining);
  codeExpiryEl.textContent = view.label;
  codeExpiryEl.classList.toggle("expired", view.expired);
  codeExpiryEl.classList.toggle("expiring", !view.expired && expiryRemaining <= 60);
  codeEl.classList.toggle("expired", view.expired);
}

function stopExpiryCountdown(): void {
  if (expiryTimer !== null) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
}

function startExpiryCountdown(expiresInSec: number): void {
  stopExpiryCountdown();
  expiryRemaining = Math.floor(expiresInSec);
  renderExpiry();
  if (expiryRemaining <= 0) return;
  expiryTimer = setInterval(() => {
    expiryRemaining -= 1;
    renderExpiry();
    if (expiryRemaining <= 0) {
      stopExpiryCountdown();
      setStatus("Code abgelaufen — bitte einen neuen Code erzeugen.", "error");
    }
  }, 1000);
}

/**
 * Resume the countdown paused by peer-joined. Ends the same way the running
 * countdown does when the deadline already passed, so the user is told the
 * code is dead rather than shown a stale "Gültig noch".
 */
function resumeExpiryCountdown(): void {
  if (codeDeadlineMs === null) return;
  const remaining = remainingSeconds(codeDeadlineMs, Date.now());
  startExpiryCountdown(remaining);
  if (remaining <= 0) {
    setStatus("Code abgelaufen — bitte einen neuen Code erzeugen.", "error");
  }
}

function showCode(code: string, expiresInSec?: number): void {
  codeEl.textContent = code;
  codeEl.classList.remove("placeholder");
  codeEl.classList.remove("expired");
  currentCode = code;
  // The refresh button is always available whenever a code is shown — the
  // sharer-user may want a fresh code at any time (gh: "new code button only
  // seemed to exist on the website").
  newCodeBtn.classList.add("visible");
  if (typeof expiresInSec === "number") {
    codeDeadlineMs = Date.now() + expiresInSec * 1000;
    startExpiryCountdown(expiresInSec);
  } else {
    codeDeadlineMs = null;
    stopExpiryCountdown();
    codeExpiryEl.textContent = "";
    codeExpiryEl.classList.remove("expired", "expiring");
  }
}

function resetCode(): void {
  codeEl.textContent = "— — —";
  codeEl.classList.add("placeholder");
  codeEl.classList.remove("expired");
  currentCode = null;
  codeDeadlineMs = null;
  newCodeBtn.classList.remove("visible");
  stopExpiryCountdown();
  codeExpiryEl.textContent = "";
  codeExpiryEl.classList.remove("expired", "expiring");
}

function showReconnect(): void {
  reconnectBtnWrap.style.display = "block";
}

function hideReconnect(): void {
  reconnectBtnWrap.style.display = "none";
}

function showStreamingActions(): void {
  streamingActionsEl.classList.add("visible");
  // The 3-step "So geht's" recap is noise once a session is live.
  howtoCardEl.classList.add("hidden");
}

const sessionIndicatorEls = {
  streamingActions: streamingActionsEl,
  howtoCard: howtoCardEl,
  pauseBanner: pauseBannerEl,
  freeTierBanner: freeTierBannerEl,
  connTypeInfo: connTypeInfoEl,
};

function hideStreamingActions(): void {
  resetSessionIndicators(sessionIndicatorEls);
  // Clear buffered SDP/ICE — the next session starts fresh
  signalBuffer.reset();
}

// Close the "Verbindungsanfrage" and forget the helper it was about. A null
// currentIpPrefix afterwards is what the accept handler checks to notice that
// the request was withdrawn while confirm_peer was in flight.
function dismissConnectionRequest(): void {
  confirmEl.classList.remove("visible");
  rememberPeerCheckbox.checked = false;
  currentIpPrefix = null;
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
    showFriendlyError("Neuer Code konnte nicht angefragt werden. Bitte erneut versuchen.", e);
    showReconnect();
  });
});

// ── Reconnect button ─────────────────────────────────────────────────────────

reconnectBtn.addEventListener("click", () => {
  hideReconnect();
  resetCode();
  setStatus("Verbinde neu…", "waiting");
  restartSignaling().catch((e: unknown) => {
    showFriendlyError("Neuverbindung fehlgeschlagen. Bitte erneut versuchen.", e);
    showReconnect();
  });
});

// ── Accept / Decline ─────────────────────────────────────────────────────────

const acceptBtn = document.getElementById("accept")! as HTMLButtonElement;

acceptBtn.addEventListener("click", () => {
  const ip = currentIpPrefix ?? "";
  const rememberIt = rememberPeerCheckbox.checked;
  // One answer per request: a second click inside the confirm_peer round
  // trip would run the start chain twice — two start_streaming calls, two
  // portal dialogs, which Plasma refuses to surface. Re-armed on failure
  // (retry) and by the next peer-joined.
  acceptBtn.disabled = true;
  declineBtn.disabled = true;

  invoke("confirm_peer", { accepted: true })
    .then(async () => {
      // A bye or disconnect withdrew the request while confirm_peer was in
      // flight: the helper is gone and the backend ignores the stale accept
      // — starting a stream for nobody would only strand the portal dialog.
      if (currentIpPrefix === null) return;
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
            await signalBuffer.ready();
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
      // After a viewer-swap the button may still be disabled from the
      // previous session's start — the streaming-stopped listener
      // deliberately leaves keepSignaling teardowns alone.
      streamBtn.disabled = false;
      openMonitorPicker("start");
    })
    .catch((err: unknown) => {
      showFriendlyError("Verbindung konnte nicht akzeptiert werden. Bitte erneut versuchen.", err);
      acceptBtn.disabled = false;
      declineBtn.disabled = false;
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

declineBtn.addEventListener("click", async () => {
  dismissConnectionRequest();
  setStatus("Abgelehnt. Neuer Code wird angefragt…", "waiting");
  // Await before restarting: confirm_peer clears SignalingState only AFTER
  // the decline frame is sent Rust-side. Racing start_signaling against it
  // trips the gh #64 still-populated guard, the failure gets swallowed and
  // the app is stranded showing a dead code. The backend also closes the
  // sharer WS on a decline, so a full restart (fresh code) is the only
  // correct continuation.
  try {
    await invoke("confirm_peer", { accepted: false });
  } catch {
    // Benign: the backend may already have dropped the socket — the
    // restart below recovers the session either way.
  }
  try {
    await restartSignaling();
  } catch (e) {
    showFriendlyError("Neuer Code konnte nicht angefragt werden. Bitte erneut versuchen.", e);
    showReconnect();
  }
});

// ── Start streaming ──────────────────────────────────────────────────────────

// The monitor-pick modal serves two flows: initial start, and runtime switch
// during an active session. The mode lives on the modal element's
// dataset so an error path that forgets to reset it can't strand a future
// "start" flow in "switch" semantics — closing the modal clears it.
function openMonitorPicker(mode: "start" | "switch"): void {
  monitorSelectEl.dataset.mode = mode;
  const view = monitorPickerView(mode);
  streamBtn.textContent = view.cta;
  monitorCancelBtn.style.display = view.showCancel ? "" : "none";
  monitorSelectEl.classList.add("visible");
}
function closeMonitorPicker(): void {
  monitorSelectEl.classList.remove("visible");
  delete monitorSelectEl.dataset.mode;
}

// Cancel is only offered in "switch" mode (see monitorPickerView): the
// stream keeps running, so backing out needs no further action.
monitorCancelBtn.addEventListener("click", () => {
  closeMonitorPicker();
});

streamBtn.addEventListener("click", () => {
  const checked = monitorListEl.querySelector<HTMLInputElement>(
    'input[name="monitor"]:checked',
  );
  if (!checked) {
    setStatus("Bitte einen Monitor auswählen.", "error");
    return;
  }
  const monitorId = parseInt(checked.value, 10);
  const mode = monitorSelectEl.dataset.mode === "switch" ? "switch" : "start";
  closeMonitorPicker();
  streamBtn.disabled = true;

  if (mode === "switch") {
    setStatus("Bildschirm wird gewechselt…", "waiting");
    invoke("switch_monitor", { monitorId })
      .then(() => {
        setStatus("Streaming läuft.", "success");
        streamBtn.disabled = false;
      })
      .catch((err: unknown) => {
        showFriendlyError("Bildschirm-Wechsel fehlgeschlagen. Bitte erneut versuchen.", err);
        streamBtn.disabled = false;
      });
    return;
  }

  setStatus("Stream wird gestartet…", "waiting");

  invoke("start_streaming", { monitorId, sessionCode: currentCode ?? "" })
    .then(async () => {
      await signalBuffer.ready();
      setStatus("Streaming läuft.", "success");
      showStreamingActions();
    })
    .catch((err: unknown) => {
      showFriendlyError("Streamen konnte nicht gestartet werden. Bitte erneut versuchen.", err);
      streamBtn.disabled = false;
      openMonitorPicker("start");
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
    renderMonitorChoices(monitors);
    openMonitorPicker("switch");
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
  specificStopStatusPending = true;
  invoke("disconnect_streaming").catch(() => {
    // No streaming-stopped event will arrive to consume the flag.
    specificStopStatusPending = false;
  });
  hideStreamingActions();
  // Full teardown closes the signaling WS, so the backend drops the
  // session — the old code is no longer valid. Tell the user the truth.
  setStatus(
    'Stream beendet. Klicke „Neuer Code“, um eine neue Sitzung zu starten.',
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
// stop-confirm → Abbrechen, monitor picker (switch mode only — a "start"
// picker has no cancel path, see monitorPickerView) → Abbrechen. This is
// the standard keyboard expectation and prevents users from getting stuck
// in a modal they don't know how to close.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (confirmEl.classList.contains("visible")) {
    e.preventDefault();
    declineBtn.click();
    return;
  }
  if (
    monitorSelectEl.classList.contains("visible") &&
    monitorSelectEl.dataset.mode === "switch"
  ) {
    e.preventDefault();
    monitorCancelBtn.click();
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

debugLogToggle.addEventListener("change", async () => {
  const enabled = debugLogToggle.checked;
  await invoke("set_debug_logging", { enabled });
  const store = await getStore();
  await store.set("debugLogging", enabled);
});

openLogBtn.addEventListener("click", () => {
  invoke("open_debug_log").catch((e: unknown) => {
    showFriendlyError("Log-Datei konnte nicht geöffnet werden.", e);
  });
});

// ── Signaling events ─────────────────────────────────────────────────────────

listen<{ code: string; expiresInSec: number }>("code-assigned", (e) => {
  showCode(e.payload.code, e.payload.expiresInSec);
  setStatus("Warte auf Verbindung…", "waiting");
});

listen<{ ipPrefix: string; country: string | null }>("peer-joined", async (e) => {
  // If a previous helper was still attached when this new join arrived
  // (e.g., the prior viewer dropped the WS without us being notified)
  // tear down before accepting the new session. Otherwise start_streaming
  // below stacks a second WebRTC peer + portal dialog on top of the
  // live one, which on Plasma manifests as a hung "wähle Bildschirm…"
  // status because the compositor refuses to surface a second portal
  // dialog while the first source is active.
  if (signalBuffer.hasActivity()) {
    // Tear down ONLY the streaming state. The signaling channel that
    // delivered this peer-joined must stay alive — without it the
    // confirm_peer / receive_offer calls below would fail with
    // "signaling not started" and the new helper would get stranded.
    //
    // Reset the buffer BEFORE awaiting disconnect_streaming. The
    // kept-alive WS may already start delivering relay frames from the
    // new viewer while we await — with ready still set, the relay
    // handler would call receive_offer against the just-cleared
    // rtc_state and lose the offer. The streaming-stopped listener
    // deliberately ignores keepSignaling events (they may arrive after
    // the new-peer state below is set and would clobber it), so the
    // per-session indicators are cleared here.
    hideStreamingActions();
    await invoke("disconnect_streaming", { keepSignaling: true }).catch(() => {});
  }
  currentIpPrefix = e.payload.ipPrefix;
  newCodeBtn.classList.remove("visible");
  // A helper is joining — the code has served its purpose; stop the countdown
  // so an expiry mid-handshake doesn't flip the UI to "abgelaufen".
  stopExpiryCountdown();
  codeExpiryEl.textContent = "";
  codeExpiryEl.classList.remove("expired", "expiring");

  // SECURITY: never auto-accept based on the IP prefix. The backend redacts
  // the viewer IP to its first octet (~/8 — up to ~16M addresses), so a
  // "trusted" match is far too coarse to authorise an unattended screen
  // share, and CLAUDE.md requires the sharer to confirm every ad-hoc peer.
  // A known prefix is surfaced as a hint in the dialog, but the human still
  // clicks Akzeptieren. (Genuine unattended access is a separate, password-
  // gated flow.)
  const trusted = await isTrustedPeer(e.payload.ipPrefix);
  confirmTextEl.textContent = formatConnectionRequest({
    ipPrefix: e.payload.ipPrefix,
    country: e.payload.country,
    trusted,
  });
  rememberPeerCheckbox.checked = trusted;
  acceptBtn.disabled = false;
  declineBtn.disabled = false;
  confirmEl.classList.add("visible");
  // This dialog gates screen access — give it initial keyboard focus like
  // every other dialog, on the safer choice (matching stop/remove-confirm).
  declineBtn.focus();
});

listen<{ payload: RelayPayload }>("relay", (e) => {
  const p = e.payload.payload;
  if (p.kind === "sdp" && p.sdp) {
    signalBuffer.offer(p.sdp.sdp);
  } else if (p.kind === "ice" && p.candidate) {
    signalBuffer.ice(p.candidate);
  } else if (p.kind === "bye") {
    const plan = planViewerBye({
      confirmPending: confirmEl.classList.contains("visible"),
      freeTierCutoffSeen,
    });
    freeTierCutoffSeen = false;
    dismissConnectionRequest();
    closeMonitorPicker();
    if (plan.kind === "end-stream") {
      // The helper is gone, this sharer is not: keepSignaling keeps the WS
      // registration, so the code stays redeemable until its TTL and the
      // viewer's 30 s "doch nochmal verbinden" (gh #71) can find it. The
      // streaming-stopped event for a keepSignaling teardown is ignored by
      // its listener, so the session UI is reset here — before the invoke,
      // as the swap path does (relay frames may arrive during the await).
      hideStreamingActions();
      streamBtn.disabled = false;
      void invoke("disconnect_streaming", { keepSignaling: true }).catch(() => {});
    }
    setStatus(plan.status, "idle");
    if (currentCode !== null) {
      newCodeBtn.classList.add("visible");
      resumeExpiryCountdown();
    }
  }
});

listen<{ reason: string }>("disconnected", (e) => {
  // Read before hideStreamingActions() — it resets the buffer this keys on.
  const streamActive = signalBuffer.hasActivity();
  const plan = planSignalingLost(streamActive, e.payload.reason);
  dismissConnectionRequest();
  closeMonitorPicker();
  // The WS task has exited, so the backend released the code either way.
  resetCode();
  if (!plan.keepStreamingActions) hideStreamingActions();
  if (plan.showReconnect) {
    showReconnect();
  } else {
    hideReconnect();
  }
  showFriendlyError(plan.status, e.payload.reason);
});

listen<{ paused: boolean }>("input-paused-changed", (e) => {
  if (e.payload.paused) {
    pauseBannerEl.classList.add("visible");
  } else {
    pauseBannerEl.classList.remove("visible");
  }
});

listen<{ keepSignaling: boolean }>("streaming-stopped", (e) => {
  const plan = planStreamingStopped(e.payload.keepSignaling, specificStopStatusPending);
  if (!plan.resetSessionUi) {
    // Viewer-swap: the peer-joined handler tore down the stream itself and
    // already owns the state for the NEW helper (currentIpPrefix, hidden
    // Neuer-Code button, open confirm dialog). Tauri gives no ordering
    // guarantee between event delivery and invoke resolution, so this
    // event may arrive after that setup — touching it here would null the
    // new helper's IP and break "Diesen Helfer merken".
    return;
  }
  specificStopStatusPending = false;
  freeTierCutoffSeen = false;
  if (plan.showGenericStatus) {
    setStatus("Stream beendet.", "idle");
  }
  streamBtn.disabled = false;
  if (plan.dismissConnectionRequest) dismissConnectionRequest();
  hideStreamingActions();
  // Full teardown drops the signaling WS, so the ad-hoc code is released
  // server-side — clear it instead of leaving a dead code on screen.
  resetCode();
  // In Unattended mode there is no ad-hoc surface to mint codes for.
  if (adhocSurfaceActive) {
    newCodeBtn.classList.add("visible");
  }
  // Reset the WebRTC handshake buffers so the next session can register
  // its own offer + ICE candidates. Without this reset, a stale
  // ready-state from the previous session causes the relay handler to
  // invoke receive_offer on a peer that hasn't been built yet.
  signalBuffer.reset();
});

// Abnormal streaming-loop exit (capture died, track writes failing,
// internal invariant): run the same disconnect/UI-reset flow as the
// other stop paths, with a reason-specific German status.
listen<{ reason: string }>("streaming-failed", (e) => {
  specificStopStatusPending = true;
  invoke("disconnect_streaming").catch(() => {
    specificStopStatusPending = false;
  });
  hideStreamingActions();
  setStatus(streamingFailedMessage(e.payload.reason), "error");
});

// A received file that failed integrity/size checks at completion —
// without this the sharer sees nothing (only file-received was wired).
listen<{ name: string; reason: string }>("file-failed", (e) => {
  setStatus(`Datei „${e.payload.name}“ konnte nicht empfangen werden.`, "error");
});

// The sharer had no answer to a dying connection: Rust reacted only to
// connected/completed, so a viewer that went away left the capture and encoder
// running forever. Mirrors the viewer's grace window rather than inventing a
// second policy.
let iceGraceTimer: ReturnType<typeof setTimeout> | null = null;

function clearIceGrace(): void {
  if (iceGraceTimer !== null) {
    clearTimeout(iceGraceTimer);
    iceGraceTimer = null;
  }
}

async function endStreamAfterIceLoss(): Promise<void> {
  clearIceGrace();
  // Reset BEFORE awaiting, as the viewer-swap path does: the kept-alive WS
  // may deliver a next viewer's relay frames during the await, and the
  // streaming-stopped event for a keepSignaling teardown is ignored.
  hideStreamingActions();
  closeMonitorPicker();
  streamBtn.disabled = false;
  const followUp = iceLossFollowUp(adhocSurfaceActive, currentCode !== null);
  setStatus(followUp.status, "error");
  if (followUp.showNewCode) {
    newCodeBtn.classList.add("visible");
    resumeExpiryCountdown();
  }
  // keepSignaling: the peer is gone, but this sharer stays available for the
  // next viewer — dropping the signaling channel would release the code (or,
  // in unattended mode, the heartbeat's OutboundSink).
  await invoke("disconnect_streaming", { keepSignaling: true }).catch(() => {});
}

listen<string>("ice-state", (e) => {
  const plan = planIceState(e.payload as IceState, iceGraceTimer !== null);
  switch (plan.kind) {
    case "teardown":
      void endStreamAfterIceLoss();
      break;
    case "arm-grace":
      setStatus(plan.status, "waiting");
      iceGraceTimer = setTimeout(() => {
        iceGraceTimer = null;
        void endStreamAfterIceLoss();
      }, ICE_DISCONNECTED_GRACE_MS);
      break;
    case "recovered":
      clearIceGrace();
      setStatus(plan.status, "success");
      break;
    case "ignore":
      break;
  }
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

// Relay sessions are free-tier-capped: Rust starts an 8-minute warning +
// 10-minute cutoff timer on relay connect (lib.rs). Enforcement lives in
// the viewer (it ends the session at cutoff) — these listeners make sure
// the sharer-user is warned before the drop instead of being surprised.
listen("free-tier-warning", () => {
  freeTierBannerEl.classList.add("visible");
});

listen("free-tier-cutoff", () => {
  freeTierBannerEl.classList.remove("visible");
  freeTierCutoffSeen = true;
  setStatus(
    "Zeitlimit für kostenlose Relay-Verbindungen erreicht — die Übertragung wird beendet.",
    "error",
  );
});

let pendingFileOfferId: string | null = null;

function showFileOfferDialog(id: string, name: string, size: number): void {
  pendingFileOfferId = id;
  const human = formatBytes(size);
  fileOfferText.textContent = `Der Helfer möchte dir „${name}“ (${human}) senden.`;
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

/**
 * Tear down any in-flight session before requesting a fresh signaling
 * channel. The backend guard (gh #64) rejects start_signaling while
 * SignalingState / WebRtcState / InputControllerState / FileTransferState
 * are still populated — call this wherever the user explicitly wants a
 * clean ad-hoc restart (Neuer-Code, Reconnect, decline, bootstrap).
 * Every caller has just set its own status line, so the streaming-stopped
 * emitted by the disconnect must not overwrite it with "Stream beendet.".
 */
async function restartSignaling(): Promise<void> {
  adhocSurfaceActive = true;
  specificStopStatusPending = true;
  await invoke("disconnect_streaming").catch(() => {
    specificStopStatusPending = false;
  });
  signalBuffer.reset();
  await invoke("start_signaling");
}

/**
 * Derive the main-panel line from Rust-side truth rather than from mode.txt
 * alone: the select persists "unattended" before pairing (the pairing UI
 * only renders in that mode), so "aktiv" must wait for a running heartbeat.
 * Each probe degrades to its safe falsy default — a keyring hiccup right
 * after login must read as "noch nicht aktiviert", not throw.
 */
async function unattendedStatusLine(): Promise<string> {
  const [paired, pwSet, active] = await Promise.all([
    invoke<string | null>("unattended_is_paired").catch(() => null),
    invoke<boolean>("unattended_is_password_set").catch(() => false),
    invoke<boolean>("unattended_is_active").catch(() => false),
  ]);
  return unattendedMainStatus({ paired: paired !== null, pwSet, active });
}

/**
 * Keep the ad-hoc surface consistent with the persisted mode. Rust keeps a
 * single OutboundSink: with Unattended mode active, a stray start_signaling
 * would overwrite the heartbeat's sink and relay answers would route into
 * the dead ad-hoc channel (and the still-displayed 9-digit code would let
 * an ad-hoc join hijack the sink right back). Runs at bootstrap and on
 * every "auffi-unattended-state-changed" the settings UI dispatches, and is
 * idempotent via adhocSurfaceActive.
 */
async function reconcileAdhocSurface(): Promise<void> {
  const mode = await invoke<string>("unattended_get_mode").catch(() => "adhoc");
  if (mode === "unattended") {
    if (adhocSurfaceActive) {
      adhocSurfaceActive = false;
      specificStopStatusPending = true;
      await invoke("disconnect_streaming").catch(() => {
        specificStopStatusPending = false;
      });
    }
    resetCode();
    hideReconnect();
    setStatus(await unattendedStatusLine(), "idle");
    return;
  }
  if (adhocSurfaceActive) return;
  setStatus("Neuer Code wird angefragt…", "waiting");
  try {
    await restartSignaling();
  } catch (e) {
    showFriendlyError("Neuer Code konnte nicht angefragt werden. Bitte erneut versuchen.", e);
    showReconnect();
  }
}

window.addEventListener("auffi-unattended-state-changed", () => {
  void reconcileAdhocSurface().catch(() => {});
});

loadSettings().catch(() => {});
renderTrustedPeers().catch(() => {});

// Bootstrap: only start the ad-hoc signaling when the persisted mode is
// ad-hoc. A webview reload (F5, dev hot-reload) does not restart the Rust
// process — restarting signaling here during an active Unattended session
// would steal its OutboundSink and kill the session. In ad-hoc mode the
// restart (not a bare start) is deliberate: the prior session's
// SignalingState still sits in Rust-side state and would trip the #64
// guard. disconnect_streaming is idempotent.
(async () => {
  const mode = await invoke<string>("unattended_get_mode").catch(() => "adhoc");
  if (mode === "unattended") {
    resetCode();
    setStatus(await unattendedStatusLine(), "idle");
    return;
  }
  await restartSignaling();
})().catch((e: unknown) => {
  showFriendlyError(
    "Server nicht erreichbar — bitte Internetverbindung prüfen und „Neu verbinden“ klicken.",
    e,
  );
  showReconnect();
});

// gh #39: feedback FAB. Visibility ties to pair-state — hidden in
// ad-hoc mode, shown when the device has a token + password set.
// Refresh on every pair/unpair so the FAB appears/disappears live.
void refreshFeedbackFab().catch(() => {});
window.addEventListener("auffi-unattended-state-changed", () => {
  void refreshFeedbackFab().catch(() => {});
});

// Update-Notifier: einmaliger Check beim Start. Bei Fehlern (Netzwerk
// down, GH-API rate-limit, Parse-Problem) gibt der Rust-Command
// `available: false` zurück — Banner bleibt versteckt, kein Toast,
// keine sichtbare Warnung. Nächster Start fragt erneut.
{
  const banner = document.getElementById("update-banner");
  const versionEl = document.getElementById("update-banner-version");
  const downloadBtn = document.getElementById("update-banner-download");
  const dismissBtn = document.getElementById("update-banner-dismiss");
  if (banner && versionEl && downloadBtn && dismissBtn) {
    invoke<UpdateInfo>("check_for_update")
      .then((info) => {
        attachBannerHandlers({
          banner,
          dismissBtn,
          downloadBtn,
          downloadUrl: info.download_url,
          openUrl: (url) => openUrl(url),
        });
        if (info.available) {
          showBanner(banner, versionEl, info.latest);
        }
      })
      .catch(() => {
        /* silent — Update-Hinweis ist nice-to-have, nicht load-blocking */
      });
  }
}
