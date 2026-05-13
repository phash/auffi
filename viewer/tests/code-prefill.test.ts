import { describe, it, expect } from "vitest";
import { codeFromQuery, normaliseCodeInput } from "../src/ui.js";

describe("normaliseCodeInput", () => {
  it("strips non-digits and reformats", () => {
    expect(normaliseCodeInput("123456789")).toBe("123-456-789");
    expect(normaliseCodeInput("123-456-789")).toBe("123-456-789");
    expect(normaliseCodeInput("  123 456 789  ")).toBe("123-456-789");
    expect(normaliseCodeInput("123.456.789")).toBe("123-456-789");
  });

  it("clamps at 9 digits", () => {
    expect(normaliseCodeInput("1234567890123")).toBe("123-456-789");
  });

  it("renders partial input progressively", () => {
    expect(normaliseCodeInput("1")).toBe("1");
    expect(normaliseCodeInput("123")).toBe("123");
    expect(normaliseCodeInput("1234")).toBe("123-4");
    expect(normaliseCodeInput("12345")).toBe("123-45");
    expect(normaliseCodeInput("123456")).toBe("123-456");
    expect(normaliseCodeInput("1234567")).toBe("123-456-7");
  });

  it("returns empty for empty / no-digit input", () => {
    expect(normaliseCodeInput("")).toBe("");
    expect(normaliseCodeInput("abc-def-ghi")).toBe("");
  });
});

describe("codeFromQuery (gh #37)", () => {
  it("returns null when no ?code is present", () => {
    expect(codeFromQuery("")).toBeNull();
    expect(codeFromQuery("?foo=bar")).toBeNull();
  });

  it("returns the normalised code for a well-formed param", () => {
    expect(codeFromQuery("?code=123-456-789")).toBe("123-456-789");
    expect(codeFromQuery("?code=123456789")).toBe("123-456-789");
  });

  it("tolerates URL-encoded dashes / spaces / smart-paste", () => {
    expect(codeFromQuery("?code=123%20456%20789")).toBe("123-456-789");
    expect(codeFromQuery("?code=123.456.789")).toBe("123-456-789");
  });

  it("returns null for partial input (won't half-fill the field)", () => {
    expect(codeFromQuery("?code=12345")).toBeNull();
    expect(codeFromQuery("?code=")).toBeNull();
  });

  it("ignores additional query params alongside code", () => {
    expect(codeFromQuery("?utm=foo&code=123-456-789&other=x")).toBe(
      "123-456-789",
    );
  });
});
