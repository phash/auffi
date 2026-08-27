import { describe, it, expect } from "vitest";
import { formatDate, formatRelative, formatUptime } from "../src/format.js";

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

describe("formatUptime", () => {
  const MIN = 60;
  const HR = 60 * MIN;
  const DAY = 24 * HR;

  it("renders sub-minute uptimes in seconds", () => {
    expect(formatUptime(0)).toBe("0 Sek");
    expect(formatUptime(59)).toBe("59 Sek");
  });

  it("renders sub-hour uptimes in minutes", () => {
    expect(formatUptime(MIN)).toBe("1 Min");
    expect(formatUptime(59 * MIN + 59)).toBe("59 Min");
  });

  it("renders sub-day uptimes as 'H Std M Min'", () => {
    expect(formatUptime(HR)).toBe("1 Std");
    expect(formatUptime(HR + MIN)).toBe("1 Std 1 Min");
    expect(formatUptime(23 * HR + 59 * MIN)).toBe("23 Std 59 Min");
  });

  it("renders day-scale uptimes as 'T Tag(e) H Std' with singular/plural", () => {
    expect(formatUptime(DAY)).toBe("1 Tag");
    expect(formatUptime(DAY + HR)).toBe("1 Tag 1 Std");
    expect(formatUptime(3 * DAY + 4 * HR)).toBe("3 Tage 4 Std");
  });

  it("is a duration, never an 'ago' phrase", () => {
    expect(formatUptime(3 * HR)).not.toContain("vor");
  });
});

describe("formatDate", () => {
  it("renders a unix-ms timestamp as DD.MM.YYYY (de-DE)", () => {
    expect(formatDate(Date.UTC(2026, 4, 21, 12, 0, 0))).toMatch(
      /^\d{2}\.\d{2}\.2026$/,
    );
  });
});
