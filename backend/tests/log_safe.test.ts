import { describe, it, expect } from "vitest";
import { redactEmail, mailErrorInfo } from "../src/email/log_safe.js";

describe("redactEmail", () => {
  it("masks the local part but keeps the domain", () => {
    expect(redactEmail("maria.mueller@example.com")).toBe("m***@example.com");
  });

  it("masks a single-char local part without revealing length", () => {
    expect(redactEmail("a@example.com")).toBe("a***@example.com");
  });

  it("returns *** for inputs without a usable address shape", () => {
    expect(redactEmail("not-an-email")).toBe("***");
    expect(redactEmail("@example.com")).toBe("***");
    expect(redactEmail("user@")).toBe("***");
    expect(redactEmail("")).toBe("***");
  });

  it("splits on the LAST @ so quoted local parts don't leak", () => {
    expect(redactEmail('"weird@local"@example.com')).toBe('"***@example.com');
  });
});

describe("mailErrorInfo", () => {
  it("keeps the error name and code but drops the (PII-bearing) message", () => {
    const err = Object.assign(new Error("550 5.1.1 <victim@example.com> unknown"), {
      code: "EENVELOPE",
    });
    const info = mailErrorInfo(err);
    expect(info).toEqual({ name: "Error", code: "EENVELOPE" });
    expect(JSON.stringify(info)).not.toContain("victim@example.com");
  });

  it("omits code when the error has none", () => {
    expect(mailErrorInfo(new TypeError("boom"))).toEqual({ name: "TypeError", code: undefined });
  });

  it("handles non-Error throws", () => {
    expect(mailErrorInfo("some string")).toEqual({ name: "UnknownError" });
    expect(mailErrorInfo(null)).toEqual({ name: "UnknownError" });
  });
});
