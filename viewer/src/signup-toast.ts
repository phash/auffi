/**
 * One-shot toast that fires when the user just completed signup in the
 * dashboard (`/dashboard/signup`) and was redirected back to the main
 * viewer page. The dashboard sets a `sessionStorage["auffi:signup-toast"]`
 * flag right before the navigation; we read+clear it on first paint here
 * and pop a single dismissible info-banner.
 *
 * sessionStorage scope is the tab — auto-cleans when the user closes the
 * tab even if the flag fires twice.
 */

const FLAG_KEY = "auffi:signup-toast";
const TOAST_ID = "signup-confirm-toast";
const DISMISS_MS = 12_000;

export function showSignupToastIfFlagged(): void {
  try {
    const flag = window.sessionStorage.getItem(FLAG_KEY);
    if (flag !== "1") return;
    window.sessionStorage.removeItem(FLAG_KEY);
  } catch (_) {
    /* sessionStorage disabled (privacy mode, iframe sandboxing) — skip */
    return;
  }
  mountToast();
}

function mountToast(): void {
  if (document.getElementById(TOAST_ID)) return;
  const toast = document.createElement("div");
  toast.id = TOAST_ID;
  toast.className = "signup-confirm-toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("width", "22");
  icon.setAttribute("height", "22");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  const path1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path1.setAttribute("d", "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z");
  const path2 = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  path2.setAttribute("points", "22,6 12,13 2,6");
  icon.appendChild(path1);
  icon.appendChild(path2);
  toast.appendChild(icon);

  const text = document.createElement("div");
  text.className = "signup-confirm-text";
  const strong = document.createElement("strong");
  strong.textContent = "Konto angelegt — bitte E-Mail-Eingang prüfen.";
  const para = document.createElement("p");
  para.textContent =
    "Wir haben dir einen Bestätigungs-Link an deine Adresse geschickt. Erst nach Klick auf den Link kannst du dich einloggen.";
  text.appendChild(strong);
  text.appendChild(para);
  toast.appendChild(text);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "signup-confirm-close";
  close.setAttribute("aria-label", "Hinweis schließen");
  close.textContent = "×";
  close.addEventListener("click", () => toast.remove());
  toast.appendChild(close);

  document.body.appendChild(toast);
  window.setTimeout(() => {
    if (document.getElementById(TOAST_ID)) toast.remove();
  }, DISMISS_MS);
}
