import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { writeAudit } from "./middleware.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface FeedbackRow {
  id: number;
  account_id: number;
  account_email: string;
  source: "dashboard" | "sharer";
  category: "bug" | "feature" | "praise" | "other";
  rating: number;
  body: string;
  user_agent_hint: string | null;
  created_at: number;
  resolved_at: number | null;
}

function bad(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: code, message });
}

export function registerAdminFeedbackRoutes(app: FastifyInstance, db: Db): void {
  /**
   * GET /api/admin/feedback?status=open|resolved|all&cursor=<id>&limit=<n>
   *
   * Paginated list of feedback rows, newest first. Cursor is the `id`
   * of the last row of the previous page (rows have monotonic ids
   * matching created_at order). Joins accounts so the admin can see
   * who submitted; the body keeps the email so a mailto-reply works
   * without a second lookup.
   */
  app.get(
    "/api/admin/feedback",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as { status?: string; cursor?: string; limit?: string };
      const status = q.status ?? "open";
      if (status !== "open" && status !== "resolved" && status !== "all") {
        return bad(reply, 400, "bad-status", "status must be open, resolved, or all");
      }
      const rawLimit = Number(q.limit ?? DEFAULT_LIMIT);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, MAX_LIMIT)) : DEFAULT_LIMIT;

      const cursor = q.cursor ? Number(q.cursor) : undefined;
      const cursorOk = cursor === undefined || (Number.isFinite(cursor) && cursor > 0);
      if (!cursorOk) {
        return bad(reply, 400, "bad-cursor", "cursor must be a positive integer");
      }

      const statusFilter =
        status === "open"
          ? " AND f.resolved_at IS NULL"
          : status === "resolved"
            ? " AND f.resolved_at IS NOT NULL"
            : "";
      const cursorPredicate = cursor !== undefined ? " AND f.id < ?" : "";

      const sql =
        `SELECT f.id, f.account_id, a.email AS account_email,
                f.source, f.category, f.rating, f.body,
                f.user_agent_hint, f.created_at, f.resolved_at
           FROM feedback f
           JOIN accounts a ON a.id = f.account_id
          WHERE 1=1${statusFilter}${cursorPredicate}
          ORDER BY f.id DESC
          LIMIT ?`;
      const stmt = db.prepare<unknown[], FeedbackRow>(sql);
      const rows =
        cursor !== undefined ? stmt.all(cursor, limit + 1) : stmt.all(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? page[page.length - 1].id : null;

      return reply.status(200).send({
        items: page.map((r) => ({
          id: r.id,
          accountId: r.account_id,
          accountEmail: r.account_email,
          source: r.source,
          category: r.category,
          rating: r.rating,
          body: r.body,
          userAgentHint: r.user_agent_hint,
          createdAt: r.created_at,
          resolvedAt: r.resolved_at,
        })),
        nextCursor,
      });
    },
  );

  /**
   * PATCH /api/admin/feedback/:id — toggle resolved.
   * Body: { resolved: boolean }.
   */
  app.patch(
    "/api/admin/feedback/:id",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const fid = Number(id);
      if (!Number.isInteger(fid) || fid <= 0) {
        return bad(reply, 400, "bad-id", "id must be a positive integer");
      }
      const body = (req.body ?? {}) as { resolved?: unknown };
      if (typeof body.resolved !== "boolean") {
        return bad(reply, 400, "bad-resolved", "resolved must be a boolean");
      }
      const row = db
        .prepare<[number], { resolved_at: number | null }>(
          "SELECT resolved_at FROM feedback WHERE id = ?",
        )
        .get(fid);
      if (!row) return bad(reply, 404, "not-found", "feedback row not found");
      const nextResolvedAt = body.resolved ? Date.now() : null;
      db.prepare("UPDATE feedback SET resolved_at = ? WHERE id = ?").run(nextResolvedAt, fid);
      writeAudit(
        db,
        req,
        body.resolved ? "feedback.resolve" : "feedback.reopen",
        "feedback",
        fid,
        { resolved_at: row.resolved_at },
        { resolved_at: nextResolvedAt },
      );
      return reply.status(200).send({ ok: true, resolvedAt: nextResolvedAt });
    },
  );

  /**
   * DELETE /api/admin/feedback/:id — hard-delete (spam/PII).
   * Audit-logged before the DELETE; the row's text is captured in the
   * `before` snapshot so an admin still has a record after deletion.
   */
  app.delete(
    "/api/admin/feedback/:id",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const fid = Number(id);
      if (!Number.isInteger(fid) || fid <= 0) {
        return bad(reply, 400, "bad-id", "id must be a positive integer");
      }
      const row = db
        .prepare<[number], FeedbackRow>(
          `SELECT f.id, f.account_id, a.email AS account_email,
                  f.source, f.category, f.rating, f.body,
                  f.user_agent_hint, f.created_at, f.resolved_at
             FROM feedback f
             JOIN accounts a ON a.id = f.account_id
            WHERE f.id = ?`,
        )
        .get(fid);
      if (!row) return bad(reply, 404, "not-found", "feedback row not found");
      writeAudit(db, req, "feedback.delete", "feedback", fid, row, null);
      db.prepare("DELETE FROM feedback WHERE id = ?").run(fid);
      return reply.status(204).send();
    },
  );
}
