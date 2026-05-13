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
      "INSERT INTO sessions (id, account_id, token_hash, expires_at, last_seen_at) VALUES ('s1', 1, 'h1', ?, ?)",
    ).run(now - 1, now); // expired
    db.prepare(
      "INSERT INTO sessions (id, account_id, token_hash, expires_at, last_seen_at) VALUES ('s2', 1, 'h2', ?, ?)",
    ).run(now + HOUR, now); // alive

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
      "INSERT INTO sessions (id, account_id, token_hash, expires_at, last_seen_at) VALUES ('s1', 1, 'h1', ?, ?)",
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
      softDeletedAccounts: 0,
      rateLimitBuckets: 0,
    });
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
});

describe("startPurgeScheduler", () => {
  it("fires runPurge on the configured interval", async () => {
    const db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, created_at) VALUES (1, 'a@a', 'x', ?)",
    ).run(1);
    db.prepare(
      "INSERT INTO sessions (id, account_id, token_hash, expires_at, last_seen_at) VALUES ('s1', 1, 'h1', 1, 1)",
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
