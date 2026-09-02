import { describe, it, expect, beforeEach, vi } from "vitest";
import nodemailer from "nodemailer";
import { smtpTransport } from "../src/email/transport.js";
import { mailErrorInfo } from "../src/email/log_safe.js";

// nodemailer is mocked so no socket is ever opened; only the wrapper's
// contract around createTransport / sendMail is under test here.
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn() } }));

const createTransport = vi.mocked(nodemailer.createTransport);

function transportRejectingWith(err: Error): void {
  createTransport.mockReturnValue({
    sendMail: vi.fn().mockRejectedValue(err),
  } as unknown as ReturnType<typeof nodemailer.createTransport>);
}

describe("smtpTransport", () => {
  beforeEach(() => {
    createTransport.mockReset();
  });

  it("keeps nodemailer's error code so mailErrorInfo stays diagnosable", async () => {
    // log_safe drops `.message` (it echoes the recipient) and logs `{name,
    // code}` instead — that only helps an operator if the code survives
    // the wrapper. A bare `new Error(...)` re-throw lost it.
    transportRejectingWith(
      Object.assign(new Error("550 5.1.1 <victim@example.com> unknown"), { code: "EENVELOPE" }),
    );
    const t = smtpTransport({ host: "mail", port: 587, from: "noreply@example.test" });
    const thrown = await t.send({ to: "victim@example.com", subject: "s", text: "t" }).catch((e) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(mailErrorInfo(thrown).code).toBe("EENVELOPE");
    expect((thrown as Error).message).not.toContain("victim@example.com");
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });

  it("redacts the recipient case-insensitively — SMTP servers echo it lowercased", async () => {
    transportRejectingWith(new Error("550 <maria.mueller@example.com> unknown"));
    const t = smtpTransport({ host: "mail", port: 587, from: "noreply@example.test" });
    const thrown = await t
      .send({ to: "Maria.Mueller@Example.com", subject: "s", text: "t" })
      .catch((e) => e);
    expect((thrown as Error).message).not.toMatch(/maria\.mueller@example\.com/i);
    expect((thrown as Error).message).toContain("<redacted>");
  });
});
