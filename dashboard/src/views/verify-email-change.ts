// /dashboard/verify-email-change/:token — fires GET /api/me/email-change/:token
// on mount and reports the outcome. The backend performs the swap and, per
// Sec L-9, clears the session cookie on the same response, so the only
// sensible next step is signing in again with the new address.

import { confirmEmailChange } from "../api.js";
import { BASE_PATH, type RouteContext, type RouteRenderer } from "../router.js";
import { friendlyAuthError } from "./login.js";

export const renderVerifyEmailChange: RouteRenderer = (
  root: HTMLElement,
  ctx: RouteContext,
) => {
  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "E-Mail-Adresse ändern";
  card.appendChild(h1);

  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Adresse wird geändert …";
  card.appendChild(status);

  const actions = document.createElement("p");
  actions.style.marginTop = "0.75rem";
  card.appendChild(actions);

  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(card);

  const loginLink = (): void => {
    const link = document.createElement("a");
    link.href = BASE_PATH + "/login";
    link.textContent = "→ Zur Anmeldung";
    actions.appendChild(link);
  };

  const token = ctx.params.token ?? "";
  if (token.length === 0) {
    status.className = "error";
    status.textContent = "Bestätigungs-Link unvollständig.";
    return;
  }

  void (async (): Promise<void> => {
    const res = await confirmEmailChange(token);
    if (res.ok) {
      status.style.color = "var(--success)";
      status.textContent =
        "E-Mail-Adresse geändert. Melde dich mit der neuen Adresse an.";
      loginLink();
      return;
    }
    status.className = "error";
    if (res.code === "token-used" || res.code === "token-invalid") {
      status.textContent =
        res.code === "token-used"
          ? "Dieser Bestätigungs-Link wurde bereits verwendet."
          : "Der Bestätigungs-Link ist ungültig oder abgelaufen.";
      loginLink();
      return;
    }
    if (res.code === "email-taken") {
      // Someone else registered the address between request and click.
      status.textContent =
        "Diese Adresse ist inzwischen vergeben. Fordere die Änderung mit einer anderen Adresse erneut an.";
      loginLink();
      return;
    }
    status.textContent = friendlyAuthError(res.code, res.message);
  })();
};
