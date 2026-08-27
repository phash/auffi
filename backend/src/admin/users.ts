import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { writeAudit } from "./middleware.js";
import { deleteAllSessionsForAccount } from "../auth/sessions.js";
import { encodeCursor, decodeNumericCursor, clampLimit, paginate } from "./pagination.js";
import {
  evictAccountDevices,
  type UnattendedRegistry,
} from "../unattended.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Escape % and _ wildcards in a LIKE pattern so a malicious search input
 * cannot match more than the literal substring. Uses `!` as the escape
 * character — unlikely to appear in real emails, avoids the SQLite
 * string-literal-vs-backslash-escape confusion.
 */
function escapeLike(s: string): string {
  return s.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

function bad(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: code, message });
}

/**
 * Admins who can actually reach the admin surface: suspended admins are
 * blocked at login, so they don't count when deciding whether an action
 * would leave the deployment without a working admin.
 */
function countActiveAdmins(db: Db): number {
  const row = db
    .prepare<[], { c: number }>(
      "SELECT COUNT(*) AS c FROM accounts WHERE admin = 1 AND suspended_at IS NULL",
    )
    .get();
  return row?.c ?? 0;
}

interface ListItem {
  id: number;
  email: string;
  admin: boolean;
  suspended_at: number | null;
  email_verified_at: number | null;
  created_at: number;
  device_count: number;
  last_login_at: number | null;
}

export function registerAdminUsersRoutes(
  app: FastifyInstance,
  db: Db,
  registry?: UnattendedRegistry,
): void {
  // ── GET /api/admin/users ────────────────────────────────────────────
  // Paginated, filterable, searchable user list (gh #45).
  app.get(
    "/api/admin/users",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as {
        cursor?: string;
        limit?: string;
        q?: string;
        status?: string;
      };

      const limit = clampLimit(q.limit, DEFAULT_LIMIT, MAX_LIMIT);

      // Build WHERE clauses dynamically.
      const where: string[] = [];
      const params: (string | number)[] = [];

      const status = q.status;
      if (status === "active") {
        where.push("a.suspended_at IS NULL AND a.email_verified_at IS NOT NULL");
      } else if (status === "suspended") {
        where.push("a.suspended_at IS NOT NULL");
      } else if (status === "unverified") {
        where.push("a.email_verified_at IS NULL");
      } else if (status === "admin") {
        where.push("a.admin = 1");
      } else if (status !== undefined && status !== "") {
        return bad(reply, 400, "bad-status", "status must be active|suspended|unverified|admin");
      }

      const search = (q.q ?? "").trim();
      if (search.length > 0) {
        // Escaped LIKE — caller-supplied % and _ are literal (escape char `!`).
        where.push("a.email LIKE ? ESCAPE '!'");
        params.push(`%${escapeLike(search.toLowerCase())}%`);
      }

      if (q.cursor) {
        const cur = decodeNumericCursor(q.cursor);
        if (!cur) return bad(reply, 400, "bad-cursor", "cursor invalid");
        // Tie-break: (created_at, id) so duplicate timestamps still paginate
        // deterministically. We sort DESC so the cursor advances backward
        // in time.
        where.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
        params.push(cur.createdAt, cur.createdAt, cur.id);
      }

      const sql = `
        SELECT a.id, a.email, a.admin, a.suspended_at, a.email_verified_at, a.created_at,
               (SELECT COUNT(*) FROM devices d WHERE d.owner_account_id = a.id) AS device_count,
               (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.account_id = a.id) AS last_login_at
          FROM accounts a
         ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ?
      `;
      // +1 limit trick: ask for one more than `limit`; if returned, there
      // are more rows and the last visible row becomes the next cursor.
      const rows = db.prepare(sql).all(...params, limit + 1) as Array<
        Omit<ListItem, "admin"> & { admin: number }
      >;

      const { visible, nextCursor: next_cursor } = paginate(rows, limit, (last) =>
        encodeCursor({ createdAt: last.created_at, id: last.id }),
      );

      const items: ListItem[] = visible.map((r) => ({
        id: r.id,
        email: r.email,
        admin: r.admin === 1,
        suspended_at: r.suspended_at,
        email_verified_at: r.email_verified_at,
        created_at: r.created_at,
        device_count: r.device_count,
        last_login_at: r.last_login_at,
      }));

      return reply.send({ items, next_cursor });
    },
  );

  // ── GET /api/admin/users/:id ────────────────────────────────────────
  // Full account detail (gh #46). Strips password_hash and any token-ish
  // fields. 404 on non-existent (admin endpoint — existence is not
  // sensitive vs. another admin).
  app.get(
    "/api/admin/users/:id",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) return bad(reply, 400, "bad-id", "id must be a positive integer");

      const account = db
        .prepare<
          [number],
          {
            id: number;
            email: string;
            admin: number;
            suspended_at: number | null;
            email_verified_at: number | null;
            created_at: number;
          }
        >(
          `SELECT id, email, admin, suspended_at, email_verified_at, created_at
             FROM accounts WHERE id = ?`,
        )
        .get(id);
      if (!account) return bad(reply, 404, "not-found", "user not found");

      const devices = db
        .prepare<
          [number, number],
          {
            id: string;
            alias: string;
            last_seen_at: number | null;
            online: number;
          }
        >(
          `SELECT id, alias, last_seen_at,
                  CASE WHEN last_seen_at IS NOT NULL AND last_seen_at >= ? THEN 1 ELSE 0 END AS online
             FROM devices WHERE owner_account_id = ?
            ORDER BY created_at`,
        )
        .all(Date.now() - 90 * 1000, id);

      const recentConnections = db
        .prepare<
          [number],
          {
            id: number;
            device_id: string;
            started_at: number;
            ended_at: number | null;
            connection_type: string;
            bytes_relayed: number;
          }
        >(
          `SELECT cl.id, cl.device_id, cl.started_at, cl.ended_at, cl.connection_type, cl.bytes_relayed
             FROM connection_log cl
             JOIN devices d ON d.id = cl.device_id
            WHERE d.owner_account_id = ?
            ORDER BY cl.started_at DESC
            LIMIT 50`,
        )
        .all(id);

      const recentAudits = db
        .prepare<
          [string, string],
          {
            id: number;
            admin_id: number;
            action: string;
            created_at: number;
            before_json: string | null;
            after_json: string | null;
          }
        >(
          `SELECT id, admin_id, action, created_at, before_json, after_json
             FROM audit_log
            WHERE target_type = ? AND target_id = ?
            ORDER BY created_at DESC
            LIMIT 20`,
        )
        .all("account", String(id));

      return reply.send({
        id: account.id,
        email: account.email,
        admin: account.admin === 1,
        suspended_at: account.suspended_at,
        email_verified_at: account.email_verified_at,
        created_at: account.created_at,
        devices: devices.map((d) => ({
          id: d.id,
          alias: d.alias,
          last_seen_at: d.last_seen_at,
          online: d.online === 1,
        })),
        recent_connections: recentConnections,
        recent_audits: recentAudits,
      });
    },
  );

  // ── PATCH /api/admin/users/:id ──────────────────────────────────────
  // suspend / unsuspend / promote / demote (gh #47). All four record an
  // audit_log row. Demote refuses if it would leave zero admins.
  app.patch(
    "/api/admin/users/:id",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) return bad(reply, 400, "bad-id", "id must be a positive integer");
      const body = (req.body ?? {}) as { action?: unknown; reason?: unknown };
      const action = typeof body.action === "string" ? body.action : "";
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;

      if (!["suspend", "unsuspend", "promote", "demote"].includes(action)) {
        return bad(reply, 400, "bad-action", "action must be suspend|unsuspend|promote|demote");
      }

      const before = db
        .prepare<
          [number],
          { id: number; email: string; admin: number; suspended_at: number | null }
        >("SELECT id, email, admin, suspended_at FROM accounts WHERE id = ?")
        .get(id);
      if (!before) return bad(reply, 404, "not-found", "user not found");

      // Refuse to demote OR suspend the last ACTIVE admin — including
      // self. Suspend needs the same guard as demote: it kills the
      // target's sessions and blocks their login, so a sole admin
      // self-suspending would brick the entire admin surface (recovery
      // only via manual DB surgery). Suspended admins don't count as a
      // remaining fallback — they can't log in either.
      if (
        (action === "demote" || action === "suspend") &&
        before.admin === 1 &&
        before.suspended_at === null &&
        countActiveAdmins(db) <= 1
      ) {
        return bad(
          reply,
          409,
          "last-admin",
          "Der letzte aktive Admin kann nicht gesperrt oder degradiert werden.",
        );
      }

      const now = Date.now();
      const tx = db.transaction(() => {
        if (action === "suspend") {
          db.prepare("UPDATE accounts SET suspended_at = ? WHERE id = ?").run(now, id);
          deleteAllSessionsForAccount(db, id);
          // Dashboard sessions alone are not the capability being abused:
          // cut the live unattended sharers too, the way DELETE does. Without
          // this a suspended owner kept full remote control until the sharer
          // happened to reconnect — and verifyBearerAuth now refuses it then.
          if (registry) evictAccountDevices(db, registry, id);
        } else if (action === "unsuspend") {
          db.prepare("UPDATE accounts SET suspended_at = NULL WHERE id = ?").run(id);
        } else if (action === "promote") {
          db.prepare("UPDATE accounts SET admin = 1 WHERE id = ?").run(id);
        } else if (action === "demote") {
          db.prepare("UPDATE accounts SET admin = 0 WHERE id = ?").run(id);
        }
        const after = db
          .prepare<
            [number],
            { id: number; email: string; admin: number; suspended_at: number | null }
          >("SELECT id, email, admin, suspended_at FROM accounts WHERE id = ?")
          .get(id);
        writeAudit(db, req, `user.${action}`, "account", id, before, { ...after, reason });
      });
      tx();
      return reply.send({ ok: true });
    },
  );

  // ── DELETE /api/admin/users/:id ─────────────────────────────────────
  // Hard-delete with reason (gh #48). Refuses self-delete and last-admin.
  app.delete(
    "/api/admin/users/:id",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) return bad(reply, 400, "bad-id", "id must be a positive integer");
      const body = (req.body ?? {}) as { reason?: unknown };
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "";
      if (!reason.trim()) {
        return bad(reply, 400, "bad-reason", "reason required");
      }

      if (id === req.account!.id) {
        return bad(reply, 409, "no-self-delete", "use DELETE /api/me to delete your own account");
      }

      const target = db
        .prepare<
          [number],
          { id: number; email: string; admin: number; suspended_at: number | null }
        >("SELECT id, email, admin, suspended_at FROM accounts WHERE id = ?")
        .get(id);
      if (!target) return bad(reply, 404, "not-found", "user not found");

      // Same active-admin floor as suspend/demote: deleting a suspended
      // admin never reduces the number of admins who can log in, so only
      // an ACTIVE admin target trips the guard.
      if (target.admin === 1 && target.suspended_at === null && countActiveAdmins(db) <= 1) {
        return bad(reply, 409, "last-admin", "Der letzte aktive Admin kann nicht gelöscht werden.");
      }

      // VOR dem Cascade zählen — der Audit-Snapshot hält fest, wie viele
      // Geräte mit dem Konto verschwinden.
      const deviceCount =
        db
          .prepare<[number], { c: number }>(
            "SELECT COUNT(*) AS c FROM devices WHERE owner_account_id = ?",
          )
          .get(id)?.c ?? 0;

      // Force-close the target's live unattended sharers before the cascade
      // removes their device rows. An admin deleting an abusive account must
      // cut its sharers off immediately, not at their next reconnect.
      if (registry) evictAccountDevices(db, registry, id);

      const tx = db.transaction(() => {
        // Snapshot what's about to vanish — audit_log row survives the cascade
        // because target_id is just a string column with no FK back.
        writeAudit(
          db,
          req,
          "user.delete",
          "account",
          id,
          { id: target.id, email: target.email, admin: target.admin, device_count: deviceCount },
          { reason },
        );
        db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
      });
      tx();

      return reply.status(204).send();
    },
  );
}
