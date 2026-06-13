import { describe, it, expect, beforeEach } from "vitest";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import {
  checkAccountLockout,
  recordAccountPwFail,
  recordAccountPwSuccess,
  ACCOUNT_PW_FAIL_THRESHOLD,
  ACCOUNT_PW_LOCKOUT_MS,
} from "../src/auth/account_lockout.js";

const KEY = "account:42:pwfail";

describe("recordAccountPwFail", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
  });

  it("creates the bucket row on first failure", () => {
    expect(recordAccountPwFail(db, 42, 1_000)).toEqual({
      failCount: 1,
      attemptsLeft: ACCOUNT_PW_FAIL_THRESHOLD - 1,
      locked: false,
      retryAfterSec: 0,
    });
  });

  it("counts up and reports attemptsLeft below the threshold", () => {
    recordAccountPwFail(db, 42);
    recordAccountPwFail(db, 42);
    const out = recordAccountPwFail(db, 42);
    expect(out.failCount).toBe(3);
    expect(out.attemptsLeft).toBe(ACCOUNT_PW_FAIL_THRESHOLD - 3);
    expect(out.locked).toBe(false);
  });

  it("latches the lock atomically at the threshold and sets locked_until = now + LOCKOUT", () => {
    const now = 5_000_000;
    for (let i = 0; i < ACCOUNT_PW_FAIL_THRESHOLD - 1; i++) recordAccountPwFail(db, 42, now);
    const out = recordAccountPwFail(db, 42, now);
    expect(out.locked).toBe(true);
    expect(out.failCount).toBe(ACCOUNT_PW_FAIL_THRESHOLD);
    expect(out.retryAfterSec).toBe(Math.ceil(ACCOUNT_PW_LOCKOUT_MS / 1000));

    const row = db
      .prepare<[string], { fail_count: number; locked_until: number | null }>(
        "SELECT fail_count, locked_until FROM rate_limit_buckets WHERE key = ?",
      )
      .get(KEY);
    // The lock-write happens in the SAME statement as the increment — never a
    // window where fail_count == THRESHOLD but locked_until is still NULL.
    expect(row?.fail_count).toBe(ACCOUNT_PW_FAIL_THRESHOLD);
    expect(row?.locked_until).toBe(now + ACCOUNT_PW_LOCKOUT_MS);
  });

  it("checkAccountLockout reflects the latched lock and expiry", () => {
    const now = 1_000_000;
    for (let i = 0; i < ACCOUNT_PW_FAIL_THRESHOLD; i++) recordAccountPwFail(db, 42, now);
    expect(checkAccountLockout(db, 42, now)).toEqual({
      locked: true,
      retryAfterSec: Math.ceil(ACCOUNT_PW_LOCKOUT_MS / 1000),
    });
    // After the window the lock lapses without a write.
    expect(checkAccountLockout(db, 42, now + ACCOUNT_PW_LOCKOUT_MS + 1)).toEqual({
      locked: false,
      retryAfterSec: 0,
    });
  });
});

describe("recordAccountPwSuccess", () => {
  it("zeroes the counter and clears the lock — idempotent on missing rows", () => {
    const db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    for (let i = 0; i < ACCOUNT_PW_FAIL_THRESHOLD; i++) recordAccountPwFail(db, 42, 1_000);
    expect(checkAccountLockout(db, 42, 1_000).locked).toBe(true);

    recordAccountPwSuccess(db, 42);
    const row = db
      .prepare<[string], { fail_count: number; locked_until: number | null }>(
        "SELECT fail_count, locked_until FROM rate_limit_buckets WHERE key = ?",
      )
      .get(KEY);
    expect(row?.fail_count).toBe(0);
    expect(row?.locked_until).toBeNull();
    expect(checkAccountLockout(db, 42, 1_000).locked).toBe(false);

    expect(() => recordAccountPwSuccess(db, 999)).not.toThrow();
  });
});
