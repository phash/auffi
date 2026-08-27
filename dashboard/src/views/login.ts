// /dashboard/login — email + password form. On 200 navigate to "/".
// All form construction uses DOM methods (no innerHTML) so any
// future "remembered email" prefill can never reach the HTML
// parser.

import { login } from "../api.js";
import { wrapPasswordField } from "../components/password-field.js";
import { BASE_PATH, navigate, type RouteContext, type RouteRenderer } from "../router.js";
import { refreshSession } from "../session.js";

export const renderLogin: RouteRenderer = (root: HTMLElement, _ctx: RouteContext) => {
  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "Anmelden";
  card.appendChild(h1);

  const form = document.createElement("form");
  form.noValidate = true;

  const emailLabel = document.createElement("label");
  emailLabel.htmlFor = "login-email";
  emailLabel.textContent = "E-Mail";
  const emailInput = document.createElement("input");
  emailInput.type = "email";
  emailInput.id = "login-email";
  emailInput.name = "email";
  emailInput.autocomplete = "username";
  emailInput.required = true;

  const pwLabel = document.createElement("label");
  pwLabel.htmlFor = "login-password";
  pwLabel.textContent = "Passwort";
  const pwInput = document.createElement("input");
  pwInput.type = "password";
  pwInput.id = "login-password";
  pwInput.name = "password";
  pwInput.autocomplete = "current-password";
  pwInput.required = true;

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "Anmelden";

  const errorBox = document.createElement("p");
  errorBox.className = "error";
  errorBox.setAttribute("role", "alert");
  errorBox.setAttribute("aria-live", "polite");

  const links = document.createElement("p");
  links.style.marginTop = "0.75rem";
  links.style.fontSize = "0.875rem";
  const signup = document.createElement("a");
  signup.href = BASE_PATH + "/signup";
  signup.textContent = "Account anlegen";
  const forgot = document.createElement("a");
  forgot.href = BASE_PATH + "/forgot";
  forgot.textContent = "Passwort vergessen?";
  forgot.style.marginLeft = "1rem";
  links.appendChild(signup);
  links.appendChild(forgot);

  form.append(emailLabel, emailInput, pwLabel, wrapPasswordField(pwInput), submit, errorBox);

  form.addEventListener("submit", async (e: SubmitEvent) => {
    e.preventDefault();
    errorBox.textContent = "";
    submit.disabled = true;
    submit.textContent = "Anmelden …";
    const res = await login(emailInput.value.trim(), pwInput.value);
    if (res.ok) {
      // Re-probe the session in the background so nav/admin-gate/FAB
      // pick up the new login without a full page reload.
      void refreshSession();
      // Land on the device list as the post-login default.
      navigate("/");
      return;
    }
    submit.disabled = false;
    submit.textContent = "Anmelden";
    errorBox.textContent = friendlyAuthError(res.code, res.message);
  });

  card.appendChild(form);
  card.appendChild(links);

  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(card);
  // Defer focus so the surrounding view-switch animation (if any)
  // doesn't steal it back.
  queueMicrotask(() => emailInput.focus());
};

export function friendlyAuthError(code: string, fallback: string): string {
  switch (code) {
    case "bad-credentials":
      return "E-Mail oder Passwort falsch.";
    case "bad-email":
      return "E-Mail-Format ungültig.";
    case "bad-password":
      return "Passwort muss 8-256 Zeichen lang sein.";
    case "account-suspended":
      return "Dieser Account ist gesperrt. Wende dich an den Support.";
    case "rate-limit":
      return "Zu viele Versuche. Bitte später erneut versuchen.";
    case "network-error":
      return "Backend nicht erreichbar.";
    default:
      return fallback;
  }
}
