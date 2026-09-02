import type { Db } from "./db.js";

/**
 * Retention windows (milliseconds) for the periodic purge. Spec
 * section 12 + DSGVO V-002: rows in user-visible logs disappear at
 * 30 days; audit rows hang on longer for support/incident review.
 * Anyone changing these constants should also update
 * `docs/security-review-2026-05.md`.
 */
export interface PurgeRetention {
  /** connection_log rows older than this are deleted. */
  connectionLogMs: number;
  /** audit_log rows older than this are deleted. */
  auditLogMs: number;
  /**
   * code_events rows older than this are deleted. Diese Tabelle ist
   * non-PII (nur Timestamps) — Retention dient nur dazu, die Tabelle
   * klein zu halten und entspricht der disclosed auditLog-Retention.
   */
  codeEventsMs: number;
  /**
   * Feedback (gh #39): resolved rows past `resolved_at + this` get
   * hard-deleted; open rows past `created_at + feedbackOpenMaxMs` go
   * too. Two windows because resolved feedback is mostly historical
   * (admin already saw + actioned it), open feedback may still need
   * triage. Default: 365 d resolved / 730 d open.
   */
  feedbackResolvedMs: number;
  feedbackOpenMaxMs: number;
  /**
   * Accounts still unverified this long after signup are hard-deleted —
   * but only if they were never used: no live session and no paired
   * device. Login is deliberately not gated on verification (spec §4.3),
   * so an unverified account CAN be someone's working account; the two
   * NOT EXISTS guards are what keeps those safe. Sessions age out at 30 d,
   * so a device-less account whose last session lapsed becomes purgeable
   * on the next pass — that is the intended "abandoned" semantics. The
   * window is well past the 24 h token TTL so a typo-signup can simply
   * re-register once the squatted address is released. Default: 7 d.
   */
  unverifiedAccountsMs: number;
}

export const DEFAULT_RETENTION: PurgeRetention = {
  connectionLogMs: 30 * 24 * 60 * 60 * 1000, // 30 d
  auditLogMs: 365 * 24 * 60 * 60 * 1000, // 1 y
  codeEventsMs: 365 * 24 * 60 * 60 * 1000, // 1 y
  feedbackResolvedMs: 365 * 24 * 60 * 60 * 1000, // 1 y
  feedbackOpenMaxMs: 2 * 365 * 24 * 60 * 60 * 1000, // 2 y
  unverifiedAccountsMs: 7 * 24 * 60 * 60 * 1000, // 7 d
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
  /** code_events rows older than retention. */
  codeEvents: number;
  /** audit_log rows pointing at a feedback row being purged this pass. */
  feedbackAuditCascade: number;
  /** rate_limit_buckets rows whose lockout is past and counter is zero. */
  rateLimitBuckets: number;
  /** Feedback rows past retention (resolved-window + open-max). */
  feedback: number;
  /** Never-used accounts still unverified past `unverifiedAccountsMs`. */
  unverifiedAccounts: number;
}

/**
 * Rows deleted across every table in one pass. Summed generically so a
 * field added to `PurgeReport` can never again be left out of the
 * "did anything happen" gate the scheduler log uses.
 */
export function purgeReportTotal(report: PurgeReport): number {
  return Object.values(report).reduce((sum, n) => sum + n, 0);
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

  const oldCodeEvents = db
    .prepare("DELETE FROM code_events WHERE created_at < ?")
    .run(now - retention.codeEventsMs);

  // rate_limit_buckets: drop fully-recovered rows (counter back at
  // zero, no active lock) AND rows whose lockout has expired — the
  // fail-recorders start a fresh streak after an expired lock anyway
  // (see recordPwFail / recordAccountPwFail), so a stale counter
  // carries no state worth keeping, and the keys reference account /
  // device ids that must not outlive their usefulness (retention).
  const expiredBuckets = db
    .prepare(
      `DELETE FROM rate_limit_buckets
        WHERE (locked_until IS NULL AND fail_count = 0)
           OR (locked_until IS NOT NULL AND locked_until < ?)`,
    )
    .run(now);

  // Feedback (gh #39 + Security-Review L-1, 2026-05-14):
  //   - resolved rows that aged past `feedbackResolvedMs` since their
  //     resolve-timestamp,
  //   - open rows that aged past `feedbackOpenMaxMs` since creation
  //     (these are stale-and-never-actioned; admin has had 2 years
  //     to look at them, time to let go).
  // Both predicates are OR'd so a single DELETE covers them.
  // Sweep the matching audit-log entries in the same transaction BEFORE
  // the feedback DELETE — otherwise `feedback.resolve`/`feedback.reply`/
  // `feedback.delete` rows would keep the full body snapshot in
  // before_json/after_json for up to `auditLogMs` (1 y) AFTER the feedback
  // row itself disappeared, stretching effective retention past the
  // disclosed windows (DSGVO-M2, code-review 2026-05-17). The cascade
  // selects the ids with a subquery rather than binding one variable per
  // row: SQLITE_MAX_VARIABLE_NUMBER (32766) would otherwise make the
  // prepare throw on a large backlog and wedge the purge permanently.
  const stalePredicate = `
        (resolved_at IS NOT NULL AND resolved_at < ?)
     OR (resolved_at IS NULL     AND created_at  < ?)`;
  const purgeFeedback = db.transaction(
    (resolvedCutoff: number, openCutoff: number): { audit: number; feedback: number } => {
      const audit = db
        .prepare(
          `DELETE FROM audit_log
            WHERE target_type = 'feedback'
              AND target_id IN (SELECT CAST(id AS TEXT) FROM feedback WHERE ${stalePredicate})`,
        )
        .run(resolvedCutoff, openCutoff).changes;
      const feedback = db
        .prepare(`DELETE FROM feedback WHERE ${stalePredicate}`)
        .run(resolvedCutoff, openCutoff).changes;
      return { audit, feedback };
    },
  );
  const oldFeedback = purgeFeedback(
    now - retention.feedbackResolvedMs,
    now - retention.feedbackOpenMaxMs,
  );

  // Abandoned signups (see PurgeRetention.unverifiedAccountsMs). The FK
  // cascade takes the account's token rows with it, but the account-lockout
  // bucket is keyed by id string, not by FK, so it is swept explicitly in
  // the same transaction — an orphaned `account:<id>:pwfail` row with a
  // non-zero counter would otherwise survive the row it belongs to.
  const unverifiedPredicate = `
        email_verified_at IS NULL
        AND created_at < ?
        AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.account_id = accounts.id)
        AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.owner_account_id = accounts.id)`;
  const purgeUnverified = db.transaction((cutoff: number): number => {
    db.prepare(
      `DELETE FROM rate_limit_buckets
        WHERE key IN (SELECT 'account:' || id || ':pwfail' FROM accounts WHERE ${unverifiedPredicate})`,
    ).run(cutoff);
    return db.prepare(`DELETE FROM accounts WHERE ${unverifiedPredicate}`).run(cutoff).changes;
  });
  const staleUnverified = purgeUnverified(now - retention.unverifiedAccountsMs);

  return {
    sessions: expiredSessions.changes,
    devicePairings: expiredPairings.changes,
    emailVerifications: expiredVerifications.changes,
    passwordResets: expiredResets.changes,
    pendingEmailChanges: expiredEmailChanges.changes,
    connectionLog: oldConnLog.changes,
    auditLog: oldAuditLog.changes,
    codeEvents: oldCodeEvents.changes,
    rateLimitBuckets: expiredBuckets.changes,
    feedback: oldFeedback.feedback,
    feedbackAuditCascade: oldFeedback.audit,
    unverifiedAccounts: staleUnverified,
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
