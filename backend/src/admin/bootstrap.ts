import type { Db } from "../db.js";

/**
 * Initial-admin bootstrap. Self-hosters set INITIAL_ADMIN_EMAIL in
 * the env to grant a specific account the admin flag automatically
 * (no DB surgery needed). Fires at two points:
 *
 *   - Email verification: once the verify-link click proves mailbox
 *     ownership, a matching account is promoted. Signup alone never
 *     promotes — otherwise anyone who registers a guessable admin@…
 *     address first would hold a working admin session with zero
 *     mailbox proof.
 *   - Boot: any existing VERIFIED account matching the env var gets
 *     promoted once. Idempotent — running on every boot is fine
 *     because setting admin=1 on an already-admin row is a no-op.
 *
 * The empty / unset env case is treated as "no auto-admin" so the
 * default deploy is closed by default.
 */

/**
 * Promote an account by email if INITIAL_ADMIN_EMAIL (case-insensitive)
 * matches `email` AND the account's mailbox ownership is proven
 * (email_verified_at set). Returns true if the account was promoted
 * (or already admin), false when the env var was unset, didn't match,
 * or the account is unverified.
 */
export function maybePromoteToAdmin(
  db: Db,
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const target = env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  if (!target) return false;
  if (email.toLowerCase() !== target) return false;
  const result = db
    .prepare(
      `UPDATE accounts SET admin = 1
        WHERE email = ? AND email_verified_at IS NOT NULL`,
    )
    .run(email.toLowerCase());
  return result.changes > 0;
}

/**
 * Boot-time pass: promote any existing VERIFIED account whose email
 * matches INITIAL_ADMIN_EMAIL. An unverified match is refused — a
 * squatter who pre-registered the address must not gain admin at the
 * next restart just by existing.
 *
 * Logging is the caller's responsibility — we don't import a logger
 * here so the function stays pure for testing.
 */
export function bootstrapInitialAdmin(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): { promoted: boolean; email: string | null } {
  const target = env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  if (!target) return { promoted: false, email: null };
  const account = db
    .prepare<[string], { id: number; admin: number; email_verified_at: number | null }>(
      "SELECT id, admin, email_verified_at FROM accounts WHERE email = ?",
    )
    .get(target);
  if (!account) return { promoted: false, email: target };
  if (account.admin === 1) return { promoted: false, email: target };
  if (account.email_verified_at === null) return { promoted: false, email: target };
  db.prepare("UPDATE accounts SET admin = 1 WHERE id = ?").run(account.id);
  return { promoted: true, email: target };
}
