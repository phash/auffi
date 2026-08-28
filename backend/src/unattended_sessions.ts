import type { WebSocket } from "ws";
import type { Db } from "./db.js";

/**
 * Per-device lockout: 5 wrong password attempts inside the window →
 * the bucket locks for `lockoutMs`. Counter resets on the first
 * successful pw-ok. Spec section 6.
 */
export const PW_FAIL_THRESHOLD = 5;
export const PW_LOCKOUT_MS = 15 * 60 * 1000;

function bucketKey(deviceId: string): string {
  return `device:${deviceId}:pwfail`;
}

export interface LockoutCheck {
  /** True iff the bucket is currently locked. */
  locked: boolean;
  /** Seconds remaining on the lock (rounded up). 0 when not locked. */
  retryAfterSec: number;
}

/**
 * Inspect the rate_limit_buckets row for this device. Pure read —
 * doesn't mutate. Returns `{locked: false}` for an absent or expired
 * lock; the caller decides whether to send needs-password or locked.
 */
export function checkLockout(db: Db, deviceId: string, now: number = Date.now()): LockoutCheck {
  const row = db
    .prepare<[string], { locked_until: number | null }>(
      "SELECT locked_until FROM rate_limit_buckets WHERE key = ?",
    )
    .get(bucketKey(deviceId));
  if (!row || row.locked_until === null) return { locked: false, retryAfterSec: 0 };
  if (row.locked_until <= now) return { locked: false, retryAfterSec: 0 };
  return {
    locked: true,
    retryAfterSec: Math.ceil((row.locked_until - now) / 1000),
  };
}

/**
 * Record a failed password attempt for `deviceId`. Increments
 * `fail_count`; when the threshold is hit, sets `locked_until` and
 * the next [`checkLockout`] returns locked. Returns the new state so
 * the caller can decide between `wrong-password` (with attemptsLeft)
 * and `locked` (with retryAfterSec).
 *
 * Uses INSERT-OR-UPDATE so the first failure for a fresh device
 * creates the row.
 */
export interface FailOutcome {
  failCount: number;
  attemptsLeft: number;
  locked: boolean;
  retryAfterSec: number;
}

export function recordPwFail(
  db: Db,
  deviceId: string,
  now: number = Date.now(),
): FailOutcome {
  const key = bucketKey(deviceId);
  // Increment AND latch the lock in one atomic statement (see the matching
  // comment in auth/account_lockout.ts). `fail_count` / `locked_until` inside
  // DO UPDATE refer to the pre-update row, so `+ 1` is the new count. An
  // EXPIRED lock decays here: the first failure after it lapsed starts a
  // fresh streak (fail_count = 1, lock cleared) — otherwise a single wrong
  // attempt would re-latch a full lockout forever, despite the `locked`
  // frame having promised the user a retry after `retryAfterSec`.
  const row = db
    .prepare<[string, number, number, number, number], { fail_count: number; locked_until: number | null }>(
      `INSERT INTO rate_limit_buckets (key, fail_count, locked_until)
       VALUES (?, 1, NULL)
       ON CONFLICT(key) DO UPDATE SET
         fail_count = CASE
           WHEN locked_until IS NOT NULL AND locked_until <= ? THEN 1
           ELSE fail_count + 1
         END,
         locked_until = CASE
           WHEN locked_until IS NOT NULL AND locked_until <= ? THEN NULL
           WHEN fail_count + 1 >= ? THEN ?
           ELSE locked_until
         END
       RETURNING fail_count, locked_until`,
    )
    .get(key, now, now, PW_FAIL_THRESHOLD, now + PW_LOCKOUT_MS)!;

  if (row.fail_count >= PW_FAIL_THRESHOLD) {
    return {
      failCount: row.fail_count,
      attemptsLeft: 0,
      locked: true,
      retryAfterSec: Math.ceil(PW_LOCKOUT_MS / 1000),
    };
  }

  return {
    failCount: row.fail_count,
    attemptsLeft: PW_FAIL_THRESHOLD - row.fail_count,
    locked: false,
    retryAfterSec: 0,
  };
}

/**
 * Successful pw-ok — reset the fail counter so the next viewer
 * starts at zero. Idempotent: missing row is a no-op.
 */
export function resetPwFail(db: Db, deviceId: string): void {
  db.prepare(
    "UPDATE rate_limit_buckets SET fail_count = 0, locked_until = NULL WHERE key = ?",
  ).run(bucketKey(deviceId));
}

/**
 * In-memory map of viewer ↔ unattended-sharer pairings, keyed by
 * device-id. Used by signaling.ts to route pw-attempt → pw-check
 * forwards and the subsequent SDP/ICE relay after pw-ok.
 *
 * One viewer per device at a time. A second viewer joining the same
 * code while a session is in flight gets rejected with "session
 * full" (same surface as ad-hoc). A new viewer after the previous
 * one disconnected is welcome.
 */
export interface UnattendedSession {
  deviceId: string;
  viewer: WebSocket;
  sharer: WebSocket;
  /**
   * Where we are in the dance:
   *   - "awaiting-pw"  — sent needs-password, no attempt yet
   *   - "pw-in-flight" — forwarded pw-attempt as pw-check, awaiting
   *                       sharer's pw-check-result
   *   - "confirmed"    — pw-check-result: ok received, peers paired,
   *                       SDP/ICE flows normally now
   */
  state: "awaiting-pw" | "pw-in-flight" | "confirmed";
  /**
   * The viewer's IP prefix at JOIN time (e.g. "84.xxx"). Stored on
   * the session because the mirrored `peer-joined` to the sharer is
   * sent from the SHARER's connection handler, where the viewer's
   * request object is no longer accessible.
   */
  viewerIpPrefix: string;
  /**
   * connection_log row id once the sharer reported `connection-started`, so
   * `connection-ended` finalises the same row. Null until then, and for
   * sessions that end before ICE settles.
   */
  logId: number | null;
  /**
   * When the session entered "awaiting-pw" (epoch ms). Bounds the
   * pre-confirmed lifetime — see [`PW_ENTRY_TIMEOUT_MS`].
   */
  createdAt: number;
}

/**
 * Server-side bound on how long a viewer may sit in awaiting-pw /
 * pw-in-flight before the slot is freed. Joining an unattended device
 * costs zero credentials (device code → needs-password), and while the
 * session exists every other viewer — the owner included — only sees
 * "session full". Without a deadline a wedged or hostile client could
 * occupy the device silently for as long as it keeps its WS open; the
 * ad-hoc flow is bounded by the 10-minute code TTL, this is the
 * unattended equivalent. 2 minutes is generous for typing a password
 * (the 5-fail lockout bounds retries anyway) yet frees the slot fast.
 * Sessions are in-memory only — this deadline is the retention policy
 * for not-yet-confirmed pairing state; confirmed sessions live until a
 * peer disconnects.
 */
export const PW_ENTRY_TIMEOUT_MS = 2 * 60 * 1000;

export class UnattendedSessions {
  private readonly byDevice = new Map<string, UnattendedSession>();
  private readonly viewerToDevice = new Map<WebSocket, string>();
  private onStaleReap: ((sess: UnattendedSession) => void) | null = null;

  /**
   * Callback invoked for every session [`sweepStale`] reaps, AFTER it
   * has been removed from the store. Registered by the signaling
   * module (mirrors `SessionStore.setOnExpiredDrop`) so the sharer
   * learns its pending pw wait is dead and the abandoned viewer socket
   * gets closed — the store itself stays transport-agnostic.
   */
  setOnStaleReap(cb: (sess: UnattendedSession) => void): void {
    this.onStaleReap = cb;
  }

  /**
   * Begin tracking a viewer's pending unattended connect attempt
   * against `deviceId`. Returns:
   *   - `"ok"`        — new session created
   *   - `"busy"`      — another session for this device is already in
   *                     flight; caller should send invalid-code /
   *                     "session full" (same wire shape as ad-hoc)
   *
   * The sharer side of the pairing is identified by the WS the device
   * authenticated on (gh #16). Caller looks it up via
   * `UnattendedRegistry`.
   */
  begin(
    deviceId: string,
    viewer: WebSocket,
    sharer: WebSocket,
    viewerIpPrefix: string,
    now: number = Date.now(),
  ): "ok" | "busy" {
    if (this.byDevice.has(deviceId)) return "busy";
    this.byDevice.set(deviceId, {
      deviceId,
      viewer,
      sharer,
      state: "awaiting-pw",
      logId: null,
      viewerIpPrefix,
      createdAt: now,
    });
    this.viewerToDevice.set(viewer, deviceId);
    return "ok";
  }

  /**
   * Reap sessions stuck before "confirmed" for longer than
   * [`PW_ENTRY_TIMEOUT_MS`] and return them so the caller (the 60 s
   * sweep in server.ts) can close the abandoned viewer sockets.
   * Confirmed sessions are exempt — they live until a peer
   * disconnects. A pw-check-result landing after the reap is silently
   * dropped by `findBySharer` returning null (TC C-2 contract).
   */
  sweepStale(now: number = Date.now()): UnattendedSession[] {
    const stale: UnattendedSession[] = [];
    for (const sess of this.byDevice.values()) {
      if (sess.state !== "confirmed" && now - sess.createdAt >= PW_ENTRY_TIMEOUT_MS) {
        stale.push(sess);
      }
    }
    for (const sess of stale) {
      this.remove(sess.deviceId);
      this.onStaleReap?.(sess);
    }
    return stale;
  }

  /** Lookup by either end of the pairing. */
  findByViewer(viewer: WebSocket): UnattendedSession | null {
    const did = this.viewerToDevice.get(viewer);
    if (!did) return null;
    return this.byDevice.get(did) ?? null;
  }

  findBySharer(sharer: WebSocket): UnattendedSession | null {
    for (const sess of this.byDevice.values()) {
      if (sess.sharer === sharer) return sess;
    }
    return null;
  }

  findByDeviceId(deviceId: string): UnattendedSession | null {
    return this.byDevice.get(deviceId) ?? null;
  }

  transition(deviceId: string, to: UnattendedSession["state"]): void {
    const sess = this.byDevice.get(deviceId);
    if (sess) sess.state = to;
  }

  /**
   * Remove the session and any side-indexes. Idempotent.
   */
  remove(deviceId: string): void {
    const sess = this.byDevice.get(deviceId);
    if (!sess) return;
    this.byDevice.delete(deviceId);
    this.viewerToDevice.delete(sess.viewer);
  }

  /**
   * Called from the viewer's WS close handler. Tears down the session
   * (the sharer's WSS stays open for the next viewer).
   */
  detachViewer(viewer: WebSocket): UnattendedSession | null {
    const did = this.viewerToDevice.get(viewer);
    if (!did) return null;
    const sess = this.byDevice.get(did) ?? null;
    this.remove(did);
    return sess;
  }

  /**
   * Called from the sharer's WS close handler. Tears down the
   * session AND signals the viewer that the sharer is gone.
   */
  detachSharer(sharer: WebSocket): UnattendedSession | null {
    const sess = this.findBySharer(sharer);
    if (sess) this.remove(sess.deviceId);
    return sess;
  }

  size(): number {
    return this.byDevice.size;
  }
}
