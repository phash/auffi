import type { Db } from "../db.js";

/**
 * Admins who can actually reach the admin surface: suspended admins are
 * blocked at login, so they don't count when deciding whether an action
 * would leave the deployment without a working admin. Shared by the admin
 * user actions (demote / suspend) and the account's own DELETE /api/me.
 */
export function countActiveAdmins(db: Db): number {
  const row = db
    .prepare<[], { c: number }>(
      "SELECT COUNT(*) AS c FROM accounts WHERE admin = 1 AND suspended_at IS NULL",
    )
    .get();
  return row?.c ?? 0;
}
