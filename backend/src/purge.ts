import type { Db } from "./db.js";

/**
 * Retention windows (milliseconds) for the periodic purge. Spec
 * section 12 + DSGVO V-002: rows in user-visible logs disappear at
 * 30 days; soft-deleted accounts and audit rows hang on longer for
 * support/incident review. Anyone changing these constants should
 * also update `docs/security-review-2026-05.md`.
 */
export interface PurgeRetention {
  /** Soft-deleted accounts: rows past `deleted_at + this` are hard-deleted. */
  softDeletedAccountsGraceMs: number;
  /** connection_log rows older than this are deleted. */
  connectionLogMs: number;
  /** audit_log rows older than this are deleted. */
  auditLogMs: number;
  /**
   * Feedback (gh #39): resolved rows past `resolved_at + this` get
   * hard-deleted; open rows past `created_at + feedbackOpenMaxMs` go
   * too. Two windows because resolved feedback is mostly historical
   * (admin already saw + actioned it), open feedback may still need
   * triage. Default: 365 d resolved / 730 d open.
   */
  feedbackResolvedMs: number;
  feedbackOpenMaxMs: number;
}

export const DEFAULT_RETENTION: PurgeRetention = {
  softDeletedAccountsGraceMs: 30 * 24 * 60 * 60 * 1000, // 30 d
  connectionLogMs: 30 * 24 * 60 * 60 * 1000, // 30 d
  auditLogMs: 365 * 24 * 60 * 60 * 1000, // 1 y
  feedbackResolvedMs: 365 * 24 * 60 * 60 * 1000, // 1 y
  feedbackOpenMaxMs: 2 * 365 * 24 * 60 * 60 * 1000, // 2 y
};

export interface PurgeReport {
  /** Expired sessions (cookies whose TTL has lapsed). */
  sessions: number;
  /** device_pairings rows past `expires_at` OR with non-null `used_at`. */
  devicePairings: number;
  /** email_verifications rows past `expires_at` OR used. */
  emailVerifications: number;
  /** password_resets rows past `expires_at` OR used. */
  passwordResets: number;
  /** pending_email_changes rows past `expires_at` OR used. */
  pendingEmailChanges: number;
  /** connection_log rows older than retention. */
  connectionLog: number;
  /** audit_log rows older than retention. */
  auditLog: number;
  /** audit_log rows pointing at a feedback row being purged this pass. */
  feedbackAuditCascade: number;
  /** Accounts soft-deleted longer ago than the grace window — hard-deleted. */
  softDeletedAccounts: number;
  /** rate_limit_buckets rows whose lockout is past and counter is zero. */
  rateLimitBuckets: number;
  /** Feedback rows past retention (resolved-window + open-max). */
  feedback: number;
}

/**
 * Run one pass of the retention cleanup. Pure on (db, now, retention) —
 * no side effects beyond the DB writes it owns. Returns a per-table
 * count so callers can log "purged N sessions, M expired pairings, …".
 *
 * Idempotent: running back-to-back yields zeroes on the second pass.
 *
 * Each section deletes by a single indexed predicate so the cost is
 * proportional to the number of rows actually purged, not the table
 * size. The indexes already exist in the migrations.
 */
export function runPurge(
  db: Db,
  now: number = Date.now(),
  retention: PurgeRetention = DEFAULT_RETENTION,
): PurgeReport {
  const expiredSessions = db
    .prepare("DELETE FROM sessions WHERE expires_at < ?")
    .run(now);

  // device_pairings: drop expired OR redeemed entries. The used_at
  // index lets the planner skip alive rows.
  const expiredPairings = db
    .prepare(
      "DELETE FROM device_pairings WHERE expires_at < ? OR used_at IS NOT NULL",
    )
    .run(now);

  const expiredVerifications = db
    .prepare(
      "DELETE FROM email_verifications WHERE expires_at < ? OR used_at IS NOT NULL",
    )
    .run(now);

  const expiredResets = db
    .prepare(
      "DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL",
    )
    .run(now);

  const expiredEmailChanges = db
    .prepare(
      "DELETE FROM pending_email_changes WHERE expires_at < ? OR used_at IS NOT NULL",
    )
    .run(now);

  const oldConnLog = db
    .prepare("DELETE FROM connection_log WHERE started_at < ?")
    .run(now - retention.connectionLogMs);

  const oldAuditLog = db
    .prepare("DELETE FROM audit_log WHERE created_at < ?")
    .run(now - retention.auditLogMs);

  // Hard-delete accounts past the soft-delete grace window. The FK
  // cascades to sessions, devices, audit_log refs (admin_id SET NULL),
  // so device tokens + connection_log rows go too.
  const softDeleted = db
    .prepare(
      "DELETE FROM accounts WHERE deleted_at IS NOT NULL AND deleted_at < ?",
    )
    .run(now - retention.softDeletedAccountsGraceMs);

  // rate_limit_buckets: drop rows whose lockout has expired AND whose
  // counter is back at zero. The counter-reset happens elsewhere; we
  // only sweep up "fully recovered" rows so the table stays small.
  const expiredBuckets = db
    .prepare(
      "DELETE FROM rate_limit_buckets WHERE (locked_until IS NULL OR locked_until < ?) AND fail_count = 0",
    )
    .run(now);

  // Feedback (gh #39 + Security-Review L-1, 2026-05-14):
  //   - resolved rows that aged past `feedbackResolvedMs` since their
  //     resolve-timestamp,
  //   - open rows that aged past `feedbackOpenMaxMs` since creation
  //     (these are stale-and-never-actioned; admin has had 2 years
  //     to look at them, time to let go).
  // Both predicates are OR'd so a single DELETE covers them.
  // Capture the deleted IDs BEFORE the DELETE so the matching audit-log
  // entries can be swept too — otherwise `feedback.resolve`/`feedback.
  // reply`/`feedback.delete` rows would keep the full body snapshot in
  // before_json/after_json for up to `auditLogMs` (1 y) AFTER the
  // feedback row itself disappeared. That stretched effective retention
  // past the disclosed feedback windows (DSGVO-M2, code-review
  // 2026-05-17). Cascade-purge keeps the disclosed promise honest.
  const feedbackToDelete = db
    .prepare<[number, number], { id: number }>(
      `SELECT id FROM feedback
        WHERE (resolved_at IS NOT NULL AND resolved_at < ?)
           OR (resolved_at IS NULL     AND created_at  < ?)`,
    )
    .all(now - retention.feedbackResolvedMs, now - retention.feedbackOpenMaxMs);
  let feedbackAuditPurged = 0;
  if (feedbackToDelete.length > 0) {
    const placeholders = feedbackToDelete.map(() => "?").join(",");
    const ids = feedbackToDelete.map((r) => String(r.id));
    feedbackAuditPurged = db
      .prepare(
        `DELETE FROM audit_log
          WHERE target_type = 'feedback'
            AND target_id IN (${placeholders})`,
      )
      .run(...ids).changes;
  }
  const oldFeedback = db
    .prepare(
      `DELETE FROM feedback
        WHERE (resolved_at IS NOT NULL AND resolved_at < ?)
           OR (resolved_at IS NULL     AND created_at  < ?)`,
    )
    .run(now - retention.feedbackResolvedMs, now - retention.feedbackOpenMaxMs);

  return {
    sessions: expiredSessions.changes,
    devicePairings: expiredPairings.changes,
    emailVerifications: expiredVerifications.changes,
    passwordResets: expiredResets.changes,
    pendingEmailChanges: expiredEmailChanges.changes,
    connectionLog: oldConnLog.changes,
    auditLog: oldAuditLog.changes,
    softDeletedAccounts: softDeleted.changes,
    rateLimitBuckets: expiredBuckets.changes,
    feedback: oldFeedback.changes,
    feedbackAuditCascade: feedbackAuditPurged,
  };
}

/**
 * Schedule `runPurge` on a recurring interval (default 6 h). Returns
 * a `stop()` function the caller registers as an `onClose` hook so
 * the timer doesn't leak between server restarts in tests.
 *
 * The first run fires `intervalMs` after install — NOT immediately at
 * startup. Backfill of months-old logs would otherwise crash a tight
 * startup window; we trust the operator to run a one-shot purge by
 * hand on initial deploy.
 *
 * Errors inside `runPurge` are caught and logged via the provided
 * `log` callback so a transient DB lock doesn't crash the server.
 */
export interface PurgeSchedulerOpts {
  intervalMs?: number;
  retention?: PurgeRetention;
  log?: (report: PurgeReport) => void;
  onError?: (err: unknown) => void;
}

export function startPurgeScheduler(db: Db, opts: PurgeSchedulerOpts = {}): () => void {
  const intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000; // 6 h
  const retention = opts.retention ?? DEFAULT_RETENTION;
  const handle = setInterval(() => {
    try {
      const report = runPurge(db, Date.now(), retention);
      opts.log?.(report);
    } catch (err) {
      opts.onError?.(err);
    }
  }, intervalMs);
  // Don't hold the Node.js event loop open just for this timer.
  if (typeof handle.unref === "function") handle.unref();
  return () => clearInterval(handle);
}
