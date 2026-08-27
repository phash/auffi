import { describe, it, expect } from "vitest";
import { redactIp } from "../src/lib/redact-ip.js";

// One shared redaction helper — output must match the `viewer_ip_prefix`
// format that signaling.ts writes to connection_log (first IPv4 octet /
// first two IPv6 hextets), documented in viewer/public/datenschutz
// ("z. B. 84.xxx").
describe("redactIp", () => {
  it("keeps only the first octet of an IPv4 address", () => {
    expect(redactIp("84.137.42.7")).toBe("84.xxx");
    expect(redactIp("203.0.113.42")).toBe("203.xxx");
  });

  it("normalises an IPv4-mapped IPv6 address before redacting", () => {
    // Fastify's req.ip can return ::ffff:-mapped addresses; without the
    // strip every such client would collapse to one constant prefix.
    expect(redactIp("::ffff:84.137.42.7")).toBe("84.xxx");
  });

  it("keeps the first two hextets of an IPv6 address", () => {
    expect(redactIp("2001:db8:abcd:1234:5678:9abc:def0:1234")).toBe("2001:db8:xxx");
  });

  it("returns 'unknown' for empty or unparseable input", () => {
    expect(redactIp("")).toBe("unknown");
    expect(redactIp(undefined)).toBe("unknown");
    expect(redactIp("not-an-ip")).toBe("unknown");
    expect(redactIp("1.2.3")).toBe("unknown");
  });
});
