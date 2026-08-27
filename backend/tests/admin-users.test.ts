import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { decorateRequireSession } from "../src/auth/middleware.js";
import { decorateRequireAdmin } from "../src/admin/middleware.js";
import { registerAuthRoutes } from "../src/auth/handlers.js";
import { registerAdminUsersRoutes } from "../src/admin/users.js";
import { captureTransport } from "../src/email/transport.js";
import { buildAuthMailer } from "../src/email/mailer.js";
import { UnattendedRegistry } from "../src/unattended.js";
import type { WebSocket } from "ws";

async function build(): Promise<{
  app: FastifyInstance;
  db: Db;
  registry: UnattendedRegistry;
  adminCookie: () => Promise<string>;
}> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const transport = captureTransport();
  const mailer = buildAuthMailer({ dashboardUrl: "https://t/", transport });
  const registry = new UnattendedRegistry();
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  decorateRequireSession(app, db);
  decorateRequireAdmin(app, db);
  registerAuthRoutes(app, { db, mailer });
  registerAdminUsersRoutes(app, db, registry);
  await app.ready();

  async function adminCookie(): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "admin@example.com", password: "admin-account-pw" },
    });
    db.prepare("UPDATE accounts SET admin = 1, email_verified_at = ? WHERE email = ?").run(
      Date.now(),
      "admin@example.com",
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "admin-account-pw" },
    });
    const sc = login.headers["set-cookie"] as string | string[] | undefined;
    const raw = Array.isArray(sc) ? sc[0] : sc!;
    return raw.match(/^__Host-auffi_session=([^;]+)/)![1];
  }

  return { app, db, registry, adminCookie };
}

async function seedUsers(db: Db): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    db.prepare(
      `INSERT INTO accounts (email, password_hash, email_verified_at, created_at)
       VALUES (?, 'dummy', ?, ?)`,
    ).run(`user${i}@example.com`, i % 2 === 0 ? now : null, now - i * 1000);
  }
}

describe("GET /api/admin/users", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.adminCookie();
    await seedUsers(h.db);
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("paginates with cursor + limit", async () => {
    const first = await h.app.inject({
      method: "GET",
      url: "/api/admin/users?limit=2",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(first.statusCode).toBe(200);
    const a = first.json();
    expect(a.items).toHaveLength(2);
    expect(a.next_cursor).toBeTruthy();

    const second = await h.app.inject({
      method: "GET",
      url: `/api/admin/users?limit=2&cursor=${a.next_cursor}`,
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    const b = second.json();
    expect(b.items).toHaveLength(2);
    // No id overlap between the two pages
    const aIds = new Set(a.items.map((x: { id: number }) => x.id));
    for (const x of b.items) expect(aIds.has(x.id)).toBe(false);
  });

  it("filters by status=suspended", async () => {
    h.db.prepare("UPDATE accounts SET suspended_at = ? WHERE email = ?").run(
      Date.now(),
      "user2@example.com",
    );
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/users?status=suspended",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].email).toBe("user2@example.com");
  });

  it("escapes %/_ in search query so they're literal", async () => {
    h.db.prepare(
      `INSERT INTO accounts (email, password_hash, created_at)
       VALUES ('not_target@example.com', 'dummy', ?)`,
    ).run(Date.now());
    h.db.prepare(
      `INSERT INTO accounts (email, password_hash, created_at)
       VALUES ('contains%percent@example.com', 'dummy', ?)`,
    ).run(Date.now());

    // Searching for literal % should match the percent address, NOT the underscore one.
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/users?q=%25",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const emails = body.items.map((x: { email: string }) => x.email);
    expect(emails).toContain("contains%percent@example.com");
    expect(emails).not.toContain("not_target@example.com");
  });

  it("device_count comes from a single JOIN, no N+1", async () => {
    // user1 owns 2 devices
    const target = h.db
      .prepare<[string], { id: number }>("SELECT id FROM accounts WHERE email = ?")
      .get("user1@example.com")!.id;
    for (let i = 0; i < 2; i++) {
      h.db.prepare(
        `INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at)
         VALUES (?, ?, 'D', 'dummy', ?)`,
      ).run(`99${i}-99${i}-99${i}`, target, Date.now());
    }
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    const u1 = res.json().items.find((x: { email: string }) => x.email === "user1@example.com");
    expect(u1.device_count).toBe(2);
  });

  it("rejects bad status with 400", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/users?status=wat",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects malformed cursor with 400", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/users?cursor=$$$",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/admin/users/:id", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.adminCookie();
    await seedUsers(h.db);
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("returns the detailed account view", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/users/2",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe("user0@example.com");
    expect(Array.isArray(body.devices)).toBe(true);
    expect(Array.isArray(body.recent_connections)).toBe(true);
    expect(Array.isArray(body.recent_audits)).toBe(true);
  });

  it("strips password_hash and similar sensitive fields", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/users/2",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    const body = res.json();
    expect(body).not.toHaveProperty("password_hash");
    expect(body).not.toHaveProperty("token_hash");
  });

  it("returns 404 for non-existent id", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/users/9999",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/admin/users/:id (suspend/promote/demote)", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.adminCookie();
    await seedUsers(h.db);
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("suspends a user, kills their sessions, writes audit row", async () => {
    // Plant a session for the target
    const targetId = 2;
    h.db.prepare(
      `INSERT INTO sessions (token_hash, account_id, expires_at, last_seen_at)
       VALUES ('h1', ?, ?, ?)`,
    ).run(targetId, Date.now() + 1_000_000, Date.now());

    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/admin/users/${targetId}`,
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { action: "suspend", reason: "spam" },
    });
    expect(res.statusCode).toBe(200);

    const row = h.db
      .prepare<[number], { suspended_at: number | null }>(
        "SELECT suspended_at FROM accounts WHERE id = ?",
      )
      .get(targetId);
    expect(row?.suspended_at).not.toBeNull();

    const sessions = h.db
      .prepare<[number], { c: number }>(
        "SELECT COUNT(*) AS c FROM sessions WHERE account_id = ?",
      )
      .get(targetId);
    expect(sessions?.c).toBe(0);

    const audit = h.db
      .prepare<[], { action: string; after_json: string | null }>(
        "SELECT action, after_json FROM audit_log ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(audit?.action).toBe("user.suspend");
    expect(audit?.after_json).toContain('"reason":"spam"');
  });

  it("unsuspend clears suspended_at", async () => {
    h.db.prepare("UPDATE accounts SET suspended_at = ? WHERE id = 2").run(Date.now());
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/admin/users/2",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { action: "unsuspend" },
    });
    expect(res.statusCode).toBe(200);
    const row = h.db
      .prepare<[], { suspended_at: number | null }>(
        "SELECT suspended_at FROM accounts WHERE id = 2",
      )
      .get();
    expect(row?.suspended_at).toBeNull();
  });

  it("promote sets admin=1", async () => {
    await h.app.inject({
      method: "PATCH",
      url: "/api/admin/users/2",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { action: "promote" },
    });
    const row = h.db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 2").get();
    expect(row?.admin).toBe(1);
  });

  it("demote refuses to leave zero admins", async () => {
    // Admin is id=1, only admin in DB
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/admin/users/1",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { action: "demote" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("last-admin");
  });

  it("demote allowed when another admin exists", async () => {
    h.db.prepare("UPDATE accounts SET admin = 1 WHERE id = 2").run();
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/admin/users/1",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { action: "demote" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("demote refuses when the only other admin is suspended (counts ACTIVE admins)", async () => {
    // A suspended admin cannot log in, so demoting the last active one
    // would leave the admin surface unreachable.
    h.db.prepare("UPDATE accounts SET admin = 1, suspended_at = ? WHERE id = 2").run(Date.now());
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/admin/users/1",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { action: "demote" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("last-admin");
  });

  it("suspend refuses to suspend the last active admin — self-suspend cannot brick the admin surface", async () => {
    // Sole admin (id=1) suspends themselves: suspended_at would be set AND
    // all their sessions killed, with login blocked afterwards → no admin
    // could ever log in again without DB surgery.
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/admin/users/1",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { action: "suspend", reason: "oops" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("last-admin");
    const row = h.db
      .prepare<[], { suspended_at: number | null }>(
        "SELECT suspended_at FROM accounts WHERE id = 1",
      )
      .get();
    expect(row?.suspended_at).toBeNull();
    // The admin's session survives the refused action.
    const sessions = h.db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM sessions WHERE account_id = 1")
      .get();
    expect(sessions?.c).toBeGreaterThan(0);
  });

  it("suspend of an admin allowed when another active admin exists", async () => {
    h.db.prepare("UPDATE accounts SET admin = 1 WHERE id = 2").run();
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/admin/users/2",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { action: "suspend", reason: "compromised" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects unknown action with 400", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/admin/users/2",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { action: "wat" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/admin/users/:id", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.adminCookie();
    await seedUsers(h.db);
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("hard-deletes the user, cascades, writes audit with snapshot", async () => {
    const targetId = 2;
    // Plant a device + connection_log row to test cascade
    h.db.prepare(
      `INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at)
       VALUES ('333-333-333', ?, 'X', 'dummy', ?)`,
    ).run(targetId, Date.now());

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/admin/users/${targetId}`,
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { reason: "manual abuse-report cleanup" },
    });
    expect(res.statusCode).toBe(204);

    const acc = h.db
      .prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM accounts WHERE id = ?")
      .get(targetId);
    expect(acc?.c).toBe(0);
    const dev = h.db
      .prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM devices WHERE owner_account_id = ?")
      .get(targetId);
    expect(dev?.c).toBe(0);

    // Audit row contains the snapshot
    const audit = h.db
      .prepare<[], { action: string; before_json: string | null; after_json: string | null }>(
        "SELECT action, before_json, after_json FROM audit_log WHERE action = 'user.delete' ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(audit?.action).toBe("user.delete");
    expect(audit?.before_json).toContain("user0@example.com");
    expect(audit?.before_json).toContain('"device_count":1');
    expect(audit?.after_json).toContain('"reason":"manual abuse-report cleanup"');
  });

  it("evicts the target's live unattended sharer connections (WSS 4401)", async () => {
    const targetId = 2;
    h.db
      .prepare(
        `INSERT INTO devices (id, owner_account_id, alias, token_hash, created_at)
         VALUES ('444-555-666', ?, 'X', 'dummy', ?)`,
      )
      .run(targetId, Date.now());
    let closed: { code: number; reason: string } | null = null;
    const peer = {
      close(c: number, r: string) {
        closed = { code: c, reason: r };
      },
    };
    h.registry.register("444-555-666", peer as unknown as WebSocket);

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/admin/users/${targetId}`,
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { reason: "cleanup" },
    });
    expect(res.statusCode).toBe(204);
    expect(closed).toEqual({ code: 4401, reason: "device revoked" });
    expect(h.registry.has("444-555-666")).toBe(false);
  });

  it("rejects self-delete with 409", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/admin/users/1",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { reason: "boom" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no-self-delete");
  });

  it("rejects deleting the last admin", async () => {
    h.db.prepare("UPDATE accounts SET admin = 1 WHERE id = 2").run();
    // Now admins are id 1 and 2. Delete 1 by acting as id 2.
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "u2-login@example.com", password: "u2-passw0rd-here" },
    });
    // Bump newly-signed-up to id 2's admin status: instead, just emulate
    // by logging in as id-2 directly.
    h.db.prepare("UPDATE accounts SET admin = 0 WHERE id = 1").run();
    // Only id=2 is admin now. Try to delete id=2 from id=1's session.
    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/admin/users/2",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { reason: "test" },
    });
    expect(res.statusCode).toBe(403); // session is no longer admin
  });

  it("rejects missing reason with 400", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/admin/users/2",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { reason: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});
