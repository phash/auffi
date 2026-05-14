import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { decorateRequireSession } from "../src/auth/middleware.js";
import { decorateRequireAdmin } from "../src/admin/middleware.js";
import { registerAuthRoutes } from "../src/auth/handlers.js";
import { registerFeedbackRoutes } from "../src/feedback/handlers.js";
import { registerAdminFeedbackRoutes } from "../src/admin/feedback.js";
import { captureTransport } from "../src/email/transport.js";
import { buildAuthMailer } from "../src/email/mailer.js";
import { hashPassword } from "../src/auth/argon.js";

async function build(): Promise<{ app: FastifyInstance; db: Db }> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const transport = captureTransport();
  const mailer = buildAuthMailer({ dashboardUrl: "https://t/", transport });
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  decorateRequireSession(app, db);
  decorateRequireAdmin(app, db);
  registerAuthRoutes(app, { db, mailer });
  registerFeedbackRoutes(app, db);
  registerAdminFeedbackRoutes(app, db);
  await app.ready();
  return { app, db };
}

describe("POST /api/feedback (dashboard / session-cookie path)", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;

  beforeEach(async () => {
    h = await build();
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "user@example.com", password: "user-account-pw" },
    });
    const login = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user@example.com", password: "user-account-pw" },
    });
    const sc = login.headers["set-cookie"] as string | string[] | undefined;
    cookie = (Array.isArray(sc) ? sc[0] : sc!).match(
      /^__Host-auffi_session=([^;]+)/,
    )![1];
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("accepts a valid feedback submission and writes a row", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: {
        source: "dashboard",
        category: "bug",
        rating: 4,
        body: "Login-Flow nach Verify zeigt kurz weiße Seite.",
      },
    });
    expect(res.statusCode).toBe(202);
    const row = h.db
      .prepare(
        "SELECT account_id, source, category, rating, body FROM feedback ORDER BY id DESC LIMIT 1",
      )
      .get() as Record<string, unknown>;
    expect(row.source).toBe("dashboard");
    expect(row.category).toBe("bug");
    expect(row.rating).toBe(4);
    expect(row.body).toBe("Login-Flow nach Verify zeigt kurz weiße Seite.");
  });

  it("rejects with 401 when no session cookie is set", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { source: "dashboard", category: "bug", rating: 3, body: "test" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects when source=sharer is claimed but no Bearer auth is present", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { source: "sharer", category: "bug", rating: 3, body: "x" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unknown category", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { source: "dashboard", category: "spam", rating: 3, body: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("bad-category");
  });

  it("rejects rating outside 1..5", async () => {
    for (const rating of [0, 6, 3.5, "3"]) {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/feedback",
        headers: { cookie: `__Host-auffi_session=${cookie}` },
        payload: { source: "dashboard", category: "bug", rating, body: "x" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("bad-rating");
    }
  });

  it("rejects empty / whitespace-only / oversized body", async () => {
    for (const body of ["", "   ", "x".repeat(4001)]) {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/feedback",
        headers: { cookie: `__Host-auffi_session=${cookie}` },
        payload: { source: "dashboard", category: "bug", rating: 3, body },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("bad-body");
    }
  });

  it("trims whitespace from the body before storing", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: {
        source: "dashboard",
        category: "praise",
        rating: 5,
        body: "  super tool  \n",
      },
    });
    const row = h.db
      .prepare("SELECT body FROM feedback ORDER BY id DESC LIMIT 1")
      .get() as { body: string };
    expect(row.body).toBe("super tool");
  });
});

describe("POST /api/feedback (sharer / device-bearer path)", () => {
  let h: Awaited<ReturnType<typeof build>>;
  const token = "deadbeef".repeat(8); // 64 hex chars (32 bytes)
  const deviceId = "555-555-555";

  beforeEach(async () => {
    h = await build();
    // Seed an account + paired device manually.
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "owner@example.com", password: "owner-pw-1234567" },
    });
    const tokenHash = await hashPassword(token);
    h.db
      .prepare(
        `INSERT INTO devices (id, owner_account_id, alias, token_hash, auto_accept, created_at)
         VALUES (?, 1, 'D', ?, 1, ?)`,
      )
      .run(deviceId, tokenHash, Date.now());
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("accepts feedback with valid device Bearer + writes account_id from device owner", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: {
        authorization: `Bearer ${token}`,
        "x-auffi-device-id": deviceId,
      },
      payload: {
        source: "sharer",
        category: "feature",
        rating: 4,
        body: "Bitte Audio-Stream supporten",
      },
    });
    expect(res.statusCode).toBe(202);
    const row = h.db
      .prepare("SELECT account_id, source FROM feedback ORDER BY id DESC LIMIT 1")
      .get() as { account_id: number; source: string };
    expect(row.account_id).toBe(1);
    expect(row.source).toBe("sharer");
  });

  it("rejects with 401 when the device token is wrong", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: {
        authorization: "Bearer " + "ff".repeat(32),
        "x-auffi-device-id": deviceId,
      },
      payload: { source: "sharer", category: "bug", rating: 1, body: "x" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/admin/feedback", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let adminCookie: string;

  beforeEach(async () => {
    h = await build();
    // Seed three feedback rows (alice user) + admin account.
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "alice@example.com", password: "alice-pw-1234" },
    });
    const aliceLogin = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.com", password: "alice-pw-1234" },
    });
    const aliceCookie = (
      (aliceLogin.headers["set-cookie"] as string)
        .match(/^__Host-auffi_session=([^;]+)/)![1]
    );
    for (const body of ["erste idee", "zweite idee", "dritte idee"]) {
      await h.app.inject({
        method: "POST",
        url: "/api/feedback",
        headers: { cookie: `__Host-auffi_session=${aliceCookie}` },
        payload: { source: "dashboard", category: "feature", rating: 4, body },
      });
    }

    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "admin@example.com", password: "admin-pw-1234" },
    });
    h.db.prepare("UPDATE accounts SET admin = 1 WHERE email = 'admin@example.com'").run();
    const adminLogin = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "admin-pw-1234" },
    });
    adminCookie = ((adminLogin.headers["set-cookie"] as string)
      .match(/^__Host-auffi_session=([^;]+)/)![1]);
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("lists all three rows newest-first with account email joined", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/feedback",
      headers: { cookie: `__Host-auffi_session=${adminCookie}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(3);
    expect(items[0].body).toBe("dritte idee");
    expect(items[0].accountEmail).toBe("alice@example.com");
    expect(items[2].body).toBe("erste idee");
  });

  it("filters by status=open and status=resolved", async () => {
    // Mark the middle row resolved via PATCH.
    const list = await h.app.inject({
      method: "GET",
      url: "/api/admin/feedback",
      headers: { cookie: `__Host-auffi_session=${adminCookie}` },
    });
    const middleId = list.json().items[1].id;
    await h.app.inject({
      method: "PATCH",
      url: `/api/admin/feedback/${middleId}`,
      headers: { cookie: `__Host-auffi_session=${adminCookie}` },
      payload: { resolved: true },
    });
    const open = await h.app.inject({
      method: "GET",
      url: "/api/admin/feedback?status=open",
      headers: { cookie: `__Host-auffi_session=${adminCookie}` },
    });
    expect(open.json().items).toHaveLength(2);
    const resolved = await h.app.inject({
      method: "GET",
      url: "/api/admin/feedback?status=resolved",
      headers: { cookie: `__Host-auffi_session=${adminCookie}` },
    });
    expect(resolved.json().items).toHaveLength(1);
    expect(resolved.json().items[0].id).toBe(middleId);
  });

  it("returns 403 for non-admin sessions", async () => {
    const aliceLogin = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.com", password: "alice-pw-1234" },
    });
    const aliceCookie = ((aliceLogin.headers["set-cookie"] as string)
      .match(/^__Host-auffi_session=([^;]+)/)![1]);
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/feedback",
      headers: { cookie: `__Host-auffi_session=${aliceCookie}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 for anonymous access", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/admin/feedback" });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/admin/feedback/:id", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let adminCookie: string;
  let userCookie: string;
  let feedbackId: number;

  beforeEach(async () => {
    h = await build();
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "user2@example.com", password: "user-pw-1234" },
    });
    const userLogin = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user2@example.com", password: "user-pw-1234" },
    });
    userCookie = ((userLogin.headers["set-cookie"] as string)
      .match(/^__Host-auffi_session=([^;]+)/)![1]);
    await h.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: { cookie: `__Host-auffi_session=${userCookie}` },
      payload: { source: "dashboard", category: "bug", rating: 2, body: "spam" },
    });
    feedbackId = (h.db
      .prepare("SELECT id FROM feedback ORDER BY id DESC LIMIT 1")
      .get() as { id: number }).id;

    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "admin2@example.com", password: "admin-pw-1234" },
    });
    h.db.prepare("UPDATE accounts SET admin = 1 WHERE email = 'admin2@example.com'").run();
    const adminLogin = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin2@example.com", password: "admin-pw-1234" },
    });
    adminCookie = ((adminLogin.headers["set-cookie"] as string)
      .match(/^__Host-auffi_session=([^;]+)/)![1]);
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("removes the row and writes an audit_log entry capturing the body", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/admin/feedback/${feedbackId}`,
      headers: { cookie: `__Host-auffi_session=${adminCookie}` },
    });
    expect(res.statusCode).toBe(204);
    const row = h.db
      .prepare("SELECT COUNT(*) AS c FROM feedback WHERE id = ?")
      .get(feedbackId) as { c: number };
    expect(row.c).toBe(0);

    const auditRow = h.db
      .prepare<[string], { action: string; before_json: string }>(
        "SELECT action, before_json FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1",
      )
      .get("feedback.delete") as { action: string; before_json: string };
    expect(auditRow.action).toBe("feedback.delete");
    expect(auditRow.before_json).toContain("spam");
  });

  it("404s on unknown id", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/admin/feedback/99999",
      headers: { cookie: `__Host-auffi_session=${adminCookie}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403s for non-admin", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/admin/feedback/${feedbackId}`,
      headers: { cookie: `__Host-auffi_session=${userCookie}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

