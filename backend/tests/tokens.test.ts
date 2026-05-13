import { describe, it, expect } from "vitest";
import { newToken, hashToken, timingSafeEquals } from "../src/auth/tokens.js";

describe("newToken", () => {
  it("returns a 64-character hex string (256 bits)", () => {
    const t = newToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces unique values across 100 calls", () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) set.add(newToken());
    expect(set.size).toBe(100);
  });
});

describe("hashToken", () => {
  it("returns a 64-character lower-case hex string (sha256)", () => {
    const h = hashToken("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // sha256("abc") canonical value
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is deterministic", () => {
    expect(hashToken("hello")).toBe(hashToken("hello"));
  });
});

describe("timingSafeEquals", () => {
  // Constant-time compare. The only correctness contracts are:
  // - equal strings → true
  // - different strings of equal length → false (without short-circuit;
  //   we can't observe timing in JS but the loop must run to the end)
  // - mismatched lengths → false (short-circuit OK; no secret content
  //   leaks through the length channel that wasn't already revealed)
  it("returns true for identical strings", () => {
    expect(timingSafeEquals("abc", "abc")).toBe(true);
    expect(timingSafeEquals("", "")).toBe(true);
    const long = "0123456789abcdef".repeat(4); // sha256-hex length
    expect(timingSafeEquals(long, long)).toBe(true);
  });

  it("returns false for same-length strings that differ", () => {
    expect(timingSafeEquals("abc", "abd")).toBe(false);
    // diff in first byte vs last byte should both return false
    expect(timingSafeEquals("abcdef", "Xbcdef")).toBe(false);
    expect(timingSafeEquals("abcdef", "abcdeX")).toBe(false);
  });

  it("returns false for length mismatch", () => {
    expect(timingSafeEquals("abc", "abcd")).toBe(false);
    expect(timingSafeEquals("abcd", "abc")).toBe(false);
    expect(timingSafeEquals("", "a")).toBe(false);
  });

  it("does not throw on Unicode / multibyte input", () => {
    // The function compares byte buffers, not characters. Equal Unicode
    // strings have equal byte sequences, so they match; differing
    // strings of the same byte length still return false without
    // throwing.
    expect(timingSafeEquals("✓", "✓")).toBe(true);
    expect(timingSafeEquals("✓", "✗")).toBe(false);
  });
});
