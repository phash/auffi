// Generic per-IP fixed-window rate limiter, shared across the signaling
// WSS upgrade path and the feedback REST route. Both gate an expensive
// argon2 verify behind a per-IP cap (Sec H-1 for signaling; the same DoS
// shape on POST /api/feedback's sharer-Bearer branch).

export type RateLimitConfig = { windowMs: number; max: number };
export type RateLimitEntry = { count: number; resetAt: number };

export function stripIpv4Mapped(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * Returns `true` if the request is within the cap (and records it), `false`
 * if it should be rejected. Buckets are keyed by the IPv4-normalised address
 * so an attacker can't double their budget by alternating between the bare
 * IPv4 and its `::ffff:`-mapped IPv6 form.
 */
export function checkIpRateLimit(
  rawIp: string,
  counts: Map<string, RateLimitEntry>,
  cfg: RateLimitConfig,
): boolean {
  const ip = stripIpv4Mapped(rawIp);
  const now = Date.now();
  const entry = counts.get(ip);
  if (!entry || now > entry.resetAt) {
    counts.set(ip, { count: 1, resetAt: now + cfg.windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= cfg.max;
}
