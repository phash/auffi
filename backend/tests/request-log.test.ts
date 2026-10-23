import { describe, it, expect } from "vitest";
import { serializeRequest } from "../src/server.js";

describe("serializeRequest (request log line)", () => {
  // The mailed one-shot tokens travel in the path; a log line holding them
  // is a working password-reset / account-takeover link for anyone with
  // log access.
  it.each([
    ["/api/auth/reset/abc123def", "/api/auth/reset/[redacted]"],
    ["/api/auth/verify/abc123def", "/api/auth/verify/[redacted]"],
    ["/api/me/email-change/abc123def", "/api/me/email-change/[redacted]"],
    ["/api/auth/verify/abc123def?utm=x", "/api/auth/verify/[redacted]?utm=x"],
  ])("redacts the token in %s", (url, logged) => {
    expect(serializeRequest({ method: "GET", url })).toEqual({ method: "GET", url: logged });
  });

  it("leaves token-free URLs untouched", () => {
    expect(serializeRequest({ method: "POST", url: "/api/auth/forgot" })).toEqual({
      method: "POST",
      url: "/api/auth/forgot",
    });
    expect(serializeRequest({ method: "GET", url: "/api/devices/123-456-789/log" })).toEqual({
      method: "GET",
      url: "/api/devices/123-456-789/log",
    });
  });
});
