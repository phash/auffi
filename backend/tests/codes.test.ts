import { describe, it, expect } from "vitest";
import { generateCode, normalizeCode } from "../src/codes.js";

describe("generateCode", () => {
  it("produces 11-character code in format DDD-DDD-DDD", () => {
    const code = generateCode();
    expect(code).toMatch(/^\d{3}-\d{3}-\d{3}$/);
  });

  it("produces different codes on repeated calls", () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateCode()));
    expect(codes.size).toBeGreaterThan(90); // collisions extremely unlikely
  });
});

describe("normalizeCode", () => {
  it("strips spaces and dashes", () => {
    expect(normalizeCode("284 915 073")).toBe("284-915-073");
    expect(normalizeCode("284915073")).toBe("284-915-073");
    expect(normalizeCode("284-915-073")).toBe("284-915-073");
  });

  it("returns null for invalid codes", () => {
    expect(normalizeCode("abc")).toBeNull();
    expect(normalizeCode("123")).toBeNull();
    expect(normalizeCode("1234567890")).toBeNull();
  });
});
