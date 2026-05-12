import { createHash, randomBytes } from "node:crypto";

/**
 * Generate a fresh 256-bit token, hex-encoded (64 chars).
 *
 * Used for:
 *  - Session cookies (the value the browser sends back)
 *  - Email-verification links
 *  - Password-reset links
 *
 * The plaintext token is sent to the user (cookie / mail link) once; the
 * database stores only sha256(token) so a DB leak doesn't expose live
 * sessions.
 */
export function newToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * SHA-256 of a token. Hex output, lower-case. Use this for the
 * `token_hash` / `sessions.token_hash` columns.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time string comparison via timingSafeEqual on the encoded
 * hashes. Only used when comparing two PRE-HASHED values (so length is
 * fixed at 64 chars). Returns false for any length mismatch.
 */
export function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
