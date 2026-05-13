// /dashboard/verify/:token — fires GET /api/auth/verify/:token on
// mount, shows status. Backend auto-issues the session cookie on
// success so the user is logged in by the time they reach this
// view.

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
      status.textContent = "E-Mail bestätigt. Du bist eingeloggt.";
      const link = document.createElement("a");
      link.href = BASE_PATH + "/devices";
      link.textContent = "→ Zu deinen Geräten";
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
