import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { writeAudit } from "./middleware.js";

const ONLINE_WINDOW_MS = 90 * 1000;
const STALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function bad(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: code, message });
}

function escapeLike(s: string): string {
  return s.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

interface CursorPayload {
  createdAt: number;
  id: string;
}

function encodeCursor(c: CursorPayload): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, "utf-8").toString("base64url");
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const s = Buffer.from(raw, "base64url").toString("utf-8");
    const [aStr, b] = s.split("|");
    const a = Number(aStr);
    if (!Number.isFinite(a) || !b) return null;
    return { createdAt: a, id: b };
  } catch {
    return null;
  }
}

export function registerAdminDevicesRoutes(app: FastifyInstance, db: Db): void {
  // ── GET /api/admin/devices ──────────────────────────────────────────
  app.get(
    "/api/admin/devices",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as {
        cursor?: string;
        limit?: string;
        q?: string;
        status?: string;
        owner_id?: string;
      };

      const rawLimit = Number(q.limit ?? DEFAULT_LIMIT);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, MAX_LIMIT)
          : DEFAULT_LIMIT;

      const where: string[] = [];
      const params: (string | number)[] = [];
      const now = Date.now();

      if (q.status === "online") {
        where.push("d.last_seen_at IS NOT NULL AND d.last_seen_at >= ?");
        params.push(now - ONLINE_WINDOW_MS);
      } else if (q.status === "offline") {
        // Either never seen OR last_seen older than online-window (but not yet stale).
        where.push("(d.last_seen_at IS NULL OR d.last_seen_at < ?)");
        params.push(now - ONLINE_WINDOW_MS);
      } else if (q.status === "stale") {
        where.push("d.last_seen_at IS NOT NULL AND d.last_seen_at < ?");
        params.push(now - STALE_WINDOW_MS);
      } else if (q.status !== undefined && q.status !== "") {
        return bad(reply, 400, "bad-status", "status must be online|offline|stale");
      }

      const search = (q.q ?? "").trim();
      if (search.length > 0) {
        where.push("(d.alias LIKE ? ESCAPE '!' OR d.id LIKE ? ESCAPE '!')");
        const p = `%${escapeLike(search)}%`;
        params.push(p, p);
      }

      const ownerId = q.owner_id ? Number(q.owner_id) : null;
      if (ownerId !== null) {
        if (!Number.isInteger(ownerId) || ownerId <= 0) return bad(reply, 400, "bad-owner-id", "owner_id must be a positive integer");
        where.push("d.owner_account_id = ?");
        params.push(ownerId);
      }

      if (q.cursor) {
        const cur = decodeCursor(q.cursor);
        if (!cur) return bad(reply, 400, "bad-cursor", "cursor invalid");
        where.push("(d.created_at < ? OR (d.created_at = ? AND d.id < ?))");
        params.push(cur.createdAt, cur.createdAt, cur.id);
      }

      const sql = `
        SELECT d.id, d.alias, d.auto_accept, d.created_at, d.last_seen_at,
               d.owner_account_id, a.email AS owner_email
          FROM devices d
          JOIN accounts a ON a.id = d.owner_account_id
        ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY d.created_at DESC, d.id DESC
         LIMIT ?
      `;
      const rows = db.prepare(sql).all(...params, limit + 1) as Array<{
        id: string;
        alias: string;
        auto_accept: number;
        created_at: number;
        last_seen_at: number | null;
        owner_account_id: number;
        owner_email: string;
      }>;

      const hasMore = rows.length > limit;
      const visible = hasMore ? rows.slice(0, limit) : rows;
      const last = visible[visible.length - 1];
      const next_cursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

      const items = visible.map((r) => ({
        id: r.id,
        alias: r.alias,
        owner_email: r.owner_email,
        owner_id: r.owner_account_id,
        online: r.last_seen_at !== null && now - r.last_seen_at < ONLINE_WINDOW_MS,
        last_seen_at: r.last_seen_at,
        created_at: r.created_at,
        auto_accept: r.auto_accept === 1,
      }));

      return reply.send({ items, next_cursor });
    },
  );

  // ── DELETE /api/admin/devices/:id ───────────────────────────────────
  app.delete(
    "/api/admin/devices/:id",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { reason?: unknown };
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "";
      if (!reason.trim()) return bad(reply, 400, "bad-reason", "reason required");

      const target = db
        .prepare<
          [string],
          { id: string; alias: string; owner_account_id: number }
        >("SELECT id, alias, owner_account_id FROM devices WHERE id = ?")
        .get(id);
      if (!target) return bad(reply, 404, "not-found", "device not found");

      const tx = db.transaction(() => {
        writeAudit(db, req, "device.delete", "device", id, target, { reason });
        db.prepare("DELETE FROM devices WHERE id = ?").run(id);
        // Clear any per-device rate-limit buckets so a re-paired device
        // doesn't inherit a lockout.
        db.prepare("DELETE FROM rate_limit_buckets WHERE key LIKE ?").run(
          `device:${id}:%`,
        );
      });
      tx();
      // WSS eager-evict deferred to follow-up on top of #16 — for now
      // the sharer's next heartbeat fails the token lookup and dies.
      return reply.status(204).send();
    },
  );

  // ── POST /api/admin/devices/:id/reset-rate-limit ────────────────────
  app.post(
    "/api/admin/devices/:id/reset-rate-limit",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const target = db
        .prepare<[string], { id: string }>("SELECT id FROM devices WHERE id = ?")
        .get(id);
      if (!target) return bad(reply, 404, "not-found", "device not found");

      const result = db
        .prepare("DELETE FROM rate_limit_buckets WHERE key LIKE ?")
        .run(`device:${id}:%`);
      const cleared = Number(result.changes ?? 0);
      writeAudit(db, req, "device.reset-rate-limit", "device", id, null, { cleared });
      return reply.send({ cleared });
    },
  );
}
