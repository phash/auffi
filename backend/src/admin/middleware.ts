import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { redactIp } from "../lib/redact-ip.js";

/**
 * Build a `requireAdmin` preHandler. Must be installed AFTER `requireSession`
 * so `req.account` is populated when this fires.
 *
 * Responses (per #43 acceptance):
 *  - Anonymous (no req.account) → 401 no-session (delegated upstream)
 *  - Logged-in non-admin       → 403 admin-required
 *  - Admin                      → next()
 *
 * Use as `{ preHandler: [app.requireSession, app.requireAdmin] }` on every
 * /api/admin/* route.
 */
function makeRequireAdmin(db: Db) {
  return async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
    if (!req.account) {
      return reply.status(401).send({ error: "no-session", message: "authentication required" });
    }
    const row = db
      .prepare<[number], { admin: number }>(
        "SELECT admin FROM accounts WHERE id = ?",
      )
      .get(req.account.id);
    if (!row || row.admin !== 1) {
      return reply.status(403).send({ error: "admin-required", message: "admin privileges required" });
    }
  };
}

export function decorateRequireAdmin(app: FastifyInstance, db: Db): void {
  app.decorate("requireAdmin", makeRequireAdmin(db));
}

declare module "fastify" {
  interface FastifyInstance {
    requireAdmin: ReturnType<typeof makeRequireAdmin>;
  }
}

/**
 * Insert one audit_log row. Designed to be called BEFORE the response is
 * sent (per acceptance criterion) — ideally inside the same DB transaction
 * as the mutation it records, so a crash between mutation and audit is
 * impossible.
 *
 *  - `action` is a stable identifier ("user.suspend", "device.delete", ...)
 *  - `targetType` is "account" or "device"
 *  - `targetId` is a string so it can hold the 9-digit device-id too
 *  - `before` / `after` are arbitrary JSON-serialisable snapshots; null
 *    is allowed when the action has no meaningful pre/post state.
 */
export function writeAudit(
  db: Db,
  req: FastifyRequest,
  action: string,
  targetType: "account" | "device" | string,
  targetId: string | number,
  before: unknown,
  after: unknown,
): void {
  if (!req.account) {
    throw new Error("writeAudit requires an authenticated admin session");
  }
  db.prepare(
    `INSERT INTO audit_log
       (admin_id, action, target_type, target_id, before_json, after_json, created_at, viewer_ip_prefix)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    req.account.id,
    action,
    targetType,
    String(targetId),
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    Date.now(),
    // Framework-trusted req.ip (trustProxy resolves the real client IP)
    // rather than the raw x-forwarded-for header, which is attacker-
    // controlled and could spoof the audit-log entry. Redaction shape is
    // shared with connection_log's viewer_ip_prefix — see lib/redact-ip.
    redactIp(req.ip),
  );
}
