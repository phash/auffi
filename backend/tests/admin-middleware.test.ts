import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { decorateRequireSession } from "../src/auth/middleware.js";
import { decorateRequireAdmin, writeAudit } from "../src/admin/middleware.js";
import { registerAuthRoutes } from "../src/auth/handlers.js";
import { captureTransport } from "../src/email/transport.js";
import { buildAuthMailer } from "../src/email/mailer.js";

async function build(): Promise<{
  app: FastifyInstance;
  db: Db;
  adminCookie: () => Promise<string>;
  userCookie: () => Promise<string>;
}> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const transport = captureTransport();
  const mailer = buildAuthMailer({ dashboardUrl: "https://t/", transport });
  // Address-range trust matches production (server.ts): the immediate peer
  // (loopback in inject/tests, the docker-bridge Caddy in prod) is trusted,
  // public XFF entries terminate the proxy-addr walk.
  // Without it req.ip is always 127.0.0.1 and adminIpPrefix is meaningless.
  const app = Fastify({ trustProxy: "loopback, linklocal, uniquelocal" });
  await app.register(rateLimit, { global: false });
  decorateRequireSession(app, db);
  decorateRequireAdmin(app, db);
  registerAuthRoutes(app, { db, mailer });

  // Toy admin-only route that records an audit row.
  app.post(
    "/api/admin/ping",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async (req, reply) => {
      writeAudit(db, req, "admin.ping", "account", String(req.account!.id), null, { ts: 1 });
      return reply.send({ ok: true });
    },
  );

  await app.ready();

  async function loginAs(email: string, pw: string, admin: boolean): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: pw },
    });
    if (admin) db.prepare("UPDATE accounts SET admin = 1 WHERE email = ?").run(email);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: pw },
    });
    const sc = login.headers["set-cookie"] as string | string[] | undefined;
    const raw = Array.isArray(sc) ? sc[0] : sc!;
    return raw.match(/^__Host-auffi_session=([^;]+)/)![1];
  }

  return {
    app,
    db,
    adminCookie: () => loginAs("admin@example.com", "admin-account-pw", true),
    userCookie: () => loginAs("user@example.com", "user-account-pw", false),
  };
}

describe("requireAdmin middleware", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("admin session → 200", async () => {
    const c = await h.adminCookie();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/admin/ping",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("non-admin session → 403 admin-required (NOT 404)", async () => {
    const c = await h.userCookie();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/admin/ping",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("admin-required");
  });

  it("anonymous → 401 no-session", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/admin/ping" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("no-session");
  });

  it("returns 401 when the admin's account was deleted between requests", async () => {
    const c = await h.adminCookie();
    h.db.prepare("DELETE FROM accounts WHERE email = ?").run("admin@example.com");
    const res = await h.app.inject({
      method: "POST",
      url: "/api/admin/ping",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    // requireSession runs first → 401 (account gone, session resolves to no account)
    expect(res.statusCode).toBe(401);
  });

  it("writes an audit_log row with the admin id and an IP-prefix", async () => {
    const c = await h.adminCookie();
    // Single-entry XFF as set by Caddy in production (one trusted proxy hop).
    // the trusted loopback peer resolves req.ip to this value.
    await h.app.inject({
      method: "POST",
      url: "/api/admin/ping",
      headers: { cookie: `__Host-auffi_session=${c}`, "x-forwarded-for": "84.137.42.7" },
    });
    const row = h.db
      .prepare<
        [],
        {
          admin_id: number;
          action: string;
          target_type: string;
          target_id: string;
          after_json: string | null;
          viewer_ip_prefix: string;
        }
      >("SELECT admin_id, action, target_type, target_id, after_json, viewer_ip_prefix FROM audit_log ORDER BY id DESC LIMIT 1")
      .get();
    expect(row?.admin_id).toBe(1);
    expect(row?.action).toBe("admin.ping");
    expect(row?.target_type).toBe("account");
    expect(row?.target_id).toBe("1");
    expect(row?.after_json).toBe('{"ts":1}');
    expect(row?.viewer_ip_prefix).toBe("84.xxx");
  });
});

describe("writeAudit IP-prefix shaping", () => {
  it("redacts to the first octet for IPv4 — matches connection_log's viewer_ip_prefix format", async () => {
    const h = await build();
    const c = await h.adminCookie();
    // Single-entry XFF: trusted-peer walk sets req.ip = 203.0.113.42.
    await h.app.inject({
      method: "POST",
      url: "/api/admin/ping",
      headers: { cookie: `__Host-auffi_session=${c}`, "x-forwarded-for": "203.0.113.42" },
    });
    const row = h.db
      .prepare<[], { viewer_ip_prefix: string }>(
        "SELECT viewer_ip_prefix FROM audit_log ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(row?.viewer_ip_prefix).toBe("203.xxx");
    await h.app.close();
    h.db.close();
  });

  it("redacts to the first two hextets for IPv6", async () => {
    const h = await build();
    const c = await h.adminCookie();
    // Single-entry XFF: trusted-peer walk sets req.ip = the IPv6 address.
    await h.app.inject({
      method: "POST",
      url: "/api/admin/ping",
      headers: {
        cookie: `__Host-auffi_session=${c}`,
        "x-forwarded-for": "2001:db8:abcd:1234:5678:9abc:def0:1234",
      },
    });
    const row = h.db
      .prepare<[], { viewer_ip_prefix: string }>(
        "SELECT viewer_ip_prefix FROM audit_log ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(row?.viewer_ip_prefix).toBe("2001:db8:xxx");
    await h.app.close();
    h.db.close();
  });

  it("normalises an IPv4-mapped IPv6 address instead of collapsing it to a constant", async () => {
    // Without stripIpv4Mapped, ::ffff:84.123.45.6 takes the IPv6 branch
    // and EVERY such client redacts to the same useless '::ffff::xxx'.
    const h = await build();
    const c = await h.adminCookie();
    await h.app.inject({
      method: "POST",
      url: "/api/admin/ping",
      headers: {
        cookie: `__Host-auffi_session=${c}`,
        "x-forwarded-for": "::ffff:84.123.45.6",
      },
    });
    const row = h.db
      .prepare<[], { viewer_ip_prefix: string }>(
        "SELECT viewer_ip_prefix FROM audit_log ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(row?.viewer_ip_prefix).toBe("84.xxx");
    await h.app.close();
    h.db.close();
  });

  it("uses req.ip (not raw x-forwarded-for) — attacker-prepended header cannot spoof audit log", async () => {
    // An attacker sending X-Forwarded-For: 1.2.3.4, <real-client-ip>
    // cannot control the audit-log IP prefix. With the address-range trust, Fastify
    // resolves req.ip to the rightmost entry (the proxy-validated real IP),
    // ignoring attacker-injected leftmost entries.
    const h = await build();
    const c = await h.adminCookie();
    // The attacker prepends "1.2.3.4," hoping to appear in the audit log
    // as that address. The walk stops at 5.6.7.8 (rightmost non-private).
    await h.app.inject({
      method: "POST",
      url: "/api/admin/ping",
      headers: {
        cookie: `__Host-auffi_session=${c}`,
        "x-forwarded-for": "1.2.3.4, 5.6.7.8",
      },
    });
    const row = h.db
      .prepare<[], { viewer_ip_prefix: string }>(
        "SELECT viewer_ip_prefix FROM audit_log ORDER BY id DESC LIMIT 1",
      )
      .get();
    // Must NOT be the attacker-controlled leftmost entry.
    expect(row?.viewer_ip_prefix).not.toBe("1.xxx");
    expect(row?.viewer_ip_prefix).toBe("5.xxx");
    await h.app.close();
    h.db.close();
  });
});
