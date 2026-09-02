// Settings UI for unattended mode (gh #20). Wires the radio-toggle +
// pair / set-password / activate / unpair flow against the Tauri
// commands in src-tauri/src/unattended_cmd.rs.
//
// The HTML scaffolding for these controls lives in `index.html` under
// the Settings panel. This module's job is to (a) gate which section
// is visible based on pair-status + password-status + active-status,
// (b) call the Tauri commands on button click, (c) subscribe to
// `unattended-event` payloads and surface them to the user.

const PASSWORD_TOGGLE_SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Wrap a password input with an eye-toggle button so users can
 * verify what they typed before submitting. Mirror of the dashboard
 * helper at dashboard/src/components/password-field.ts — duplicated
 * here because the sharer's webview bundle is separate.
 */
function wrapPasswordWithEyeToggle(input: HTMLInputElement): void {
  if (!input.parentElement) return;
  if (input.parentElement.classList.contains("password-wrap")) return;
  const wrap = document.createElement("div");
  wrap.className = "password-wrap";
  input.parentElement.insertBefore(wrap, input);
  wrap.appendChild(input);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "password-toggle";
  btn.setAttribute("aria-label", "Passwort anzeigen");
  btn.setAttribute("aria-pressed", "false");
  btn.appendChild(makePasswordToggleIcon(false));
  btn.addEventListener("click", () => {
    const visible = input.type === "text";
    if (visible) {
      input.type = "password";
      btn.setAttribute("aria-label", "Passwort anzeigen");
      btn.setAttribute("aria-pressed", "false");
    } else {
      input.type = "text";
      btn.setAttribute("aria-label", "Passwort verstecken");
      btn.setAttribute("aria-pressed", "true");
    }
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    btn.appendChild(makePasswordToggleIcon(!visible));
  });
  wrap.appendChild(btn);
}

function makePasswordToggleIcon(slashed: boolean): SVGElement {
  const svg = document.createElementNS(PASSWORD_TOGGLE_SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const lens = document.createElementNS(PASSWORD_TOGGLE_SVG_NS, "path");
  lens.setAttribute(
    "d",
    "M1.5 12s4-7 10.5-7 10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z",
  );
  svg.appendChild(lens);
  const pupil = document.createElementNS(PASSWORD_TOGGLE_SVG_NS, "circle");
  pupil.setAttribute("cx", "12");
  pupil.setAttribute("cy", "12");
  pupil.setAttribute("r", "3");
  svg.appendChild(pupil);
  if (slashed) {
    const line = document.createElementNS(PASSWORD_TOGGLE_SVG_NS, "line");
    line.setAttribute("x1", "3");
    line.setAttribute("y1", "3");
    line.setAttribute("x2", "21");
    line.setAttribute("y2", "21");
    svg.appendChild(line);
  }
  return svg;
}

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirmDialog, dismissConfirmDialog } from "./confirm-dialog.js";
import { UNATTENDED_CONFIRM_OPTIONS } from "./unattended-confirm.js";
import { planUnattendedTerminal } from "./unattended-terminal-policy.js";
import { SignalingBuffer, type WireIceCandidate } from "./signaling-buffer.js";
import { wireAutostartToggle } from "./autostart-toggle.js";

type ModeChoice = "adhoc" | "unattended";

interface UnattendedEvent {
  kind:
    | "connected"
    | "needs-confirm"
    | "confirm-expired"
    | "peer-joined"
    | "relay"
    | "disconnected"
    | "reconnecting"
    | "revoked"
    | "superseded"
    | "locked-out";
  deviceId?: string;
  attempt?: number;
  after_ms?: number;
  /**
   * Present only on `needs-confirm` events (Sec M-1). The confirm
   * dialog must echo this back through `unattended_confirm` so the
   * user's click routes to the right pending waiter even when
   * overlapping pw-check attempts have queued multiple dialogs.
   */
  confirmId?: number;
}

const modeSelect = document.getElementById("unattended-mode-select") as HTMLSelectElement | null;
const setupBlock = document.getElementById("unattended-setup") as HTMLDivElement | null;
const passwordBlock = document.getElementById("unattended-password") as HTMLDivElement | null;
const activeBlock = document.getElementById("unattended-active") as HTMLDivElement | null;
const pairCode = document.getElementById("unattended-pair-code") as HTMLInputElement | null;
const pairAlias = document.getElementById("unattended-pair-alias") as HTMLInputElement | null;
const pairBtn = document.getElementById("unattended-pair-btn") as HTMLButtonElement | null;
const pairStatus = document.getElementById("unattended-pair-status") as HTMLElement | null;
const pwInput = document.getElementById("unattended-pw-input") as HTMLInputElement | null;
const pwBtn = document.getElementById("unattended-pw-btn") as HTMLButtonElement | null;
const pwStatus = document.getElementById("unattended-pw-status") as HTMLElement | null;
if (pwInput) wrapPasswordWithEyeToggle(pwInput);
const deviceIdEl = document.getElementById("unattended-device-id") as HTMLElement | null;
const statusEl = document.getElementById("unattended-status") as HTMLElement | null;
const startBtn = document.getElementById("unattended-start-btn") as HTMLButtonElement | null;
const stopBtn = document.getElementById("unattended-stop-btn") as HTMLButtonElement | null;
const unpairBtn = document.getElementById("unattended-unpair-btn") as HTMLButtonElement | null;
const autostartCheckbox = document.getElementById(
  "unattended-autostart-toggle",
) as HTMLInputElement | null;
const autostartStatus = document.getElementById(
  "unattended-autostart-status",
) as HTMLElement | null;

const autostart = autostartCheckbox
  ? wireAutostartToggle({
      checkbox: autostartCheckbox,
      statusEl: autostartStatus,
      invoke: (cmd) => invoke(cmd),
    })
  : null;

// Cache of the Rust-side heartbeat state; refresh() resyncs it via
// unattended_is_active because a webview reload (F5 / hot-reload)
// resets this flag while the heartbeat keeps running.
let active = false;
// confirmId of the manual-confirm dialog currently on screen (null when
// none) — lets a Rust-side "confirm-expired" dismiss exactly that dialog.
let openConfirmId: number | null = null;
// confirmId of a prompt the helper's bye withdrew: its dialog was closed
// programmatically and the resulting `false` must NOT be sent as an answer
// (see the bye branch) — the Rust waiter's own 60 s timeout closes it.
let withdrawnConfirmId: number | null = null;

// SDP/ICE buffering for the unattended relay path — same race as the
// ad-hoc flow: the viewer sends its offer while start_streaming is
// still initializing (TURN fetch + capturer startup), and an offer
// invoked against the not-yet-built peer is lost. Shared module so
// both paths normalize the ICE key casing identically.
const signalBuffer = new SignalingBuffer({
  sendOffer: async (sdp) => {
    await invoke("receive_offer", { sdp }).catch((e: unknown) => {
      setStatusText(`Fehler beim Verbindungsaufbau: ${detail(e)}`);
    });
  },
  sendIce: async (ice) => {
    await invoke("receive_ice_candidate", ice).catch(() => {
      // Benign: candidate may be stale (remote description not yet set).
    });
  },
});

/**
 * Serialised session start for a freshly confirmed helper. A previous
 * viewer that vanished without a bye leaves the Rust peer populated
 * (there is no ICE-failure teardown, mirroring ad-hoc semantics), so
 * tear stale streaming state down first — keepSignaling, because the
 * heartbeat WSS and its OutboundSink must survive the swap. Failures
 * surface in the status line and reset state so the next attempt works.
 */
async function startUnattendedStream(): Promise<void> {
  if (signalBuffer.hasActivity()) {
    signalBuffer.reset();
    await invoke("disconnect_streaming", { keepSignaling: true }).catch(() => {});
  }
  try {
    await invoke("start_streaming", { monitorId: 0, sessionCode: "" });
    await signalBuffer.ready();
  } catch (e) {
    signalBuffer.reset();
    setStatusText(`Fehler beim Streamen: ${detail(e)}`);
  }
}

/**
 * Every user-driven exit from unattended mode (Deaktivieren, switching back
 * to Ad-hoc, Gerät entkoppeln) must also end a session that is already
 * running. `unattended_stop` only clears the heartbeat's command slot and
 * OutboundSink; an established peer-to-peer session survives it, so without
 * this the helper keeps screen and input after the user thought they cut it.
 * keepSignaling for the same reason every other unattended teardown passes it:
 * the heartbeat owns its OutboundSink and the full-teardown intent is shaped
 * for the ad-hoc lifecycle (docs/footguns.md § Sharer Teardown).
 */
async function endLiveUnattendedSession(): Promise<void> {
  if (!signalBuffer.hasActivity()) return;
  signalBuffer.reset();
  await invoke("disconnect_streaming", { keepSignaling: true }).catch(() => {});
}

function hide(el: HTMLElement | null): void {
  if (el) el.style.display = "none";
}

function show(el: HTMLElement | null, kind: "block" | "inline-block" = "block"): void {
  if (el) el.style.display = kind;
}

function setStatusText(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

/**
 * Log the raw error for diagnosis but return a user-presentable string.
 * Tauri command rejections are German message strings (shown as-is); any
 * other thrown value collapses to a generic German fallback instead of
 * dumping `[object Object]` into the UI.
 */
function detail(e: unknown): string {
  console.warn("[unattended] action failed:", e);
  return typeof e === "string" && e.trim().length > 0 ? e : "Unbekannter Fehler";
}

async function refresh(): Promise<void> {
  // gh #39: every refresh() pass crosses every state-transition the
  // feedback FAB cares about (mode change, pair, unpair, password
  // set). Dispatch a custom event so the FAB can re-evaluate
  // visibility without polling.
  window.dispatchEvent(new CustomEvent("auffi-unattended-state-changed"));

  if (!modeSelect) return;
  const mode = ((await invoke<string>("unattended_get_mode").catch(() => "adhoc")) as ModeChoice);
  modeSelect.value = mode;

  if (mode !== "unattended") {
    hide(setupBlock);
    hide(passwordBlock);
    hide(activeBlock);
    return;
  }

  const paired = await invoke<string | null>("unattended_is_paired").catch(() => null);
  if (!paired) {
    show(setupBlock);
    hide(passwordBlock);
    hide(activeBlock);
    return;
  }

  if (deviceIdEl) deviceIdEl.textContent = paired;
  const pwSet = await invoke<boolean>("unattended_is_password_set").catch(() => false);
  if (!pwSet) {
    hide(setupBlock);
    show(passwordBlock);
    hide(activeBlock);
    return;
  }

  hide(setupBlock);
  hide(passwordBlock);
  show(activeBlock);
  // Resync from the Rust-side truth — the local flag lies after a
  // webview reload while the heartbeat keeps running.
  active = await invoke<boolean>("unattended_is_active").catch(() => active);
  setStatusText(active ? "Verbunden" : "Inaktiv");
  if (active) {
    hide(startBtn);
    show(stopBtn);
  } else {
    show(startBtn);
    hide(stopBtn);
  }
  await autostart?.sync();
}

modeSelect?.addEventListener("change", async () => {
  const choice = modeSelect.value as ModeChoice;
  await invoke("unattended_set_mode", { mode: choice }).catch(() => {});
  if (choice !== "unattended" && active) {
    await endLiveUnattendedSession();
    await invoke("unattended_stop").catch(() => {});
    active = false;
  }
  await refresh();
});

pairBtn?.addEventListener("click", async () => {
  const code = pairCode?.value?.trim() ?? "";
  const alias = (pairAlias?.value?.trim() ?? "") || "Mein Gerät";
  if (!code) {
    if (pairStatus) pairStatus.textContent = "Bitte Pairing-Code eingeben.";
    return;
  }
  pairBtn.disabled = true;
  if (pairStatus) pairStatus.textContent = "Verbinde …";
  try {
    const deviceId = await invoke<string>("unattended_pair", { code, alias });
    if (pairStatus) pairStatus.textContent = `Verbunden als ${deviceId}.`;
    await refresh();
  } catch (e) {
    if (pairStatus) pairStatus.textContent = `Fehler: ${detail(e)}`;
  } finally {
    pairBtn.disabled = false;
  }
});

pwBtn?.addEventListener("click", async () => {
  const password = pwInput?.value ?? "";
  if (password.length < 8) {
    if (pwStatus) pwStatus.textContent = "Mindestens 8 Zeichen.";
    return;
  }
  pwBtn.disabled = true;
  if (pwStatus) pwStatus.textContent = "Speichere …";
  try {
    await invoke("unattended_set_password", { password });
    if (pwInput) pwInput.value = "";
    if (pwStatus) pwStatus.textContent = "Passwort gespeichert.";
    await refresh();
  } catch (e) {
    if (pwStatus) pwStatus.textContent = `Fehler: ${detail(e)}`;
  } finally {
    pwBtn.disabled = false;
  }
});

startBtn?.addEventListener("click", async () => {
  startBtn.disabled = true;
  try {
    await invoke("unattended_start");
    active = true;
    await refresh();
  } catch (e) {
    setStatusText(`Fehler: ${detail(e)}`);
  } finally {
    startBtn.disabled = false;
  }
});

stopBtn?.addEventListener("click", async () => {
  stopBtn.disabled = true;
  try {
    await endLiveUnattendedSession();
    await invoke("unattended_stop");
    active = false;
    await refresh();
  } catch (e) {
    setStatusText(`Fehler: ${detail(e)}`);
  } finally {
    stopBtn.disabled = false;
  }
});

unpairBtn?.addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Gerät entkoppeln",
    message: "Gerät wirklich entkoppeln? Du musst es dann erneut koppeln.",
    confirmLabel: "Entkoppeln",
    danger: true,
  });
  if (!ok) return;
  unpairBtn.disabled = true;
  try {
    // Not gated on `active`: a heartbeat that died earlier leaves a live
    // P2P session with active === false, and the dashboard-side revoke path
    // (backend closes the WSS → `revoked` → teardown) cannot fire once the
    // heartbeat below is shut down by us first.
    await endLiveUnattendedSession();
    await invoke("unattended_stop").catch(() => {});
    active = false;
    await invoke("unattended_unpair");
    await refresh();
  } catch (e) {
    setStatusText(`Fehler: ${detail(e)}`);
  } finally {
    unpairBtn.disabled = false;
  }
});

void listen<UnattendedEvent>("unattended-event", (e) => {
  const ev = e.payload;
  switch (ev.kind) {
    case "connected":
      setStatusText(`Verbunden${ev.deviceId ? ` (${ev.deviceId})` : ""}`);
      active = true;
      void refresh();
      break;
    case "disconnected":
      // The raw reason stays in the Rust debug log; the heartbeat follows up
      // with a `reconnecting` event carrying the countdown.
      setStatusText("Getrennt — Verbindung wird neu aufgebaut…");
      break;
    case "reconnecting":
      setStatusText(
        `Neuer Verbindungsversuch in ${Math.round((ev.after_ms ?? 0) / 1000)} s (Versuch ${ev.attempt ?? "?"})`,
      );
      break;
    case "needs-confirm": {
      // App-global confirm dialog (the Rust side has already shown +
      // focused the window). The old toast lived inside the hidden
      // Settings panel and silently auto-declined. Each event opens a
      // fresh dialog; confirmDialog's single-slot displaces an older
      // one by resolving it false — matching the Sec M-1 eviction
      // semantics. An answer after the 60 s Rust-side timeout routes
      // to a no-longer-pending confirmId and is a silent no-op.
      const id = ev.confirmId;
      if (id === undefined) break;
      openConfirmId = id;
      void confirmDialog(UNATTENDED_CONFIRM_OPTIONS)
        .then((accepted) => {
          if (openConfirmId === id) openConfirmId = null;
          if (withdrawnConfirmId === id) {
            withdrawnConfirmId = null;
            return;
          }
          return invoke("unattended_confirm", { confirmId: id, accepted });
        })
        .catch(() => {});
      break;
    }
    case "confirm-expired":
      // Rust-side 60 s auto-decline (or eviction by a newer attempt):
      // the open dialog's answer would be a dead-id no-op — close it.
      // Id match guards the race where a NEWER dialog already replaced
      // the expired one.
      if (ev.confirmId !== undefined && ev.confirmId === openConfirmId) {
        openConfirmId = null;
        dismissConfirmDialog();
        setStatusText("Zugriffsanfrage abgelaufen — automatisch abgelehnt.");
      }
      break;
    case "peer-joined":
      setStatusText("Helfer verbunden");
      // gh #20 + heartbeat→webrtc_peer integration: kick off the
      // WebRTC pipeline (tearing stale streaming state down first).
      // The viewer follows up with an SDP offer via "relay".
      void startUnattendedStream();
      break;
    case "revoked":
    case "superseded": {
      // Terminal: the pairing is over. The Rust side clears only the
      // heartbeat's command slot and OutboundSink, so an established
      // peer-to-peer session would otherwise keep running — screen AND
      // input — long after the owner revoked the device. Tear it down here.
      const kind = e.payload.kind === "revoked" ? "revoked" : "superseded";
      const plan = planUnattendedTerminal(kind, signalBuffer.hasActivity());
      if (plan.tearDownStream) {
        signalBuffer.reset();
        void invoke("disconnect_streaming", { keepSignaling: plan.keepSignaling }).catch(
          () => {},
        );
      }
      setStatusText(plan.status);
      active = plan.stillActive;
      void refresh();
      break;
    }
    case "locked-out":
      setStatusText("Zu viele Fehlversuche — Zugriff für 1 Stunde gesperrt.");
      break;
    case "relay": {
      // SDP/ICE forwarding through the shared buffer — same
      // receive_offer / receive_ice_candidate Tauri commands (and the
      // same ICE key normalization) as the ad-hoc path; outbound goes
      // back via the OutboundSink in Unattended mode.
      const payload = (e.payload as unknown as { payload?: unknown }).payload;
      if (payload && typeof payload === "object" && "kind" in payload) {
        const p = payload as { kind: string; sdp?: { sdp: string }; candidate?: unknown };
        if (p.kind === "sdp" && p.sdp && typeof p.sdp.sdp === "string") {
          signalBuffer.offer(p.sdp.sdp);
        } else if (p.kind === "ice" && p.candidate) {
          signalBuffer.ice(p.candidate as WireIceCandidate);
        } else if (p.kind === "bye") {
          // keepSignaling: the heartbeat owns its OutboundSink and the
          // full-teardown intent is shaped for the ad-hoc lifecycle
          // (docs/footguns.md § Sharer Teardown).
          signalBuffer.reset();
          void invoke("disconnect_streaming", { keepSignaling: true }).catch(() => {});
          if (openConfirmId !== null) {
            // Pre-confirm bye (tab closed, pw-entry reap): the helper behind
            // the open prompt is gone. Withdraw it WITHOUT answering — the
            // backend routes pw-check-result by sharer socket, so a Rejected
            // sent now could land on a newer helper's in-flight check.
            withdrawnConfirmId = openConfirmId;
            openConfirmId = null;
            dismissConfirmDialog();
            setStatusText("Zugriffsanfrage zurückgezogen — der Helfer hat abgebrochen.");
          } else {
            setStatusText("Helfer hat die Verbindung getrennt.");
          }
        }
      }
      break;
    }
  }
}).catch(() => {});

// Abnormal streaming-loop exit while in unattended mode: main.ts owns
// the disconnect flow; here only the handshake state + status line need
// resetting so the next helper connect starts cleanly.
void listen<{ reason: string }>("streaming-failed", () => {
  signalBuffer.reset();
  setStatusText("Übertragung unterbrochen — bereit für neue Verbindung.");
}).catch(() => {});

void refresh().catch(() => {});
