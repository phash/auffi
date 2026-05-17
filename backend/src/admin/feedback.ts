import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import type { FeedbackMailer } from "../email/mailer.js";
import { writeAudit } from "./middleware.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_REPLY_LENGTH = 4000;

interface FeedbackRow {
  id: number;
  account_id: number;
  account_email: string;
  source: "dashboard" | "sharer" | "viewer";
  category: "bug" | "feature" | "praise" | "other";
  rating: number;
  body: string;
  user_agent_hint: string | null;
  created_at: number;
  resolved_at: number | null;
  reply_body: string | null;
  replied_at: number | null;
  replied_by: number | null;
  reply_sent_at: number | null;
}

function bad(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: code, message });
}

export function registerAdminFeedbackRoutes(
  app: FastifyInstance,
  db: Db,
  mailer: FeedbackMailer,
): void {
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
      const cursorOk =
        cursor === undefined || (Number.isInteger(cursor) && cursor > 0);
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
                f.user_agent_hint, f.created_at, f.resolved_at,
                f.reply_body, f.replied_at, f.replied_by, f.reply_sent_at
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
          replyBody: r.reply_body,
          repliedAt: r.replied_at,
          repliedBy: r.replied_by,
          replySentAt: r.reply_sent_at,
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
      // Security-Review L-3 (2026-05-14): Snapshot the full row in
      // the audit log, not just `resolved_at`. The feedback table
      // may be purged later (gh #39 retention), at which point the
      // audit row becomes the only trace of WHAT was resolved/
      // reopened by an admin and on what content. Cheap to capture.
      const row = db
        .prepare<
          [number],
          {
            category: string;
            rating: number;
            body: string;
            source: string;
            resolved_at: number | null;
          }
        >(
          "SELECT category, rating, body, source, resolved_at FROM feedback WHERE id = ?",
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
        {
          resolved_at: row.resolved_at,
          source: row.source,
          category: row.category,
          rating: row.rating,
          body: row.body,
        },
        { resolved_at: nextResolvedAt },
      );
      return reply.status(200).send({ ok: true, resolvedAt: nextResolvedAt });
    },
  );

  /**
   * POST /api/admin/feedback/:id/reply — admin replies inline.
   *
   * The reply is stored in the row (reply_body + replied_at + replied_by)
   * BEFORE we attempt SMTP — that way a transient mail failure leaves the
   * reply persisted as a draft the admin can re-send without re-typing.
   * `reply_sent_at` is set only after SMTP confirms acceptance; the
   * response payload reports both `replyAt` and `sentAt` (nullable) so
   * the UI can render "draft saved, send retry pending" vs "delivered".
   *
   * Replying auto-resolves an open row (admin did the work — separate
   * resolve click would be busywork). Already-resolved rows aren't
   * touched; re-replying to a resolved row is allowed and overwrites
   * the previous reply (audit log captures the change).
   */
  app.post(
    "/api/admin/feedback/:id/reply",
    {
      preHandler: [app.requireSession, app.requireAdmin],
      // Per-route cap on top of the global 1000/min/IP. Each call fires
      // an SMTP transaction via mail.mr-development.de — without this,
      // a compromised admin credential could relay-blast the SMTP host
      // into a blacklist + drag legitimate verify/reset mails with it
      // (security-review SEC-M2, 2026-05-17). 10/min is generous for
      // a human admin clicking "Senden" and tight enough to make spam
      // unattractive.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const fid = Number(id);
      if (!Number.isInteger(fid) || fid <= 0) {
        return bad(reply, 400, "bad-id", "id must be a positive integer");
      }
      const body = (req.body ?? {}) as { reply?: unknown };
      if (typeof body.reply !== "string") {
        return bad(reply, 400, "bad-reply", "reply must be a string");
      }
      const replyText = body.reply.trim();
      if (replyText.length === 0) {
        return bad(reply, 400, "bad-reply", "reply must not be empty");
      }
      if (replyText.length > MAX_REPLY_LENGTH) {
        return bad(
          reply,
          400,
          "reply-too-long",
          `reply must be ≤${MAX_REPLY_LENGTH} characters`,
        );
      }
      const row = db
        .prepare<
          [number],
          {
            id: number;
            body: string;
            account_email: string;
            reply_body: string | null;
            replied_at: number | null;
            resolved_at: number | null;
          }
        >(
          `SELECT f.id, f.body, a.email AS account_email,
                  f.reply_body, f.replied_at, f.resolved_at
             FROM feedback f
             JOIN accounts a ON a.id = f.account_id
            WHERE f.id = ?`,
        )
        .get(fid);
      if (!row) return bad(reply, 404, "not-found", "feedback row not found");

      const now = Date.now();
      const adminId = req.account!.id;
      const nextResolvedAt = row.resolved_at ?? now;
      db.prepare(
        `UPDATE feedback
            SET reply_body = ?, replied_at = ?, replied_by = ?,
                reply_sent_at = NULL, resolved_at = ?
          WHERE id = ?`,
      ).run(replyText, now, adminId, nextResolvedAt, fid);

      writeAudit(
        db,
        req,
        "feedback.reply",
        "feedback",
        fid,
        {
          reply_body: row.reply_body,
          replied_at: row.replied_at,
          resolved_at: row.resolved_at,
        },
        {
          reply_body: replyText,
          replied_at: now,
          resolved_at: nextResolvedAt,
        },
      );

      let sentAt: number | null = null;
      let sendError: string | null = null;
      try {
        await mailer.sendReply({
          to: row.account_email,
          originalBody: row.body,
          replyText,
        });
        sentAt = Date.now();
        db.prepare("UPDATE feedback SET reply_sent_at = ? WHERE id = ?").run(
          sentAt,
          fid,
        );
      } catch (err) {
        sendError = (err as Error).message;
        req.log.warn(
          { err: sendError, feedbackId: fid },
          "feedback reply email send failed (reply persisted as draft)",
        );
      }

      return reply.status(200).send({
        ok: true,
        replyAt: now,
        sentAt,
        sendError: sendError ?? undefined,
      });
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
