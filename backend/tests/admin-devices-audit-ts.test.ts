import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { decorateRequireSession } from "../src/auth/middleware.js";
import { decorateRequireAdmin } from "../src/admin/middleware.js";
import { registerAuthRoutes } from "../src/auth/handlers.js";
import { registerAdminDevicesRoutes } from "../src/admin/devices.js";
import { registerAdminTimeseriesRoutes } from "../src/admin/timeseries.js";
import { registerAdminAuditRoutes } from "../src/admin/audit.js";
import { captureTransport } from "../src/email/transport.js";
import { buildAuthMailer } from "../src/email/mailer.js";

async function build(): Promise<{
  app: FastifyInstance;
  db: Db;
  adminCookie: () => Promise<string>;
}> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const transport = captureTransport();
  const mailer = buildAuthMailer({ dashboardUrl: "https://t/", transport });
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  decorateRequireSession(app, db);
  decorateRequireAdmin(app, db);
  registerAuthRoutes(app, { db, mailer });
  registerAdminDevicesRoutes(app, db);
  registerAdminTimeseriesRoutes(app, db);
  registerAdminAuditRoutes(app, db);
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
    return raw.match(/^auffi_session=([^;]+)/)![1];
  }
  return { app, db, adminCookie };
}

function seedDevices(db: Db): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO accounts (email, password_hash, created_at) VALUES ('owner@example.com', 'd', ?)`,
  ).run(now);
  const ownerId = db.prepare("SELECT id FROM accounts WHERE email = ?").get("owner@example.com") as {
    id: number;
  };

  db.prepare(
    `INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at, last_seen_at)
     VALUES ('111-111-111', ?, 'Online', 'd', ?, ?)`,
  ).run(ownerId.id, now, now);
  db.prepare(
    `INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at, last_seen_at)
     VALUES ('222-222-222', ?, 'Offline', 'd', ?, NULL)`,
  ).run(ownerId.id, now);
  db.prepare(
    `INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at, last_seen_at)
     VALUES ('333-333-333', ?, 'Stale', 'd', ?, ?)`,
  ).run(ownerId.id, now, now - 10 * 24 * 60 * 60 * 1000);
}

describe("GET /api/admin/devices", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.adminCookie();
    seedDevices(h.db);
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("lists all devices with owner email", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/devices",
      headers: { cookie: `auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(3);
    expect(body.items[0].owner_email).toBe("owner@example.com");
  });

  it("filters by status=online", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/devices?status=online",
      headers: { cookie: `auffi_session=${cookie}` },
    });
    expect(res.json().items.map((x: { alias: string }) => x.alias)).toEqual(["Online"]);
  });

  it("filters by status=stale (last_seen older than 7 days)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/devices?status=stale",
      headers: { cookie: `auffi_session=${cookie}` },
    });
    expect(res.json().items.map((x: { alias: string }) => x.alias)).toEqual(["Stale"]);
  });

  it("searches by alias OR id substring", async () => {
    const byAlias = await h.app.inject({
      method: "GET",
      url: "/api/admin/devices?q=Stale",
      headers: { cookie: `auffi_session=${cookie}` },
    });
    expect(byAlias.json().items).toHaveLength(1);
    const byId = await h.app.inject({
      method: "GET",
      url: "/api/admin/devices?q=222",
      headers: { cookie: `auffi_session=${cookie}` },
    });
    expect(byId.json().items[0].id).toBe("222-222-222");
  });
});

describe("DELETE + reset-rate-limit", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.adminCookie();
    seedDevices(h.db);
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("DELETE removes device + clears rate buckets + writes audit row", async () => {
    h.db
      .prepare(
        `INSERT INTO rate_limit_buckets (key, fail_count) VALUES ('device:111-111-111:pwfail', 5)`,
      )
      .run();

    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/admin/devices/111-111-111",
      headers: { cookie: `auffi_session=${cookie}` },
      payload: { reason: "abuse" },
    });
    expect(res.statusCode).toBe(204);

    const left = h.db.prepare("SELECT COUNT(*) AS c FROM devices WHERE id = ?").get("111-111-111") as {
      c: number;
    };
    expect(left.c).toBe(0);
    const buckets = h.db.prepare("SELECT COUNT(*) AS c FROM rate_limit_buckets").get() as {
      c: number;
    };
    expect(buckets.c).toBe(0);
    const audit = h.db
      .prepare<[], { action: string }>(
        "SELECT action FROM audit_log WHERE target_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get("111-111-111");
    expect(audit?.action).toBe("device.delete");
  });

  it("DELETE rejects missing reason with 400", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/admin/devices/111-111-111",
      headers: { cookie: `auffi_session=${cookie}` },
      payload: { reason: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reset-rate-limit clears buckets and returns count", async () => {
    h.db
      .prepare(
        `INSERT INTO rate_limit_buckets (key, fail_count) VALUES ('device:111-111-111:pwfail', 5)`,
      )
      .run();
    h.db
      .prepare(
        `INSERT INTO rate_limit_buckets (key, fail_count) VALUES ('device:111-111-111:connect', 2)`,
      )
      .run();

    const res = await h.app.inject({
      method: "POST",
      url: "/api/admin/devices/111-111-111/reset-rate-limit",
      headers: { cookie: `auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cleared).toBe(2);
  });
});

describe("GET /api/admin/stats/timeseries", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.adminCookie();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("returns three series for the requested range, with empty days zero-filled", async () => {
    // Seed connection_log with 2 rows on a known UTC day
    const day = new Date("2026-05-10T12:00:00.000Z");
    h.db.prepare(
      `INSERT INTO accounts (email, password_hash, created_at) VALUES ('o@example.com', 'd', ?)`,
    ).run(day.getTime());
    h.db.prepare(
      `INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at)
       VALUES ('444-444-444', 2, 'X', 'd', ?)`,
    ).run(day.getTime());
    h.db.prepare(
      `INSERT INTO connection_log (device_id, started_at, viewer_ip_prefix, connection_type, bytes_relayed)
       VALUES ('444-444-444', ?, '84.xxx', 'p2p', 0),
              ('444-444-444', ?, '84.xxx', 'relay', 5000)`,
    ).run(day.getTime(), day.getTime() + 1000);

    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/stats/timeseries?from=2026-05-09&to=2026-05-11",
      headers: { cookie: `auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 3 days expected, no gaps
    expect(body.signups).toHaveLength(3);
    expect(body.connections).toHaveLength(3);
    expect(body.relay_bytes).toHaveLength(3);

    const day2 = body.connections.find((x: { date: string }) => x.date === "2026-05-10");
    expect(day2.p2p).toBe(1);
    expect(day2.relay).toBe(1);
    const bytesDay = body.relay_bytes.find((x: { date: string }) => x.date === "2026-05-10");
    expect(bytesDay.bytes).toBe(5000);

    // Empty days zero
    const empty = body.connections.find((x: { date: string }) => x.date === "2026-05-09");
    expect(empty.p2p).toBe(0);
  });

  it("rejects malformed date with 400", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/stats/timeseries?from=not-a-date&to=2026-05-10",
      headers: { cookie: `auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects ranges over 90 days with 400", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/stats/timeseries?from=2026-01-01&to=2026-06-01",
      headers: { cookie: `auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/admin/audit-log", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.adminCookie();
    // Plant some audit rows
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      h.db.prepare(
        `INSERT INTO audit_log (admin_id, action, target_type, target_id, created_at, viewer_ip_prefix)
         VALUES (1, ?, 'account', ?, ?, '84.xxx')`,
      ).run(i % 2 === 0 ? "user.suspend" : "user.unsuspend", String(100 + i), now - i * 1000);
    }
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("returns rows DESC by created_at with admin_email", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/audit-log",
      headers: { cookie: `auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(5);
    expect(body.items[0].admin_email).toBe("admin@example.com");
    for (let i = 1; i < body.items.length; i++) {
      expect(body.items[i].created_at).toBeLessThanOrEqual(body.items[i - 1].created_at);
    }
  });

  it("filters compose: action AND target_type", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/audit-log?action=user.suspend&target_type=account",
      headers: { cookie: `auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.action).toBe("user.suspend");
      expect(item.target_type).toBe("account");
    }
  });

  it("supports cursor pagination", async () => {
    const first = await h.app.inject({
      method: "GET",
      url: "/api/admin/audit-log?limit=2",
      headers: { cookie: `auffi_session=${cookie}` },
    });
    const a = first.json();
    expect(a.items).toHaveLength(2);
    expect(a.next_cursor).toBeTruthy();
    const second = await h.app.inject({
      method: "GET",
      url: `/api/admin/audit-log?limit=2&cursor=${a.next_cursor}`,
      headers: { cookie: `auffi_session=${cookie}` },
    });
    const b = second.json();
    expect(b.items[0].id).not.toBe(a.items[0].id);
  });

  it("there is no PATCH/PUT/DELETE on the audit-log resource", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await h.app.inject({
        method,
        url: "/api/admin/audit-log",
        headers: { cookie: `auffi_session=${cookie}` },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
