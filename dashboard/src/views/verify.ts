// /dashboard/verify/:token — fires GET /api/auth/verify/:token on
// mount, shows status. Success marks the account verified but issues
// NO session (Sec H-2): the user is still anonymous here and the view
// links them to /login.

import { verifyEmail } from "../api.js";
import { BASE_PATH, type RouteContext, type RouteRenderer } from "../router.js";
import { friendlyAuthError } from "./login.js";

export const renderVerify: RouteRenderer = (root: HTMLElement, ctx: RouteContext) => {
  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "E-Mail bestätigen";
  card.appendChild(h1);

  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Bestätige …";
  card.appendChild(status);

  // Single-line action area; we swap its text between the verify
  // attempt and the post-result links.
  const actions = document.createElement("p");
  actions.style.marginTop = "0.75rem";
  card.appendChild(actions);

  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(card);

  const token = ctx.params.token ?? "";
  if (token.length === 0) {
    status.className = "error";
    status.textContent = "Verifikations-Link unvollständig.";
    return;
  }

  void (async (): Promise<void> => {
    const res = await verifyEmail(token);
    if (res.ok) {
      status.style.color = "var(--success)";
      // Sec H-2: backend deliberately does NOT auto-login on verify
      // anymore. The user has to sign in explicitly so a fishy mail
      // link can't silently log them in via an embed/redirect.
      status.textContent = "E-Mail bestätigt. Du kannst dich jetzt anmelden.";
      const link = document.createElement("a");
      link.href = BASE_PATH + "/login";
      link.textContent = "→ Zur Anmeldung";
      actions.appendChild(link);
      return;
    }
    status.className = "error";
    if (res.code === "token-invalid" || res.code === "token-used") {
      status.textContent =
        res.code === "token-used"
          ? "Dieser Link wurde bereits verwendet. Versuch dich einzuloggen."
          : "Der Bestätigungs-Link ist ungültig oder abgelaufen.";
      const link = document.createElement("a");
      link.href = BASE_PATH + "/login";
      link.textContent = "→ Zur Anmeldung";
      actions.appendChild(link);
      return;
    }
    status.textContent = friendlyAuthError(res.code, res.message);
  })();
};
