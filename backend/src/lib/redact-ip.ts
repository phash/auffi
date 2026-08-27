import { stripIpv4Mapped } from "../rate-limit.js";

/**
 * DSGVO-safe IP redaction, shared by everything that persists an
 * IP-derived value. Output matches the `viewer_ip_prefix` format
 * signaling.ts writes to connection_log and the disclosure in
 * viewer/public/datenschutz ("z. B. 84.xxx"):
 *
 *  - IPv4 keeps only the FIRST octet (`84.xxx`)
 *  - IPv6 keeps the first two hextets (`2001:db8:xxx`) — coarser than
 *    the /64-per-customer assignment the BGH (VI ZR 135/13) treats as
 *    personenbezogen
 *  - IPv4-mapped IPv6 (`::ffff:84.1.2.3`, which Fastify's req.ip can
 *    return) is normalised first so it doesn't collapse every such
 *    client to one constant IPv6-branch prefix
 *  - empty / unparseable input becomes `"unknown"`
 */
export function redactIp(rawIp: string | undefined): string {
  const ip = stripIpv4Mapped(rawIp ?? "");
  if (!ip) return "unknown";
  if (ip.includes(":")) {
    return ip.split(":").slice(0, 2).join(":") + ":xxx";
  }
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.xxx`;
  return "unknown";
}
