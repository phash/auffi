import { describe, it, expect } from "vitest";
import { formatRelative } from "../src/format.js";

const NOW = 10_000_000_000;

describe("formatRelative", () => {
  it("renders null as em-dash", () => {
    expect(formatRelative(null, NOW)).toBe("—");
  });

  it("just-now (<1 min) → 'gerade eben'", () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe("gerade eben");
  });

  it("under an hour → 'vor N Min'", () => {
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe("vor 5 Min");
    expect(formatRelative(NOW - 59 * 60_000, NOW)).toBe("vor 59 Min");
  });

  it("under a day → 'vor N Std'", () => {
    expect(formatRelative(NOW - 60 * 60_000, NOW)).toBe("vor 1 Std");
    expect(formatRelative(NOW - 23 * 60 * 60_000, NOW)).toBe("vor 23 Std");
  });

  it("under a week → 'vor N Tag(en)' with singular/plural", () => {
    expect(formatRelative(NOW - 24 * 60 * 60_000, NOW)).toBe("vor 1 Tag");
    expect(formatRelative(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe("vor 3 Tagen");
  });

  it("past a week → absolute DD.MM.YYYY (de-DE)", () => {
    const out = formatRelative(NOW - 30 * 24 * 60 * 60_000, NOW);
    expect(out).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  it("future timestamps clamp to 'gerade eben' (no negative)", () => {
    expect(formatRelative(NOW + 5_000, NOW)).toBe("gerade eben");
  });
});
