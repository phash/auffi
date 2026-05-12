import nodemailer, { Transporter } from "nodemailer";

/**
 * Tiny indirection so tests can swap nodemailer for an in-memory recorder
 * and prod can use real SMTP without the call sites caring.
 */
export interface MailTransport {
  send(opts: { to: string; subject: string; text: string }): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
}

/**
 * Parse `SMTP_*` env vars into an SmtpConfig. Returns null if any required
 * field is missing or malformed — call sites use that as the signal to
 * fall back to the in-memory captureTransport (e.g. local dev without an
 * SMTP relay configured).
 */
export function smtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  const portRaw = env.SMTP_PORT?.trim();
  const from = env.SMTP_FROM?.trim();
  const user = env.SMTP_USER?.trim() || undefined;
  const pass = env.SMTP_PASS?.trim() || undefined;
  if (!host || !portRaw || !from) return null;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) return null;
  return { host, port, user, pass, from };
}

/**
 * Real SMTP transport via nodemailer. `secure` is true on the canonical
 * implicit-TLS port (465); STARTTLS / opportunistic encryption on 587 /
 * 25 is left to nodemailer's defaults.
 */
export function smtpTransport(cfg: SmtpConfig): MailTransport {
  const auth = cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined;
  const transporter: Transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth,
  });
  return {
    async send({ to, subject, text }) {
      try {
        await transporter.sendMail({ from: cfg.from, to, subject, text });
      } catch (e) {
        // Re-throw but strip the recipient out of the error message —
        // it shouldn't end up in upstream logs (#11 acceptance criterion).
        const msg = (e as Error).message;
        throw new Error(`smtp send failed: ${msg.replaceAll(to, "<redacted>")}`);
      }
    },
  };
}

/**
 * In-memory capturing transport used by tests. Stores every sent message
 * on `.captured` so assertions can inspect contents without needing an
 * external server. `NODE_ENV=test` defaults to this via mailerFromEnv.
 */
export interface CaptureTransport extends MailTransport {
  readonly captured: ReadonlyArray<{ to: string; subject: string; text: string }>;
  clear(): void;
}

export function captureTransport(): CaptureTransport {
  const captured: { to: string; subject: string; text: string }[] = [];
  return {
    async send(opts) {
      captured.push({ ...opts });
    },
    get captured() {
      return captured;
    },
    clear() {
      captured.length = 0;
    },
  };
}
