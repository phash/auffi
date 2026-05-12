import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function bad(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: code, message });
}

interface CursorPayload {
  createdAt: number;
  id: number;
}

function encodeCursor(c: CursorPayload): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, "utf-8").toString("base64url");
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const s = Buffer.from(raw, "base64url").toString("utf-8");
    const [aStr, bStr] = s.split("|");
    const a = Number(aStr);
    const b = Number(bStr);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { createdAt: a, id: b };
  } catch {
    return null;
  }
}

export function registerAdminAuditRoutes(app: FastifyInstance, db: Db): void {
  app.get(
    "/api/admin/audit-log",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as {
        cursor?: string;
        limit?: string;
        admin_id?: string;
        target_type?: string;
        target_id?: string;
        action?: string;
        from?: string;
        to?: string;
      };

      const rawLimit = Number(q.limit ?? DEFAULT_LIMIT);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, MAX_LIMIT)
          : DEFAULT_LIMIT;

      const where: string[] = [];
      const params: (string | number)[] = [];

      if (q.admin_id) {
        const adminId = Number(q.admin_id);
        if (!Number.isFinite(adminId)) return bad(reply, 400, "bad-admin-id", "admin_id must be numeric");
        where.push("al.admin_id = ?");
        params.push(adminId);
      }
      if (q.target_type) {
        where.push("al.target_type = ?");
        params.push(q.target_type);
      }
      if (q.target_id) {
        where.push("al.target_id = ?");
        params.push(q.target_id);
      }
      if (q.action) {
        where.push("al.action = ?");
        params.push(q.action);
      }
      if (q.from) {
        const f = Number(q.from);
        if (!Number.isFinite(f)) return bad(reply, 400, "bad-from", "from must be unix ms");
        where.push("al.created_at >= ?");
        params.push(f);
      }
      if (q.to) {
        const t = Number(q.to);
        if (!Number.isFinite(t)) return bad(reply, 400, "bad-to", "to must be unix ms");
        where.push("al.created_at <= ?");
        params.push(t);
      }
      if (q.cursor) {
        const cur = decodeCursor(q.cursor);
        if (!cur) return bad(reply, 400, "bad-cursor", "cursor invalid");
        where.push("(al.created_at < ? OR (al.created_at = ? AND al.id < ?))");
        params.push(cur.createdAt, cur.createdAt, cur.id);
      }

      const sql = `
        SELECT al.id, al.admin_id, al.action, al.target_type, al.target_id,
               al.before_json, al.after_json, al.created_at, al.viewer_ip_prefix,
               a.email AS admin_email
          FROM audit_log al
          LEFT JOIN accounts a ON a.id = al.admin_id
        ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY al.created_at DESC, al.id DESC
         LIMIT ?
      `;
      const rows = db.prepare(sql).all(...params, limit + 1) as Array<{
        id: number;
        admin_id: number;
        admin_email: string | null;
        action: string;
        target_type: string;
        target_id: string;
        before_json: string | null;
        after_json: string | null;
        created_at: number;
        viewer_ip_prefix: string | null;
      }>;

      const hasMore = rows.length > limit;
      const visible = hasMore ? rows.slice(0, limit) : rows;
      const last = visible[visible.length - 1];
      const next_cursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

      const items = visible.map((r) => ({
        id: r.id,
        admin_id: r.admin_id,
        admin_email: r.admin_email,
        action: r.action,
        target_type: r.target_type,
        target_id: r.target_id,
        before: r.before_json ? JSON.parse(r.before_json) : null,
        after: r.after_json ? JSON.parse(r.after_json) : null,
        created_at: r.created_at,
        viewer_ip_prefix: r.viewer_ip_prefix,
      }));

      return reply.send({ items, next_cursor });
    },
  );
}
