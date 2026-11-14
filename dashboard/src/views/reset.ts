// /dashboard/reset/:token — set new password form. On 200 the backend
// revokes every session of the account (per spec §4.5 step 3) —
// including this browser's, if the link was opened while still signed in.
// The success notice lives on /login?reset=ok rather than here: the
// re-probe can flip a signed-in admin to anonymous, main.ts then
// re-renders the current route, and an in-place notice would vanish
// behind an empty form whose token is already spent.

import { resetPassword } from "../api.js";
import { wrapPasswordField } from "../components/password-field.js";
import { BASE_PATH, type RouteContext, type RouteRenderer } from "../router.js";
import { redirectToLogin } from "../session.js";
import { friendlyAuthError } from "./login.js";

export const renderReset: RouteRenderer = (root: HTMLElement, ctx: RouteContext) => {
  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "Neues Passwort setzen";
  card.appendChild(h1);

  const token = ctx.params.token ?? "";
  if (token.length === 0) {
    const err = document.createElement("p");
    err.className = "error";
    err.textContent = "Reset-Link unvollständig.";
    card.appendChild(err);
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(card);
    return;
  }

  const form = document.createElement("form");
  form.noValidate = true;

  const pwLabel = document.createElement("label");
  pwLabel.htmlFor = "reset-password";
  pwLabel.textContent = "Neues Passwort (mindestens 8 Zeichen)";
  const pwInput = document.createElement("input");
  pwInput.type = "password";
  pwInput.maxLength = 256;
  pwInput.id = "reset-password";
  pwInput.name = "password";
  pwInput.autocomplete = "new-password";
  pwInput.required = true;
  pwInput.minLength = 8;

  const pw2Label = document.createElement("label");
  pw2Label.htmlFor = "reset-password-confirm";
  pw2Label.textContent = "Passwort wiederholen";
  const pw2Input = document.createElement("input");
  pw2Input.type = "password";
  pw2Input.maxLength = 256;
  pw2Input.id = "reset-password-confirm";
  pw2Input.name = "password-confirm";
  pw2Input.autocomplete = "new-password";
  pw2Input.required = true;

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "Passwort speichern";

  const errorBox = document.createElement("p");
  errorBox.className = "error";
  errorBox.setAttribute("role", "alert");
  errorBox.setAttribute("aria-live", "polite");

  form.append(pwLabel, wrapPasswordField(pwInput), pw2Label, wrapPasswordField(pw2Input), submit, errorBox);

  const linksHolder = document.createElement("p");
  linksHolder.style.marginTop = "0.75rem";

  form.addEventListener("submit", async (e: SubmitEvent) => {
    e.preventDefault();
    errorBox.textContent = "";
    if (pwInput.value !== pw2Input.value) {
      errorBox.textContent = "Die beiden Passwörter sind nicht identisch.";
      return;
    }
    if (pwInput.value.length < 8) {
      errorBox.textContent = "Passwort muss mindestens 8 Zeichen lang sein.";
      return;
    }
    submit.disabled = true;
    submit.textContent = "Speichere …";
    const res = await resetPassword(token, pwInput.value);
    submit.disabled = false;
    submit.textContent = "Passwort speichern";
    if (res.ok) {
      redirectToLogin("?reset=ok");
      return;
    }
    if (res.code === "token-invalid" || res.code === "token-used") {
      errorBox.textContent =
        res.code === "token-used"
          ? "Dieser Reset-Link wurde bereits verwendet. Fordere einen neuen an."
          : "Reset-Link ist ungültig oder abgelaufen.";
      const link = document.createElement("a");
      link.href = BASE_PATH + "/forgot";
      link.textContent = "→ Neuen Reset-Link anfordern";
      while (linksHolder.firstChild) linksHolder.removeChild(linksHolder.firstChild);
      linksHolder.appendChild(link);
      return;
    }
    errorBox.textContent = friendlyAuthError(res.code, res.message);
  });

  card.appendChild(form);
  card.appendChild(linksHolder);

  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(card);
  queueMicrotask(() => pwInput.focus());
};
