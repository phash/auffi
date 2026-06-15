import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Db } from "../db.js";
import { hashPassword, verifyPasswordTimingSafe } from "./argon.js";
import { newToken, hashToken } from "./tokens.js";
import { mailErrorInfo } from "../email/log_safe.js";
import { maybePromoteToAdmin } from "../admin/bootstrap.js";
import {
  createSession,
  clearSessionCookie,
  readSessionCookie,
  findSession,
  deleteSession,
  deleteAllSessionsForAccount,
} from "./sessions.js";

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h per spec §4.1
const RESET_TTL_MS = 60 * 60 * 1000;        // 1h per spec §4.5

/**
 * Pluggable SMTP sender. The real implementation (gh #11) plugs in via
 * dependency injection; tests pass a recording stub. The address-only
 * payload is intentional — the mail body is the responsibility of the
 * adapter and might include the per-recipient base URL, branding etc.
 */
export interface AuthMailer {
  sendVerifyEmail(email: string, verifyToken: string): Promise<void>;
  sendResetEmail(email: string, resetToken: string): Promise<void>;
}

export interface AuthDeps {
  db: Db;
  mailer: AuthMailer;
}

interface SignupBody {
  email?: unknown;
  password?: unknown;
}

interface LoginBody extends SignupBody {}

interface ResetBody {
  password?: unknown;
}

interface ForgotBody {
  email?: unknown;
}

/**
 * Cheap email shape check. We trust the SMTP layer to reject unrouteable
 * addresses on send; here we only filter out obviously malformed inputs
 * before paying the cost of an argon2 hash.
 */
function isPlausibleEmail(s: string): boolean {
  // Local part, exactly one @, domain part with at least one dot. Caps at
  // 254 chars per RFC 5321 envelope limit.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

function isAcceptablePassword(s: string): boolean {
  // 8-byte minimum because below that argon2 effectively becomes a CPU
  // exercise rather than a guess-resistance layer; cap at 256 to bound
  // hashing time for adversarial input.
  return s.length >= 8 && s.length <= 256;
}

function bad(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: code, message });
}

/**
 * Self-host kill-switch (gh #39). When `SIGNUP_DISABLED` is set the public
 * registration endpoint is closed; login + password-reset stay open so
 * existing accounts keep working. Read per-request so a deploy can flip it
 * without code changes.
 */
function signupDisabled(): boolean {
  // Accept the common truthy spellings (trimmed, case-insensitive) so a
  // `SIGNUP_DISABLED=yes` or a stray trailing space from a .env paste still
  // closes signup; everything else (incl. "0"/"false"/"no"/empty) leaves it
  // open. Erring toward "open" on an unrecognised value is the safe default —
  // an operator who wanted it closed used one of these spellings.
  const v = process.env.SIGNUP_DISABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db, mailer } = deps;

  // ── Signup ──────────────────────────────────────────────────────────
  app.post(
    "/api/auth/signup",
    {
      // 3 signups per hour per IP — generous for legitimate users, hard
      // ceiling against abuse / mailbomb attacks. Spec §9.
      config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
    if (signupDisabled())
      return bad(reply, 403, "signup-disabled", "registration is disabled");
    const body = (req.body ?? {}) as SignupBody;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!isPlausibleEmail(email)) return bad(reply, 400, "bad-email", "email format invalid");
    if (!isAcceptablePassword(password))
      return bad(reply, 400, "bad-password", "password must be 8-256 characters");

    // Duplicate-email check. A second signup for an existing email returns
    // 409 — we accept the small enumeration risk because the user will see
    // the same answer on the login screen (try-forgot-password) anyway.
    const existing = db
      .prepare<[string], { id: number }>("SELECT id FROM accounts WHERE email = ? AND deleted_at IS NULL")
      .get(email);
    if (existing) return bad(reply, 409, "email-taken", "email already registered");

    const passwordHash = await hashPassword(password);
    const now = Date.now();
    const insert = db
      .prepare(
        `INSERT INTO accounts (email, password_hash, email_verified_at, created_at, deleted_at)
         VALUES (?, ?, NULL, ?, NULL)`,
      )
      .run(email, passwordHash, now);
    const accountId = Number(insert.lastInsertRowid);

    // INITIAL_ADMIN_EMAIL bootstrap (gh #42): promote on the spot if the
    // env var matches this email. No-op when the env is unset, so the
    // default deploy stays closed.
    maybePromoteToAdmin(db, email);

    const verifyToken = newToken();
    db.prepare(
      `INSERT INTO email_verifications (token_hash, account_id, expires_at, used_at)
       VALUES (?, ?, ?, NULL)`,
    ).run(hashToken(verifyToken), accountId, now + VERIFY_TTL_MS);

    // Fire-and-forget mail; the user sees a generic success no matter what
    // happens at the SMTP layer (cannot leak deliverability). Log only the
    // error class/code — the raw message can echo the recipient address.
    void mailer.sendVerifyEmail(email, verifyToken).catch((e) => {
      req.log.warn({ err: mailErrorInfo(e) }, "verify-email send failed");
    });

    return reply.status(202).send({ ok: true });
  },
  );

  // ── Verify ──────────────────────────────────────────────────────────
  // GET because the link is followed by a click in a mail client.
  // Marks the token used + the account verified, and that's IT —
  // explicitly does NOT issue a session cookie (Sec H-2, review
  // 2026-05-13). A prior version auto-logged the user in here,
  // which made the URL a phishing/XS-leak vehicle: any page
  // embedding the link as <img src=…> would silently log a
  // first-time-visiting victim into their own (or, with
  // token-guessing, someone else's) account. The dashboard's
  // verify view now redirects to /login after a successful
  // verify and the user picks up from there.
  app.get(
    "/api/auth/verify/:token",
    {
      // 10 verification clicks per hour per IP — abuse-bound on the
      // token-guess path while leaving room for the user retrying.
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { token } = req.params as { token: string };
      if (!token) return bad(reply, 400, "bad-token", "missing token");
      const row = db
        .prepare<[string, number], { account_id: number; used_at: number | null }>(
          `SELECT account_id, used_at FROM email_verifications
            WHERE token_hash = ? AND expires_at > ?`,
        )
        .get(hashToken(token), Date.now());
      if (!row) return bad(reply, 410, "token-invalid", "verification link expired or unknown");
      if (row.used_at !== null) return bad(reply, 410, "token-used", "verification link already used");

      const now = Date.now();
      const tx = db.transaction(() => {
        db.prepare("UPDATE email_verifications SET used_at = ? WHERE token_hash = ?").run(
          now,
          hashToken(token),
        );
        db.prepare("UPDATE accounts SET email_verified_at = ? WHERE id = ?").run(now, row.account_id);
      });
      tx();

      return reply.status(200).send({ ok: true });
    },
  );

  // ── Login ───────────────────────────────────────────────────────────
  app.post(
    "/api/auth/login",
    {
      // 5 attempts per minute per IP — bot brute-force ceiling.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as LoginBody;
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";

      // Email shape check is cheap; do it BEFORE argon2 to avoid wasting
      // ~250 ms on obviously-bogus input.
      if (!isPlausibleEmail(email) || !password) {
        // Even here, pay the argon2 cost so timing is uniform. Only emit
        // a 400 when the *body* is entirely missing fields — that's a
        // protocol error, not a credential test.
        await verifyPasswordTimingSafe(null, password || "x");
        return bad(reply, 401, "bad-credentials", "email or password incorrect");
      }

      const account = db
        .prepare<
          [string],
          { id: number; password_hash: string; suspended_at: number | null }
        >(
          "SELECT id, password_hash, suspended_at FROM accounts WHERE email = ? AND deleted_at IS NULL",
        )
        .get(email);

      const ok = await verifyPasswordTimingSafe(account?.password_hash, password);
      if (!ok || !account) {
        return bad(reply, 401, "bad-credentials", "email or password incorrect");
      }

      // Suspended accounts pass the password check but cannot proceed
      // (gh #41 acceptance criterion: suspended_at blocks login after
      // password verify). The response shape stays distinct from
      // bad-credentials so the UI can show a meaningful message.
      if (account.suspended_at !== null) {
        return bad(reply, 403, "account-suspended", "account is suspended");
      }

      createSession(db, reply, account.id, req.headers["user-agent"]);
      return reply.status(200).send({ ok: true });
    },
  );

  // ── Logout ──────────────────────────────────────────────────────────
  app.post("/api/auth/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    const cookie = readSessionCookie(req);
    if (cookie) {
      const sess = findSession(db, cookie);
      if (sess) deleteSession(db, sess.tokenHash);
    }
    clearSessionCookie(reply);
    return reply.status(200).send({ ok: true });
  });

  // ── Forgot password ─────────────────────────────────────────────────
  app.post(
    "/api/auth/forgot",
    {
      // 3/h/IP per spec §9 — same ceiling as signup (both queue an
      // outbound email so the rate-limit also protects SMTP volume).
      config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as ForgotBody;
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

      // Always 200 — leaking account existence here defeats the purpose.
      // Even on bad email shape, we return ok so the response is constant
      // from the attacker's viewpoint.
      if (!isPlausibleEmail(email)) return reply.status(200).send({ ok: true });

      const account = db
        .prepare<[string], { id: number }>(
          "SELECT id FROM accounts WHERE email = ? AND deleted_at IS NULL",
        )
        .get(email);

      if (account) {
        const token = newToken();
        db.prepare(
          `INSERT INTO password_resets (token_hash, account_id, expires_at, used_at)
           VALUES (?, ?, ?, NULL)`,
        ).run(hashToken(token), account.id, Date.now() + RESET_TTL_MS);

        void mailer.sendResetEmail(email, token).catch((e) => {
          req.log.warn({ err: mailErrorInfo(e) }, "reset-email send failed");
        });
      }

      return reply.status(200).send({ ok: true });
    },
  );

  // ── Reset password ──────────────────────────────────────────────────
  app.post(
    "/api/auth/reset/:token",
    {
      // 5/h/IP per spec §9 — leaves room for the user retrying after a
      // typo while still blunting token-guess attempts.
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
    const { token } = req.params as { token: string };
    const body = (req.body ?? {}) as ResetBody;
    const password = typeof body.password === "string" ? body.password : "";

    if (!token) return bad(reply, 400, "bad-token", "missing token");
    if (!isAcceptablePassword(password))
      return bad(reply, 400, "bad-password", "password must be 8-256 characters");

    const row = db
      .prepare<[string, number], { account_id: number; used_at: number | null }>(
        `SELECT account_id, used_at FROM password_resets
          WHERE token_hash = ? AND expires_at > ?`,
      )
      .get(hashToken(token), Date.now());
    if (!row) return bad(reply, 410, "token-invalid", "reset link expired or unknown");
    if (row.used_at !== null) return bad(reply, 410, "token-used", "reset link already used");

    const newHash = await hashPassword(password);
    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ?").run(
        now,
        hashToken(token),
      );
      db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").run(newHash, row.account_id);
      // Spec §4.5 step 3: a successful reset invalidates every other
      // session of the account — log everyone else out.
      deleteAllSessionsForAccount(db, row.account_id);
    });
    tx();

    return reply.status(200).send({ ok: true });
  },
  );
}
