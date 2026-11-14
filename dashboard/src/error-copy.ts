// German copy for backend error codes outside the auth/account forms
// (those keep their own maps in login.ts / account.ts). Backend `bad()`
// messages are English diagnostics; per api.ts the raw message is only the
// fallback for codes a view does not expect, such as a 5xx.

import type { ApiErr } from "./api.js";

export type ErrorCopy = Readonly<Record<string, string>>;

export function localizedError(res: ApiErr, copy: ErrorCopy): string {
  return Object.hasOwn(copy, res.code) ? copy[res.code] : res.message;
}

/** /api/devices/:id and /api/devices/:id/log answer 403 for a foreign or unpaired device. */
export const DEVICE_ERRORS: ErrorCopy = {
  forbidden:
    "Dieses Gerät gehört nicht (mehr) zu deinem Account — wurde es inzwischen entkoppelt?",
  "bad-alias": "Name muss 1–80 Zeichen haben.",
  "no-changes": "Keine Änderung angegeben.",
};

const ADMIN_REQUIRED = "Du musst Admin sein.";

export const ADMIN_USER_ERRORS: ErrorCopy = {
  "admin-required": ADMIN_REQUIRED,
  "no-self-delete": "Den eigenen Account löschst du unter „Konto“.",
  "bad-reason": "Bitte einen Grund angeben.",
  "not-found": "Nutzer nicht gefunden — wurde er inzwischen gelöscht?",
};

export const ADMIN_FEEDBACK_ERRORS: ErrorCopy = {
  "admin-required": ADMIN_REQUIRED,
  "bad-reply": "Bitte Text eingeben.",
  "not-found": "Feedback-Eintrag nicht gefunden — wurde er inzwischen gelöscht?",
};
