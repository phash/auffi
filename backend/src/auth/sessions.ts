import type { FastifyRequest, FastifyReply } from "fastify";
import type { Db } from "../db.js";
import { newToken, hashToken } from "./tokens.js";
import { truncateUserAgent } from "../feedback/user_agent.js";

/**
 * Per the spec §4.3, sessions live 30 days from issuance.
 * Renewed last_seen_at on every authenticated request that touches the
 * session (handled by the requireSession middleware in gh #12).
 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Cookie name carrying the session token. The `__Host-` prefix is a
 * browser-side defense-in-depth measure (Sec L-1, review 2026-05-13):
 *   - the browser refuses to set the cookie unless `Secure` is on AND
 *     `Path=/` is set AND no `Domain` attribute is present,
 *   - subdomains can NEVER overwrite it (no Domain attribute allowed).
 * Together with our existing HttpOnly + SameSite=Strict + sha256-only
 * server storage, this makes the cookie resistant to subdomain take-
 * over (e.g. a future static-assets host on `*.auffi.app` cannot
 * forge a session cookie that the dashboard will accept).
 */
export const SESSION_COOKIE = "__Host-auffi_session";

/**
 * Insert a new session row for `account_id`, set the cookie on `reply`,
 * and return the random cookie value. The DB stores only `sha256(cookie)`
 * via the `token_hash` primary key — the plaintext NEVER hits SQLite.
 *
 * Sec C-1 (review 2026-05-13): a prior version stored the plaintext as
 * `sessions.id` alongside the hash. Anyone with read access to the DB
 * file could replay every live session. The migration in
 * `0006_sessions_drop_plaintext_id.sql` drops the column; this function
 * is the matching producer-side fix.
 */
export function createSession(
  db: Db,
  reply: FastifyReply,
  accountId: number,
  userAgent: string | undefined,
): { cookieValue: string } {
  const now = Date.now();
  const cookieValue = newToken();
  const tokenHash = hashToken(cookieValue);
  const expiresAt = now + SESSION_TTL_MS;
  // user_agent_hint is reduced to "Browser-Family/OS-Family" (e.g.
  // "Chrome/Linux") via truncateUserAgent — the same reduction the
  // feedback handler uses. The full UA string (200-char slice) was a
  // precise fingerprint (version, build-id, platform-patches) that
  // exceeded the privacy promise in viewer/public/datenschutz §6
  // ("anonymisiertes UA-Hint wie `Chrome/Linux`") — DSGVO Art. 5
  // Abs. 1 lit. c (Datenminimierung). Code-review 2026-05-17.
  const uaHint = truncateUserAgent(userAgent);

  db.prepare(
    `INSERT INTO sessions (token_hash, account_id, expires_at, last_seen_at, user_agent_hint)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tokenHash, accountId, expiresAt, now, uaHint);

  // Cookie attributes per spec §4.3 step 4: HttpOnly + Secure + SameSite=Strict + 30d TTL.
  // Path=/ so it covers /api/* and /dashboard/* without per-route cookies.
  reply.header(
    "Set-Cookie",
    [
      `${SESSION_COOKIE}=${cookieValue}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ].join("; "),
  );

  return { cookieValue };
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
 * Look up the session whose `token_hash` matches `sha256(cookieValue)`.
 * Returns `null` if the session is missing, expired, or the owning
 * account is soft-deleted.
 *
 * The returned `tokenHash` is the row's primary key — pass it to
 * [`deleteSession`] (e.g. on logout). The plaintext cookie value is
 * NOT retained anywhere server-side.
 */
export function findSession(
  db: Db,
  cookieValue: string,
): { tokenHash: string; accountId: number } | null {
  if (!cookieValue) return null;
  const tokenHash = hashToken(cookieValue);
  // Kein Account-JOIN nötig: Konten werden hart gelöscht und der
  // FK-Cascade nimmt die Sessions mit — eine gefundene Session gehört
  // immer zu einem existierenden Konto.
  const row = db
    .prepare<[string, number], { account_id: number }>(
      `SELECT account_id FROM sessions
        WHERE token_hash = ? AND expires_at > ?`,
    )
    .get(tokenHash, Date.now());
  if (!row) return null;
  return { tokenHash, accountId: row.account_id };
}

/** Delete a single session by its token hash (used by logout). */
export function deleteSession(db: Db, tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

/**
 * Delete every session for an account. Called from the password-reset
 * handler so a successful reset invalidates every other browser /
 * session of that account (spec §4.5).
 */
export function deleteAllSessionsForAccount(db: Db, accountId: number): void {
  db.prepare("DELETE FROM sessions WHERE account_id = ?").run(accountId);
}
