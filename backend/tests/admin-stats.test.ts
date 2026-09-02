import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { decorateRequireSession } from "../src/auth/middleware.js";
import { decorateRequireAdmin } from "../src/admin/middleware.js";
import { registerAuthRoutes } from "../src/auth/handlers.js";
import { registerAdminStatsRoutes, _clearStatsCache } from "../src/admin/stats.js";
import { captureTransport } from "../src/email/transport.js";
import { buildAuthMailer } from "../src/email/mailer.js";
import { recordCodeCreated } from "../src/tracking/code_events.js";

async function build(): Promise<{
  app: FastifyInstance;
  db: Db;
  adminCookie: () => Promise<string>;
  plainCookie: () => Promise<string>;
}> {
  _clearStatsCache();
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const transport = captureTransport();
  const mailer = buildAuthMailer({ dashboardUrl: "https://t/", transport });
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  decorateRequireSession(app, db);
  decorateRequireAdmin(app, db);
  registerAuthRoutes(app, { db, mailer });
  registerAdminStatsRoutes(app, db);
  await app.ready();

  async function loginCookie(email: string, password: string): Promise<string> {
    await app.inject({ method: "POST", url: "/api/auth/signup", payload: { email, password } });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password },
    });
    const sc = login.headers["set-cookie"] as string | string[] | undefined;
    const raw = Array.isArray(sc) ? sc[0] : sc!;
    return raw.match(/^__Host-auffi_session=([^;]+)/)![1];
  }

  async function adminCookie(): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "admin@example.com", password: "admin-account-pw" },
    });
    db.prepare("UPDATE accounts SET admin = 1 WHERE email = ?").run("admin@example.com");
    return loginCookie("admin@example.com", "admin-account-pw");
  }

  const plainCookie = (): Promise<string> => loginCookie("plain@example.com", "plain-account-pw");

  return { app, db, adminCookie, plainCookie };
}

function seedData(db: Db): void {
  const now = Date.now();
  // 3 active accounts (1 admin already exists). Seed 2 more + 1 suspended.
  db.prepare(
    `INSERT INTO accounts (email, password_hash, email_verified_at, created_at)
     VALUES ('verified@example.com', 'dummy', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO accounts (email, password_hash, created_at, suspended_at)
     VALUES ('suspended@example.com', 'dummy', ?, ?)`,
  ).run(now, now);

  // A couple of devices
  db.prepare(
    `INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at, last_seen_at)
     VALUES ('111-111-111', 1, 'D1', 'dummy', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at, last_seen_at)
     VALUES ('222-222-222', 1, 'D2', 'dummy', ?, NULL)`,
  ).run(now);

  // Today's connection log. Seed-Zeit muss BEIDES erfüllen: >= today_start
  // (00:00 UTC) UND <= now. "now - 10s" passt immer, außer in der ersten
  // Sekunde nach UTC-Mitternacht — vernachlässigbar. Vorherige Version
  // nutzte 08:00 UTC und failed wenn der Test vor 08:00 UTC lief.
  const seedTime = now - 10_000;
  db.prepare(
    `INSERT INTO connection_log (device_id, started_at, viewer_ip_prefix, connection_type, bytes_relayed)
     VALUES ('111-111-111', ?, '84.xxx', 'p2p', 0)`,
  ).run(seedTime);
  db.prepare(
    `INSERT INTO connection_log (device_id, started_at, viewer_ip_prefix, connection_type, bytes_relayed)
     VALUES ('111-111-111', ?, '84.xxx', 'relay', 1000)`,
  ).run(seedTime + 1000);
}

describe("GET /api/admin/stats", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("returns the full JSON shape with zeros on an empty DB", async () => {
    const c = await h.adminCookie();
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/stats",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("users");
    expect(body).toHaveProperty("devices");
    expect(body).toHaveProperty("connections");
    expect(body).toHaveProperty("system");
    expect(body.users.total).toBe(1); // the admin itself
    expect(body.devices.total).toBe(0);
    expect(body.connections.today).toBe(0);
    expect(body.system.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it("reflects seeded counts across users/devices/connections", async () => {
    const c = await h.adminCookie();
    seedData(h.db);
    _clearStatsCache();

    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/stats",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    const body = res.json();
    expect(body.users.total).toBe(3); // admin + verified + suspended
    expect(body.users.verified).toBe(1); // 'verified@…'
    expect(body.users.suspended).toBe(1);
    expect(body.users.new_24h).toBe(3);
    expect(body.devices.total).toBe(2);
    expect(body.devices.online_now).toBe(1); // D1 has last_seen_at=now
    expect(body.connections.today).toBe(2);
    expect(body.connections.p2p_today).toBe(1);
    expect(body.connections.relay_today).toBe(1);
    expect(body.connections.relay_bytes_today).toBe(1000);
  });

  it("caches results for 30 s — second call inside window returns identical object", async () => {
    const c = await h.adminCookie();
    const first = (
      await h.app.inject({
        method: "GET",
        url: "/api/admin/stats",
        headers: { cookie: `__Host-auffi_session=${c}` },
      })
    ).json();

    // Mutate the DB; if not cached, the response would change.
    h.db
      .prepare(
        `INSERT INTO accounts (email, password_hash, created_at)
         VALUES ('post@example.com', 'dummy', ?)`,
      )
      .run(Date.now());

    const second = (
      await h.app.inject({
        method: "GET",
        url: "/api/admin/stats",
        headers: { cookie: `__Host-auffi_session=${c}` },
      })
    ).json();
    expect(second.users.total).toBe(first.users.total);
  });

  it("returns 403 for non-admin", async () => {
    const cookie = await h.plainCookie();
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/stats",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 for anonymous", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/admin/stats" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/admin/stats/codes", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("returns 401 for anonymous", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/admin/stats/codes" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for non-admin", async () => {
    const cookie = await h.plainCookie();
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/stats/codes",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns all-zero windows and no buckets on an empty DB", async () => {
    const c = await h.adminCookie();
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/stats/codes",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 0, last24h: 0, last7d: 0, last30d: 0, perDay: [] });
  });

  it("reflects seeded code_events per window, uncached", async () => {
    const c = await h.adminCookie();
    const now = Date.now();
    // One recent mint and one outside every window but `total`. Offsets
    // rather than wall-clock dates so the assertion is UTC-midnight-safe.
    recordCodeCreated(h.db, now - 10_000);
    recordCodeCreated(h.db, now - 40 * 24 * 3600 * 1000);

    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/stats/codes",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.last24h).toBe(1);
    expect(body.last7d).toBe(1);
    expect(body.last30d).toBe(1);
    expect(body.perDay).toHaveLength(1);
    expect(body.perDay[0].count).toBe(1);

    // Unlike /api/admin/stats this route is not cached: a new mint shows up
    // on the very next call.
    recordCodeCreated(h.db, now - 5_000);
    const again = await h.app.inject({
      method: "GET",
      url: "/api/admin/stats/codes",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(again.json().total).toBe(3);
  });
});
