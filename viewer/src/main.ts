import "./styles.css";
import { bindUI } from "./ui.js";
import { showSignupToastIfFlagged } from "./signup-toast.js";
import { attachNotchHandler, focusCodeInput } from "./notch-connect.js";
import { wireHelpModal } from "./help-modal.js";

function deriveBackendWsUrl(): string {
  const explicit = import.meta.env.VITE_BACKEND_WS;
  if (explicit) return explicit;

  // When the page is served over HTTP(S), assume the signaling server lives at
  // the same origin behind a reverse proxy — this matches the production
  // deployment where Caddy reverse-proxies /signal to the backend container.
  // Falls back to the dev backend on plain localhost when neither file:// nor
  // a remote origin is detected.
  const { protocol, host } = window.location;
  if (protocol === "https:") return `wss://${host}/signal`;
  if (protocol === "http:" && host && host !== "localhost") return `ws://${host}/signal`;
  return "ws://localhost:8080/signal";
}

bindUI(deriveBackendWsUrl());
showSignupToastIfFlagged();

// gh #104 — Notch-CTA: weicher Scroll + Fokus auf das Code-Eingabefeld.
// Greift auch wenn die Seite mit `#code`-Fragment geladen wird, weil eine
// Marketing-Subpage (impressum/datenschutz/download) auf `/#code` linkt.
{
  const notchEl = document.getElementById("notch-connect");
  const codeEl = document.getElementById("code");
  const codeInput = codeEl instanceof HTMLInputElement ? codeEl : null;
  attachNotchHandler(notchEl, codeInput);
  if (codeInput && window.location.hash === "#code") {
    focusCodeInput(codeInput, false);
  }
}

wireHelpModal(
  document.getElementById("help-trigger"),
  document.getElementById("help-modal"),
);
