import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { createServer } from "../src/server.js";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { hashPassword } from "../src/auth/argon.js";
import {
  checkLockout,
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
    app = await createServer({ port: 0, host: "127.0.0.1", db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    url = `ws://127.0.0.1:${addr.port}/signal`;
  });

  afterAll(async () => {
    await app.close();
    db.close();
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
    expect(onSharer).toEqual({ type: "pw-check", attempt: "hunter2", autoAccept: true });
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
    });
    // Reset for any later test.
    db.prepare("UPDATE devices SET auto_accept = 1 WHERE id = ?").run(deviceId);
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

  it("ad-hoc flow still works: viewer joins an unknown code → invalid-code (regression)", async () => {
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: "000-000-000" }));
    const msg = await once(viewer, "message");
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("invalid-code");
    viewer.close();
  });
});
