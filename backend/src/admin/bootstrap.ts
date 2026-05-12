import type { Db } from "../db.js";

/**
 * Initial-admin bootstrap. Self-hosters set INITIAL_ADMIN_EMAIL in
 * the env to grant a specific account the admin flag automatically
 * (no DB surgery needed). Fires at two points:
 *
 *   - Signup: if the email being created matches the env var, the new
 *     row is promoted in the same transaction.
 *   - Boot: any existing account matching the env var gets promoted
 *     once. Idempotent — running on every boot is fine because
 *     setting admin=1 on an already-admin row is a no-op.
 *
 * The empty / unset env case is treated as "no auto-admin" so the
 * default deploy is closed by default.
 */

/**
 * Promote an account by email if INITIAL_ADMIN_EMAIL (case-insensitive)
 * matches `email`. Caller decides whether to invoke from signup or boot.
 * Returns true if the account was promoted (or already admin), false if
 * the env var was unset or didn't match.
 */
export function maybePromoteToAdmin(
  db: Db,
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const target = env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  if (!target) return false;
  if (email.toLowerCase() !== target) return false;
  db.prepare("UPDATE accounts SET admin = 1 WHERE email = ? AND deleted_at IS NULL").run(
    email.toLowerCase(),
  );
  return true;
}

/**
 * Boot-time pass: promote any existing account whose email matches
 * INITIAL_ADMIN_EMAIL. Returns the number of rows promoted (0 or 1).
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
    .prepare<[string], { id: number; admin: number }>(
      "SELECT id, admin FROM accounts WHERE email = ? AND deleted_at IS NULL",
    )
    .get(target);
  if (!account) return { promoted: false, email: target };
  if (account.admin === 1) return { promoted: false, email: target };
  db.prepare("UPDATE accounts SET admin = 1 WHERE id = ?").run(account.id);
  return { promoted: true, email: target };
}
