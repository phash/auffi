import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { createServer } from "../src/server.js";
import {
  parseBearerAuth,
  UnattendedRegistry,
  verifyBearerAuth,
  WS_CLOSE,
} from "../src/unattended.js";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { hashPassword } from "../src/auth/argon.js";

// Pure helpers first — no Fastify spin-up cost.

describe("parseBearerAuth", () => {
  it("returns null when neither header is present (ad-hoc path)", () => {
    expect(parseBearerAuth({})).toBeNull();
  });

  it("returns BearerAuth when both headers well-shaped", () => {
    const out = parseBearerAuth({
      authorization: "Bearer " + "a".repeat(64),
      "x-auffi-device-id": "123-456-789",
    });
    expect(out).toEqual({ deviceId: "123-456-789", token: "a".repeat(64) });
  });

  it('returns "malformed" when only the authorization header is present', () => {
    expect(parseBearerAuth({ authorization: "Bearer abc" })).toBe("malformed");
  });

  it('returns "malformed" when only the device-id header is present', () => {
    expect(parseBearerAuth({ "x-auffi-device-id": "123-456-789" })).toBe("malformed");
  });

  it('rejects token shape other than 64 hex (avoid 250 ms argon2 on garbage)', () => {
    expect(
      parseBearerAuth({
        authorization: "Bearer short",
        "x-auffi-device-id": "123-456-789",
      }),
    ).toBe("malformed");
  });

  it('rejects device-id not matching NNN-NNN-NNN', () => {
    expect(
      parseBearerAuth({
        authorization: "Bearer " + "a".repeat(64),
        "x-auffi-device-id": "1234-56-789",
      }),
    ).toBe("malformed");
  });

  it("accepts case-variant header names (some proxies lowercase, some don't)", () => {
    const out = parseBearerAuth({
      Authorization: "Bearer " + "f".repeat(64),
      "X-Auffi-Device-Id": "987-654-321",
    });
    expect(out).toEqual({ deviceId: "987-654-321", token: "f".repeat(64) });
  });

  it("takes the first value when a header arrives as an array (proxy folding)", () => {
    const out = parseBearerAuth({
      authorization: ["Bearer " + "0".repeat(64), "Bearer ignored"],
      "x-auffi-device-id": "111-222-333",
    });
    expect(out).toEqual({ deviceId: "111-222-333", token: "0".repeat(64) });
  });
});

// verifyBearerAuth + DB integration

describe("verifyBearerAuth", () => {
  let db: Db;
  const token = "1234567890abcdef".repeat(4); // 64 hex chars

  beforeEach(async () => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      "INSERT INTO accounts (email, password_hash, email_verified_at, created_at) VALUES (?, ?, ?, ?)",
    ).run("owner@example.com", "x", Date.now(), Date.now());
    const tokenHash = await hashPassword(token);
    db.prepare(
      `INSERT INTO devices (id, owner_account_id, alias, token_hash, auto_accept, created_at, last_seen_at)
       VALUES ('123-456-789', 1, 'D1', ?, 1, ?, NULL)`,
    ).run(tokenHash, Date.now());
  });

  // Suspending an account is the moderation lever short of deletion, but the
  // device lookup never joined to accounts — so a suspended owner's sharer
  // kept its live WSS AND re-authenticated cleanly on every reconnect, leaving
  // unattended remote control fully usable. gh #47 listed cutting the sharer
  // off as an acceptance criterion.
  it("rejects a device whose owner account is suspended", async () => {
    db.prepare("UPDATE accounts SET suspended_at = ? WHERE id = 1").run(Date.now());
    const ok = await verifyBearerAuth(db, { deviceId: "123-456-789", token }, 1_000_000);
    expect(ok).toBe(false);
  });

  it("accepts again once the suspension is lifted", async () => {
    db.prepare("UPDATE accounts SET suspended_at = ? WHERE id = 1").run(Date.now());
    expect(await verifyBearerAuth(db, { deviceId: "123-456-789", token })).toBe(false);
    db.prepare("UPDATE accounts SET suspended_at = NULL WHERE id = 1").run();
    expect(await verifyBearerAuth(db, { deviceId: "123-456-789", token })).toBe(true);
  });

  it("does not bump last_seen_at for a suspended owner", async () => {
    db.prepare("UPDATE accounts SET suspended_at = ? WHERE id = 1").run(Date.now());
    await verifyBearerAuth(db, { deviceId: "123-456-789", token }, 1_000_000);
    const row = db
      .prepare<[], { last_seen_at: number | null }>(
        "SELECT last_seen_at FROM devices WHERE id = '123-456-789'",
      )
      .get();
    expect(row?.last_seen_at).toBeNull();
  });

  it("returns true on valid bearer and bumps last_seen_at", async () => {
    const ok = await verifyBearerAuth(db, { deviceId: "123-456-789", token }, 1_000_000);
    expect(ok).toBe(true);
    const row = db
      .prepare<[], { last_seen_at: number | null }>(
        "SELECT last_seen_at FROM devices WHERE id = '123-456-789'",
      )
      .get();
    expect(row?.last_seen_at).toBe(1_000_000);
  });

  it("returns false when the device-id is unknown", async () => {
    const ok = await verifyBearerAuth(db, { deviceId: "000-000-000", token });
    expect(ok).toBe(false);
  });

  it("returns false on wrong token (and does NOT bump last_seen_at)", async () => {
    const before = db
      .prepare<[], { last_seen_at: number | null }>(
        "SELECT last_seen_at FROM devices WHERE id = '123-456-789'",
      )
      .get();
    expect(before?.last_seen_at).toBeNull();
    const ok = await verifyBearerAuth(db, {
      deviceId: "123-456-789",
      token: "0".repeat(64),
    });
    expect(ok).toBe(false);
    const after = db
      .prepare<[], { last_seen_at: number | null }>(
        "SELECT last_seen_at FROM devices WHERE id = '123-456-789'",
      )
      .get();
    expect(after?.last_seen_at).toBeNull();
  });
});

// UnattendedRegistry behaviour

describe("UnattendedRegistry", () => {
  function fakePeer(): { closed: { code: number; reason: string } | null; close: (c: number, r: string) => void } {
    let closed: { code: number; reason: string } | null = null;
    return {
      get closed() {
        return closed;
      },
      close(c: number, r: string) {
        closed = { code: c, reason: r };
      },
    };
  }

  it("registers a peer and reports it via has()", () => {
    const reg = new UnattendedRegistry();
    const peer = fakePeer() as unknown as WebSocket;
    reg.register("123-456-789", peer);
    expect(reg.has("123-456-789")).toBe(true);
    expect(reg.size()).toBe(1);
  });

  it("evicts the prior peer when a new one registers for the same device", () => {
    const reg = new UnattendedRegistry();
    const oldPeer = fakePeer();
    const newPeer = fakePeer();
    reg.register("123-456-789", oldPeer as unknown as WebSocket);
    reg.register("123-456-789", newPeer as unknown as WebSocket);
    expect(oldPeer.closed?.code).toBe(WS_CLOSE.SUPERSEDED);
    expect(newPeer.closed).toBeNull();
    expect(reg.size()).toBe(1);
  });

  it("evict() force-closes with 4401 and removes the entry", () => {
    const reg = new UnattendedRegistry();
    const peer = fakePeer();
    reg.register("123-456-789", peer as unknown as WebSocket);
    reg.evict("123-456-789");
    expect(peer.closed?.code).toBe(WS_CLOSE.AUTH_FAILED);
    expect(reg.has("123-456-789")).toBe(false);
  });

  it("evict() on an unknown device-id is a no-op", () => {
    const reg = new UnattendedRegistry();
    expect(() => reg.evict("000-000-000")).not.toThrow();
  });

  it("unregister(deviceId, peer) keeps the new peer when the old one's close fires late", () => {
    // Reproduces the race the conditional guard exists for: register
    // new → old's close handler fires AFTER → must not unregister
    // the new one.
    const reg = new UnattendedRegistry();
    const oldPeer = fakePeer();
    const newPeer = fakePeer();
    reg.register("123-456-789", oldPeer as unknown as WebSocket);
    reg.register("123-456-789", newPeer as unknown as WebSocket);
    reg.unregister("123-456-789", oldPeer as unknown as WebSocket);
    expect(reg.has("123-456-789")).toBe(true);
    expect(reg.size()).toBe(1);
  });
});

// End-to-end: WSS upgrade through real createServer

describe("/signal WSS upgrade with Bearer auth (gh #16)", () => {
  let app: FastifyInstance;
  let url: string;
  let baseUrl: string;
  let db: Db;
  const token = "feedface".repeat(8); // 64 hex chars

  beforeAll(async () => {
    // Use an injected DB so we can pre-seed a device row that
    // createServer's signaling handler will verify against.
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      "INSERT INTO accounts (email, password_hash, email_verified_at, created_at) VALUES (?, ?, ?, ?)",
    ).run("owner@example.com", "x", Date.now(), Date.now());
    const tokenHash = await hashPassword(token);
    db.prepare(
      `INSERT INTO devices (id, owner_account_id, alias, token_hash, auto_accept, created_at, last_seen_at)
       VALUES ('999-000-111', 1, 'TestDevice', ?, 1, ?, NULL)`,
    ).run(tokenHash, Date.now());

    process.env.REGISTER_RATE_LIMIT_MAX = "1000";
    // Sec H-1 cap is 10/min/IP by default — existing tests run >10
    // WSS connects from 127.0.0.1 across the suite, so raise it
    // here for everything except the dedicated rate-limit test
    // below (which builds its own server with a tight cap).
    process.env.BEARER_AUTH_RATE_LIMIT_MAX = "1000";
    app = await createServer({ port: 0, host: "127.0.0.1", db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    url = `ws://127.0.0.1:${addr.port}/signal`;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it("accepts a valid bearer and replies unattended-hello", async () => {
    const ws = new WebSocket(url, {
      headers: {
        origin: "http://127.0.0.1",
        authorization: `Bearer ${token}`,
        "x-auffi-device-id": "999-000-111",
      },
    });
    const msg = await new Promise<any>((resolve, reject) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString())));
      ws.once("error", reject);
    });
    expect(msg).toEqual({ type: "unattended-hello", deviceId: "999-000-111" });
    ws.close();
  });

  it("bumps last_seen_at on successful auth", async () => {
    db.prepare("UPDATE devices SET last_seen_at = NULL WHERE id = ?").run(
      "999-000-111",
    );
    const ws = new WebSocket(url, {
      headers: {
        origin: "http://127.0.0.1",
        authorization: `Bearer ${token}`,
        "x-auffi-device-id": "999-000-111",
      },
    });
    await new Promise((r) => ws.once("message", r));
    const row = db
      .prepare<[], { last_seen_at: number | null }>(
        "SELECT last_seen_at FROM devices WHERE id = '999-000-111'",
      )
      .get();
    expect(row?.last_seen_at).not.toBeNull();
    expect(row!.last_seen_at!).toBeGreaterThan(Date.now() - 5_000);
    ws.close();
  });

  it("closes with 4401 on wrong token", async () => {
    const ws = new WebSocket(url, {
      headers: {
        origin: "http://127.0.0.1",
        authorization: `Bearer ${"0".repeat(64)}`,
        "x-auffi-device-id": "999-000-111",
      },
    });
    const close = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    expect(close.code).toBe(WS_CLOSE.AUTH_FAILED);
  });

  it("closes with 4401 on unknown device-id", async () => {
    const ws = new WebSocket(url, {
      headers: {
        origin: "http://127.0.0.1",
        authorization: `Bearer ${token}`,
        "x-auffi-device-id": "000-000-000",
      },
    });
    const close = await new Promise<{ code: number }>((resolve) => {
      ws.once("close", (code) => resolve({ code }));
    });
    expect(close.code).toBe(WS_CLOSE.AUTH_FAILED);
  });

  it("closes with 4401 on malformed bearer (caller does NOT fall through to ad-hoc)", async () => {
    const ws = new WebSocket(url, {
      headers: {
        origin: "http://127.0.0.1",
        authorization: "Bearer too-short",
        "x-auffi-device-id": "999-000-111",
      },
    });
    const close = await new Promise<{ code: number }>((resolve) => {
      ws.once("close", (code) => resolve({ code }));
    });
    expect(close.code).toBe(WS_CLOSE.AUTH_FAILED);
  });

  it("ad-hoc (no bearer headers) flow still works", async () => {
    const ws = new WebSocket(url, { headers: { origin: "http://127.0.0.1" } });
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "register", role: "sharer" }));
    const msg = await new Promise<any>((resolve) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    expect(msg.type).toBe("code-assigned");
    expect(msg.code).toMatch(/^\d{3}-\d{3}-\d{3}$/);
    ws.close();
  });

  it("closes WSS with 4401 once bearer-auth attempts exceed the per-IP cap (Sec H-1)", async () => {
    // Spin up a dedicated server with a TIGHT bearer cap so we can
    // trip the gate without thousands of connections. The map is
    // per-server-instance; the shared test rig at the top of this
    // file uses BEARER_AUTH_RATE_LIMIT_MAX=1000.
    const tightDb = openDb(":memory:");
    applyMigrations(tightDb, defaultMigrationsDir());
    tightDb
      .prepare(
        "INSERT INTO accounts (email, password_hash, email_verified_at, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("owner2@example.com", "x", Date.now(), Date.now());
    const tightTokenHash = await hashPassword(token);
    tightDb
      .prepare(
        `INSERT INTO devices (id, owner_account_id, alias, token_hash, auto_accept, created_at)
         VALUES ('444-555-666', 1, 'Tight', ?, 1, ?)`,
      )
      .run(tightTokenHash, Date.now());

    process.env.BEARER_AUTH_RATE_LIMIT_MAX = "2";
    process.env.BEARER_AUTH_RATE_LIMIT_WINDOW_MS = "60000";
    const tight = await createServer({
      port: 0,
      host: "127.0.0.1",
      db: tightDb,
    });
    await tight.listen({ port: 0, host: "127.0.0.1" });
    const addr = tight.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    const tightUrl = `ws://127.0.0.1:${addr.port}/signal`;
    // Reset back so subsequent tests in this file aren't affected.
    process.env.BEARER_AUTH_RATE_LIMIT_MAX = "1000";

    function tryConnect(): Promise<{ code: number }> {
      return new Promise((resolve) => {
        const ws = new WebSocket(tightUrl, {
          headers: {
            origin: "http://127.0.0.1",
            authorization: `Bearer ${token}`,
            "x-auffi-device-id": "444-555-666",
          },
        });
        ws.once("message", () => {
          ws.once("close", (code) => resolve({ code }));
          ws.close();
        });
        ws.once("close", (code) => resolve({ code }));
      });
    }

    // Two attempts under the cap of 2: both authenticate cleanly.
    const r1 = await tryConnect();
    const r2 = await tryConnect();
    expect(r1.code).not.toBe(WS_CLOSE.AUTH_FAILED);
    expect(r2.code).not.toBe(WS_CLOSE.AUTH_FAILED);
    // Third: rate-limited → AUTH_FAILED close.
    const r3 = await tryConnect();
    expect(r3.code).toBe(WS_CLOSE.AUTH_FAILED);

    await tight.close();
    tightDb.close();
  });

  it("DELETE /api/devices/:id force-closes a live WSS with 4401", async () => {
    // Seed a second device + matching session so we can authenticate
    // the DELETE call with a real owner cookie.
    const devToken = "abcdef00".repeat(8);
    const devHash = await hashPassword(devToken);
    db.prepare(
      `INSERT INTO devices (id, owner_account_id, alias, token_hash, auto_accept, created_at)
       VALUES ('888-777-666', 1, 'Evictee', ?, 1, ?)`,
    ).run(devHash, Date.now());
    // Pretend to be the owner via /api/auth/login. Need a real
    // password — set one.
    const { hashPassword: hp } = await import("../src/auth/argon.js");
    const pwHash = await hp("owner-account-pw");
    db.prepare("UPDATE accounts SET password_hash = ? WHERE id = 1").run(pwHash);
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify({ email: "owner@example.com", password: "owner-account-pw" }),
    });
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get("set-cookie")!;
    const cookieVal = setCookie.match(/__Host-auffi_session=([^;]+)/)![1];

    // Open the unattended WSS for the second device.
    const ws = new WebSocket(url, {
      headers: {
        origin: "http://127.0.0.1",
        authorization: `Bearer ${devToken}`,
        "x-auffi-device-id": "888-777-666",
      },
    });
    await new Promise((r) => ws.once("message", r)); // unattended-hello

    // Revoke from the dashboard.
    const delRes = await fetch(`${baseUrl}/api/devices/888-777-666`, {
      method: "DELETE",
      headers: {
        cookie: `__Host-auffi_session=${cookieVal}`,
        origin: "http://127.0.0.1",
      },
    });
    expect(delRes.status).toBe(204);

    // The WSS must close with 4401 within a small window.
    const close = await new Promise<{ code: number }>((resolve) => {
      ws.once("close", (code) => resolve({ code }));
    });
    expect(close.code).toBe(WS_CLOSE.AUTH_FAILED);
  });
});
