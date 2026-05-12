import type { FastifyRequest, FastifyReply } from "fastify";
import type { Db } from "../db.js";
import { newToken, hashToken } from "./tokens.js";

/**
 * Per the spec §4.3, sessions live 30 days from issuance.
 * Renewed last_seen_at on every authenticated request that touches the
 * session (handled by the requireSession middleware in gh #12).
 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Cookie name carrying the session token. */
export const SESSION_COOKIE = "auffi_session";

/**
 * Insert a new sessions row for `account_id`, set the cookie on `reply`,
 * and return the random session id (also the cookie value). The token
 * itself is only stored hashed; the cookie value is the plaintext.
 */
export function createSession(
  db: Db,
  reply: FastifyReply,
  accountId: number,
  userAgent: string | undefined,
): { sessionId: string } {
  const now = Date.now();
  const sessionId = newToken();
  const tokenHash = hashToken(sessionId);
  const expiresAt = now + SESSION_TTL_MS;
  // user_agent_hint is truncated to 200 chars; we record a coarse fingerprint
  // for the "active sessions" UI later, not the full UA for DSGVO reasons.
  const uaHint = (userAgent ?? "").slice(0, 200);

  db.prepare(
    `INSERT INTO sessions (id, account_id, token_hash, expires_at, last_seen_at, user_agent_hint)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, accountId, tokenHash, expiresAt, now, uaHint);

  // Cookie attributes per spec §4.3 step 4: HttpOnly + Secure + SameSite=Strict + 30d TTL.
  // Path=/ so it covers /api/* and /dashboard/* without per-route cookies.
  reply.header(
    "Set-Cookie",
    [
      `${SESSION_COOKIE}=${sessionId}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ].join("; "),
  );

  return { sessionId };
}

/** Clear the session cookie on the response (used by logout). */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    "Set-Cookie",
    [
      `${SESSION_COOKIE}=`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Max-Age=0",
    ].join("; "),
  );
}

/**
 * Extract the session cookie value from the request. Returns undefined if
 * no auffi_session cookie is present or the header is malformed.
 */
export function readSessionCookie(req: FastifyRequest): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (name === SESSION_COOKIE) {
      return part.slice(idx + 1).trim() || undefined;
    }
  }
  return undefined;
}

/**
 * Look up the sessions row whose token_hash matches the supplied cookie
 * value. Returns null if the session is missing, expired, or the matching
 * account is soft-deleted.
 */
export function findSession(
  db: Db,
  cookieValue: string,
): { id: string; accountId: number } | null {
  if (!cookieValue) return null;
  const tokenHash = hashToken(cookieValue);
  const row = db
    .prepare<[string, number], { id: string; account_id: number; account_deleted_at: number | null }>(
      `SELECT s.id, s.account_id, a.deleted_at AS account_deleted_at
         FROM sessions s
         JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(tokenHash, Date.now());
  if (!row) return null;
  if (row.account_deleted_at !== null) return null;
  return { id: row.id, accountId: row.account_id };
}

/** Delete a single session by id (used by logout). */
export function deleteSession(db: Db, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

/**
 * Delete every session for an account. Called from the password-reset
 * handler so a successful reset invalidates every other browser /
 * session of that account (spec §4.5).
 */
export function deleteAllSessionsForAccount(db: Db, accountId: number): void {
  db.prepare("DELETE FROM sessions WHERE account_id = ?").run(accountId);
}
