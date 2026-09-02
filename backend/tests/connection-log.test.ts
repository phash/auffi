import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FastifyInstance } from "fastify";
import { createServer } from "../src/server.js";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { hashPassword } from "../src/auth/argon.js";
import { listConnectionLog, MAX_LIMIT } from "../src/connection_log.js";

// The connection_log WRITE path (the connection-started / connection-ended
// wire acceptance) was removed as dead code — no client ever emitted the
// frames (gh #109 tracks the telemetry feature). These tests seed rows
// directly and pin the surviving READ surface: listConnectionLog and
// GET /api/devices/:id/log.
function insertLog(
  db: Db,
  deviceId: string,
  startedAt: number,
  connectionType: "p2p" | "relay" = "p2p",
  endedAt: number | null = null,
  bytesRelayed = 0,
): number {
  const res = db
    .prepare(
      `INSERT INTO connection_log
         (device_id, started_at, ended_at, viewer_ip_prefix, connection_type, bytes_relayed)
       VALUES (?, ?, ?, '84.xxx', ?, ?)`,
    )
    .run(deviceId, startedAt, endedAt, connectionType, bytesRelayed);
  return Number(res.lastInsertRowid);
}

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
    for (let i = 1; i <= 5; i++) insertLog(db, "111-111-111", i);
    const page = listConnectionLog(db, "111-111-111", undefined, 10);
    expect(page.items.map((r) => r.startedAt)).toEqual([5, 4, 3, 2, 1]);
    expect(page.nextCursor).toBeNull();
  });

  it("paginates via cursor with nextCursor set to last id on page", () => {
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(insertLog(db, "111-111-111", i));
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
      insertLog(db, "111-111-111", i);
    }
    const page = listConnectionLog(db, "111-111-111", undefined, 999);
    expect(page.items.length).toBe(MAX_LIMIT);
  });

  it("scopes by device_id", () => {
    db.prepare(
      "INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at) VALUES ('222-222-222', 1, 'D2', 'h', ?)",
    ).run(1);
    insertLog(db, "111-111-111", 1);
    insertLog(db, "222-222-222", 1);
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
      const type = i % 2 === 0 ? "p2p" : "relay";
      if (i < 20) insertLog(db, "333-333-333", i + 1, type, i + 100, 1000 * i);
      else insertLog(db, "333-333-333", i + 1, type);
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

  type LogPage = { items: Array<{ id: number }>; nextCursor: string | null };

  it("returns newest rows first, default limit 20, with nextCursor", async () => {
    const c = await cookieFor("owner@a.test", "owner-account-pw");
    const res = await fetch(`${baseUrl}/api/devices/333-333-333/log`, {
      headers: { cookie: `__Host-auffi_session=${c}`, origin: "http://127.0.0.1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LogPage;
    expect(body.items.length).toBe(20);
    expect(body.nextCursor).not.toBeNull();
    // Newest first.
    expect(body.items[0].id).toBeGreaterThan(body.items[19].id);
  });

  it("paginates via cursor query param", async () => {
    const c = await cookieFor("owner@a.test", "owner-account-pw");
    const first = (await (
      await fetch(`${baseUrl}/api/devices/333-333-333/log?limit=10`, {
        headers: { cookie: `__Host-auffi_session=${c}`, origin: "http://127.0.0.1" },
      })
    ).json()) as LogPage;
    expect(first.items.length).toBe(10);
    const second = (await (
      await fetch(
        `${baseUrl}/api/devices/333-333-333/log?limit=10&cursor=${first.nextCursor}`,
        { headers: { cookie: `__Host-auffi_session=${c}`, origin: "http://127.0.0.1" } },
      )
    ).json()) as LogPage;
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
