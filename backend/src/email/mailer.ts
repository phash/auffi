import type { AuthMailer } from "../auth/handlers.js";
import type { AccountMailer } from "../account/me.js";
import {
  emailChangeTemplate,
  feedbackReplyTemplate,
  resetPasswordTemplate,
  verifyEmailTemplate,
} from "./templates.js";
import {
  type MailTransport,
  captureTransport,
  smtpConfigFromEnv,
  smtpTransport,
} from "./transport.js";

/**
 * Mails fired when an admin replies to user feedback in the dashboard.
 * Separated from `AuthMailer` / `AccountMailer` so the admin-feedback
 * module doesn't accidentally inherit unrelated mail surfaces.
 */
export interface FeedbackMailer {
  sendReply(opts: {
    to: string;
    originalBody: string;
    replyText: string;
  }): Promise<void>;
}

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
 * Mailer for /api/me email-change verification. Kept separate from
 * `AuthMailer` so a stub transport for one flow can be swapped without
 * touching the other.
 */
export function buildAccountMailer(cfg: MailerConfig): AccountMailer {
  const base = cfg.dashboardUrl.replace(/\/+$/, "");
  return {
    async sendEmailChangeVerification(newEmail, token) {
      const link = `${base}/verify-email-change/${token}`;
      const { subject, text } = emailChangeTemplate(link);
      await cfg.transport.send({ to: newEmail, subject, text });
    },
  };
}

export function buildFeedbackMailer(cfg: { transport: MailTransport }): FeedbackMailer {
  return {
    async sendReply({ to, originalBody, replyText }) {
      const { subject, text } = feedbackReplyTemplate(originalBody, replyText);
      await cfg.transport.send({ to, subject, text });
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
  accountMailer: AccountMailer;
  feedbackMailer: FeedbackMailer;
  transport: MailTransport;
} {
  const dashboardUrl = env.DASHBOARD_URL?.trim() || DEFAULT_DASHBOARD_URL;
  const wantTransport = (): MailTransport => {
    if (env.NODE_ENV === "test") return captureTransport();
    const cfg = smtpConfigFromEnv(env);
    if (!cfg) {
      // No SMTP wired up — fall back to capture so signup still works
      // locally (mail just isn't delivered). Wrap the capture transport
      // so every "sent" mail is also dumped to stderr — that way an
      // operator who forgot to configure SMTP on prod still has a
      // grep-able path to extract the verify-link plaintext from
      // `docker logs`, and an obvious red signal (`[mailer:no-smtp]`)
      // that mail delivery is broken. Logs are stderr, redacted by
      // the Fastify pino setup, and not world-readable on the host.
      const inner = captureTransport();
      return {
        async send(opts) {
          process.stderr.write(
            `[mailer:no-smtp] to=${opts.to} subject=${JSON.stringify(opts.subject)}\n` +
              `[mailer:no-smtp] body=\n${opts.text}\n`,
          );
          await inner.send(opts);
        },
        // Preserve the CaptureTransport-shape so tests + admin tooling
        // can still inspect the in-memory buffer of "sent" mails.
        get captured() {
          return inner.captured;
        },
        clear() {
          inner.clear();
        },
      } as MailTransport;
    }
    return smtpTransport(cfg);
  };
  const transport = wantTransport();
  return {
    mailer: buildAuthMailer({ dashboardUrl, transport }),
    accountMailer: buildAccountMailer({ dashboardUrl, transport }),
    feedbackMailer: buildFeedbackMailer({ transport }),
    transport,
  };
}
