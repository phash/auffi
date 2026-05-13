// Settings UI for unattended mode (gh #20). Wires the radio-toggle +
// pair / set-password / activate / unpair flow against the Tauri
// commands in src-tauri/src/unattended_cmd.rs.
//
// The HTML scaffolding for these controls lives in `index.html` under
// the Settings panel. This module's job is to (a) gate which section
// is visible based on pair-status + password-status + active-status,
// (b) call the Tauri commands on button click, (c) subscribe to
// `unattended-event` payloads and surface them to the user.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type ModeChoice = "adhoc" | "unattended";

interface UnattendedEvent {
  kind:
    | "connected"
    | "needs-confirm"
    | "peer-joined"
    | "peer-rejected"
    | "relay"
    | "disconnected"
    | "reconnecting"
    | "revoked"
    | "superseded"
    | "locked-out";
  deviceId?: string;
  reason?: string;
  attempt?: number;
  after_ms?: number;
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
const deviceIdEl = document.getElementById("unattended-device-id") as HTMLElement | null;
const statusEl = document.getElementById("unattended-status") as HTMLElement | null;
const startBtn = document.getElementById("unattended-start-btn") as HTMLButtonElement | null;
const stopBtn = document.getElementById("unattended-stop-btn") as HTMLButtonElement | null;
const unpairBtn = document.getElementById("unattended-unpair-btn") as HTMLButtonElement | null;
const confirmToast = document.getElementById("unattended-confirm-toast") as HTMLDivElement | null;
const confirmYes = document.getElementById("unattended-confirm-yes") as HTMLButtonElement | null;
const confirmNo = document.getElementById("unattended-confirm-no") as HTMLButtonElement | null;

let active = false;

function hide(el: HTMLElement | null): void {
  if (el) el.style.display = "none";
}

function show(el: HTMLElement | null, kind: "block" | "inline-block" = "block"): void {
  if (el) el.style.display = kind;
}

function setStatusText(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

async function refresh(): Promise<void> {
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
  setStatusText(active ? "Verbunden" : "Inaktiv");
  if (active) {
    hide(startBtn);
    show(stopBtn);
  } else {
    show(startBtn);
    hide(stopBtn);
  }
}

modeSelect?.addEventListener("change", async () => {
  const choice = modeSelect.value as ModeChoice;
  await invoke("unattended_set_mode", { mode: choice }).catch(() => {});
  if (choice !== "unattended" && active) {
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
    if (pairStatus) pairStatus.textContent = `Fehler: ${String(e)}`;
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
    if (pwStatus) pwStatus.textContent = `Fehler: ${String(e)}`;
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
    setStatusText(`Fehler: ${String(e)}`);
  } finally {
    startBtn.disabled = false;
  }
});

stopBtn?.addEventListener("click", async () => {
  stopBtn.disabled = true;
  try {
    await invoke("unattended_stop");
    active = false;
    await refresh();
  } catch (e) {
    setStatusText(`Fehler: ${String(e)}`);
  } finally {
    stopBtn.disabled = false;
  }
});

unpairBtn?.addEventListener("click", async () => {
  if (!confirm("Gerät wirklich entkoppeln? Du musst dann erneut pairen.")) return;
  unpairBtn.disabled = true;
  try {
    if (active) {
      await invoke("unattended_stop").catch(() => {});
      active = false;
    }
    await invoke("unattended_unpair");
    await refresh();
  } catch (e) {
    setStatusText(`Fehler: ${String(e)}`);
  } finally {
    unpairBtn.disabled = false;
  }
});

confirmYes?.addEventListener("click", async () => {
  hide(confirmToast);
  await invoke("unattended_confirm", { accepted: true }).catch(() => {});
});

confirmNo?.addEventListener("click", async () => {
  hide(confirmToast);
  await invoke("unattended_confirm", { accepted: false }).catch(() => {});
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
      setStatusText(`Getrennt — ${ev.reason ?? ""}`);
      break;
    case "reconnecting":
      setStatusText(
        `Reconnect in ${Math.round((ev.after_ms ?? 0) / 1000)}s (Versuch ${ev.attempt ?? "?"})`,
      );
      break;
    case "needs-confirm":
      show(confirmToast);
      break;
    case "peer-joined":
      setStatusText("Helfer verbunden");
      hide(confirmToast);
      // gh #20 + heartbeat→webrtc_peer integration: kick off the
      // WebRTC pipeline. The viewer will follow up with an SDP offer
      // forwarded via "relay".
      void invoke("start_streaming", { monitorId: 0, sessionCode: "" }).catch(() => {});
      break;
    case "peer-rejected":
      setStatusText(`Helfer getrennt: ${ev.reason ?? ""}`);
      break;
    case "revoked":
      setStatusText("Token widerrufen — bitte erneut pairen.");
      active = false;
      void refresh();
      break;
    case "superseded":
      setStatusText("Eine andere Instanz hat übernommen.");
      active = false;
      void refresh();
      break;
    case "locked-out":
      setStatusText("Lokales Lockout aktiv (10+ Fehlversuche). 1 h Sperre.");
      break;
    case "relay": {
      // SDP/ICE forwarding — calls the same receive_offer /
      // receive_ice_candidate Tauri commands the ad-hoc path uses;
      // outbound goes back via the OutboundSink in Unattended mode.
      const payload = (e.payload as unknown as { payload?: unknown }).payload;
      if (payload && typeof payload === "object" && "kind" in payload) {
        const p = payload as { kind: string; sdp?: { sdp: string }; candidate?: unknown };
        if (p.kind === "sdp" && p.sdp && typeof p.sdp.sdp === "string") {
          void invoke("receive_offer", { sdp: p.sdp.sdp }).catch(() => {});
        } else if (p.kind === "ice" && p.candidate) {
          void invoke("receive_ice_candidate", p.candidate as Record<string, unknown>).catch(
            () => {},
          );
        } else if (p.kind === "bye") {
          void invoke("disconnect_streaming").catch(() => {});
        }
      }
      break;
    }
  }
}).catch(() => {});

void refresh().catch(() => {});
