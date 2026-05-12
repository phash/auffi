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
