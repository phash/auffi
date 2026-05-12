import type { AuthMailer } from "../auth/handlers.js";
import { resetPasswordTemplate, verifyEmailTemplate } from "./templates.js";
import {
  type MailTransport,
  captureTransport,
  smtpConfigFromEnv,
  smtpTransport,
} from "./transport.js";

/**
 * Default link base used when DASHBOARD_URL is unset. Self-hosted
 * instances override via env.
 */
const DEFAULT_DASHBOARD_URL = "https://auffi.app/dashboard";

export interface MailerConfig {
  /** Base URL of the dashboard, without trailing slash. */
  dashboardUrl: string;
  /** Transport used to actually send. */
  transport: MailTransport;
}

/**
 * Compose the verify and reset mail bodies and hand them to the transport.
 * The `AuthMailer` shape matches what the auth handlers expect.
 */
export function buildAuthMailer(cfg: MailerConfig): AuthMailer {
  const base = cfg.dashboardUrl.replace(/\/+$/, "");
  return {
    async sendVerifyEmail(email, token) {
      const link = `${base}/verify/${token}`;
      const { subject, text } = verifyEmailTemplate(link);
      await cfg.transport.send({ to: email, subject, text });
    },
    async sendResetEmail(email, token) {
      const link = `${base}/reset/${token}`;
      const { subject, text } = resetPasswordTemplate(link);
      await cfg.transport.send({ to: email, subject, text });
    },
  };
}

/**
 * Resolve the appropriate transport from env vars:
 *  - NODE_ENV=test or missing SMTP_* → in-memory capture
 *  - otherwise → real nodemailer SMTP
 *
 * Returns the assembled AuthMailer plus the underlying transport (so
 * tests can grab the capture handle).
 */
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): {
  mailer: AuthMailer;
  transport: MailTransport;
} {
  const dashboardUrl = env.DASHBOARD_URL?.trim() || DEFAULT_DASHBOARD_URL;
  if (env.NODE_ENV === "test") {
    const transport = captureTransport();
    return { mailer: buildAuthMailer({ dashboardUrl, transport }), transport };
  }
  const cfg = smtpConfigFromEnv(env);
  if (!cfg) {
    // No SMTP wired up — fall back to capture so signup still works
    // locally (mail just isn't delivered). The /api/auth/signup handler
    // logs a fire-and-forget warning so the dev sees it.
    const transport = captureTransport();
    return { mailer: buildAuthMailer({ dashboardUrl, transport }), transport };
  }
  const transport = smtpTransport(cfg);
  return { mailer: buildAuthMailer({ dashboardUrl, transport }), transport };
}
