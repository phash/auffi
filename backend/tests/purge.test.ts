import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import {
  DEFAULT_RETENTION,
  runPurge,
  startPurgeScheduler,
} from "../src/purge.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("runPurge", () => {
  let db: Db;
  const now = 10_000_000_000;

  beforeEach(() => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, email_verified_at, created_at) VALUES (1, 'a@a', 'x', ?, ?)",
    ).run(now, now);
  });

  afterEach(() => {
    db.close();
  });

  it("deletes expired sessions and keeps live ones", () => {
    db.prepare(
      "INSERT INTO sessions (token_hash, account_id, expires_at, last_seen_at) VALUES ('h1', 1, ?, ?)",
    ).run(now - 1, now); // expired
    db.prepare(
      "INSERT INTO sessions (token_hash, account_id, expires_at, last_seen_at) VALUES ('h2-alive', 1, ?, ?)",
    ).run(now + HOUR, now); // alive — unique token_hash needed as PK

    const rep = runPurge(db, now);
    expect(rep.sessions).toBe(1);
    expect(
      db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM sessions").get()!.c,
    ).toBe(1);
  });

  it("deletes expired AND used device_pairings", () => {
    db.prepare(
      "INSERT INTO device_pairings (code_hash, account_id, expires_at, used_at) VALUES ('h1', 1, ?, NULL)",
    ).run(now - 1); // expired
    db.prepare(
      "INSERT INTO device_pairings (code_hash, account_id, expires_at, used_at) VALUES ('h2', 1, ?, ?)",
    ).run(now + HOUR, now - 1000); // used (regardless of expiry)
    db.prepare(
      "INSERT INTO device_pairings (code_hash, account_id, expires_at, used_at) VALUES ('h3', 1, ?, NULL)",
    ).run(now + HOUR); // alive + unused — keep

    const rep = runPurge(db, now);
    expect(rep.devicePairings).toBe(2);
    expect(
      db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM device_pairings").get()!.c,
    ).toBe(1);
  });

  it("deletes expired OR used email_verifications + password_resets + pending_email_changes", () => {
    for (const table of ["email_verifications", "password_resets", "pending_email_changes"]) {
      const extraCol = table === "pending_email_changes" ? ", new_email" : "";
      const extraVal = table === "pending_email_changes" ? ", 'b@b'" : "";
      db.prepare(
        `INSERT INTO ${table} (token_hash, account_id, expires_at, used_at${extraCol})
         VALUES ('e_${table}', 1, ?, NULL${extraVal})`,
      ).run(now - 1);
      db.prepare(
        `INSERT INTO ${table} (token_hash, account_id, expires_at, used_at${extraCol})
         VALUES ('u_${table}', 1, ?, ?${extraVal})`,
      ).run(now + HOUR, now - 1000);
      db.prepare(
        `INSERT INTO ${table} (token_hash, account_id, expires_at, used_at${extraCol})
         VALUES ('a_${table}', 1, ?, NULL${extraVal})`,
      ).run(now + HOUR);
    }
    const rep = runPurge(db, now);
    expect(rep.emailVerifications).toBe(2);
    expect(rep.passwordResets).toBe(2);
    expect(rep.pendingEmailChanges).toBe(2);
    for (const table of ["email_verifications", "password_resets", "pending_email_changes"]) {
      const c = db
        .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)
        .get()!.c;
      expect(c).toBe(1);
    }
  });

  it("deletes connection_log rows older than the 30-day retention", () => {
    db.prepare(
      "INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at) VALUES ('111-111-111', 1, 'D', 'h', ?)",
    ).run(now);
    db.prepare(
      "INSERT INTO connection_log (device_id, started_at, viewer_ip_prefix, connection_type) VALUES ('111-111-111', ?, '84.xxx', 'p2p')",
    ).run(now - 31 * DAY);
    db.prepare(
      "INSERT INTO connection_log (device_id, started_at, viewer_ip_prefix, connection_type) VALUES ('111-111-111', ?, '84.xxx', 'p2p')",
    ).run(now - 29 * DAY);
    const rep = runPurge(db, now);
    expect(rep.connectionLog).toBe(1);
    expect(
      db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM connection_log").get()!.c,
    ).toBe(1);
  });

  it("deletes audit_log rows older than the 1-year retention", () => {
    db.prepare(
      "INSERT INTO audit_log (admin_id, action, target_type, target_id, created_at) VALUES (1, 'user.suspend', 'account', '1', ?)",
    ).run(now - 366 * DAY);
    db.prepare(
      "INSERT INTO audit_log (admin_id, action, target_type, target_id, created_at) VALUES (1, 'user.suspend', 'account', '1', ?)",
    ).run(now - 100 * DAY);
    const rep = runPurge(db, now);
    expect(rep.auditLog).toBe(1);
  });

  it("hard-deletes soft-deleted accounts past the 30-day grace", () => {
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, created_at, deleted_at) VALUES (2, 'old@a', 'x', ?, ?)",
    ).run(now - 100 * DAY, now - 31 * DAY); // grace expired
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, created_at, deleted_at) VALUES (3, 'recent@a', 'x', ?, ?)",
    ).run(now - 100 * DAY, now - 7 * DAY); // still in grace
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, created_at, deleted_at) VALUES (4, 'live@a', 'x', ?, NULL)",
    ).run(now - 100 * DAY); // never deleted

    const rep = runPurge(db, now);
    expect(rep.softDeletedAccounts).toBe(1);
    expect(
      db
        .prepare<[number], { id: number }>("SELECT id FROM accounts WHERE id = ?")
        .all(2).length,
    ).toBe(0);
    expect(
      db
        .prepare<[number], { id: number }>("SELECT id FROM accounts WHERE id = ?")
        .all(3).length,
    ).toBe(1);
  });

  it("drops fully-recovered rate_limit_buckets but keeps active ones", () => {
    db.prepare(
      "INSERT INTO rate_limit_buckets (key, fail_count, locked_until) VALUES ('a', 0, NULL)",
    ).run();
    db.prepare(
      "INSERT INTO rate_limit_buckets (key, fail_count, locked_until) VALUES ('b', 0, ?)",
    ).run(now - 1); // lock expired AND count zero — drop
    db.prepare(
      "INSERT INTO rate_limit_buckets (key, fail_count, locked_until) VALUES ('c', 3, NULL)",
    ).run(); // count > 0 — keep
    db.prepare(
      "INSERT INTO rate_limit_buckets (key, fail_count, locked_until) VALUES ('d', 0, ?)",
    ).run(now + HOUR); // still locked — keep

    const rep = runPurge(db, now);
    expect(rep.rateLimitBuckets).toBe(2);
    const rest = db
      .prepare<[], { key: string }>("SELECT key FROM rate_limit_buckets ORDER BY key")
      .all()
      .map((r) => r.key);
    expect(rest).toEqual(["c", "d"]);
  });

  it("is idempotent — second consecutive run reports zeroes everywhere", () => {
    db.prepare(
      "INSERT INTO sessions (token_hash, account_id, expires_at, last_seen_at) VALUES ('h1', 1, ?, ?)",
    ).run(now - 1, now);
    const first = runPurge(db, now);
    expect(first.sessions).toBe(1);
    const second = runPurge(db, now);
    expect(second).toEqual({
      sessions: 0,
      devicePairings: 0,
      emailVerifications: 0,
      passwordResets: 0,
      pendingEmailChanges: 0,
      connectionLog: 0,
      auditLog: 0,
      codeEvents: 0,
      softDeletedAccounts: 0,
      rateLimitBuckets: 0,
      feedback: 0,
      feedbackAuditCascade: 0,
    });
  });

  // gh #39 + Security-Review L-1 (2026-05-14): feedback rows must
  // age out — resolved ones after 1 y, open ones after 2 y.
  it("hard-deletes resolved feedback past `feedbackResolvedMs` and stale open feedback past `feedbackOpenMaxMs`", () => {
    // Account-row required for the FK.
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, created_at) VALUES (10, 'feedback@test', 'x', ?)",
    ).run(now);

    const insert = db.prepare(
      `INSERT INTO feedback
         (account_id, source, category, rating, body, created_at, resolved_at)
       VALUES (10, 'dashboard', 'feature', 4, ?, ?, ?)`,
    );

    // Resolved 13 months ago → deletes (> 1 y).
    insert.run("old-resolved", now - 400 * DAY, now - 400 * DAY);
    // Resolved 6 months ago → keeps (< 1 y).
    insert.run("recent-resolved", now - 180 * DAY, now - 180 * DAY);
    // Open since 3 years ago → deletes (> 2 y).
    insert.run("ancient-open", now - 3 * 365 * DAY, null);
    // Open since 6 months ago → keeps (< 2 y).
    insert.run("recent-open", now - 180 * DAY, null);

    const report = runPurge(db, now);
    expect(report.feedback).toBe(2);

    const survivors = db
      .prepare<[], { body: string }>("SELECT body FROM feedback ORDER BY body")
      .all()
      .map((r) => r.body);
    expect(survivors).toEqual(["recent-open", "recent-resolved"]);
  });

  it("cascade-purges audit_log entries about feedback rows being purged (DSGVO-M2 fix)", () => {
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, created_at, admin) VALUES (12, 'cascade@test', 'x', ?, 1)",
    ).run(now);
    db.prepare(
      `INSERT INTO feedback
         (id, account_id, source, category, rating, body, created_at, resolved_at)
       VALUES (777, 12, 'dashboard', 'feature', 4, 'old-with-audit', ?, ?)`,
    ).run(now - 400 * DAY, now - 400 * DAY);
    // Two audit_log rows about that feedback — these should cascade.
    const auditInsert = db.prepare(
      `INSERT INTO audit_log
         (admin_id, action, target_type, target_id, before_json, after_json, created_at, viewer_ip_prefix)
       VALUES (12, ?, 'feedback', '777', ?, ?, ?, 'xxx')`,
    );
    // Use audit timestamps INSIDE the auditLogMs window (1 y) so the
    // aging purge doesn't sweep them first — we want to verify the
    // cascade path explicitly, not get the right count by accident.
    auditInsert.run("feedback.resolve", '{"body":"old-with-audit"}', '{"resolved_at":1}', now - 100 * DAY);
    auditInsert.run("feedback.reply", '{"reply_body":null}', '{"reply_body":"answer"}', now - 50 * DAY);
    // Plus an UNRELATED audit row (different target) — must NOT cascade.
    db.prepare(
      `INSERT INTO audit_log
         (admin_id, action, target_type, target_id, before_json, after_json, created_at, viewer_ip_prefix)
       VALUES (12, 'user.suspend', 'account', '99', NULL, NULL, ?, 'xxx')`,
    ).run(now - 100 * DAY);

    const report = runPurge(db, now);
    expect(report.feedback).toBe(1);
    expect(report.feedbackAuditCascade).toBe(2);
    // The unrelated account-targeted row survived (would be swept by
    // auditLogMs=1y aging, not by feedback cascade).
    const surviving = db
      .prepare<[], { target_type: string; target_id: string }>(
        "SELECT target_type, target_id FROM audit_log WHERE created_at > 0",
      )
      .all();
    expect(surviving).toContainEqual({ target_type: "account", target_id: "99" });
    expect(surviving.find((r) => r.target_type === "feedback")).toBeUndefined();
  });

  it("custom feedback retention windows override the default", () => {
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, created_at) VALUES (11, 'fb-custom@test', 'x', ?)",
    ).run(now);
    db.prepare(
      `INSERT INTO feedback
         (account_id, source, category, rating, body, created_at, resolved_at)
       VALUES (11, 'sharer', 'bug', 2, 'two-days-resolved', ?, ?)`,
    ).run(now - 2 * DAY, now - 2 * DAY);

    // Default 1-year window — survives.
    expect(runPurge(db, now).feedback).toBe(0);
    // 1-day window — purged.
    expect(
      runPurge(db, now, {
        ...DEFAULT_RETENTION,
        feedbackResolvedMs: 1 * DAY,
      }).feedback,
    ).toBe(1);
  });

  it("respects custom retention windows", () => {
    db.prepare(
      "INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at) VALUES ('111-111-111', 1, 'D', 'h', ?)",
    ).run(now);
    db.prepare(
      "INSERT INTO connection_log (device_id, started_at, viewer_ip_prefix, connection_type) VALUES ('111-111-111', ?, '84.xxx', 'p2p')",
    ).run(now - 5 * DAY);
    // Default retention is 30 d — this row should survive.
    expect(runPurge(db, now).connectionLog).toBe(0);
    // With a 3-day retention it must be deleted.
    expect(
      runPurge(db, now, { ...DEFAULT_RETENTION, connectionLogMs: 3 * DAY }).connectionLog,
    ).toBe(1);
  });

  it("purges code_events older than retention, keeps fresh ones", () => {
    db.prepare("INSERT INTO code_events (created_at) VALUES (?)").run(now - 400 * DAY);
    db.prepare("INSERT INTO code_events (created_at) VALUES (?)").run(now - 100 * DAY);
    expect(runPurge(db, now).codeEvents).toBe(1);
    const remaining = (
      db.prepare("SELECT COUNT(*) AS n FROM code_events").get() as { n: number }
    ).n;
    expect(remaining).toBe(1);
  });

  it("respects custom codeEvents retention window", () => {
    db.prepare("INSERT INTO code_events (created_at) VALUES (?)").run(now - 5 * DAY);
    expect(runPurge(db, now).codeEvents).toBe(0);
    expect(
      runPurge(db, now, { ...DEFAULT_RETENTION, codeEventsMs: 3 * DAY }).codeEvents,
    ).toBe(1);
  });
});

describe("startPurgeScheduler", () => {
  it("fires runPurge on the configured interval", async () => {
    const db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, created_at) VALUES (1, 'a@a', 'x', ?)",
    ).run(1);
    db.prepare(
      "INSERT INTO sessions (token_hash, account_id, expires_at, last_seen_at) VALUES ('h-sched', 1, 1, 1)",
    ).run();

    const reports: number[] = [];
    const stop = startPurgeScheduler(db, {
      intervalMs: 20,
      log: (r) => reports.push(r.sessions),
    });

    await new Promise((r) => setTimeout(r, 55));
    stop();
    db.close();

    // Should have fired at least twice within the 55 ms window.
    expect(reports.length).toBeGreaterThanOrEqual(2);
    // First run cleans the expired session.
    expect(reports[0]).toBe(1);
    // Subsequent runs find nothing.
    expect(reports.slice(1).every((n) => n === 0)).toBe(true);
  });

  it("survives runPurge throwing — onError fires, timer keeps going", async () => {
    const db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.close(); // force a clear error path

    const errors: unknown[] = [];
    const stop = startPurgeScheduler(db, {
      intervalMs: 20,
      onError: (e) => errors.push(e),
    });

    await new Promise((r) => setTimeout(r, 55));
    stop();

    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});
