// /dashboard/devices/new — mint a one-shot pairing code and display
// it big & readable for the user to type into the sharer (spec §5.1).
//
// The backend returns `{code: "ABC-DEF-7K", expiresAt: <unix-ms>}`.
// Codes live 10 min; we render a countdown so the user knows whether
// to ask for a fresh one. Once the sharer redeems the code the
// pairing finishes silently — there's no signal back to this tab.
// The user closes the modal manually and refreshes /devices.

import { mintPairingCode } from "../api.js";
import { BASE_PATH, navigate, type RouteContext, type RouteRenderer } from "../router.js";

const COUNTDOWN_TICK_MS = 1_000;

export const renderAddDevice: RouteRenderer = (root: HTMLElement, _ctx: RouteContext) => {
  while (root.firstChild) root.removeChild(root.firstChild);

  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "Neues Gerät pairen";
  card.appendChild(h1);

  const status = document.createElement("p");
  status.className = "loading";
  status.textContent = "Code wird erstellt …";
  card.appendChild(status);

  root.appendChild(card);

  let stopCountdown: (() => void) | null = null;

  void (async (): Promise<void> => {
    const res = await mintPairingCode();
    if (!res.ok) {
      if (res.status === 401) {
        navigate("/login");
        return;
      }
      status.className = "error";
      status.textContent = `Pairing-Code konnte nicht erstellt werden: ${res.message}`;
      return;
    }
    stopCountdown = renderSuccess(root, res.data.code, res.data.expiresAt);
  })();

  // Router-invoked cleanup: stop the countdown when the view unmounts,
  // otherwise the interval keeps ticking against detached DOM.
  return () => {
    stopCountdown?.();
  };
};

function renderSuccess(root: HTMLElement, code: string, expiresAt: number): () => void {
  while (root.firstChild) root.removeChild(root.firstChild);

  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "Neues Gerät pairen";
  card.appendChild(h1);

  const instructions = document.createElement("p");
  instructions.style.fontSize = "0.9375rem";
  instructions.style.marginBottom = "0.75rem";
  instructions.textContent =
    "Öffne Auffi auf dem Gerät, das du verbinden möchtest. " +
    'Geh in den Einstellungen auf "Unattended-Modus" und gib diesen Code ein:';
  card.appendChild(instructions);

  const codeBox = document.createElement("div");
  codeBox.setAttribute("role", "status");
  codeBox.setAttribute("aria-label", "Pairing-Code");
  codeBox.style.fontFamily = "monospace";
  codeBox.style.fontSize = "2.5rem";
  codeBox.style.fontWeight = "700";
  codeBox.style.letterSpacing = "0.1em";
  codeBox.style.textAlign = "center";
  codeBox.style.padding = "1rem";
  codeBox.style.margin = "0.5rem 0 1rem";
  codeBox.style.background = "var(--surface)";
  codeBox.style.border = "1px solid var(--border)";
  codeBox.style.borderRadius = "var(--radius)";
  codeBox.textContent = code;
  card.appendChild(codeBox);

  const expiryText = document.createElement("p");
  expiryText.setAttribute("role", "status");
  expiryText.setAttribute("aria-live", "polite");
  expiryText.style.fontSize = "0.875rem";
  expiryText.style.color = "var(--text-secondary)";
  expiryText.style.textAlign = "center";
  card.appendChild(expiryText);

  const hint = document.createElement("p");
  hint.style.fontSize = "0.8125rem";
  hint.style.color = "var(--text-secondary)";
  hint.style.marginTop = "0.75rem";
  hint.textContent =
    "Sobald das Gerät den Code eingelöst hat, taucht es in deiner Geräte-Liste auf — diese Seite kannst du dann schließen.";
  card.appendChild(hint);

  const actions = document.createElement("p");
  actions.style.marginTop = "0.75rem";
  const back = document.createElement("a");
  back.href = BASE_PATH + "/devices";
  back.textContent = "← Zur Geräte-Liste";
  actions.appendChild(back);
  card.appendChild(actions);

  root.appendChild(card);

  // Countdown — recompute each tick so the timer survives tab-sleep
  // without drifting (no accumulated `seconds--`). `handle` is declared
  // BEFORE the first updateExpiry() call and guarded: with a client
  // clock >10 min ahead the very first tick already hits the expired
  // branch (interval not started yet).
  let handle: number | undefined;

  const stopCountdown = (): void => {
    if (handle !== undefined) {
      window.clearInterval(handle);
      handle = undefined;
    }
  };

  /** Returns true once the code is expired (countdown finished). */
  const updateExpiry = (): boolean => {
    const text = renderExpiryText(expiresAt, Date.now());
    if (text === "expired") {
      expiryText.style.color = "var(--error)";
      expiryText.textContent = "Code abgelaufen — bitte einen neuen erzeugen.";
      const newLink = document.createElement("a");
      newLink.href = BASE_PATH + "/devices/new";
      newLink.textContent = "→ Neuen Code erzeugen";
      newLink.style.marginLeft = "0.5rem";
      // Render once: if user just sits here we don't keep
      // appending; mark via the data-attribute.
      if (!actions.dataset.hasNewCode) {
        actions.dataset.hasNewCode = "1";
        actions.appendChild(document.createTextNode(" · "));
        actions.appendChild(newLink);
      }
      stopCountdown();
      return true;
    }
    expiryText.textContent = text;
    return false;
  };

  if (!updateExpiry()) {
    handle = window.setInterval(updateExpiry, COUNTDOWN_TICK_MS);
  }
  return stopCountdown;
}

/**
 * Pure helper for the countdown text. Returns `"expired"` once the
 * deadline has passed so the caller can swap in the "neuen erzeugen"
 * link without re-parsing the string.
 */
export function renderExpiryText(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return "expired";
  const totalSec = Math.ceil(remaining / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `Läuft in ${sec} Sekunde${sec === 1 ? "" : "n"} ab`;
  const secPadded = sec.toString().padStart(2, "0");
  return `Läuft in ${min}:${secPadded} Min ab`;
}
