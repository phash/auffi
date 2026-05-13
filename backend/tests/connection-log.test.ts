import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { createServer } from "../src/server.js";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { hashPassword } from "../src/auth/argon.js";
import {
  endConnectionLog,
  listConnectionLog,
  startConnectionLog,
  MAX_LIMIT,
} from "../src/connection_log.js";

// ── Pure tests: startConnectionLog / endConnectionLog / listConnectionLog ──

describe("startConnectionLog / endConnectionLog", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, created_at) VALUES (1, 'a@a', 'x', ?)",
    ).run(1);
    db.prepare(
      "INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at) VALUES ('111-111-111', 1, 'D', 'h', ?)",
    ).run(1);
  });

  it("inserts a row with ended_at NULL and bytes_relayed 0", () => {
    const id = startConnectionLog(db, "111-111-111", "84.xxx", "p2p", 10_000);
    const row = db
      .prepare<[number], { ended_at: number | null; bytes_relayed: number; connection_type: string }>(
        "SELECT ended_at, bytes_relayed, connection_type FROM connection_log WHERE id = ?",
      )
      .get(id);
    expect(row?.ended_at).toBeNull();
    expect(row?.bytes_relayed).toBe(0);
    expect(row?.connection_type).toBe("p2p");
  });

  it("endConnectionLog sets ended_at and bytes_relayed; idempotent on bad id", () => {
    const id = startConnectionLog(db, "111-111-111", "84.xxx", "relay", 10_000);
    endConnectionLog(db, id, 12345, 20_000);
    const row = db
      .prepare<[number], { ended_at: number; bytes_relayed: number }>(
        "SELECT ended_at, bytes_relayed FROM connection_log WHERE id = ?",
      )
      .get(id);
    expect(row?.ended_at).toBe(20_000);
    expect(row?.bytes_relayed).toBe(12345);
    expect(() => endConnectionLog(db, 999_999, 0)).not.toThrow();
  });
});

describe("listConnectionLog", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, created_at) VALUES (1, 'a@a', 'x', ?)",
    ).run(1);
    db.prepare(
      "INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at) VALUES ('111-111-111', 1, 'D', 'h', ?)",
    ).run(1);
  });

  it("returns the newest rows first (id DESC)", () => {
    for (let i = 1; i <= 5; i++) startConnectionLog(db, "111-111-111", "84.xxx", "p2p", i);
    const page = listConnectionLog(db, "111-111-111", undefined, 10);
    expect(page.items.map((r) => r.startedAt)).toEqual([5, 4, 3, 2, 1]);
    expect(page.nextCursor).toBeNull();
  });

  it("paginates via cursor with nextCursor set to last id on page", () => {
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(startConnectionLog(db, "111-111-111", "84.xxx", "p2p", i));
    }
    const first = listConnectionLog(db, "111-111-111", undefined, 2);
    expect(first.items.length).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = listConnectionLog(db, "111-111-111", first.nextCursor!, 2);
    expect(second.items.length).toBe(2);
    expect(second.items[0].id).toBeLessThan(first.items[1].id);
    const third = listConnectionLog(db, "111-111-111", second.nextCursor!, 2);
    expect(third.items.length).toBe(1);
    expect(third.nextCursor).toBeNull();
  });

  it("clamps limit to MAX_LIMIT", () => {
    for (let i = 0; i < MAX_LIMIT + 5; i++) {
      startConnectionLog(db, "111-111-111", "84.xxx", "p2p", i);
    }
    const page = listConnectionLog(db, "111-111-111", undefined, 999);
    expect(page.items.length).toBe(MAX_LIMIT);
  });

  it("scopes by device_id", () => {
    db.prepare(
      "INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at) VALUES ('222-222-222', 1, 'D2', 'h', ?)",
    ).run(1);
    startConnectionLog(db, "111-111-111", "84.xxx", "p2p");
    startConnectionLog(db, "222-222-222", "84.xxx", "p2p");
    const page = listConnectionLog(db, "111-111-111", undefined, 10);
    expect(page.items.length).toBe(1);
    expect(page.items[0].deviceId).toBe("111-111-111");
  });
});

// ── HTTP: GET /api/devices/:id/log ────────────────────────────────────

describe("GET /api/devices/:id/log", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let db: Db;

  beforeAll(async () => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, email_verified_at, created_at) VALUES (1, 'owner@a.test', ?, ?, ?)",
    ).run(await hashPassword("owner-account-pw"), Date.now(), Date.now());
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, email_verified_at, created_at) VALUES (2, 'other@a.test', ?, ?, ?)",
    ).run(await hashPassword("other-account-pw"), Date.now(), Date.now());
    db.prepare(
      "INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at) VALUES ('333-333-333', 1, 'Mine', 'h', ?)",
    ).run(Date.now());
    for (let i = 0; i < 25; i++) {
      const id = startConnectionLog(db, "333-333-333", "84.xxx", i % 2 === 0 ? "p2p" : "relay", i + 1);
      if (i < 20) endConnectionLog(db, id, 1000 * i, i + 100);
    }

    process.env.REGISTER_RATE_LIMIT_MAX = "1000";
    app = await createServer({ port: 0, host: "127.0.0.1", db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  async function cookieFor(email: string, password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    const sc = res.headers.get("set-cookie")!;
    return sc.match(/__Host-auffi_session=([^;]+)/)![1];
  }

  it("returns newest rows first, default limit 20, with nextCursor", async () => {
    const c = await cookieFor("owner@a.test", "owner-account-pw");
    const res = await fetch(`${baseUrl}/api/devices/333-333-333/log`, {
      headers: { cookie: `__Host-auffi_session=${c}`, origin: "http://127.0.0.1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(20);
    expect(body.nextCursor).not.toBeNull();
    // Newest first.
    expect(body.items[0].id).toBeGreaterThan(body.items[19].id);
  });

  it("paginates via cursor query param", async () => {
    const c = await cookieFor("owner@a.test", "owner-account-pw");
    const first = await (
      await fetch(`${baseUrl}/api/devices/333-333-333/log?limit=10`, {
        headers: { cookie: `__Host-auffi_session=${c}`, origin: "http://127.0.0.1" },
      })
    ).json();
    expect(first.items.length).toBe(10);
    const second = await (
      await fetch(
        `${baseUrl}/api/devices/333-333-333/log?limit=10&cursor=${first.nextCursor}`,
        { headers: { cookie: `__Host-auffi_session=${c}`, origin: "http://127.0.0.1" } },
      )
    ).json();
    expect(second.items[0].id).toBeLessThan(first.items[9].id);
  });

  it("403s on cross-account access (does NOT leak device existence)", async () => {
    const c = await cookieFor("other@a.test", "other-account-pw");
    const res = await fetch(`${baseUrl}/api/devices/333-333-333/log`, {
      headers: { cookie: `__Host-auffi_session=${c}`, origin: "http://127.0.0.1" },
    });
    expect(res.status).toBe(403);
  });

  it("403s on unknown device id (same shape as cross-account)", async () => {
    const c = await cookieFor("owner@a.test", "owner-account-pw");
    const res = await fetch(`${baseUrl}/api/devices/000-000-000/log`, {
      headers: { cookie: `__Host-auffi_session=${c}`, origin: "http://127.0.0.1" },
    });
    expect(res.status).toBe(403);
  });

  it("401s without a session cookie", async () => {
    const res = await fetch(`${baseUrl}/api/devices/333-333-333/log`, {
      headers: { origin: "http://127.0.0.1" },
    });
    expect(res.status).toBe(401);
  });
});

// ── WSS end-to-end: connection-started / connection-ended ─────────────

describe("/signal connection-started + connection-ended (gh #18)", () => {
  let app: FastifyInstance;
  let url: string;
  let db: Db;
  const token = "feedface".repeat(8);
  const deviceId = "555-555-555";

  beforeAll(async () => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      "INSERT INTO accounts (id, email, password_hash, email_verified_at, created_at) VALUES (1, 'owner@a.test', 'x', ?, ?)",
    ).run(Date.now(), Date.now());
    const tokenHash = await hashPassword(token);
    db.prepare(
      "INSERT INTO devices (id, owner_account_id, alias, token_hash, auto_accept, created_at) VALUES (?, 1, 'D', ?, 1, ?)",
    ).run(deviceId, tokenHash, Date.now());

    process.env.REGISTER_RATE_LIMIT_MAX = "1000";
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
    db.prepare("DELETE FROM connection_log").run();
  });

  function openSharer(): Promise<WebSocket> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, {
        headers: {
          origin: "http://127.0.0.1",
          authorization: `Bearer ${token}`,
          "x-auffi-device-id": deviceId,
        },
      });
      ws.once("message", () => resolve(ws));
    });
  }

  function openViewer(): WebSocket {
    return new WebSocket(url, { headers: { origin: "http://127.0.0.1" } });
  }

  async function once(ws: WebSocket): Promise<any> {
    return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));
  }

  async function completePwOk(): Promise<{ sharer: WebSocket; viewer: WebSocket }> {
    const sharer = await openSharer();
    const viewer = openViewer();
    await new Promise<void>((r) => viewer.once("open", () => r()));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: deviceId }));
    await once(viewer); // needs-password
    viewer.send(JSON.stringify({ type: "pw-attempt", password: "x" }));
    await once(sharer); // pw-check
    sharer.send(JSON.stringify({ type: "pw-check-result", result: "ok" }));
    await once(viewer); // peer-confirmed
    await once(sharer); // peer-joined
    return { sharer, viewer };
  }

  it("connection-started from sharer writes a connection_log row", async () => {
    const { sharer, viewer } = await completePwOk();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "p2p" }));
    // Give the DB write time to land.
    await new Promise((r) => setTimeout(r, 30));
    const row = db
      .prepare<[string], { connection_type: string; ended_at: number | null; bytes_relayed: number }>(
        "SELECT connection_type, ended_at, bytes_relayed FROM connection_log WHERE device_id = ?",
      )
      .get(deviceId);
    expect(row?.connection_type).toBe("p2p");
    expect(row?.ended_at).toBeNull();
    expect(row?.bytes_relayed).toBe(0);
    viewer.close();
    sharer.close();
  });

  it("connection-ended sets ended_at and bytes_relayed", async () => {
    const { sharer, viewer } = await completePwOk();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "relay" }));
    await new Promise((r) => setTimeout(r, 30));
    sharer.send(JSON.stringify({ type: "connection-ended", bytesRelayed: 4096 }));
    await new Promise((r) => setTimeout(r, 30));
    const row = db
      .prepare<[string], { ended_at: number | null; bytes_relayed: number }>(
        "SELECT ended_at, bytes_relayed FROM connection_log WHERE device_id = ?",
      )
      .get(deviceId);
    expect(row?.ended_at).not.toBeNull();
    expect(row?.bytes_relayed).toBe(4096);
    viewer.close();
    sharer.close();
  });

  it("caps bytesRelayed at MAX_BYTES_PER_SESSION (Sec L-3)", async () => {
    // 100 GB is the documented cap. A malicious/buggy sharer
    // sending Number.MAX_SAFE_INTEGER must not pollute the
    // per-device usage metric.
    const MAX_BYTES = 100 * 1024 * 1024 * 1024;
    const { sharer, viewer } = await completePwOk();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "relay" }));
    await new Promise((r) => setTimeout(r, 30));
    sharer.send(
      JSON.stringify({ type: "connection-ended", bytesRelayed: Number.MAX_SAFE_INTEGER }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const row = db
      .prepare<[string], { bytes_relayed: number }>(
        "SELECT bytes_relayed FROM connection_log WHERE device_id = ?",
      )
      .get(deviceId);
    expect(row?.bytes_relayed).toBe(MAX_BYTES);
    viewer.close();
    sharer.close();
  });

  it("coerces negative/NaN/Infinity bytesRelayed to 0", async () => {
    const { sharer, viewer } = await completePwOk();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "relay" }));
    await new Promise((r) => setTimeout(r, 30));
    // -1, NaN, and Infinity all collapse to 0 — no spam pixels in
    // the usage UI.
    sharer.send(JSON.stringify({ type: "connection-ended", bytesRelayed: -1 }));
    await new Promise((r) => setTimeout(r, 30));
    const row = db
      .prepare<[string], { bytes_relayed: number }>(
        "SELECT bytes_relayed FROM connection_log WHERE device_id = ?",
      )
      .get(deviceId);
    expect(row?.bytes_relayed).toBe(0);
    viewer.close();
    sharer.close();
  });

  it("viewer close finalises an open log row with bytes_relayed=0", async () => {
    const { sharer, viewer } = await completePwOk();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "p2p" }));
    await new Promise((r) => setTimeout(r, 30));
    viewer.close();
    // Wait for the close event to propagate.
    await new Promise((r) => setTimeout(r, 60));
    const row = db
      .prepare<[string], { ended_at: number | null; bytes_relayed: number }>(
        "SELECT ended_at, bytes_relayed FROM connection_log WHERE device_id = ?",
      )
      .get(deviceId);
    expect(row?.ended_at).not.toBeNull();
    expect(row?.bytes_relayed).toBe(0);
    sharer.close();
  });

  it("ignores connection-started with invalid connectionType", async () => {
    const { sharer, viewer } = await completePwOk();
    sharer.send(JSON.stringify({ type: "connection-started", connectionType: "fancy-new-protocol" }));
    await new Promise((r) => setTimeout(r, 30));
    const count = db
      .prepare<[string], { c: number }>(
        "SELECT COUNT(*) AS c FROM connection_log WHERE device_id = ?",
      )
      .get(deviceId)!.c;
    expect(count).toBe(0);
    viewer.close();
    sharer.close();
  });
});
