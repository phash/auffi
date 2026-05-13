import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { registerAuthRoutes, type AuthMailer } from "../src/auth/handlers.js";
import { hashToken } from "../src/auth/tokens.js";

type MailerRecord = {
  to: string;
  token: string;
  kind: "verify" | "reset";
};

function recordingMailer(): AuthMailer & { sent: MailerRecord[] } {
  const sent: MailerRecord[] = [];
  return {
    sent,
    async sendVerifyEmail(to, token) {
      sent.push({ to, token, kind: "verify" });
    },
    async sendResetEmail(to, token) {
      sent.push({ to, token, kind: "reset" });
    },
  };
}

async function build(): Promise<{
  app: FastifyInstance;
  db: Db;
  mailer: AuthMailer & { sent: MailerRecord[] };
}> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const mailer = recordingMailer();
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  registerAuthRoutes(app, { db, mailer });
  await app.ready();
  return { app, db, mailer };
}

function cookieValue(headers: Record<string, string | string[] | undefined>): string | undefined {
  const sc = headers["set-cookie"];
  const raw = Array.isArray(sc) ? sc[0] : sc;
  if (!raw) return undefined;
  const m = raw.match(/^__Host-auffi_session=([^;]+)/);
  return m?.[1];
}

describe("POST /api/auth/signup", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("creates account, queues verify mail, returns 202", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "alice@example.com", password: "correct-horse-battery" },
    });
    expect(res.statusCode).toBe(202);
    const row = h.db
      .prepare<[string], { email: string; email_verified_at: number | null }>(
        "SELECT email, email_verified_at FROM accounts WHERE email = ?",
      )
      .get("alice@example.com");
    expect(row?.email).toBe("alice@example.com");
    expect(row?.email_verified_at).toBeNull();

    expect(h.mailer.sent).toHaveLength(1);
    expect(h.mailer.sent[0].kind).toBe("verify");
    expect(h.mailer.sent[0].to).toBe("alice@example.com");

    const verif = h.db
      .prepare<[number], { used_at: number | null }>(
        "SELECT used_at FROM email_verifications WHERE account_id = ?",
      )
      .get(1);
    expect(verif?.used_at).toBeNull();
  });

  it("rejects an email already in use with 409", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "alice@example.com", password: "first-password-here" },
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "alice@example.com", password: "second-password-here" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects malformed email with 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "not-an-email", password: "correct-horse-battery" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects short password with 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "bob@example.com", password: "short" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lower-cases email so collation matches", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "Carol@Example.COM", password: "case-insensitive-1" },
    });
    const dup = await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "carol@example.com", password: "case-insensitive-2" },
    });
    expect(dup.statusCode).toBe(409);
  });
});

describe("GET /api/auth/verify/:token", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  async function signup(): Promise<string> {
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "dora@example.com", password: "verify-flow-pass" },
    });
    return h.mailer.sent[0].token;
  }

  it("marks the token used + verifies the account WITHOUT issuing a session cookie (Sec H-2)", async () => {
    const token = await signup();
    const res = await h.app.inject({
      method: "GET",
      url: `/api/auth/verify/${token}`,
    });
    expect(res.statusCode).toBe(200);
    // Sec H-2 (review 2026-05-13): the verify GET must NOT auto-
    // login. A page embedding the URL as <img src=…> could
    // otherwise silently authenticate the victim's browser. The
    // user logs in explicitly after the dashboard renders the
    // success message.
    expect(cookieValue(res.headers)).toBeUndefined();

    const row = h.db
      .prepare<[number], { email_verified_at: number | null }>(
        "SELECT email_verified_at FROM accounts WHERE id = ?",
      )
      .get(1);
    expect(row?.email_verified_at).toBeGreaterThan(0);

    const used = h.db
      .prepare<[string], { used_at: number | null }>(
        "SELECT used_at FROM email_verifications WHERE token_hash = ?",
      )
      .get(hashToken(token));
    expect(used?.used_at).not.toBeNull();
  });

  it("rejects an already-used token with 410", async () => {
    const token = await signup();
    await h.app.inject({ method: "GET", url: `/api/auth/verify/${token}` });
    const second = await h.app.inject({ method: "GET", url: `/api/auth/verify/${token}` });
    expect(second.statusCode).toBe(410);
  });

  it("rejects an expired token with 410", async () => {
    const token = await signup();
    h.db.prepare("UPDATE email_verifications SET expires_at = 1").run();
    const res = await h.app.inject({ method: "GET", url: `/api/auth/verify/${token}` });
    expect(res.statusCode).toBe(410);
  });

  it("rejects a fabricated token with 410", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/auth/verify/abcdef" });
    expect(res.statusCode).toBe(410);
  });
});

describe("POST /api/auth/login", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "eve@example.com", password: "the-real-password" },
    });
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("returns 200 + session cookie on correct credentials", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "eve@example.com", password: "the-real-password" },
    });
    expect(res.statusCode).toBe(200);
    const cookie = cookieValue(res.headers);
    expect(cookie).toBeDefined();
    expect(cookie!.length).toBe(64);

    const sessionRow = h.db
      .prepare<[string], { account_id: number }>(
        "SELECT account_id FROM sessions WHERE token_hash = ?",
      )
      .get(hashToken(cookie!));
    expect(sessionRow?.account_id).toBe(1);
  });

  it("returns 401 on wrong password (and does NOT create a session)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "eve@example.com", password: "wrong-password-here" },
    });
    expect(res.statusCode).toBe(401);
    expect(cookieValue(res.headers)).toBeUndefined();

    const sessions = h.db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    expect(sessions.c).toBe(0);
  });

  it("returns 401 on unknown email (same response shape as wrong password)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ghost@example.com", password: "doesnt-matter-here" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("sets cookie with HttpOnly+Secure+SameSite=Strict+Max-Age", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "eve@example.com", password: "the-real-password" },
    });
    const sc = res.headers["set-cookie"] as string | string[] | undefined;
    const raw = Array.isArray(sc) ? sc[0] : sc!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/Secure/);
    expect(raw).toMatch(/SameSite=Strict/);
    expect(raw).toMatch(/Max-Age=2592000/); // 30 days in seconds
  });
});

describe("POST /api/auth/logout", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("deletes the session row and clears the cookie", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "frank@example.com", password: "logout-test-pass" },
    });
    const loginRes = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "frank@example.com", password: "logout-test-pass" },
    });
    const cookie = cookieValue(loginRes.headers)!;

    const logoutRes = await h.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(logoutRes.statusCode).toBe(200);

    const count = h.db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    expect(count.c).toBe(0);

    const sc = logoutRes.headers["set-cookie"] as string | string[] | undefined;
    const raw = Array.isArray(sc) ? sc[0] : sc!;
    expect(raw).toMatch(/Max-Age=0/);
  });

  it("is idempotent when no cookie is sent (200, no row touched)", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/auth/forgot + /api/auth/reset", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "grace@example.com", password: "old-password-here" },
    });
    // Drop the verify mail from the recording so we only count reset mails.
    h.mailer.sent.length = 0;
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("forgot for known email → 200, queues reset mail, inserts password_resets row", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/forgot",
      payload: { email: "grace@example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.mailer.sent).toHaveLength(1);
    expect(h.mailer.sent[0].kind).toBe("reset");
    expect(h.mailer.sent[0].to).toBe("grace@example.com");

    const row = h.db.prepare("SELECT COUNT(*) AS c FROM password_resets").get() as { c: number };
    expect(row.c).toBe(1);
  });

  it("forgot for unknown email → 200, no mail, no row (existence not leaked)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/forgot",
      payload: { email: "nobody@example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.mailer.sent).toHaveLength(0);
    const row = h.db.prepare("SELECT COUNT(*) AS c FROM password_resets").get() as { c: number };
    expect(row.c).toBe(0);
  });

  it("reset with valid token sets new password and kills all sessions", async () => {
    // Two live sessions across two browsers
    const a = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "grace@example.com", password: "old-password-here" },
    });
    const b = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "grace@example.com", password: "old-password-here" },
    });
    expect(cookieValue(a.headers)).toBeDefined();
    expect(cookieValue(b.headers)).toBeDefined();

    // Request reset
    await h.app.inject({
      method: "POST",
      url: "/api/auth/forgot",
      payload: { email: "grace@example.com" },
    });
    const token = h.mailer.sent[0].token;

    const res = await h.app.inject({
      method: "POST",
      url: `/api/auth/reset/${token}`,
      payload: { password: "brand-new-password-here" },
    });
    expect(res.statusCode).toBe(200);

    // Old credentials should fail
    const oldLogin = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "grace@example.com", password: "old-password-here" },
    });
    expect(oldLogin.statusCode).toBe(401);

    // New credentials succeed
    const newLogin = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "grace@example.com", password: "brand-new-password-here" },
    });
    expect(newLogin.statusCode).toBe(200);

    // The pre-reset sessions were wiped (only the new login's session remains)
    const count = h.db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("reset rejects an expired token with 410", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/auth/forgot",
      payload: { email: "grace@example.com" },
    });
    h.db.prepare("UPDATE password_resets SET expires_at = 1").run();
    const token = h.mailer.sent[0].token;
    const res = await h.app.inject({
      method: "POST",
      url: `/api/auth/reset/${token}`,
      payload: { password: "brand-new-password-here" },
    });
    expect(res.statusCode).toBe(410);
  });

  it("reset rejects an already-used token with 410", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/auth/forgot",
      payload: { email: "grace@example.com" },
    });
    const token = h.mailer.sent[0].token;
    await h.app.inject({
      method: "POST",
      url: `/api/auth/reset/${token}`,
      payload: { password: "first-new-password" },
    });
    const second = await h.app.inject({
      method: "POST",
      url: `/api/auth/reset/${token}`,
      payload: { password: "second-new-password" },
    });
    expect(second.statusCode).toBe(410);
  });
});
