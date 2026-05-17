import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { parseBearerAuth, verifyBearerAuth } from "../unattended.js";
import { findSession, readSessionCookie } from "../auth/sessions.js";
import { truncateUserAgent } from "./user_agent.js";

const ALLOWED_CATEGORIES = ["bug", "feature", "praise", "other"] as const;
const ALLOWED_SOURCES = ["dashboard", "sharer", "viewer"] as const;
const BODY_MAX_LEN = 4000;

type Category = (typeof ALLOWED_CATEGORIES)[number];
type Source = (typeof ALLOWED_SOURCES)[number];

interface SubmitBody {
  source?: unknown;
  category?: unknown;
  rating?: unknown;
  body?: unknown;
}

/**
 * `POST /api/feedback` — accepts feedback from a logged-in dashboard
 * session OR a paired-device sharer. Both auth paths converge on an
 * `account_id` (sharer derives it via devices.owner_account_id).
 *
 * Anonymous posts are rejected — the schema requires an account ref,
 * and we don't want to invite spam from the open WSS surface.
 */
export function registerFeedbackRoutes(app: FastifyInstance, db: Db): void {
  app.post(
    "/api/feedback",
    {
      // Looser than the auth-endpoint cap but tighter than the global
      // 1000/min/IP. 20/min/IP is generous for a human filling out a
      // form and tight enough to make scripted spam unattractive.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as SubmitBody;
      const validation = parseSubmitBody(body);
      if ("error" in validation) {
        return reply.status(400).send(validation.error);
      }
      const { source, category, rating, text } = validation;

      const accountId = await resolveAccountId(db, req, source);
      if (accountId === null) {
        return reply
          .status(401)
          .send({ error: "no-auth", message: "login or device-bearer required" });
      }

      // Security-Review L-2 (2026-05-14): UA wird auf
      // `Browser-Family/OS-Family` reduziert — die volle UA wäre ein
      // unnötig präziser Fingerprint für das, was Admins brauchen
      // („aus welcher Umgebung kam der Bug-Report").
      const uaHint = truncateUserAgent(req.headers["user-agent"] as string | undefined);
      db.prepare(
        `INSERT INTO feedback
           (account_id, source, category, rating, body, user_agent_hint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(accountId, source, category, rating, text, uaHint, Date.now());

      return reply.status(202).send({ ok: true });
    },
  );
}

/**
 * Parse + validate the request body. Returns either the typed values
 * or an `error` payload ready to send back as 400. Pure — no IO.
 */
function parseSubmitBody(body: SubmitBody):
  | { source: Source; category: Category; rating: number; text: string }
  | { error: { error: string; message: string } } {
  if (typeof body.source !== "string" || !ALLOWED_SOURCES.includes(body.source as Source)) {
    return {
      error: {
        error: "bad-source",
        message: "source must be 'dashboard', 'sharer', or 'viewer'",
      },
    };
  }
  if (
    typeof body.category !== "string" ||
    !ALLOWED_CATEGORIES.includes(body.category as Category)
  ) {
    return {
      error: {
        error: "bad-category",
        message: "category must be one of: bug, feature, praise, other",
      },
    };
  }
  if (typeof body.rating !== "number" || !Number.isInteger(body.rating)) {
    return { error: { error: "bad-rating", message: "rating must be an integer" } };
  }
  if (body.rating < 1 || body.rating > 5) {
    return { error: { error: "bad-rating", message: "rating must be between 1 and 5" } };
  }
  if (typeof body.body !== "string") {
    return { error: { error: "bad-body", message: "body must be a string" } };
  }
  const text = body.body.trim();
  if (text.length === 0) {
    return { error: { error: "bad-body", message: "body cannot be empty" } };
  }
  if (text.length > BODY_MAX_LEN) {
    return {
      error: { error: "bad-body", message: `body must be at most ${BODY_MAX_LEN} characters` },
    };
  }
  return {
    source: body.source as Source,
    category: body.category as Category,
    rating: body.rating,
    text,
  };
}

/**
 * Resolve the account-id the feedback should be attached to. Two
 * paths:
 *  - Dashboard: requireSession populated req.account via cookie.
 *  - Sharer:    no cookie, but Authorization Bearer + X-Auffi-Device-Id
 *               headers. Verify against devices, return its owner.
 *
 * The declared `source` on the body must match the auth method —
 * otherwise a logged-in dashboard user could spoof "sharer" or
 * vice-versa.
 */
async function resolveAccountId(
  db: Db,
  req: FastifyRequest,
  source: Source,
): Promise<number | null> {
  if (source === "dashboard" || source === "viewer") {
    // Both UIs authenticate via the same __Host-auffi_session cookie —
    // the only difference is which page the feedback came FROM, which
    // is purely admin-visible metadata. Manual session lookup because
    // the route also serves the sharer Bearer-auth path (no cookie).
    const cookie = readSessionCookie(req);
    if (!cookie) return null;
    const sess = findSession(db, cookie);
    return sess?.accountId ?? null;
  }
  // source === "sharer"
  const auth = parseBearerAuth(req.headers as Record<string, string | string[] | undefined>);
  if (!auth || auth === "malformed") return null;
  const ok = await verifyBearerAuth(db, auth);
  if (!ok) return null;
  const dev = db
    .prepare<[string], { owner_account_id: number }>(
      "SELECT owner_account_id FROM devices WHERE id = ?",
    )
    .get(auth.deviceId);
  return dev?.owner_account_id ?? null;
}
