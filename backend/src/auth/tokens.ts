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
