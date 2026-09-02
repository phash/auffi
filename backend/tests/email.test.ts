import { describe, it, expect } from "vitest";
import { verifyEmailTemplate, resetPasswordTemplate } from "../src/email/templates.js";
import {
  captureTransport,
  smtpConfigFromEnv,
} from "../src/email/transport.js";
import { buildAuthMailer, mailerFromEnv } from "../src/email/mailer.js";

describe("email templates", () => {
  it("verify template snapshot", () => {
    const out = verifyEmailTemplate("https://auffi.app/dashboard/verify/ABC123");
    expect(out.subject).toBe("Bestätige deine Auffi-E-Mail-Adresse");
    expect(out).toMatchSnapshot();
  });

  it("reset template snapshot", () => {
    const out = resetPasswordTemplate("https://auffi.app/dashboard/reset/XYZ987");
    expect(out.subject).toBe("Auffi: Passwort zurücksetzen");
    expect(out).toMatchSnapshot();
  });

  it("link placeholder replaced everywhere", () => {
    const out = verifyEmailTemplate("https://example.test/x/y");
    expect(out.text).not.toContain("{{link}}");
    expect(out.text).toContain("https://example.test/x/y");
  });
});

describe("smtpConfigFromEnv", () => {
  it("returns null when required vars are missing", () => {
    expect(smtpConfigFromEnv({})).toBeNull();
    expect(smtpConfigFromEnv({ SMTP_HOST: "mail" })).toBeNull();
    expect(smtpConfigFromEnv({ SMTP_HOST: "mail", SMTP_PORT: "587" })).toBeNull();
  });

  it("parses a complete env block", () => {
    const cfg = smtpConfigFromEnv({
      SMTP_HOST: "mail.example.test",
      SMTP_PORT: "587",
      SMTP_USER: "noreply@example.test",
      SMTP_PASS: "s3cret",
      SMTP_FROM: "Auffi <noreply@example.test>",
    });
    expect(cfg).toEqual({
      host: "mail.example.test",
      port: 587,
      user: "noreply@example.test",
      pass: "s3cret",
      from: "Auffi <noreply@example.test>",
    });
  });

  it("rejects non-numeric or out-of-range port", () => {
    expect(
      smtpConfigFromEnv({
        SMTP_HOST: "mail",
        SMTP_PORT: "not-a-port",
        SMTP_FROM: "x@y",
      }),
    ).toBeNull();
    expect(
      smtpConfigFromEnv({
        SMTP_HOST: "mail",
        SMTP_PORT: "99999",
        SMTP_FROM: "x@y",
      }),
    ).toBeNull();
  });

  it("treats missing user/pass as anonymous", () => {
    const cfg = smtpConfigFromEnv({
      SMTP_HOST: "mail",
      SMTP_PORT: "25",
      SMTP_FROM: "x@y",
    });
    expect(cfg?.user).toBeUndefined();
    expect(cfg?.pass).toBeUndefined();
  });
});

describe("buildAuthMailer + capture transport", () => {
  it("sendVerifyEmail wires link from token via dashboardUrl", async () => {
    const transport = captureTransport();
    const mailer = buildAuthMailer({
      dashboardUrl: "https://auffi.app/dashboard",
      transport,
    });
    await mailer.sendVerifyEmail("alice@example.com", "abc123");
    expect(transport.captured).toHaveLength(1);
    const m = transport.captured[0];
    expect(m.to).toBe("alice@example.com");
    expect(m.subject).toBe("Bestätige deine Auffi-E-Mail-Adresse");
    expect(m.text).toContain("https://auffi.app/dashboard/verify/abc123");
  });

  it("sendResetEmail wires link from token", async () => {
    const transport = captureTransport();
    const mailer = buildAuthMailer({
      dashboardUrl: "https://auffi.app/dashboard",
      transport,
    });
    await mailer.sendResetEmail("bob@example.com", "tok999");
    expect(transport.captured[0].subject).toBe("Auffi: Passwort zurücksetzen");
    expect(transport.captured[0].text).toContain(
      "https://auffi.app/dashboard/reset/tok999",
    );
  });

  it("trims trailing slashes from dashboardUrl", async () => {
    const transport = captureTransport();
    const mailer = buildAuthMailer({
      dashboardUrl: "https://auffi.app/dashboard/",
      transport,
    });
    await mailer.sendVerifyEmail("c@example.com", "tok");
    expect(transport.captured[0].text).toContain("https://auffi.app/dashboard/verify/tok");
    expect(transport.captured[0].text).not.toContain("dashboard//verify");
  });
});

describe("mailerFromEnv", () => {
  it("returns capture transport when NODE_ENV=test", () => {
    const out = mailerFromEnv({ NODE_ENV: "test" });
    expect(out.transport).toHaveProperty("captured");
  });

  it("returns capture transport when no SMTP_* env is set", () => {
    const out = mailerFromEnv({ NODE_ENV: "production" });
    expect(out.transport).toHaveProperty("captured");
  });

  it("uses real SMTP transport when env is complete", () => {
    const out = mailerFromEnv({
      NODE_ENV: "production",
      SMTP_HOST: "mail.example.test",
      SMTP_PORT: "587",
      SMTP_FROM: "noreply@example.test",
    });
    // smtpTransport produces an object with only a `send` method; the
    // capture variant exposes `captured`. Distinguish by the latter.
    expect(out.transport).not.toHaveProperty("captured");
    expect(typeof out.transport.send).toBe("function");
  });

  it("respects DASHBOARD_URL override", async () => {
    const out = mailerFromEnv({
      NODE_ENV: "test",
      DASHBOARD_URL: "https://self-hosted.example/db",
    });
    await out.mailer.sendVerifyEmail("x@y", "tok");
    const captured = (out.transport as { captured: { text: string }[] }).captured;
    expect(captured[0].text).toContain("https://self-hosted.example/db/verify/tok");
  });
});

describe("mailerFromEnv — no-SMTP fallback token-leak fix", () => {
  it("logs recipient + subject but NOT the body when AUFFI_LOG_MAIL_BODIES is unset", async () => {
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // Capture stderr without touching AUFFI_LOG_MAIL_BODIES in process.env.
    (process.stderr as { write: (s: string) => boolean }).write = (s: string) => {
      stderrLines.push(s);
      return true;
    };
    try {
      delete process.env.AUFFI_LOG_MAIL_BODIES;
      const out = mailerFromEnv({ NODE_ENV: "production" }); // no SMTP → fallback
      await out.mailer.sendVerifyEmail("victim@example.com", "secret-token-abc");
    } finally {
      (process.stderr as { write: (s: string) => boolean }).write = origWrite;
    }
    const combined = stderrLines.join("");
    // Recipient is redacted — the full address (PII) must NEVER hit the logs.
    expect(combined).toContain("v***@example.com");
    expect(combined).not.toContain("victim@example.com");
    // Token must NOT appear in logs when body-dump is disabled.
    expect(combined).not.toContain("secret-token-abc");
  });

  it("logs the full body including the token when the injected env sets AUFFI_LOG_MAIL_BODIES=1", async () => {
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (s: string) => boolean }).write = (s: string) => {
      stderrLines.push(s);
      return true;
    };
    try {
      // The flag must come from the env object mailerFromEnv was given, not
      // from process.env — the injection exists so tests never touch it.
      delete process.env.AUFFI_LOG_MAIL_BODIES;
      const out = mailerFromEnv({ NODE_ENV: "production", AUFFI_LOG_MAIL_BODIES: "1" });
      await out.mailer.sendVerifyEmail("dev@example.com", "dev-token-xyz");
    } finally {
      (process.stderr as { write: (s: string) => boolean }).write = origWrite;
    }
    const combined = stderrLines.join("");
    // Recipient stays redacted even with body-dump on.
    expect(combined).toContain("d***@example.com");
    expect(combined).not.toContain("dev@example.com");
    // Body dump is explicitly enabled — the token link must appear.
    expect(combined).toContain("dev-token-xyz");
  });
});
