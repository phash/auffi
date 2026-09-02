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
angelegt. Bitte bestätige deine E-Mail-Adresse über diesen Link:

    {{link}}

Der Link ist 24 Stunden gültig. Falls du dich nicht registriert hast,
kannst du diese E-Mail ignorieren — ein unbestätigtes, nie genutztes
Konto wird nach 7 Tagen automatisch gelöscht.

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

const EMAIL_CHANGE_SUBJECT = "Bestätige deine neue Auffi-E-Mail-Adresse";
const EMAIL_CHANGE_BODY = `Hallo,

du hast angefordert, die mit deinem Auffi-Account verknüpfte
E-Mail-Adresse zu ändern. Bestätige die neue Adresse über diesen Link:

    {{link}}

Der Link ist 24 Stunden gültig. Bis du ihn anklickst, bleibt deine
alte Adresse aktiv — falls du dich vertippt hast oder die Anfrage
nicht von dir kam, kannst du diese E-Mail einfach ignorieren.

— Auffi
https://auffi.app
`;

export function verifyEmailTemplate(link: string): TemplateContent {
  return { subject: VERIFY_SUBJECT, text: applyLink(VERIFY_BODY, link) };
}

export function resetPasswordTemplate(link: string): TemplateContent {
  return { subject: RESET_SUBJECT, text: applyLink(RESET_BODY, link) };
}

export function emailChangeTemplate(link: string): TemplateContent {
  return { subject: EMAIL_CHANGE_SUBJECT, text: applyLink(EMAIL_CHANGE_BODY, link) };
}

const FEEDBACK_REPLY_SUBJECT = "Antwort auf dein Auffi-Feedback";

/**
 * Reply to user-submitted feedback. Quotes the user's original message
 * so they can place the answer in context without scrolling back through
 * their own send-folder. Both texts are user-generated; we trust them
 * because the plain-text mail body cannot inject markup, and the SMTP
 * transport already redacts the recipient on error.
 */
export function feedbackReplyTemplate(
  originalBody: string,
  replyText: string,
): TemplateContent {
  const quoted = originalBody
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  const text = `Hallo,

du hast vor einiger Zeit Feedback zu Auffi eingereicht — hier die Antwort
darauf:

${replyText}

────────────────────────────────────────────────────────────
Dein urspruengliches Feedback:

${quoted}
────────────────────────────────────────────────────────────

Falls du nachfragen oder weitere Punkte einreichen moechtest, klick im
Dashboard auf das Feedback-Symbol unten rechts.

— Auffi
https://auffi.app
`;
  return { subject: FEEDBACK_REPLY_SUBJECT, text };
}
