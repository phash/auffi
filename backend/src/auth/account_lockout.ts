import type { Db } from "../db.js";

/**
 * Per-account password-attempt lockout for the `/api/me` surface.
 *
 * Sec H-3 (review 2026-05-13): `PATCH /api/me` and `DELETE /api/me`
 * both gate every change on `current_password`. Without a per-account
 * counter, an attacker who steals one session cookie (or shares a NAT
 * IP with the victim) gets the global 10/hour/IP limit as their only
 * brake — 240 password guesses per day per account.
 *
 * Mirrors the per-device lockout in `unattended_sessions.ts`: 5 fails
 * in any window → 15-min lock. Bucket key shape:
 *   `account:<id>:pwfail`
 *
 * Counter resets on the first successful auth (`recordPwSuccess`).
 */

export const ACCOUNT_PW_FAIL_THRESHOLD = 5;
export const ACCOUNT_PW_LOCKOUT_MS = 15 * 60 * 1000;

function bucketKey(accountId: number): string {
  return `account:${accountId}:pwfail`;
}

export interface AccountLockoutCheck {
  locked: boolean;
  /** Seconds remaining on the lock (rounded up). 0 when not locked. */
  retryAfterSec: number;
}

/**
 * Pure read of the account's lockout state. Does NOT mutate. Returns
 * `{locked: false}` for absent / expired locks; the caller decides
 * whether to early-return 423 (or 403) without running argon2.
 */
export function checkAccountLockout(
  db: Db,
  accountId: number,
  now: number = Date.now(),
): AccountLockoutCheck {
  const row = db
    .prepare<[string], { locked_until: number | null }>(
      "SELECT locked_until FROM rate_limit_buckets WHERE key = ?",
    )
    .get(bucketKey(accountId));
  if (!row || row.locked_until === null) return { locked: false, retryAfterSec: 0 };
  if (row.locked_until <= now) return { locked: false, retryAfterSec: 0 };
  return {
    locked: true,
    retryAfterSec: Math.ceil((row.locked_until - now) / 1000),
  };
}

export interface AccountFailOutcome {
  failCount: number;
  attemptsLeft: number;
  locked: boolean;
  retryAfterSec: number;
}

/**
 * Record a failed `current_password` attempt for `accountId`. When the
 * threshold is hit, sets `locked_until = now + ACCOUNT_PW_LOCKOUT_MS`
 * and the next [`checkAccountLockout`] returns locked.
 */
export function recordAccountPwFail(
  db: Db,
  accountId: number,
  now: number = Date.now(),
): AccountFailOutcome {
  const key = bucketKey(accountId);
  // Increment AND latch the lock in one atomic statement so a burst of
  // concurrent wrong-password requests can't read a sub-threshold count
  // between a separate increment and a separate lock-write. `fail_count`
  // inside DO UPDATE refers to the pre-increment value, so `+ 1` is the new
  // count; RETURNING hands back the post-update row.
  const row = db
    .prepare<[string, number, number], { fail_count: number; locked_until: number | null }>(
      `INSERT INTO rate_limit_buckets (key, fail_count, locked_until)
       VALUES (?, 1, NULL)
       ON CONFLICT(key) DO UPDATE SET
         fail_count = fail_count + 1,
         locked_until = CASE WHEN fail_count + 1 >= ? THEN ? ELSE locked_until END
       RETURNING fail_count, locked_until`,
    )
    .get(key, ACCOUNT_PW_FAIL_THRESHOLD, now + ACCOUNT_PW_LOCKOUT_MS)!;

  if (row.fail_count >= ACCOUNT_PW_FAIL_THRESHOLD) {
    return {
      failCount: row.fail_count,
      attemptsLeft: 0,
      locked: true,
      retryAfterSec: Math.ceil(ACCOUNT_PW_LOCKOUT_MS / 1000),
    };
  }

  return {
    failCount: row.fail_count,
    attemptsLeft: ACCOUNT_PW_FAIL_THRESHOLD - row.fail_count,
    locked: false,
    retryAfterSec: 0,
  };
}

/**
 * Successful current_password verify — reset the fail counter so a
 * legitimate user typing a typo earlier in the session isn't punished
 * for it later. Idempotent on absent rows.
 */
export function recordAccountPwSuccess(db: Db, accountId: number): void {
  db.prepare(
    "UPDATE rate_limit_buckets SET fail_count = 0, locked_until = NULL WHERE key = ?",
  ).run(bucketKey(accountId));
}
