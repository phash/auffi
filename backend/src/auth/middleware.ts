import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { findSession, readSessionCookie } from "./sessions.js";

/**
 * Authenticated-request context attached by `requireSession`. Every route
 * registered with `{ preHandler: requireSession }` can rely on `req.account`
 * being populated; without auth the preHandler returns 401 first.
 */
declare module "fastify" {
  interface FastifyRequest {
    /**
     * Populated by `requireSession`. `tokenHash` is the `sessions`
     * row's primary key (sha256 of the cookie value, NOT the value
     * itself — see Sec C-1).
     */
    account?: { id: number; tokenHash: string };
  }
}

/**
 * Build a per-app `requireSession` preHandler. Captures the DB handle in a
 * closure so the request hook itself is cheap.
 *
 *  - 401 if cookie missing
 *  - 401 if cookie value not in `sessions` or row is expired
 *  - 401 if the matching account is soft-deleted
 *  - otherwise: stamps `sessions.last_seen_at = now` and attaches
 *    `req.account = { id, tokenHash }`.
 */
export function makeRequireSession(db: Db) {
  return async function requireSession(req: FastifyRequest, reply: FastifyReply) {
    const cookie = readSessionCookie(req);
    if (!cookie) {
      return reply.status(401).send({ error: "no-session", message: "authentication required" });
    }
    const sess = findSession(db, cookie);
    if (!sess) {
      return reply.status(401).send({ error: "no-session", message: "authentication required" });
    }
    // Refresh last_seen_at on every authenticated hit (per #12 acceptance).
    // This makes "stale" sessions visible in the dashboard's active-sessions
    // view later and keeps active users' cookies from rolling-expiry pruning.
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(
      Date.now(),
      sess.tokenHash,
    );
    req.account = { id: sess.accountId, tokenHash: sess.tokenHash };
  };
}

/**
 * Convenience: register the decorator under `app.requireSession` so route
 * definitions can write `preHandler: app.requireSession` rather than
 * importing the helper each time.
 */
export function decorateRequireSession(app: FastifyInstance, db: Db): void {
  app.decorate("requireSession", makeRequireSession(db));
}

declare module "fastify" {
  interface FastifyInstance {
    requireSession: ReturnType<typeof makeRequireSession>;
  }
}
