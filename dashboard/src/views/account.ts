// /dashboard/account — account settings (spec §8.5).
//
// Surfaces:
//   • Current email + verified status, pending email-change banner.
//   • Change email      — PATCH /api/me { current_password, new_email }.
//   • Change password   — PATCH /api/me { current_password, new_password }
//                          → backend revokes ALL sessions of this account;
//                          we follow up by routing the tab to /login.
//   • Delete account    — DELETE /api/me { current_password, confirm: "LÖSCHEN" }
//                          → confirmation string is intentionally
//                          high-friction; we route to /login on success.

import { deleteMe, getMe, patchMe, type Me } from "../api.js";
import { wrapPasswordField } from "../components/password-field.js";
import { formatAbsolute } from "../format.js";
import { navigate, type RouteContext, type RouteRenderer } from "../router.js";
import { refreshSession } from "../session.js";

export const renderAccount: RouteRenderer = (root: HTMLElement, _ctx: RouteContext) => {
  while (root.firstChild) root.removeChild(root.firstChild);

  const card = document.createElement("section");
  card.className = "card";
  const status = document.createElement("p");
  status.className = "loading";
  status.textContent = "Lade Account …";
  card.appendChild(status);
  root.appendChild(card);

  void (async (): Promise<void> => {
    const res = await getMe();
    if (!res.ok) {
      if (res.status === 401) {
        navigate("/login");
        return;
      }
      status.className = "error";
      status.textContent = `Account konnte nicht geladen werden: ${res.message}`;
      return;
    }
    renderEditor(root, res.data);
  })();
};

function renderEditor(root: HTMLElement, me: Me): void {
  while (root.firstChild) root.removeChild(root.firstChild);

  // ── Card 1: identity + email change ─────────────────────────────
  const idCard = document.createElement("section");
  idCard.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "Account";
  idCard.appendChild(h1);

  const emailRow = document.createElement("p");
  emailRow.style.fontSize = "0.9375rem";
  emailRow.style.marginBottom = "0.25rem";
  emailRow.textContent = me.email;
  idCard.appendChild(emailRow);

  const verifiedRow = document.createElement("p");
  verifiedRow.style.fontSize = "0.8125rem";
  verifiedRow.style.color = "var(--text-secondary)";
  verifiedRow.style.marginBottom = "0.75rem";
  verifiedRow.textContent = me.emailVerifiedAt === null
    ? "Noch nicht bestätigt"
    : "Bestätigt am " + formatAbsolute(me.emailVerifiedAt);
  idCard.appendChild(verifiedRow);

  if (me.pendingEmail !== null) {
    const pending = document.createElement("p");
    pending.style.fontSize = "0.875rem";
    pending.style.padding = "0.5rem 0.75rem";
    pending.style.background = "var(--surface)";
    pending.style.border = "1px solid var(--border)";
    pending.style.borderRadius = "6px";
    pending.style.marginBottom = "0.75rem";
    pending.textContent =
      `Änderung auf ${me.pendingEmail} angefragt — bestätige den Link in der Mail an die neue Adresse.`;
    idCard.appendChild(pending);
  }

  const emailForm = document.createElement("form");
  const eh = document.createElement("p");
  eh.style.fontWeight = "600";
  eh.style.marginBottom = "0.5rem";
  eh.textContent = "E-Mail-Adresse ändern";
  emailForm.appendChild(eh);

  const emailNewLabel = document.createElement("label");
  emailNewLabel.htmlFor = "acc-new-email";
  emailNewLabel.textContent = "Neue E-Mail-Adresse";
  emailForm.appendChild(emailNewLabel);
  const emailNewInput = document.createElement("input");
  emailNewInput.type = "email";
  emailNewInput.id = "acc-new-email";
  emailNewInput.autocomplete = "email";
  emailForm.appendChild(emailNewInput);

  const emailPwLabel = document.createElement("label");
  emailPwLabel.htmlFor = "acc-email-current-pw";
  emailPwLabel.textContent = "Aktuelles Passwort";
  emailForm.appendChild(emailPwLabel);
  const emailPwInput = document.createElement("input");
  emailPwInput.type = "password";
  emailPwInput.id = "acc-email-current-pw";
  emailPwInput.autocomplete = "current-password";
  emailForm.appendChild(wrapPasswordField(emailPwInput));

  const emailSubmit = document.createElement("button");
  emailSubmit.type = "submit";
  emailSubmit.className = "primary";
  emailSubmit.textContent = "E-Mail ändern";
  emailForm.appendChild(emailSubmit);

  const emailStatus = document.createElement("p");
  emailStatus.setAttribute("role", "status");
  emailStatus.setAttribute("aria-live", "polite");
  emailStatus.style.fontSize = "0.875rem";
  emailStatus.style.marginTop = "0.5rem";
  emailForm.appendChild(emailStatus);

  emailForm.addEventListener("submit", async (e: SubmitEvent) => {
    e.preventDefault();
    emailStatus.textContent = "";
    const newEmail = emailNewInput.value.trim();
    const current = emailPwInput.value;
    if (newEmail.length === 0 || current.length === 0) {
      emailStatus.style.color = "var(--error)";
      emailStatus.textContent = "Bitte neue Adresse und aktuelles Passwort eingeben.";
      return;
    }
    emailSubmit.disabled = true;
    const old = emailSubmit.textContent;
    emailSubmit.textContent = "Speichere …";
    const res = await patchMe({ current_password: current, new_email: newEmail });
    emailSubmit.disabled = false;
    emailSubmit.textContent = old;
    if (res.ok) {
      emailNewInput.value = "";
      emailPwInput.value = "";
      emailStatus.style.color = "var(--success)";
      emailStatus.textContent =
        "Bestätigungs-Mail an die neue Adresse unterwegs. Klick den Link, dann ist die Adresse aktiv.";
      return;
    }
    emailStatus.style.color = "var(--error)";
    if (res.code === "bad-credentials") {
      emailStatus.textContent = "Aktuelles Passwort falsch.";
    } else if (res.code === "email-taken") {
      emailStatus.textContent = "Diese E-Mail ist bereits registriert.";
    } else if (res.code === "bad-email") {
      emailStatus.textContent = "E-Mail-Format ungültig.";
    } else {
      emailStatus.textContent = `Fehler: ${res.message}`;
    }
  });

  idCard.appendChild(emailForm);
  root.appendChild(idCard);

  // ── Card 2: password change ─────────────────────────────────────
  const pwCard = document.createElement("section");
  pwCard.className = "card";

  const ph = document.createElement("p");
  ph.style.fontWeight = "600";
  ph.style.marginBottom = "0.5rem";
  ph.textContent = "Passwort ändern";
  pwCard.appendChild(ph);

  const pwDesc = document.createElement("p");
  pwDesc.style.fontSize = "0.8125rem";
  pwDesc.style.color = "var(--text-secondary)";
  pwDesc.style.marginBottom = "0.75rem";
  pwDesc.textContent =
    "Eine Passwort-Änderung meldet dich auf allen Geräten ab, auch in diesem Tab.";
  pwCard.appendChild(pwDesc);

  const pwForm = document.createElement("form");

  const pwCurLabel = document.createElement("label");
  pwCurLabel.htmlFor = "acc-current-pw";
  pwCurLabel.textContent = "Aktuelles Passwort";
  pwForm.appendChild(pwCurLabel);
  const pwCurInput = document.createElement("input");
  pwCurInput.type = "password";
  pwCurInput.id = "acc-current-pw";
  pwCurInput.autocomplete = "current-password";
  pwForm.appendChild(wrapPasswordField(pwCurInput));

  const pwNewLabel = document.createElement("label");
  pwNewLabel.htmlFor = "acc-new-pw";
  pwNewLabel.textContent = "Neues Passwort (mindestens 8 Zeichen)";
  pwForm.appendChild(pwNewLabel);
  const pwNewInput = document.createElement("input");
  pwNewInput.type = "password";
  pwNewInput.id = "acc-new-pw";
  pwNewInput.autocomplete = "new-password";
  pwNewInput.minLength = 8;
  pwForm.appendChild(wrapPasswordField(pwNewInput));

  const pwSubmit = document.createElement("button");
  pwSubmit.type = "submit";
  pwSubmit.className = "primary";
  pwSubmit.textContent = "Passwort ändern";
  pwForm.appendChild(pwSubmit);

  const pwStatus = document.createElement("p");
  pwStatus.setAttribute("role", "status");
  pwStatus.setAttribute("aria-live", "polite");
  pwStatus.style.fontSize = "0.875rem";
  pwStatus.style.marginTop = "0.5rem";
  pwForm.appendChild(pwStatus);

  pwForm.addEventListener("submit", async (e: SubmitEvent) => {
    e.preventDefault();
    pwStatus.textContent = "";
    if (pwNewInput.value.length < 8) {
      pwStatus.style.color = "var(--error)";
      pwStatus.textContent = "Neues Passwort muss mindestens 8 Zeichen lang sein.";
      return;
    }
    if (pwCurInput.value.length === 0) {
      pwStatus.style.color = "var(--error)";
      pwStatus.textContent = "Aktuelles Passwort fehlt.";
      return;
    }
    pwSubmit.disabled = true;
    pwSubmit.textContent = "Speichere …";
    const res = await patchMe({
      current_password: pwCurInput.value,
      new_password: pwNewInput.value,
    });
    if (res.ok) {
      // Backend revoked our session — bounce to /login and re-probe so
      // nav/admin-gate/FAB drop the ended session.
      navigate("/login");
      void refreshSession();
      return;
    }
    pwSubmit.disabled = false;
    pwSubmit.textContent = "Passwort ändern";
    pwStatus.style.color = "var(--error)";
    pwStatus.textContent = res.code === "bad-credentials"
      ? "Aktuelles Passwort falsch."
      : `Fehler: ${res.message}`;
  });

  pwCard.appendChild(pwForm);
  root.appendChild(pwCard);

  // ── Card 3: danger zone ─────────────────────────────────────────
  const danger = document.createElement("section");
  danger.className = "card";

  const dh = document.createElement("p");
  dh.style.fontWeight = "600";
  dh.style.color = "var(--error)";
  dh.style.marginBottom = "0.5rem";
  dh.textContent = "Account löschen";
  danger.appendChild(dh);

  const dDesc = document.createElement("p");
  dDesc.style.fontSize = "0.8125rem";
  dDesc.style.color = "var(--text-secondary)";
  dDesc.style.marginBottom = "0.75rem";
  dDesc.textContent =
    'Löscht den Account, alle Geräte und das gesamte Verbindungs-Protokoll unwiderruflich. ' +
    'Zum Bestätigen muss das Wort LÖSCHEN exakt eingegeben werden.';
  danger.appendChild(dDesc);

  const dForm = document.createElement("form");

  const dConfirmLabel = document.createElement("label");
  dConfirmLabel.htmlFor = "acc-confirm";
  dConfirmLabel.textContent = 'Bestätigung (tippe LÖSCHEN)';
  dForm.appendChild(dConfirmLabel);
  const dConfirmInput = document.createElement("input");
  dConfirmInput.type = "text";
  dConfirmInput.id = "acc-confirm";
  dConfirmInput.autocomplete = "off";
  dForm.appendChild(dConfirmInput);

  const dPwLabel = document.createElement("label");
  dPwLabel.htmlFor = "acc-delete-pw";
  dPwLabel.textContent = "Aktuelles Passwort";
  dForm.appendChild(dPwLabel);
  const dPwInput = document.createElement("input");
  dPwInput.type = "password";
  dPwInput.id = "acc-delete-pw";
  dPwInput.autocomplete = "current-password";
  dForm.appendChild(wrapPasswordField(dPwInput));

  const dSubmit = document.createElement("button");
  dSubmit.type = "submit";
  dSubmit.style.background = "var(--error)";
  dSubmit.style.color = "#fff";
  dSubmit.style.border = "none";
  dSubmit.style.padding = "0.5rem 0.875rem";
  dSubmit.style.borderRadius = "6px";
  dSubmit.style.cursor = "pointer";
  dSubmit.style.fontSize = "0.9375rem";
  dSubmit.textContent = "Account unwiderruflich löschen";
  dForm.appendChild(dSubmit);

  const dStatus = document.createElement("p");
  dStatus.setAttribute("role", "status");
  dStatus.setAttribute("aria-live", "polite");
  dStatus.style.fontSize = "0.875rem";
  dStatus.style.marginTop = "0.5rem";
  dForm.appendChild(dStatus);

  dForm.addEventListener("submit", async (e: SubmitEvent) => {
    e.preventDefault();
    dStatus.textContent = "";
    if (dConfirmInput.value !== "LÖSCHEN") {
      dStatus.style.color = "var(--error)";
      dStatus.textContent = 'Bitte exakt das Wort LÖSCHEN eingeben.';
      return;
    }
    if (dPwInput.value.length === 0) {
      dStatus.style.color = "var(--error)";
      dStatus.textContent = "Aktuelles Passwort fehlt.";
      return;
    }
    dSubmit.disabled = true;
    dSubmit.textContent = "Lösche …";
    const res = await deleteMe({
      current_password: dPwInput.value,
      confirm: dConfirmInput.value,
    });
    if (res.ok) {
      navigate("/login");
      // Account weg → Session weg; Nav/FAB entsprechend zurücksetzen.
      void refreshSession();
      return;
    }
    dSubmit.disabled = false;
    dSubmit.textContent = "Account unwiderruflich löschen";
    dStatus.style.color = "var(--error)";
    dStatus.textContent = res.code === "bad-credentials"
      ? "Aktuelles Passwort falsch."
      : `Fehler: ${res.message}`;
  });

  danger.appendChild(dForm);
  root.appendChild(danger);
}
