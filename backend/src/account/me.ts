import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { hashPassword, verifyPassword } from "../auth/argon.js";
import { newToken, hashToken } from "../auth/tokens.js";
import {
  clearSessionCookie,
  deleteAllSessionsForAccount,
} from "../auth/sessions.js";
import {
  checkAccountLockout,
  recordAccountPwFail,
  recordAccountPwSuccess,
} from "../auth/account_lockout.js";
import { mailErrorInfo } from "../email/log_safe.js";
import type { UnattendedRegistry } from "../unattended.js";

const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

export interface AccountMailer {
  /**
   * Sent to the NEW email address — clicking the link confirms the swap.
   * The old address stays active until then so a typo doesn't lock the
   * user out (spec §4.6).
   */
  sendEmailChangeVerification(newEmail: string, token: string): Promise<void>;
}

export interface MeDeps {
  db: Db;
  mailer: AccountMailer;
  /**
   * Live unattended-sharer WSS connections. Account deletion cascades
   * the devices away in SQL — without eviction the paired sharers would
   * stay connected until their next heartbeat re-auth.
   */
  registry?: UnattendedRegistry;
}

interface PatchMeBody {
  current_password?: unknown;
  new_email?: unknown;
  new_password?: unknown;
}

interface DeleteMeBody {
  current_password?: unknown;
  confirm?: unknown;
}

function bad(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: code, message });
}

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

function isAcceptablePassword(s: string): boolean {
  return s.length >= 8 && s.length <= 256;
}

export function registerMeRoutes(app: FastifyInstance, deps: MeDeps): void {
  const { db, mailer, registry } = deps;

  // ── GET /api/me ─────────────────────────────────────────────────────
  app.get(
    "/api/me",
    { preHandler: app.requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const account = db
        .prepare<
          [number],
          {
            id: number;
            email: string;
            email_verified_at: number | null;
            created_at: number;
            admin: number;
          }
        >(
          `SELECT id, email, email_verified_at, created_at, admin
             FROM accounts WHERE id = ?`,
        )
        .get(req.account!.id);
      if (!account) return bad(reply, 404, "not-found", "account gone");
      // Also report whether a pending email-change request is in flight
      // so the dashboard can surface it.
      const pending = db
        .prepare<[number, number], { new_email: string; expires_at: number }>(
          `SELECT new_email, expires_at FROM pending_email_changes
             WHERE account_id = ? AND used_at IS NULL AND expires_at > ?`,
        )
        .get(req.account!.id, Date.now());
      return reply.status(200).send({
        id: account.id,
        email: account.email,
        emailVerifiedAt: account.email_verified_at,
        createdAt: account.created_at,
        admin: account.admin === 1,
        pendingEmail: pending?.new_email ?? null,
        pendingEmailExpiresAt: pending?.expires_at ?? null,
      });
    },
  );

  // ── PATCH /api/me ───────────────────────────────────────────────────
  app.patch(
    "/api/me",
    {
      preHandler: app.requireSession,
      // 10/h per spec §9 — enough for the user to retry once or twice
      // but small enough to bound password-guessing through this surface.
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as PatchMeBody;
      const currentPassword =
        typeof body.current_password === "string" ? body.current_password : "";
      const newEmail = typeof body.new_email === "string" ? body.new_email.trim().toLowerCase() : null;
      const newPassword = typeof body.new_password === "string" ? body.new_password : null;

      if (!newEmail && !newPassword) {
        return bad(reply, 400, "no-changes", "specify new_email and/or new_password");
      }
      if (newEmail && !isPlausibleEmail(newEmail)) {
        return bad(reply, 400, "bad-email", "email format invalid");
      }
      if (newPassword !== null && !isAcceptablePassword(newPassword)) {
        return bad(reply, 400, "bad-password", "password must be 8-256 characters");
      }

      const account = db
        .prepare<[number], { id: number; email: string; password_hash: string }>(
          "SELECT id, email, password_hash FROM accounts WHERE id = ?",
        )
        .get(req.account!.id);
      if (!account) return bad(reply, 404, "not-found", "account gone");

      // Sec H-3 (review 2026-05-13): per-account lockout. An attacker
      // who steals one session cookie should NOT be able to brute the
      // current_password gate through the per-IP limit alone. Check
      // BEFORE running argon2 so a locked account also short-circuits
      // the CPU cost.
      const lock = checkAccountLockout(db, account.id);
      if (lock.locked) {
        return reply.status(423).send({
          error: "locked",
          message: "account temporarily locked",
          retryAfterSec: lock.retryAfterSec,
        });
      }

      // current_password gates every change. Use plain verify (not the
      // timing-safe variant) — the account is known to exist.
      const ok = await verifyPassword(account.password_hash, currentPassword);
      if (!ok) {
        recordAccountPwFail(db, account.id);
        return bad(reply, 403, "bad-credentials", "current password incorrect");
      }
      recordAccountPwSuccess(db, account.id);

      // Email change: queue a pending row + send verify mail to the NEW
      // address. The accounts.email column is NOT touched yet — the
      // verify-link click is what actually performs the swap.
      if (newEmail && newEmail !== account.email.toLowerCase()) {
        // Reject if the new address is already taken by another verified
        // account. Use a soft uniqueness check rather than relying on the
        // unique index because the unique only fires at the verify step
        // (where the swap happens transactionally).
        const taken = db
          .prepare<[string, number], { id: number }>(
            "SELECT id FROM accounts WHERE email = ? AND id != ?",
          )
          .get(newEmail, account.id);
        if (taken) return bad(reply, 409, "email-taken", "email already registered");

        // Drop any prior in-flight change request — only one pending
        // address at a time per account.
        db.prepare("DELETE FROM pending_email_changes WHERE account_id = ?").run(account.id);

        const token = newToken();
        db.prepare(
          `INSERT INTO pending_email_changes (token_hash, account_id, new_email, expires_at, used_at)
           VALUES (?, ?, ?, ?, NULL)`,
        ).run(hashToken(token), account.id, newEmail, Date.now() + EMAIL_CHANGE_TTL_MS);
        void mailer.sendEmailChangeVerification(newEmail, token).catch((e) => {
          req.log.warn({ err: mailErrorInfo(e) }, "email-change verify send failed");
        });
      }

      // Password change: re-hash + invalidate every session of this
      // account (spec §4.5 semantics). The current request's session
      // also gets nuked — the dashboard will redirect to login.
      if (newPassword !== null) {
        const newHash = await hashPassword(newPassword);
        const tx = db.transaction(() => {
          db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").run(
            newHash,
            account.id,
          );
          deleteAllSessionsForAccount(db, account.id);
        });
        tx();
        clearSessionCookie(reply);
      }

      return reply.status(200).send({ ok: true });
    },
  );

  // ── DELETE /api/me ──────────────────────────────────────────────────
  app.delete(
    "/api/me",
    {
      preHandler: app.requireSession,
      config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as DeleteMeBody;
      const currentPassword =
        typeof body.current_password === "string" ? body.current_password : "";
      const confirm = typeof body.confirm === "string" ? body.confirm : "";

      if (confirm !== "LÖSCHEN") {
        return bad(reply, 400, "bad-confirm", "confirm field must be exactly the string LÖSCHEN");
      }

      const account = db
        .prepare<[number], { id: number; password_hash: string }>(
          "SELECT id, password_hash FROM accounts WHERE id = ?",
        )
        .get(req.account!.id);
      if (!account) return bad(reply, 404, "not-found", "account gone");

      // Sec H-3: share the lockout with PATCH /api/me. Account
      // deletion is a one-shot but the cost of a delete-then-undo on
      // a wrong-password attacker is the same as a PATCH: 250 ms of
      // argon2 + a state-changing op. Lock check before verify.
      const lock = checkAccountLockout(db, account.id);
      if (lock.locked) {
        return reply.status(423).send({
          error: "locked",
          message: "account temporarily locked",
          retryAfterSec: lock.retryAfterSec,
        });
      }

      const ok = await verifyPassword(account.password_hash, currentPassword);
      if (!ok) {
        recordAccountPwFail(db, account.id);
        return bad(reply, 403, "bad-credentials", "current password incorrect");
      }
      recordAccountPwSuccess(db, account.id);

      // Device-IDs VOR dem Cascade einsammeln — danach sind die Zeilen weg,
      // aber die WSS-Verbindungen der gepaarten Sharer leben noch.
      const deviceIds = db
        .prepare<[number], { id: string }>(
          "SELECT id FROM devices WHERE owner_account_id = ?",
        )
        .all(account.id);

      // Hard-delete. Foreign-key cascades on sessions, email_verifications,
      // password_resets, pending_email_changes, devices + logs take
      // everything related with it.
      db.prepare("DELETE FROM accounts WHERE id = ?").run(account.id);

      for (const d of deviceIds) registry?.evict(d.id);

      clearSessionCookie(reply);
      return reply.status(204).send();
    },
  );

  // ── GET /api/me/email-change/:token ─────────────────────────────────
  // The click-through that actually performs the swap. Wired here rather
  // than under /api/auth/* because it's an authenticated user-initiated
  // change, not an account-recovery flow.
  app.get(
    "/api/me/email-change/:token",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { token } = req.params as { token: string };
      if (!token) return bad(reply, 400, "bad-token", "missing token");

      const row = db
        .prepare<[string, number], { account_id: number; new_email: string; used_at: number | null }>(
          `SELECT account_id, new_email, used_at
             FROM pending_email_changes
            WHERE token_hash = ? AND expires_at > ?`,
        )
        .get(hashToken(token), Date.now());
      if (!row) return bad(reply, 410, "token-invalid", "link expired or unknown");
      if (row.used_at !== null) return bad(reply, 410, "token-used", "link already used");

      // Final taken-check inside the transaction. If two pending changes
      // race for the same new address, only the first commit wins.
      const tx = db.transaction(() => {
        const taken = db
          .prepare<[string, number], { id: number }>(
            "SELECT id FROM accounts WHERE email = ? AND id != ?",
          )
          .get(row.new_email, row.account_id);
        if (taken) {
          throw new Error("email-taken");
        }
        // The click proves ownership of the NEW mailbox, so it also sets
        // email_verified_at: a typo-signup account (verify mail went to a
        // wrong address, no resend path exists) becomes verified here, and
        // a previously-verified account doesn't keep a stale timestamp
        // that claimed verification of the OLD address.
        db.prepare("UPDATE accounts SET email = ?, email_verified_at = ? WHERE id = ?").run(
          row.new_email,
          Date.now(),
          row.account_id,
        );
        db.prepare(
          "UPDATE pending_email_changes SET used_at = ? WHERE token_hash = ?",
        ).run(Date.now(), hashToken(token));
        // Sec L-9 (review 2026-05-13): invalidate every session of
        // the account on email change — mirrors the password-change
        // policy (spec §4.5 step 3). The recovery-address is now a
        // different inbox; existing live sessions on other devices
        // should re-authenticate so a stolen cookie doesn't keep
        // privileged access after the legitimate owner's email
        // suddenly differs.
        deleteAllSessionsForAccount(db, row.account_id);
      });
      try {
        tx();
      } catch (e) {
        if ((e as Error).message === "email-taken") {
          return bad(reply, 409, "email-taken", "new address was claimed elsewhere");
        }
        throw e;
      }

      // Sec L-9: also clear the cookie on THIS response so the
      // browser following the mail link sees the logout immediately.
      // Other browsers (mobile, second laptop) will hit a 401 on
      // their next request because deleteAllSessionsForAccount
      // dropped the DB row.
      clearSessionCookie(reply);
      return reply.status(200).send({ ok: true });
    },
  );
}
