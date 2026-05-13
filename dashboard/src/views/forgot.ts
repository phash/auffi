// /dashboard/forgot — email form. Backend always returns 200 so the
// UI message is generic on success ("falls die Adresse bei uns ist,
// kommt eine Mail"). Showing the same message whether the address is
// in the DB or not is intentional: distinguishing them would let an
// attacker enumerate accounts.

import { forgotPassword } from "../api.js";
import { BASE_PATH, type RouteContext, type RouteRenderer } from "../router.js";
import { friendlyAuthError } from "./login.js";

export const renderForgot: RouteRenderer = (root: HTMLElement, _ctx: RouteContext) => {
  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "Passwort zurücksetzen";
  card.appendChild(h1);

  const desc = document.createElement("p");
  desc.style.fontSize = "0.875rem";
  desc.style.color = "var(--text-secondary)";
  desc.style.marginBottom = "0.75rem";
  desc.textContent =
    "Gib deine Account-E-Mail-Adresse ein. Wir schicken dir einen Link, mit dem du ein neues Passwort setzen kannst.";
  card.appendChild(desc);

  const form = document.createElement("form");
  form.noValidate = true;

  const emailLabel = document.createElement("label");
  emailLabel.htmlFor = "forgot-email";
  emailLabel.textContent = "E-Mail";
  const emailInput = document.createElement("input");
  emailInput.type = "email";
  emailInput.id = "forgot-email";
  emailInput.name = "email";
  emailInput.autocomplete = "username";
  emailInput.required = true;

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "Reset-Link schicken";

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
  const back = document.createElement("a");
  back.href = BASE_PATH + "/login";
  back.textContent = "← Zurück zur Anmeldung";
  links.appendChild(back);

  form.append(emailLabel, emailInput, submit, errorBox, successBox);

  form.addEventListener("submit", async (e: SubmitEvent) => {
    e.preventDefault();
    errorBox.textContent = "";
    successBox.textContent = "";
    submit.disabled = true;
    submit.textContent = "Sende …";
    const res = await forgotPassword(emailInput.value.trim());
    submit.disabled = false;
    submit.textContent = "Reset-Link schicken";
    if (res.ok) {
      // Lock the email field so the user doesn't fire a second
      // request while waiting for the mail. The login-link below
      // stays clickable.
      emailInput.disabled = true;
      submit.disabled = true;
      successBox.textContent =
        "Falls die Adresse bei uns registriert ist, ist eine Mail mit einem Reset-Link unterwegs.";
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
