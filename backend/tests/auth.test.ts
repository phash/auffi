import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
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

function cookieValue(headers: OutgoingHttpHeaders): string | undefined {
  const sc = headers["set-cookie"];
  const raw = Array.isArray(sc) ? sc[0] : typeof sc === "string" ? sc : undefined;
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

  it("concurrent duplicate signups → one 202, one 409 (UNIQUE race maps to email-taken, not 500)", async () => {
    // Both requests pass the duplicate-email SELECT while the other is
    // still inside the ~250 ms argon2 hash; the loser's INSERT trips the
    // UNIQUE constraint and must surface as the same 409 as the pre-check.
    const [r1, r2] = await Promise.all([
      h.app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { email: "race@example.com", password: "racer-password-1" },
      }),
      h.app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { email: "race@example.com", password: "racer-password-2" },
      }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
    expect(codes).toEqual([202, 409]);
    const rows = h.db.prepare("SELECT COUNT(*) AS c FROM accounts").get() as { c: number };
    expect(rows.c).toBe(1);
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

  it("successful reset invalidates every other outstanding reset token of the account", async () => {
    // Attacker scenario: a stashed unused reset link must not survive the
    // victim's own successful reset — mirrors the session invalidation.
    await h.app.inject({
      method: "POST",
      url: "/api/auth/forgot",
      payload: { email: "grace@example.com" },
    });
    await h.app.inject({
      method: "POST",
      url: "/api/auth/forgot",
      payload: { email: "grace@example.com" },
    });
    expect(h.mailer.sent).toHaveLength(2);
    const stashed = h.mailer.sent[0].token;
    const used = h.mailer.sent[1].token;

    const res = await h.app.inject({
      method: "POST",
      url: `/api/auth/reset/${used}`,
      payload: { password: "victims-new-password" },
    });
    expect(res.statusCode).toBe(200);

    const replay = await h.app.inject({
      method: "POST",
      url: `/api/auth/reset/${stashed}`,
      payload: { password: "attacker-password-x" },
    });
    expect(replay.statusCode).toBe(410);

    const unused = h.db
      .prepare("SELECT COUNT(*) AS c FROM password_resets WHERE used_at IS NULL")
      .get() as { c: number };
    expect(unused.c).toBe(0);
  });

  it("honours a reset token exactly once when two resets race on it", async () => {
    // The used_at pre-check and the transaction straddle the argon2 hash,
    // so two concurrent POSTs with the same token both pass the pre-check.
    // The claim inside the transaction must decide: one 200, one 410.
    await h.app.inject({
      method: "POST",
      url: "/api/auth/forgot",
      payload: { email: "grace@example.com" },
    });
    const token = h.mailer.sent[0].token;

    const [first, second] = await Promise.all([
      h.app.inject({
        method: "POST",
        url: `/api/auth/reset/${token}`,
        payload: { password: "first-racer-password" },
      }),
      h.app.inject({
        method: "POST",
        url: `/api/auth/reset/${token}`,
        payload: { password: "second-racer-password" },
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 410]);
    const loser = first.statusCode === 410 ? first : second;
    expect(loser.json().error).toBe("token-used");

    // Only the winner's password verifies.
    const winnerPw = first.statusCode === 200 ? "first-racer-password" : "second-racer-password";
    const loserPw = first.statusCode === 200 ? "second-racer-password" : "first-racer-password";
    const okLogin = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "grace@example.com", password: winnerPw },
    });
    expect(okLogin.statusCode).toBe(200);
    const badLogin = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "grace@example.com", password: loserPw },
    });
    expect(badLogin.statusCode).toBe(401);
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

describe("SIGNUP_DISABLED gate (gh #39)", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    delete process.env.SIGNUP_DISABLED;
    await h.app.close();
    h.db.close();
  });

  it("returns 403 and creates no account when SIGNUP_DISABLED=1", async () => {
    process.env.SIGNUP_DISABLED = "1";
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "blocked@example.com", password: "correct-horse-battery" },
    });
    expect(res.statusCode).toBe(403);
    const row = h.db
      .prepare<[string], { id: number }>("SELECT id FROM accounts WHERE email = ?")
      .get("blocked@example.com");
    expect(row).toBeUndefined();
    expect(h.mailer.sent).toHaveLength(0);
  });

  it("allows signup when SIGNUP_DISABLED is unset", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "allowed@example.com", password: "correct-horse-battery" },
    });
    expect(res.statusCode).toBe(202);
  });

  it("honours common truthy values with surrounding whitespace/case", async () => {
    process.env.SIGNUP_DISABLED = " YES ";
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "x@example.com", password: "correct-horse-battery" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("treats falsy strings as enabled (does not close on '0' / 'false')", async () => {
    process.env.SIGNUP_DISABLED = "false";
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "y@example.com", password: "correct-horse-battery" },
    });
    expect(res.statusCode).toBe(202);
  });
});

describe("POST /api/auth/login — per-account lockout", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    vi.useRealTimers();
    h = await build();
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "eve@example.com", password: "the-real-password" },
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await h.app.close();
    h.db.close();
  });

  // Every attempt comes from a different address: the per-IP limiter is the
  // brake being bypassed here, so the test must not trip it.
  let nextIp = 1;
  async function login(password: string): Promise<{ status: number; cookie: string | undefined }> {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: `10.0.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`,
      payload: { email: "eve@example.com", password },
    });
    return { status: res.statusCode, cookie: cookieValue(res.headers) };
  }

  // The per-IP limiter is the only brake on login guesses, and it is trivially
  // spread over many addresses. /api/me already locks the account after five
  // wrong passwords (CLAUDE.md: the lockout applies to the password surfaces);
  // login is the primary password surface and had none.
  it("after five wrong passwords the right one is refused too", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(`wrong-${i}`)).status).toBe(401);
    }
    const locked = await login("the-real-password");
    expect(locked.status).toBe(401);
    expect(locked.cookie).toBeUndefined();
    expect(h.db.prepare("SELECT COUNT(*) AS c FROM sessions").get()).toEqual({ c: 0 });
  });

  it("the lock answers exactly like a wrong password — no account enumeration", async () => {
    for (let i = 0; i < 5; i++) await login(`wrong-${i}`);
    const locked = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "eve@example.com", password: "the-real-password" },
    });
    const unknown = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.com", password: "the-real-password" },
    });
    expect(locked.statusCode).toBe(unknown.statusCode);
    expect(locked.json()).toEqual(unknown.json());
  });

  it("the lock lifts after fifteen minutes", async () => {
    for (let i = 0; i < 5; i++) await login(`wrong-${i}`);
    expect((await login("the-real-password")).status).toBe(401);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const after = await login("the-real-password");
    expect(after.status).toBe(200);
    expect(after.cookie).toBeDefined();
  });

  it("a successful login forgives earlier wrong attempts", async () => {
    await login("wrong-1");
    await login("wrong-2");
    expect((await login("the-real-password")).status).toBe(200);
    for (let i = 0; i < 4; i++) await login(`wrong-again-${i}`);
    // Four wrong since the reset — still one short of the lock.
    expect((await login("the-real-password")).status).toBe(200);
  });
});
