// /dashboard/signup — POST /api/auth/signup. Backend returns 202
// regardless of whether the address is deliverable (the verify
// mail goes out fire-and-forget). We show a "Bestätigung
// unterwegs" message after success; the user follows the mail
// link to land on /verify/:token.

import { signup } from "../api.js";
import { BASE_PATH, type RouteContext, type RouteRenderer } from "../router.js";
import { friendlyAuthError } from "./login.js";

export const renderSignup: RouteRenderer = (root: HTMLElement, _ctx: RouteContext) => {
  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "Account anlegen";
  card.appendChild(h1);

  const form = document.createElement("form");
  form.noValidate = true;

  const emailLabel = document.createElement("label");
  emailLabel.htmlFor = "signup-email";
  emailLabel.textContent = "E-Mail";
  const emailInput = document.createElement("input");
  emailInput.type = "email";
  emailInput.id = "signup-email";
  emailInput.name = "email";
  emailInput.autocomplete = "username";
  emailInput.required = true;

  const pwLabel = document.createElement("label");
  pwLabel.htmlFor = "signup-password";
  pwLabel.textContent = "Passwort (8-256 Zeichen)";
  const pwInput = document.createElement("input");
  pwInput.type = "password";
  pwInput.id = "signup-password";
  pwInput.name = "password";
  pwInput.autocomplete = "new-password";
  pwInput.required = true;
  pwInput.minLength = 8;

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "Account anlegen";

  const errorBox = document.createElement("p");
  errorBox.className = "error";
  errorBox.setAttribute("role", "alert");
  errorBox.setAttribute("aria-live", "polite");

  const successBox = document.createElement("p");
  successBox.setAttribute("role", "status");
  successBox.setAttribute("aria-live", "polite");
  successBox.style.color = "var(--success)";
  successBox.style.fontSize = "0.9375rem";
  successBox.style.marginTop = "0.5rem";

  const links = document.createElement("p");
  links.style.marginTop = "0.75rem";
  links.style.fontSize = "0.875rem";
  const loginLink = document.createElement("a");
  loginLink.href = BASE_PATH + "/login";
  loginLink.textContent = "Schon registriert? Anmelden";
  links.appendChild(loginLink);

  form.append(emailLabel, emailInput, pwLabel, pwInput, submit, errorBox, successBox);

  form.addEventListener("submit", async (e: SubmitEvent) => {
    e.preventDefault();
    errorBox.textContent = "";
    successBox.textContent = "";
    submit.disabled = true;
    submit.textContent = "Speichere …";
    const res = await signup(emailInput.value.trim(), pwInput.value);
    submit.disabled = false;
    submit.textContent = "Account anlegen";
    if (res.ok) {
      // Lock the form so the user can't double-submit before the
      // mail arrives. The Anmelden-Link bleibt klickbar.
      emailInput.disabled = true;
      pwInput.disabled = true;
      submit.disabled = true;
      successBox.textContent =
        "Bestätigungs-Mail unterwegs. Klick auf den Link in der Mail, um die Adresse zu bestätigen.";
      return;
    }
    if (res.code === "email-taken") {
      errorBox.textContent =
        "Diese E-Mail ist bereits registriert. Bitte anmelden oder Passwort zurücksetzen.";
      return;
    }
    errorBox.textContent = friendlyAuthError(res.code, res.message);
  });

  card.appendChild(form);
  card.appendChild(links);

  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(card);
  queueMicrotask(() => emailInput.focus());
};
