import "./styles.css";
import { bindUI } from "./ui.js";
import { deriveBackendWsUrl } from "./backend-url.js";
import { showSignupToastIfFlagged } from "./signup-toast.js";
import { attachNotchHandler, focusCodeInput } from "./notch-connect.js";
import { wireHelpModal } from "./help-modal.js";

bindUI(deriveBackendWsUrl(window.location, import.meta.env.VITE_BACKEND_WS));
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
