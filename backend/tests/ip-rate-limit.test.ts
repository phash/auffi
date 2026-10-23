import { describe, it, expect, vi } from "vitest";
import {
  checkIpRateLimit,
  rateLimitKey,
  stripIpv4Mapped,
  type RateLimitEntry,
} from "../src/rate-limit.js";

// One IPv6 subscriber gets a whole /64 (2^64 addresses). Keyed per address,
// every per-IP limit was a formality for an IPv6 client.
describe("rateLimitKey", () => {
  it("keys IPv6 by its /64, whatever the notation", () => {
    expect(rateLimitKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateLimitKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
  });

  it("keeps IPv4 (bare or mapped) per address", () => {
    expect(rateLimitKey("9.9.9.9")).toBe("9.9.9.9");
    expect(rateLimitKey("::ffff:9.9.9.9")).toBe("9.9.9.9");
  });
});

describe("checkIpRateLimit over IPv6", () => {
  it("shares one bucket across a /64", () => {
    const counts = new Map<string, RateLimitEntry>();
    const cfg = { windowMs: 60_000, max: 1 };
    expect(checkIpRateLimit("2001:db8:1:2::1", counts, cfg)).toBe(true);
    expect(checkIpRateLimit("2001:db8:1:2::2", counts, cfg)).toBe(false);
    expect(checkIpRateLimit("2001:db8:1:3::1", counts, cfg)).toBe(true);
  });
});

describe("checkIpRateLimit", () => {
  it("allows requests up to the cap, then blocks", () => {
    const counts = new Map<string, RateLimitEntry>();
    const cfg = { windowMs: 60_000, max: 2 };
    expect(checkIpRateLimit("1.2.3.4", counts, cfg)).toBe(true); // 1st
    expect(checkIpRateLimit("1.2.3.4", counts, cfg)).toBe(true); // 2nd
    expect(checkIpRateLimit("1.2.3.4", counts, cfg)).toBe(false); // over cap
  });

  it("resets the bucket once the window elapses", () => {
    vi.useFakeTimers();
    try {
      const counts = new Map<string, RateLimitEntry>();
      const cfg = { windowMs: 1000, max: 1 };
      expect(checkIpRateLimit("1.2.3.4", counts, cfg)).toBe(true);
      expect(checkIpRateLimit("1.2.3.4", counts, cfg)).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(checkIpRateLimit("1.2.3.4", counts, cfg)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps separate buckets per IP", () => {
    const counts = new Map<string, RateLimitEntry>();
    const cfg = { windowMs: 60_000, max: 1 };
    expect(checkIpRateLimit("1.1.1.1", counts, cfg)).toBe(true);
    expect(checkIpRateLimit("2.2.2.2", counts, cfg)).toBe(true);
  });

  it("normalises an IPv4-mapped IPv6 address to the same bucket as the bare IPv4", () => {
    const counts = new Map<string, RateLimitEntry>();
    const cfg = { windowMs: 60_000, max: 1 };
    expect(checkIpRateLimit("::ffff:9.9.9.9", counts, cfg)).toBe(true);
    expect(checkIpRateLimit("9.9.9.9", counts, cfg)).toBe(false);
  });
});

describe("stripIpv4Mapped", () => {
  it("strips the ::ffff: prefix", () => {
    expect(stripIpv4Mapped("::ffff:9.9.9.9")).toBe("9.9.9.9");
  });
  it("leaves a bare address untouched", () => {
    expect(stripIpv4Mapped("9.9.9.9")).toBe("9.9.9.9");
    expect(stripIpv4Mapped("2001:db8::1")).toBe("2001:db8::1");
  });
});
