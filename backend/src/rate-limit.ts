// Generic per-IP fixed-window rate limiter, shared across the signaling
// WSS upgrade path and the feedback REST route. Both gate an expensive
// argon2 verify behind a per-IP cap (Sec H-1 for signaling; the same DoS
// shape on POST /api/feedback's sharer-Bearer branch).

import { isIPv6 } from "node:net";

export type RateLimitConfig = { windowMs: number; max: number };
export type RateLimitEntry = { count: number; resetAt: number };

export function stripIpv4Mapped(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * The bucket a client address counts against. IPv4 (bare or `::ffff:`-mapped,
 * so alternating forms cannot double a budget) is keyed per address. IPv6 is
 * keyed by its /64: a single subscriber is routinely handed a whole /64, so
 * per-address buckets gave every IPv6 client 2^64 fresh budgets. Same subnet
 * @fastify/rate-limit uses for the REST routes.
 */
export function rateLimitKey(rawIp: string): string {
  const ip = stripIpv4Mapped(rawIp).split("%")[0];
  if (!isIPv6(ip)) return ip;
  const [head, tail] = ip.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  // An embedded dotted IPv4 (64:ff9b::192.0.2.1) fills two 16-bit groups.
  const width = (groups: string[]) =>
    groups.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const zeros = ip.includes("::") ? 8 - width(headGroups) - width(tailGroups) : 0;
  const groups = [...headGroups, ...Array<string>(zeros).fill("0"), ...tailGroups];
  const prefix = groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16));
  return `${prefix.join(":")}::/64`;
}

/**
 * Returns `true` if the request is within the cap (and records it), `false`
 * if it should be rejected. Buckets are keyed by `rateLimitKey`.
 */
export function checkIpRateLimit(
  rawIp: string,
  counts: Map<string, RateLimitEntry>,
  cfg: RateLimitConfig,
): boolean {
  const ip = rateLimitKey(rawIp);
  const now = Date.now();
  const entry = counts.get(ip);
  if (!entry || now > entry.resetAt) {
    counts.set(ip, { count: 1, resetAt: now + cfg.windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= cfg.max;
}
