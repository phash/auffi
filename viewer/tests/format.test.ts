import { describe, it, expect } from "vitest";
import { formatBytes } from "../src/format.js";

// Shared byte formatter — single source of truth for the compact bar AND the
// session summary (previously two drifted copies; a >1 GB file rendered as
// "1024.00 MB" in the summary).
describe("formatBytes", () => {
  it("formats bytes below 1 KB as plain B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats KB with one decimal (binary divisor)", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1500)).toBe("1.5 KB");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats MB with one decimal (binary divisor)", () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("formats GB with two decimals above 1 GiB", () => {
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
    // Regression: the old session-summary copy had no GB tier and showed
    // "1024.00 MB" here.
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
  });

  it("clamps invalid input to 0 B", () => {
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(-100)).toBe("0 B");
    expect(formatBytes(Infinity)).toBe("0 B");
  });
});
