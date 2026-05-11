import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const codeEl = document.getElementById("code")!;
const statusEl = document.getElementById("status")!;
const confirmEl = document.getElementById("confirm")!;
const confirmTextEl = document.getElementById("confirm-text")!;

listen<{ code: string }>("code-assigned", (e) => {
  codeEl.textContent = e.payload.code;
  statusEl.textContent = "Warte auf Verbindung…";
});

listen<{ ipPrefix: string }>("peer-joined", (e) => {
  confirmTextEl.textContent = `Verbindungsanfrage von ${e.payload.ipPrefix}`;
  confirmEl.style.display = "block";
});

listen<{ payload: unknown }>("relay", (e) => {
  statusEl.textContent = "Verbunden. Relay empfangen: " + JSON.stringify(e.payload);
});

listen<{ reason: string }>("disconnected", (e) => {
  statusEl.textContent = "Getrennt: " + e.payload.reason;
  confirmEl.style.display = "none";
});

document.getElementById("accept")!.addEventListener("click", () => {
  invoke("confirm_peer", { accepted: true });
  confirmEl.style.display = "none";
  statusEl.textContent = "Verbunden. Sende Test-Relay…";
});

document.getElementById("decline")!.addEventListener("click", () => {
  invoke("confirm_peer", { accepted: false });
  confirmEl.style.display = "none";
  statusEl.textContent = "Abgelehnt.";
});

invoke("start_signaling");
