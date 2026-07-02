import { describe, it, expect } from "vitest";
import { newToken, hashToken } from "../src/auth/tokens.js";

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
