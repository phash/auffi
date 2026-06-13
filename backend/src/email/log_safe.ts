/**
 * Helpers that keep recipient addresses (PII) out of the logs.
 *
 * CLAUDE.md § Security & DSGVO forbids logging PII. SMTP failures are the
 * sneaky offender: nodemailer routinely embeds the envelope recipient in
 * its error messages ("550 5.1.1 <user@example.com> unknown"), so logging
 * the raw error object leaks the address. These helpers reduce both the
 * address and the error to a non-PII shape that is still diagnosable.
 */

/**
 * Mask the local-part of an email so logs show the shape (and the domain,
 * which is rarely PII on its own) without the identifying mailbox name.
 * `maria.mueller@example.com` → `m***@example.com`.
 */
export function redactEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Reduce an arbitrary thrown value to a log-safe summary: the error class
 * name plus the transport's machine code (e.g. `EENVELOPE`, `EAUTH`) when
 * present. Deliberately drops `.message` — that is where SMTP servers echo
 * the recipient address back.
 */
export function mailErrorInfo(err: unknown): { name: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      code: typeof code === "string" ? code : undefined,
    };
  }
  return { name: "UnknownError" };
}
