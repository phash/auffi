/**
 * Mail templates. German only — the Auffi UI is German, so users wouldn't
 * recognise an English mail as legitimate. Plain text only (per gh #11
 * acceptance criteria): keeps the mails small, avoids HTML-rendering
 * mistakes, sidesteps HTML-injection vectors in user-supplied links.
 *
 * The {{link}} placeholder is the single substitution point. The caller
 * is responsible for building the URL — `https://auffi.app/dashboard/
 * verify/<token>` or analogous — and passing it as a fully-formed string.
 */

export interface TemplateContent {
  subject: string;
  text: string;
}

function applyLink(template: string, link: string): string {
  return template.replaceAll("{{link}}", link);
}

const VERIFY_SUBJECT = "Bestätige deine Auffi-E-Mail-Adresse";
const VERIFY_BODY = `Hallo,

du (oder jemand mit deiner E-Mail-Adresse) hat soeben einen Auffi-Account
angelegt. Damit du dich anmelden kannst, bestätige bitte deine E-Mail-Adresse
über diesen Link:

    {{link}}

Der Link ist 24 Stunden gültig. Falls du dich nicht registriert hast,
kannst du diese E-Mail ignorieren — ohne Bestätigung wird der Account
automatisch verworfen.

— Auffi
https://auffi.app
`;

const RESET_SUBJECT = "Auffi: Passwort zurücksetzen";
const RESET_BODY = `Hallo,

du hast eine Zurücksetzung deines Auffi-Passworts angefordert. Setze ein
neues Passwort über diesen Link:

    {{link}}

Der Link ist 1 Stunde gültig. Sobald du dein Passwort änderst, werden
alle bestehenden Sitzungen (z. B. anderer Browser, Auffi-Sharer im
Unattended-Modus) abgemeldet.

Falls du den Reset nicht angefordert hast, ignoriere diese E-Mail —
dein Passwort bleibt unverändert.

— Auffi
https://auffi.app
`;

export function verifyEmailTemplate(link: string): TemplateContent {
  return { subject: VERIFY_SUBJECT, text: applyLink(VERIFY_BODY, link) };
}

export function resetPasswordTemplate(link: string): TemplateContent {
  return { subject: RESET_SUBJECT, text: applyLink(RESET_BODY, link) };
}
