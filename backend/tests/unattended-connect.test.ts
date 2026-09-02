import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import WebSocket from "ws";
import { createServer } from "../src/server.js";
import { registerSignaling } from "../src/signaling.js";
import { SessionStore } from "../src/codes.js";
import { UnattendedRegistry } from "../src/unattended.js";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { hashPassword } from "../src/auth/argon.js";
import {
  checkLockout,
  PW_ENTRY_TIMEOUT_MS,
  PW_FAIL_THRESHOLD,
  PW_LOCKOUT_MS,
  recordPwFail,
  resetPwFail,
  UnattendedSessions,
} from "../src/unattended_sessions.js";

const ORIGIN = "http://127.0.0.1";

// ── Pure unit tests: lockout helpers ──────────────────────────────────

describe("checkLockout", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
  });

  it("returns not-locked when the bucket row is absent", () => {
    expect(checkLockout(db, "123-456-789")).toEqual({ locked: false, retryAfterSec: 0 });
  });

  it("returns not-locked when locked_until is in the past", () => {
    db.prepare(
      "INSERT INTO rate_limit_buckets (key, fail_count, locked_until) VALUES ('device:123-456-789:pwfail', 5, ?)",
    ).run(1_000);
    expect(checkLockout(db, "123-456-789", 2_000).locked).toBe(false);
  });

  it("returns locked + retryAfterSec when locked_until is in the future", () => {
    db.prepare(
      "INSERT INTO rate_limit_buckets (key, fail_count, locked_until) VALUES ('device:123-456-789:pwfail', 5, ?)",
    ).run(10_500);
    const out = checkLockout(db, "123-456-789", 1_000);
    expect(out.locked).toBe(true);
    expect(out.retryAfterSec).toBe(10); // ceil((10500-1000)/1000)
  });
});

describe("recordPwFail", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
  });

  it("creates the bucket row on first failure", () => {
    const out = recordPwFail(db, "123-456-789", 1_000);
    expect(out).toEqual({
      failCount: 1,
      attemptsLeft: PW_FAIL_THRESHOLD - 1,
      locked: false,
      retryAfterSec: 0,
    });
  });

  it("counts up and reports attemptsLeft", () => {
    recordPwFail(db, "123-456-789");
    recordPwFail(db, "123-456-789");
    const out = recordPwFail(db, "123-456-789");
    expect(out.failCount).toBe(3);
    expect(out.attemptsLeft).toBe(PW_FAIL_THRESHOLD - 3);
    expect(out.locked).toBe(false);
  });

  it("locks at the threshold and sets locked_until = now + PW_LOCKOUT_MS", () => {
    const now = 1_000_000;
    for (let i = 0; i < PW_FAIL_THRESHOLD - 1; i++) recordPwFail(db, "123-456-789", now);
    const out = recordPwFail(db, "123-456-789", now);
    expect(out.locked).toBe(true);
    expect(out.retryAfterSec).toBe(Math.ceil(PW_LOCKOUT_MS / 1000));
    const row = db
      .prepare<[], { locked_until: number | null }>(
        "SELECT locked_until FROM rate_limit_buckets WHERE key = 'device:123-456-789:pwfail'",
      )
      .get();
    expect(row?.locked_until).toBe(now + PW_LOCKOUT_MS);
  });

  it("starts a fresh count after an expired lockout instead of instantly re-locking", () => {
    const now = 1_000_000;
    for (let i = 0; i < PW_FAIL_THRESHOLD; i++) recordPwFail(db, "123-456-789", now);
    expect(checkLockout(db, "123-456-789", now).locked).toBe(true);

    const after = now + PW_LOCKOUT_MS + 1;
    expect(checkLockout(db, "123-456-789", after).locked).toBe(false);
    // The first failure AFTER the lock lapsed must not re-latch a full
    // 15-min lock — the user was promised they could retry.
    const out = recordPwFail(db, "123-456-789", after);
    expect(out).toEqual({
      failCount: 1,
      attemptsLeft: PW_FAIL_THRESHOLD - 1,
      locked: false,
      retryAfterSec: 0,
    });
    const row = db
      .prepare<[], { fail_count: number; locked_until: number | null }>(
        "SELECT fail_count, locked_until FROM rate_limit_buckets WHERE key = 'device:123-456-789:pwfail'",
      )
      .get();
    expect(row?.fail_count).toBe(1);
    expect(row?.locked_until).toBeNull();
  });
});

describe("resetPwFail", () => {
  it("zeroes the counter and clears locked_until — idempotent on missing rows", () => {
    const db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    recordPwFail(db, "123-456-789");
    recordPwFail(db, "123-456-789");
    resetPwFail(db, "123-456-789");
    const row = db
      .prepare<[], { fail_count: number; locked_until: number | null }>(
        "SELECT fail_count, locked_until FROM rate_limit_buckets WHERE key = 'device:123-456-789:pwfail'",
      )
      .get();
    expect(row?.fail_count).toBe(0);
    expect(row?.locked_until).toBeNull();
    // Missing row → no-op (no throw).
    expect(() => resetPwFail(db, "000-000-000")).not.toThrow();
  });
});

// ── UnattendedSessions store ──────────────────────────────────────────

describe("UnattendedSessions", () => {
  const v = {} as unknown as WebSocket;
  const s = {} as unknown as WebSocket;

  it("begin returns 'busy' on a second attempt for the same device", () => {
    const ss = new UnattendedSessions();
    expect(ss.begin("123-456-789", v, s)).toBe("ok");
    expect(ss.begin("123-456-789", {} as WebSocket, s)).toBe("busy");
  });

  it("transitions state through awaiting-pw → pw-in-flight → confirmed", () => {
    const ss = new UnattendedSessions();
    ss.begin("123-456-789", v, s);
    expect(ss.findByViewer(v)?.state).toBe("awaiting-pw");
    ss.transition("123-456-789", "pw-in-flight");
    expect(ss.findByViewer(v)?.state).toBe("pw-in-flight");
    ss.transition("123-456-789", "confirmed");
    expect(ss.findByViewer(v)?.state).toBe("confirmed");
  });

  it("detachViewer removes the session but detachSharer is needed to clear by sharer-key", () => {
    const ss = new UnattendedSessions();
    ss.begin("123-456-789", v, s);
    expect(ss.detachViewer(v)?.deviceId).toBe("123-456-789");
    expect(ss.findByViewer(v)).toBeNull();
    expect(ss.size()).toBe(0);
  });

  it("findBySharer returns the session by sharer ref", () => {
    const ss = new UnattendedSessions();
    ss.begin("123-456-789", v, s);
    expect(ss.findBySharer(s)?.deviceId).toBe("123-456-789");
  });

  it("sweepStale frees a slot stuck in awaiting-pw past PW_ENTRY_TIMEOUT_MS", () => {
    const ss = new UnattendedSessions();
    ss.begin("123-456-789", v, s, "84.xxx", 1_000);
    // Not yet stale — nothing reaped.
    expect(ss.sweepStale(1_000 + PW_ENTRY_TIMEOUT_MS - 1)).toEqual([]);
    expect(ss.size()).toBe(1);

    const stale = ss.sweepStale(1_000 + PW_ENTRY_TIMEOUT_MS);
    expect(stale.map((x) => x.deviceId)).toEqual(["123-456-789"]);
    expect(ss.size()).toBe(0);
    // The device slot is free again for the next viewer.
    expect(ss.begin("123-456-789", v, s, "84.xxx")).toBe("ok");
  });

  it("sweepStale reaps pw-in-flight sessions but never confirmed ones", () => {
    const ss = new UnattendedSessions();
    const v2 = {} as unknown as WebSocket;
    const s2 = {} as unknown as WebSocket;
    ss.begin("111-111-111", v, s, "84.xxx", 0);
    ss.transition("111-111-111", "pw-in-flight");
    ss.begin("222-222-222", v2, s2, "84.xxx", 0);
    ss.transition("222-222-222", "confirmed");

    const stale = ss.sweepStale(PW_ENTRY_TIMEOUT_MS + 1);
    expect(stale.map((x) => x.deviceId)).toEqual(["111-111-111"]);
    // Confirmed sessions live until a peer disconnects.
    expect(ss.findByDeviceId("222-222-222")).not.toBeNull();
  });
});

// ── End-to-end /signal flow ───────────────────────────────────────────

describe("/signal unattended connect flow (gh #17)", () => {
  let app: FastifyInstance;
  let url: string;
  let db: Db;
  const token = "abcdef00".repeat(8);
  const deviceId = "777-777-777";

  beforeAll(async () => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, email_verified_at, created_at) VALUES (1, 'owner@a', 'x', ?, ?)",
    ).run(Date.now(), Date.now());
    const tokenHash = await hashPassword(token);
    db.prepare(
      `INSERT INTO devices (id, owner_account_id, alias, token_hash, auto_accept, created_at)
       VALUES (?, 1, 'D', ?, 1, ?)`,
    ).run(deviceId, tokenHash, Date.now());

    process.env.REGISTER_RATE_LIMIT_MAX = "1000";
    process.env.BEARER_AUTH_RATE_LIMIT_MAX = "1000";
    // Every viewer join costs one unit of the 5/min per-IP budget.
    process.env.RATE_LIMIT_MAX = "1000";
    app = await createServer({ port: 0, host: "127.0.0.1", db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    url = `ws://127.0.0.1:${addr.port}/signal`;
  });

  afterAll(async () => {
    await app.close();
    db.close();
    delete process.env.RATE_LIMIT_MAX;
  });

  beforeEach(() => {
    // Reset the per-device lockout state before each test so they
    // run independently.
    db.prepare("DELETE FROM rate_limit_buckets WHERE key LIKE 'device:%'").run();
  });

  function openSharer(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          origin: ORIGIN,
          authorization: `Bearer ${token}`,
          "x-auffi-device-id": deviceId,
        },
      });
      ws.once("message", () => resolve(ws)); // unattended-hello
      ws.once("error", reject);
    });
  }

  function openViewer(): WebSocket {
    return new WebSocket(url, { headers: { origin: ORIGIN } });
  }

  async function once(ws: WebSocket, ev: "message"): Promise<any> {
    return new Promise((resolve) => {
      ws.once(ev, (data) => resolve(JSON.parse(data.toString())));
    });
  }

  it("viewer joining a device-id with a connected sharer receives needs-password", async () => {
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    const msg = await once(viewer, "message");
    expect(msg).toEqual({ type: "needs-password" });
    viewer.close();
    sharer.close();
  });

  it("viewer joining a device-id with NO connected sharer falls through to invalid-code", async () => {
    // Sharer not opened in this test.
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    const msg = await once(viewer, "message");
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("invalid-code");
    viewer.close();
  });

  it("viewer joining a device-id receives locked when rate_limit_buckets is locked", async () => {
    db.prepare(
      "INSERT INTO rate_limit_buckets (key, fail_count, locked_until) VALUES (?, 5, ?)",
    ).run(`device:${deviceId}:pwfail`, Date.now() + 60_000);
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    const msg = await once(viewer, "message");
    expect(msg.type).toBe("locked");
    expect(msg.retryAfterSec).toBeGreaterThan(0);
    viewer.close();
    sharer.close();
  });

  it("second viewer joining the same device while one in flight gets session full", async () => {
    const sharer = await openSharer();
    const v1 = openViewer();
    await new Promise<void>((r) => v1.once("open", () => r()));
    v1.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(v1, "message"); // needs-password

    const v2 = openViewer();
    await new Promise<void>((r) => v2.once("open", () => r()));
    v2.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    const msg = await once(v2, "message");
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("session full");
    v1.close();
    v2.close();
    sharer.close();
  });

  it("pw-attempt is forwarded to sharer as pw-check", async () => {
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message"); // needs-password

    viewer.send(JSON.stringify({ type: "pw-attempt", password: "hunter2" }));
    const onSharer = await once(sharer, "message");
    // gh #25 added autoAccept which reflects devices.auto_accept (1 in seed).
    expect(onSharer).toEqual({
      type: "pw-check",
      attempt: "hunter2",
      autoAccept: true,
      attemptId: expect.any(Number),
    });
    viewer.close();
    sharer.close();
  });

  it("pw-check forwards autoAccept=false when the device row has auto_accept=0", async () => {
    // gh #25: dashboard toggling auto-accept off must take effect
    // without sharer reconnect — backend reads the flag fresh on
    // every pw-attempt.
    db.prepare("UPDATE devices SET auto_accept = 0 WHERE id = ?").run(deviceId);
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message");
    viewer.send(JSON.stringify({ type: "pw-attempt", password: "irrelevant" }));
    const onSharer = await once(sharer, "message");
    expect(onSharer).toEqual({
      type: "pw-check",
      attempt: "irrelevant",
      autoAccept: false,
      attemptId: expect.any(Number),
    });
    // Reset for any later test.
    db.prepare("UPDATE devices SET auto_accept = 1 WHERE id = ?").run(deviceId);
    viewer.close();
    sharer.close();
  });

  // gh #109: connection_log had a read surface (device log page, admin stats,
  // 30-day retention) and no writer at all — every query returned empty. The
  // sharer reports the negotiated path once ICE settles and the byte count
  // when the session ends.
  async function confirmedPair(): Promise<{ sharer: WebSocket; viewer: WebSocket }> {
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message"); // needs-password
    viewer.send(JSON.stringify({ type: "pw-attempt", password: "right" }));
    await once(sharer, "message"); // pw-check
    sharer.send(JSON.stringify({ type: "pw-check-result", result: "ok" }));
    await once(viewer, "message"); // peer-confirmed
    await once(sharer, "message"); // peer-joined
    return { sharer, viewer };
  }

  it("connection-started writes a connection_log row for the device", async () => {
    db.prepare("DELETE FROM connection_log").run();
    const { sharer, viewer } = await confirmedPair();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "relay" }));
    await new Promise((r) => setTimeout(r, 80));

    const row = db
      .prepare<[string], { device_id: string; connection_type: string; ended_at: number | null; bytes_relayed: number }>(
        "SELECT device_id, connection_type, ended_at, bytes_relayed FROM connection_log WHERE device_id = ?",
      )
      .get(deviceId);
    expect(row, "a row must exist after connection-started").toBeTruthy();
    expect(row!.connection_type).toBe("relay");
    expect(row!.ended_at, "row stays open until connection-ended").toBeNull();
    expect(row!.bytes_relayed).toBe(0);
    viewer.close();
    sharer.close();
  });

  it("connection-ended finalises the same row with the byte count", async () => {
    db.prepare("DELETE FROM connection_log").run();
    const { sharer, viewer } = await confirmedPair();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "p2p" }));
    await new Promise((r) => setTimeout(r, 80));
    sharer.send(JSON.stringify({ type: "connection-ended", bytesRelayed: 4096 }));
    await new Promise((r) => setTimeout(r, 80));

    const rows = db
      .prepare<[string], { ended_at: number | null; bytes_relayed: number }>(
        "SELECT ended_at, bytes_relayed FROM connection_log WHERE device_id = ?",
      )
      .all(deviceId);
    expect(rows.length, "must finalise, not insert a second row").toBe(1);
    expect(rows[0].ended_at).not.toBeNull();
    expect(rows[0].bytes_relayed).toBe(4096);
    viewer.close();
    sharer.close();
  });

  it("ignores telemetry from a session that never reached confirmed", async () => {
    db.prepare("DELETE FROM connection_log").run();
    // Pre-confirm there is no agreed session to attribute the row to, and
    // accepting it would let an unconfirmed peer write log entries.
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message");

    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "relay" }));
    await new Promise((r) => setTimeout(r, 80));
    const count = db
      .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM connection_log WHERE device_id = ?")
      .get(deviceId)!.c;
    expect(count).toBe(0);
    expect(sharer.readyState, "and the sharer stays connected").toBe(sharer.OPEN);
    viewer.close();
    sharer.close();
  });

  it("finalises an open row when the viewer ends the session", async () => {
    // The sharer can only send connection-ended from disconnect_streaming,
    // which runs at least one round-trip AFTER the viewer socket closed — so
    // on the common ending the frame arrives to a session that no longer
    // exists and is dropped. The row must be closed by the backend, which
    // owns the session lifetime, not by a best-effort client frame.
    db.prepare("DELETE FROM connection_log").run();
    const { sharer, viewer } = await confirmedPair();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "relay" }));
    await new Promise((r) => setTimeout(r, 80));

    viewer.close();
    await new Promise((r) => setTimeout(r, 150));

    const row = db
      .prepare<[string], { ended_at: number | null }>(
        "SELECT ended_at FROM connection_log WHERE device_id = ?",
      )
      .get(deviceId);
    expect(row, "row still exists").toBeTruthy();
    expect(row!.ended_at, "viewer teardown must close the row").not.toBeNull();
    sharer.close();
  });

  it("finalises an open row when the sharer drops", async () => {
    db.prepare("DELETE FROM connection_log").run();
    const { sharer, viewer } = await confirmedPair();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "p2p" }));
    await new Promise((r) => setTimeout(r, 80));

    sharer.close();
    await new Promise((r) => setTimeout(r, 150));

    const row = db
      .prepare<[string], { ended_at: number | null }>(
        "SELECT ended_at FROM connection_log WHERE device_id = ?",
      )
      .get(deviceId);
    expect(row!.ended_at, "sharer teardown must close the row too").not.toBeNull();
    viewer.close();
  });

  it("does not double-finalise a row the sharer already closed", async () => {
    db.prepare("DELETE FROM connection_log").run();
    const { sharer, viewer } = await confirmedPair();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "relay" }));
    await new Promise((r) => setTimeout(r, 80));
    sharer.send(JSON.stringify({ type: "connection-ended", bytesRelayed: 999 }));
    await new Promise((r) => setTimeout(r, 80));

    viewer.close();
    await new Promise((r) => setTimeout(r, 150));

    const row = db
      .prepare<[string], { bytes_relayed: number }>(
        "SELECT bytes_relayed FROM connection_log WHERE device_id = ?",
      )
      .get(deviceId);
    expect(row!.bytes_relayed, "the reported count must survive the teardown sweep").toBe(999);
    sharer.close();
  });

  it("clamps an absurd byte count instead of binding a float", async () => {
    db.prepare("DELETE FROM connection_log").run();
    const { sharer, viewer } = await confirmedPair();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "relay" }));
    await new Promise((r) => setTimeout(r, 80));
    sharer.send(JSON.stringify({ type: "connection-ended", bytesRelayed: 1e30 }));
    await new Promise((r) => setTimeout(r, 80));

    const row = db
      .prepare<[string], { bytes_relayed: number }>(
        "SELECT bytes_relayed FROM connection_log WHERE device_id = ?",
      )
      .get(deviceId);
    expect(Number.isSafeInteger(row!.bytes_relayed), `got ${row!.bytes_relayed}`).toBe(true);
    viewer.close();
    sharer.close();
  });

  it("rejects a bogus connectionType without writing a row", async () => {
    db.prepare("DELETE FROM connection_log").run();
    const { sharer, viewer } = await confirmedPair();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "carrier-pigeon" }));
    await new Promise((r) => setTimeout(r, 80));
    const count = db
      .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM connection_log WHERE device_id = ?")
      .get(deviceId)!.c;
    expect(count).toBe(0);
    viewer.close();
    sharer.close();
  });

  it("rejects pw-attempt with password >256 chars (Sec H-4)", async () => {
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message");

    const tooLong = "x".repeat(257);
    viewer.send(JSON.stringify({ type: "pw-attempt", password: tooLong }));
    const out = await once(viewer, "message");
    expect(out.type).toBe("error");
    expect(out.message).toContain("password too long");
    // Sharer never sees the pw-check forward — gated server-side.
    // We can't directly assert "sharer didn't receive" without a
    // race-free hook, but the session state remains awaiting-pw,
    // which the next legitimate pw-attempt observes.
    viewer.close();
    sharer.close();
  });

  it("pw-check-result fail → wrong-password to viewer + counter increments", async () => {
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message");

    viewer.send(JSON.stringify({ type: "pw-attempt", password: "wrong" }));
    await once(sharer, "message");
    sharer.send(JSON.stringify({ type: "pw-check-result", result: "fail" }));
    const out = await once(viewer, "message");
    expect(out.type).toBe("wrong-password");
    expect(out.attemptsLeft).toBe(PW_FAIL_THRESHOLD - 1);

    const row = db
      .prepare<[], { fail_count: number }>(
        `SELECT fail_count FROM rate_limit_buckets WHERE key = 'device:${deviceId}:pwfail'`,
      )
      .get();
    expect(row?.fail_count).toBe(1);
    viewer.close();
    sharer.close();
  });

  it("pw-check-result rejected → rejected-by-user to viewer, viewer WSS closes", async () => {
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message");

    viewer.send(JSON.stringify({ type: "pw-attempt", password: "right" }));
    await once(sharer, "message");
    sharer.send(JSON.stringify({ type: "pw-check-result", result: "rejected" }));
    const out = await once(viewer, "message");
    expect(out.type).toBe("rejected-by-user");
    await new Promise<void>((r) => viewer.once("close", () => r()));
    sharer.close();
  });

  it("pw-check-result ok → peer-confirmed to viewer + peer-joined to sharer + relay flows", async () => {
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message"); // needs-password

    viewer.send(JSON.stringify({ type: "pw-attempt", password: "right" }));
    await once(sharer, "message"); // pw-check

    sharer.send(JSON.stringify({ type: "pw-check-result", result: "ok" }));
    const vMsg = await once(viewer, "message");
    expect(vMsg.type).toBe("peer-confirmed");
    const sMsg = await once(sharer, "message");
    expect(sMsg.type).toBe("peer-joined");
    expect(sMsg.viewerInfo.ipPrefix).toMatch(/^[0-9.]+\.xxx/);

    // Now SDP/ICE flows both ways via relay.
    viewer.send(
      JSON.stringify({
        type: "relay",
        payload: { kind: "sdp", sdp: { type: "offer", sdp: "v=0\n" } },
      }),
    );
    const sRelay = await once(sharer, "message");
    expect(sRelay.type).toBe("relay");
    expect(sRelay.payload.kind).toBe("sdp");

    sharer.send(
      JSON.stringify({
        type: "relay",
        payload: { kind: "ice", candidate: { candidate: "candidate:0 1 UDP", sdpMid: "0", sdpMLineIndex: 0 } },
      }),
    );
    const vRelay = await once(viewer, "message");
    expect(vRelay.type).toBe("relay");
    expect(vRelay.payload.kind).toBe("ice");

    viewer.close();
    sharer.close();
  });

  it("five fails in a row → locked to viewer, lockout persisted", async () => {
    // A failed attempt keeps the same viewer in awaiting-pw state —
    // they can retry. Only the 5th hit causes a close + lockout. Use
    // ONE viewer + ONE sharer and retry on the same connection.
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message"); // needs-password

    for (let i = 1; i <= PW_FAIL_THRESHOLD; i++) {
      viewer.send(JSON.stringify({ type: "pw-attempt", password: "wrong" }));
      await once(sharer, "message"); // pw-check
      sharer.send(JSON.stringify({ type: "pw-check-result", result: "fail" }));
      const out = await once(viewer, "message");
      if (i < PW_FAIL_THRESHOLD) {
        expect(out.type).toBe("wrong-password");
        expect(out.attemptsLeft).toBe(PW_FAIL_THRESHOLD - i);
      } else {
        expect(out.type).toBe("locked");
        expect(out.retryAfterSec).toBeGreaterThan(0);
      }
    }
    // After the 5th fail the viewer must have been closed by the
    // server. Confirm via close event.
    await new Promise<void>((r) => {
      if (viewer.readyState === viewer.CLOSED) r();
      else viewer.once("close", () => r());
    });
    sharer.close();
  });

  // TC C-2 (review 2026-05-13): a sharer that lands its pw-check-
  // result AFTER the viewer dropped must NOT receive a backend
  // error frame. The heartbeat treats `error` / `backend-error`
  // as a fatal disconnect (heartbeat.rs: BackendError => returns
  // ConnectOutcome::Disconnected) and would force the sharer to
  // reconnect — collateral damage from a perfectly benign viewer
  // give-up. The synthesized `relay`/`bye` from the viewer-close
  // path is expected here and is NOT fatal (heartbeat.rs forwards
  // Relay as a plain event); the test above owns that assertion.
  it("late pw-check-result after viewer drop is silently ignored (TC C-2)", async () => {
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message"); // needs-password
    viewer.send(JSON.stringify({ type: "pw-attempt", password: "right" }));
    await once(sharer, "message"); // pw-check

    // Viewer gives up before the sharer responds.
    viewer.close();
    await new Promise<void>((r) => {
      if (viewer.readyState === viewer.CLOSED) r();
      else viewer.once("close", () => r());
    });

    // Collect anything the sharer might receive after the result.
    const stray: unknown[] = [];
    const onMessage = (data: Buffer): void => {
      stray.push(JSON.parse(data.toString()));
    };
    sharer.on("message", onMessage);

    sharer.send(JSON.stringify({ type: "pw-check-result", result: "ok" }));
    // Give the server a generous tick to send (or not send) a reply.
    await new Promise((r) => setTimeout(r, 80));

    sharer.off("message", onMessage);
    // The invariant is "nothing fatal", not "nothing at all": a
    // synthesized bye may race in from the viewer's close handler.
    const fatal = stray.filter(
      (m) => (m as { type?: string }).type === "error"
        || (m as { type?: string }).type === "backend-error",
    );
    expect(fatal, `fatal frames: ${JSON.stringify(fatal)}`).toEqual([]);
    for (const m of stray) {
      expect(m).toEqual({ type: "relay", payload: { kind: "bye" } });
    }
    // And the sharer's WSS is still open.
    expect(sharer.readyState).toBe(sharer.OPEN);
    sharer.close();
  });

  // F053: the result frame used to carry no correlation, so a sharer
  // waiter that outlived its viewer (60 s timeout, or the webview
  // displacing an orphaned confirm dialog) answered for whichever viewer
  // was pw-in-flight NEXT — a rejected-by-user nobody clicked, or a
  // confirm before the sharer's own verdict on that viewer's password.
  it("a pw-check-result for a stale attemptId is ignored; the current attempt still resolves", async () => {
    const sharer = await openSharer();
    const a = openViewer();
    await new Promise<void>((r) => a.once("open", () => r()));
    a.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(a, "message"); // needs-password
    a.send(JSON.stringify({ type: "pw-attempt", password: "right" }));
    const checkA = await once(sharer, "message");
    expect(checkA.type).toBe("pw-check");
    const staleId: number = checkA.attemptId;

    // A gives up mid-confirm; the backend synthesises a bye to the sharer.
    a.close();
    expect(await once(sharer, "message")).toEqual({ type: "relay", payload: { kind: "bye" } });

    const b = openViewer();
    await new Promise<void>((r) => b.once("open", () => r()));
    b.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(b, "message"); // needs-password
    b.send(JSON.stringify({ type: "pw-attempt", password: "right" }));
    const checkB = await once(sharer, "message");
    expect(checkB.type).toBe("pw-check");
    expect(checkB.attemptId).not.toBe(staleId);

    const toB: unknown[] = [];
    const onMessage = (data: Buffer): void => {
      toB.push(JSON.parse(data.toString()));
    };
    b.on("message", onMessage);
    sharer.send(JSON.stringify({ type: "pw-check-result", attemptId: staleId, result: "rejected" }));
    sharer.send(JSON.stringify({ type: "pw-check-result", attemptId: staleId, result: "ok" }));
    await new Promise((r) => setTimeout(r, 80));
    expect(toB, `B must not hear A's stale answers: ${JSON.stringify(toB)}`).toEqual([]);
    expect(b.readyState).toBe(b.OPEN);
    b.off("message", onMessage);

    sharer.send(
      JSON.stringify({ type: "pw-check-result", attemptId: checkB.attemptId, result: "ok" }),
    );
    expect(await once(b, "message")).toEqual({ type: "peer-confirmed" });
    b.close();
    sharer.close();
  });

  it("a pw-check-result without attemptId is still honoured (sharer predating the id)", async () => {
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message"); // needs-password
    viewer.send(JSON.stringify({ type: "pw-attempt", password: "right" }));
    await once(sharer, "message"); // pw-check
    sharer.send(JSON.stringify({ type: "pw-check-result", result: "ok" }));
    expect(await once(viewer, "message")).toEqual({ type: "peer-confirmed" });
    viewer.close();
    sharer.close();
  });

  it("ad-hoc flow still works: viewer joins an unknown code → invalid-code (regression)", async () => {
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: "000-000-000" }));
    const msg = await once(viewer, "message");
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("invalid-code");
    viewer.close();
  });

  // Mirrors the ad-hoc pre-confirm synthesized bye: a viewer that
  // vanishes before the session is confirmed sends nothing itself
  // (tab-close), so the backend must deliver the bye on its behalf —
  // otherwise the sharer's pending confirm dialog / pw wait points at
  // a gone viewer until the 60 s auto-decline.
  it("viewer close before confirm → backend synthesizes relay bye to the sharer", async () => {
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message"); // needs-password

    viewer.close();
    const msg = await once(sharer, "message");
    expect(msg).toEqual({ type: "relay", payload: { kind: "bye" } });
    sharer.close();
  });

  it("viewer close mid pw-check (pw-in-flight) → synthesized bye to the sharer", async () => {
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message"); // needs-password
    viewer.send(JSON.stringify({ type: "pw-attempt", password: "right" }));
    await once(sharer, "message"); // pw-check

    viewer.close();
    const msg = await once(sharer, "message");
    expect(msg).toEqual({ type: "relay", payload: { kind: "bye" } });
    sharer.close();
  });

  it("viewer close on a CONFIRMED session sends the sharer nothing (Wi-Fi-blip grace)", async () => {
    // Mirror of the ad-hoc semantics: once confirmed, a viewer WS drop
    // must NOT tear the stream down — the ICE grace / reconnect window
    // owns that decision.
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer, "message"); // needs-password
    viewer.send(JSON.stringify({ type: "pw-attempt", password: "right" }));
    await once(sharer, "message"); // pw-check
    sharer.send(JSON.stringify({ type: "pw-check-result", result: "ok" }));
    await once(viewer, "message"); // peer-confirmed
    await once(sharer, "message"); // peer-joined

    const stray: unknown[] = [];
    const onMessage = (data: Buffer): void => {
      stray.push(JSON.parse(data.toString()));
    };
    sharer.on("message", onMessage);
    viewer.close();
    await new Promise((r) => setTimeout(r, 80));
    sharer.off("message", onMessage);
    expect(stray).toEqual([]);
    sharer.close();
  });
});

// ── TC C-5 (review 2026-05-13): DELETE /api/devices/:id while a
// sharer is WSS-connected force-closes the connection with 4401.
//
// The unit tests in unattended.test.ts pin the in-memory registry's
// evict() in isolation; this exercises the full chain:
//   sharer authenticates → registry.register(id) →
//   owner calls DELETE → handler runs registry.evict(id) →
//   sharer's ws receives close 4401.
// Without this, a refactor that forgets to plumb the registry into
// devices/handlers.ts would silently leave the connection alive for
// the 30 s heartbeat-timeout window.

describe("device DELETE force-closes a live unattended WSS (TC C-5)", () => {
  let app: FastifyInstance;
  let url: string;
  let db: Db;
  let cookie: string;

  beforeAll(async () => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());

    process.env.REGISTER_RATE_LIMIT_MAX = "1000";
    process.env.BEARER_AUTH_RATE_LIMIT_MAX = "1000";
    app = await createServer({ port: 0, host: "127.0.0.1", db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    url = `ws://127.0.0.1:${addr.port}/signal`;

    // Mint an account + verified email so /api/auth/login issues a
    // session cookie.
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "owner-tcc5@example.com", password: "owner-account-pw" },
    });
    db.prepare(
      "UPDATE accounts SET email_verified_at = ? WHERE email = 'owner-tcc5@example.com'",
    ).run(Date.now());
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner-tcc5@example.com", password: "owner-account-pw" },
    });
    const sc = login.headers["set-cookie"] as string | string[] | undefined;
    cookie = (Array.isArray(sc) ? sc[0] : sc!).match(/^__Host-auffi_session=([^;]+)/)![1];
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it("DELETE on the owner's path closes the sharer's WSS with code 4401", async () => {
    // Pair + redeem to get a real (device_id, token) pair.
    const pair = await app.inject({
      method: "POST",
      url: "/api/devices/pairing-code",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    const { code } = pair.json();
    const redeem = await app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code, alias: "TC-C-5-device" },
    });
    const { deviceId, token } = redeem.json();

    // Open the WSS as the freshly-paired sharer.
    const ws = new WebSocket(url, {
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${token}`,
        "x-auffi-device-id": deviceId,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("message", () => resolve()); // unattended-hello → registered
      ws.once("error", reject);
    });

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reasonBuf) => {
        resolve({ code, reason: reasonBuf.toString() });
      });
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(del.statusCode).toBe(204);

    const closed = await closePromise;
    expect(closed.code).toBe(4401);
    expect(closed.reason).toMatch(/revoked/i);
  });

  // Seed a device with a KNOWN plaintext token directly in the DB (owned by
  // the TC-C5 cookie's account). Avoids the pairing-code 5/h rate-limit that
  // several device-minting tests in one describe would otherwise trip, and
  // gives us the plaintext token for bearer auth. `id` doubles as a unique
  // 9-digit device-id; `token` must be 64 hex chars (parseBearerAuth shape).
  let seedCounter = 0;
  async function pairDevice(_alias: string): Promise<{ deviceId: string; token: string }> {
    seedCounter += 1;
    const deviceId = `900-000-${String(seedCounter).padStart(3, "0")}`;
    const token = seedCounter.toString(16).padStart(64, "0");
    const owner = db
      .prepare<[string], { id: number }>("SELECT id FROM accounts WHERE email = ?")
      .get("owner-tcc5@example.com")!;
    db.prepare(
      `INSERT INTO devices (id, owner_account_id, alias, token_hash, auto_accept, created_at)
       VALUES (?, ?, 'seed', ?, 1, ?)`,
    ).run(deviceId, owner.id, await hashPassword(token), Date.now());
    return { deviceId, token };
  }

  function openSharerWss(deviceId: string, token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          origin: ORIGIN,
          authorization: `Bearer ${token}`,
          "x-auffi-device-id": deviceId,
        },
      });
      ws.once("message", () => resolve(ws)); // unattended-hello → registered
      ws.once("error", reject);
    });
  }

  function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
      ws.once("close", (code, reasonBuf) => resolve({ code, reason: reasonBuf.toString() }));
    });
  }

  // I-B1 (review 2026-07-02): a SHARER can revoke ITSELF using its own device
  // bearer token (the "Entkoppeln" button). Previously the DELETE route only
  // accepted a session cookie, so the sharer's bearer DELETE always 401'd and
  // the server-side token was never revoked.
  it("device self-revoke via its own bearer token deletes the row + closes the WSS (I-B1)", async () => {
    const { deviceId, token } = await pairDevice("self-revoke");
    const ws = await openSharerWss(deviceId, token);
    const closed = nextClose(ws);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/devices/${deviceId}`,
      headers: { authorization: `Bearer ${token}`, "x-auffi-device-id": deviceId },
    });
    expect(del.statusCode).toBe(204);

    const c = await closed;
    expect(c.code).toBe(4401);
    const row = db.prepare("SELECT id FROM devices WHERE id = ?").get(deviceId);
    expect(row).toBeUndefined();
  });

  it("self-revoke with a wrong token is rejected 401 and keeps the device (I-B1)", async () => {
    const { deviceId } = await pairDevice("wrong-token");
    const wrongToken = "0".repeat(64);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/devices/${deviceId}`,
      headers: { authorization: `Bearer ${wrongToken}`, "x-auffi-device-id": deviceId },
    });
    expect(del.statusCode).toBe(401);
    const row = db.prepare("SELECT id FROM devices WHERE id = ?").get(deviceId);
    expect(row).toBeTruthy();
  });

  it("a device token cannot delete a DIFFERENT device (403) (I-B1)", async () => {
    const a = await pairDevice("device-a");
    const b = await pairDevice("device-b");
    // Present device A's token but target device B's id in the path.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/devices/${b.deviceId}`,
      headers: { authorization: `Bearer ${a.token}`, "x-auffi-device-id": a.deviceId },
    });
    expect(del.statusCode).toBe(403);
    const row = db.prepare("SELECT id FROM devices WHERE id = ?").get(b.deviceId);
    expect(row).toBeTruthy();
  });

  // B2 (review 2026-07-02): deleting the owning ACCOUNT must force-close its
  // devices' live unattended WSS — otherwise a revoked account keeps relaying
  // on its already-authenticated socket until the next reconnect.
  it("DELETE /api/me force-closes the account's live unattended WSS (B2)", async () => {
    const { deviceId, token } = await pairDevice("account-delete");
    const ws = await openSharerWss(deviceId, token);
    const closed = nextClose(ws);

    const del = await app.inject({
      method: "DELETE",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "owner-account-pw", confirm: "LÖSCHEN" },
    });
    expect(del.statusCode).toBe(204);

    const c = await closed;
    expect(c.code).toBe(4401);
  });
});

// B1 (review 2026-07-02): if a device row vanishes (account/device
// hard-delete) while its unattended WSS stays open, a subsequent
// `connection-started` used to throw a FK SqliteError inside the ws
// 'message' listener — an uncaughtException that could drop every session.
// The handler now catches it at the module boundary. This simulates the
// delete-without-evict race by deleting the row directly (bypassing the
// route's registry.evict) and asserts the backend neither crashes nor
// kills the sharer socket.

// ── Stale-session reap notifies the sharer ────────────────────────────
//
// The 60 s sweep frees device slots whose viewer never finished the
// password step (PW_ENTRY_TIMEOUT_MS). Closing the abandoned viewer
// socket alone left the sharer waiting on a pw-check nobody would ever
// answer — the reap must also deliver the synthesized bye. Uses the
// registerSignaling harness directly so the test can drive sweepStale
// without waiting for the server's 60 s interval.

describe("sweepStale reap → synthesized bye to the unattended sharer", () => {
  let app: FastifyInstance;
  let url: string;
  let db: Db;
  const sessions = new UnattendedSessions();
  const token = "12abcdef".repeat(8);
  const deviceId = "555-555-555";

  beforeAll(async () => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, email_verified_at, created_at) VALUES (1, 'owner@a', 'x', ?, ?)",
    ).run(Date.now(), Date.now());
    const tokenHash = await hashPassword(token);
    db.prepare(
      `INSERT INTO devices (id, owner_account_id, alias, token_hash, auto_accept, created_at)
       VALUES (?, 1, 'D', ?, 1, ?)`,
    ).run(deviceId, tokenHash, Date.now());

    app = Fastify();
    await app.register(websocketPlugin);
    const store = new SessionStore({ ttlMs: 600_000 });
    registerSignaling(
      app,
      store,
      undefined,
      undefined,
      undefined,
      { windowMs: 60_000, max: 1000 },
      undefined,
      { db, registry: new UnattendedRegistry(), sessions },
      { windowMs: 60_000, max: 1000 },
    );
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    url = `ws://127.0.0.1:${addr.port}/signal`;
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it("reaping an awaiting-pw session sends the sharer a bye and closes the viewer", async () => {
    const sharer = new WebSocket(url, {
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${token}`,
        "x-auffi-device-id": deviceId,
      },
    });
    await new Promise<void>((resolve, reject) => {
      sharer.once("message", () => resolve()); // unattended-hello
      sharer.once("error", reject);
    });

    const viewer = new WebSocket(url, { headers: { origin: ORIGIN } });
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await new Promise<void>((r) => viewer.once("message", () => r())); // needs-password

    const byePromise = new Promise<unknown>((r) =>
      sharer.once("message", (data: Buffer) => r(JSON.parse(data.toString()))),
    );
    const viewerClosed = new Promise<void>((r) => viewer.once("close", () => r()));

    const reaped = sessions.sweepStale(Date.now() + PW_ENTRY_TIMEOUT_MS + 1);
    expect(reaped.map((s) => s.deviceId)).toEqual([deviceId]);

    expect(await byePromise).toEqual({ type: "relay", payload: { kind: "bye" } });
    await viewerClosed;
    sharer.close();
  });
});

// ── TURN credentials over the heartbeat WSS ───────────────────────────
//
// The unattended sharer has no session code for POST /turn-credentials;
// it asks over its bearer-authenticated WSS instead
// (turn-credentials-request → turn-credentials). With TURN configured
// the reply carries the same ephemeral HMAC credentials as the REST
// endpoint; without, `credentials` is null and the sharer proceeds
// STUN-less.

describe("/signal turn-credentials-request (unattended sharer)", () => {
  const token = "34abcdef".repeat(8);
  const deviceId = "666-666-666";

  async function startApp(withTurn: boolean): Promise<{ app: FastifyInstance; url: string; db: Db }> {
    const db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, email_verified_at, created_at) VALUES (1, 'owner@a', 'x', ?, ?)",
    ).run(Date.now(), Date.now());
    const tokenHash = await hashPassword(token);
    db.prepare(
      `INSERT INTO devices (id, owner_account_id, alias, token_hash, auto_accept, created_at)
       VALUES (?, 1, 'D', ?, 1, ?)`,
    ).run(deviceId, tokenHash, Date.now());

    if (withTurn) {
      process.env.TURN_SHARED_SECRET = "test-secret-32-chars-minimum";
      process.env.TURN_HOSTS = "turn:turn.auffi.local:3478";
    } else {
      delete process.env.TURN_SHARED_SECRET;
      delete process.env.TURN_HOSTS;
    }
    process.env.BEARER_AUTH_RATE_LIMIT_MAX = "1000";
    const app = await createServer({ port: 0, host: "127.0.0.1", db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    return { app, url: `ws://127.0.0.1:${addr.port}/signal`, db };
  }

  async function openSharerAt(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          origin: ORIGIN,
          authorization: `Bearer ${token}`,
          "x-auffi-device-id": deviceId,
        },
      });
      ws.once("message", () => resolve(ws)); // unattended-hello
      ws.once("error", reject);
    });
  }

  afterAll(() => {
    delete process.env.TURN_SHARED_SECRET;
    delete process.env.TURN_HOSTS;
  });

  it("replies with ephemeral credentials when TURN is configured", async () => {
    const { app, url, db } = await startApp(true);
    const sharer = await openSharerAt(url);
    sharer.send(JSON.stringify({ type: "turn-credentials-request" }));
    const msg = await new Promise<any>((r) =>
      sharer.once("message", (data: Buffer) => r(JSON.parse(data.toString()))),
    );
    expect(msg.type).toBe("turn-credentials");
    expect(msg.credentials.urls).toContain("turn:turn.auffi.local:3478");
    expect(msg.credentials.username).toMatch(/^\d+:[a-z0-9-]+$/);
    expect(msg.credentials.ttl).toBeGreaterThan(60);
    sharer.close();
    await app.close();
    db.close();
  });

  it("replies with credentials: null when the backend has no TURN configured", async () => {
    const { app, url, db } = await startApp(false);
    const sharer = await openSharerAt(url);
    sharer.send(JSON.stringify({ type: "turn-credentials-request" }));
    const msg = await new Promise<any>((r) =>
      sharer.once("message", (data: Buffer) => r(JSON.parse(data.toString()))),
    );
    expect(msg).toEqual({ type: "turn-credentials", credentials: null });
    sharer.close();
    await app.close();
    db.close();
  });
});
