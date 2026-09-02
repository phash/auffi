import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { decorateRequireSession } from "../src/auth/middleware.js";
import { registerAuthRoutes } from "../src/auth/handlers.js";
import { captureTransport } from "../src/email/transport.js";
import { buildAuthMailer } from "../src/email/mailer.js";
import { hashToken } from "../src/auth/tokens.js";

async function build(): Promise<{ app: FastifyInstance; db: Db; cookie: () => Promise<string> }> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const transport = captureTransport();
  const mailer = buildAuthMailer({ dashboardUrl: "https://t/", transport });
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  decorateRequireSession(app, db);
  registerAuthRoutes(app, { db, mailer });

  // Toy authenticated route to exercise the decorator. We surface
  // `tokenHash` so the regression test for Sec C-1 can confirm the
  // server-side identifier is NOT the raw cookie value.
  app.get(
    "/api/me",
    { preHandler: app.requireSession },
    async (req) => ({ accountId: req.account?.id, tokenHash: req.account?.tokenHash }),
  );

  await app.ready();

  async function cookie(): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "u@example.com", password: "long-enough-password" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "u@example.com", password: "long-enough-password" },
    });
    const sc = login.headers["set-cookie"] as string | string[] | undefined;
    const raw = Array.isArray(sc) ? sc[0] : sc!;
    return raw.match(/^__Host-auffi_session=([^;]+)/)![1];
  }

  return { app, db, cookie };
}

describe("requireSession decorator", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("allows a request with a valid cookie + populates req.account", async () => {
    const c = await h.cookie();
    const res = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountId).toBe(1);
    // Sec C-1 regression pin: the server-side session identifier is
    // sha256(cookie), NOT the cookie value. Anyone restoring the old
    // "store the plaintext as the row id" shape brings this back as
    // an equality.
    expect(body.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.tokenHash).not.toBe(c);
  });

  it("returns 401 when no cookie is set", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the cookie value is unknown", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: "__Host-auffi_session=garbage" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the session is expired", async () => {
    const c = await h.cookie();
    h.db.prepare("UPDATE sessions SET expires_at = 1").run();
    const res = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the cookie header is malformed (no key=value)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: "noequalshere" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the account was deleted (FK cascade drops the session)", async () => {
    const c = await h.cookie();
    h.db.prepare("DELETE FROM accounts WHERE id = 1").run();
    const res = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 while the owning account is suspended, and recovers on unsuspend", async () => {
    // Suspension purges sessions once, but a session minted in the same
    // instant (login racing the admin action) survives that purge — the
    // per-request gate must refuse it, mirroring verifyBearerAuth (gh #47).
    const c = await h.cookie();
    h.db.prepare("UPDATE accounts SET suspended_at = ? WHERE id = 1").run(Date.now());
    const suspended = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(suspended.statusCode).toBe(401);
    expect(suspended.json().error).toBe("no-session");

    h.db.prepare("UPDATE accounts SET suspended_at = NULL WHERE id = 1").run();
    const restored = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(restored.statusCode).toBe(200);
  });

  it("logout deletes the session row even when the account is suspended", async () => {
    const c = await h.cookie();
    h.db.prepare("UPDATE accounts SET suspended_at = ? WHERE id = 1").run(Date.now());
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = h.db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it("updates sessions.last_seen_at on every successful call", async () => {
    const c = await h.cookie();
    const before = h.db
      .prepare<[string], { last_seen_at: number }>(
        "SELECT last_seen_at FROM sessions WHERE token_hash = ?",
      )
      .get(hashToken(c))!.last_seen_at;

    // wait a millisecond so the new timestamp differs
    await new Promise((r) => setTimeout(r, 5));
    await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });

    const after = h.db
      .prepare<[string], { last_seen_at: number }>(
        "SELECT last_seen_at FROM sessions WHERE token_hash = ?",
      )
      .get(hashToken(c))!.last_seen_at;
    expect(after).toBeGreaterThan(before);
  });
});

describe("rate-limit responses include Retry-After", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("login rate-limit returns 429 + Retry-After after the 5th attempt", async () => {
    // 5 attempts allowed in the 1-minute window per spec §9
    let lastStatus = 0;
    let lastRetryAfter: string | undefined;
    for (let i = 0; i < 6; i++) {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "noone@example.com", password: "any-password-here" },
      });
      lastStatus = res.statusCode;
      lastRetryAfter = res.headers["retry-after"] as string | undefined;
    }
    expect(lastStatus).toBe(429);
    expect(lastRetryAfter).toBeDefined();
    expect(Number(lastRetryAfter)).toBeGreaterThan(0);
  });
});
