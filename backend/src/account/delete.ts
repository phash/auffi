import type { Db } from "../db.js";
import type { UnattendedRegistry } from "../unattended.js";

/**
 * Hard-delete an account (DELETE /api/me and the admin delete share this).
 * FK cascades take sessions, tokens, devices, connection_log and the
 * account's own feedback with it, the feedback's audit rows are removed
 * explicitly; `alsoInTransaction` lets the caller commit
 * its audit row atomically with the delete.
 *
 * The live unattended sharers are force-closed only AFTER the commit: a
 * delete that fails (constraint, locked DB) must leave the account fully
 * working, not half-revoked. Their ids are read up front because the
 * cascade removes the device rows.
 */
export function deleteAccount(
  db: Db,
  registry: UnattendedRegistry | undefined,
  accountId: number,
  alsoInTransaction: () => void = () => {},
): void {
  const deviceIds = db
    .prepare<[number], { id: string }>("SELECT id FROM devices WHERE owner_account_id = ?")
    .all(accountId)
    .map((r) => r.id);
  db.transaction(() => {
    alsoInTransaction();
    // The account's feedback cascades away, but audit_log.target_id has no
    // FK back, so the resolve/reply rows (body and reply text in their
    // snapshots) would outlive it — contrary to Datenschutz §9.
    db.prepare(
      `DELETE FROM audit_log
        WHERE target_type = 'feedback'
          AND target_id IN (SELECT CAST(id AS TEXT) FROM feedback WHERE account_id = ?)`,
    ).run(accountId);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
  })();
  if (registry) for (const id of deviceIds) registry.evict(id);
}
