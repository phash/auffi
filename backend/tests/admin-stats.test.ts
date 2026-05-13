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

async function build(): Promise<{
  app: FastifyInstance;
  db: Db;
  adminCookie: () => Promise<string>;
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

  async function adminCookie(): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "admin@example.com", password: "admin-account-pw" },
    });
    db.prepare("UPDATE accounts SET admin = 1 WHERE email = ?").run("admin@example.com");
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "admin-account-pw" },
    });
    const sc = login.headers["set-cookie"] as string | string[] | undefined;
    const raw = Array.isArray(sc) ? sc[0] : sc!;
    return raw.match(/^__Host-auffi_session=([^;]+)/)![1];
  }

  return { app, db, adminCookie };
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

  // Today's connection log
  const todayStart = new Date(now).setUTCHours(8, 0, 0, 0); // safely "today"
  db.prepare(
    `INSERT INTO connection_log (device_id, started_at, viewer_ip_prefix, connection_type, bytes_relayed)
     VALUES ('111-111-111', ?, '84.xxx', 'p2p', 0)`,
  ).run(todayStart);
  db.prepare(
    `INSERT INTO connection_log (device_id, started_at, viewer_ip_prefix, connection_type, bytes_relayed)
     VALUES ('111-111-111', ?, '84.xxx', 'relay', 1000)`,
  ).run(todayStart + 1000);
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
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "plain@example.com", password: "plain-account-pw" },
    });
    const login = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "plain@example.com", password: "plain-account-pw" },
    });
    const sc = login.headers["set-cookie"] as string | string[] | undefined;
    const cookie = (Array.isArray(sc) ? sc[0] : sc!).match(/^__Host-auffi_session=([^;]+)/)![1];
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
