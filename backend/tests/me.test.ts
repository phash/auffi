import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { decorateRequireSession } from "../src/auth/middleware.js";
import { registerAuthRoutes } from "../src/auth/handlers.js";
import { registerMeRoutes, type AccountMailer } from "../src/account/me.js";
import { captureTransport } from "../src/email/transport.js";
import { buildAuthMailer } from "../src/email/mailer.js";

function recordingChangeMailer(): AccountMailer & { sent: { to: string; token: string }[] } {
  const sent: { to: string; token: string }[] = [];
  return {
    sent,
    async sendEmailChangeVerification(to, token) {
      sent.push({ to, token });
    },
  };
}

async function build(): Promise<{
  app: FastifyInstance;
  db: Db;
  changeMailer: AccountMailer & { sent: { to: string; token: string }[] };
  cookie: () => Promise<string>;
}> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const transport = captureTransport();
  const mailer = buildAuthMailer({ dashboardUrl: "https://t/", transport });
  const changeMailer = recordingChangeMailer();
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  decorateRequireSession(app, db);
  registerAuthRoutes(app, { db, mailer });
  registerMeRoutes(app, { db, mailer: changeMailer });
  await app.ready();

  async function cookie(): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "henry@example.com", password: "the-current-password" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "henry@example.com", password: "the-current-password" },
    });
    const sc = login.headers["set-cookie"] as string | string[] | undefined;
    const raw = Array.isArray(sc) ? sc[0] : sc!;
    return raw.match(/^__Host-auffi_session=([^;]+)/)![1];
  }

  return { app, db, changeMailer, cookie };
}

describe("GET /api/me", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("returns the authenticated account's meta", async () => {
    const c = await h.cookie();
    const res = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${c}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe("henry@example.com");
    expect(body.id).toBe(1);
    expect(body.emailVerifiedAt).toBeNull();
    expect(body.pendingEmail).toBeNull();
  });

  it("returns 401 without a session", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /api/me — password change", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.cookie();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("rejects without current_password (403)", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { new_password: "brand-new-password" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("changes the password and invalidates all sessions", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "the-current-password", new_password: "brand-new-secret-pw" },
    });
    expect(res.statusCode).toBe(200);

    // Old session is gone — same cookie now returns 401
    const after = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(after.statusCode).toBe(401);

    // Old password rejected on login; new one accepted
    const old = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "henry@example.com", password: "the-current-password" },
    });
    expect(old.statusCode).toBe(401);

    const nu = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "henry@example.com", password: "brand-new-secret-pw" },
    });
    expect(nu.statusCode).toBe(200);
  });
});

describe("PATCH /api/me — email change", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.cookie();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("queues a pending change + sends verify mail to NEW address — old email still active", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "the-current-password", new_email: "henry-new@example.com" },
    });
    expect(res.statusCode).toBe(200);

    expect(h.changeMailer.sent).toHaveLength(1);
    expect(h.changeMailer.sent[0].to).toBe("henry-new@example.com");

    // Account row still has the old email — swap waits for verify click.
    const me = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(me.json().email).toBe("henry@example.com");
    expect(me.json().pendingEmail).toBe("henry-new@example.com");
  });

  it("verify click on the change token swaps the email + invalidates sessions (Sec L-9)", async () => {
    await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "the-current-password", new_email: "henry-new@example.com" },
    });
    const token = h.changeMailer.sent[0].token;

    const verify = await h.app.inject({
      method: "GET",
      url: `/api/me/email-change/${token}`,
    });
    expect(verify.statusCode).toBe(200);

    // Sec L-9: the prior session must be dead — mirrors the
    // password-change behaviour. A stolen cookie shouldn't survive
    // an email-recovery-address swap.
    const stale = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(stale.statusCode).toBe(401);

    // Logging in with the new address proves the swap landed in DB.
    const login = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "henry-new@example.com", password: "the-current-password" },
    });
    expect(login.statusCode).toBe(200);
    const sc = login.headers["set-cookie"] as string | string[] | undefined;
    const fresh = (Array.isArray(sc) ? sc[0] : sc!).match(/^__Host-auffi_session=([^;]+)/)![1];

    const me = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${fresh}` },
    });
    expect(me.json().email).toBe("henry-new@example.com");
    expect(me.json().pendingEmail).toBeNull();
  });

  it("refuses to change to an already-taken email at request time (409)", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "rival@example.com", password: "rivals-own-password" },
    });
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "the-current-password", new_email: "rival@example.com" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("verify-click resolves 410 when token is unknown", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/me/email-change/garbage-token",
    });
    expect(res.statusCode).toBe(410);
  });

  it("a fresh change overwrites a prior in-flight one (only one pending)", async () => {
    await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "the-current-password", new_email: "a@example.com" },
    });
    await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "the-current-password", new_email: "b@example.com" },
    });
    const count = h.db
      .prepare("SELECT COUNT(*) AS c FROM pending_email_changes WHERE account_id = 1")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });
});

describe("DELETE /api/me", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.cookie();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("rejects without confirm=LÖSCHEN (400)", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "the-current-password", confirm: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects on wrong password (403)", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "wrong-pw", confirm: "LÖSCHEN" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("hard-deletes the account + cascades and subsequent requests 401", async () => {
    // Confirm cascade target: a pending email-change row that should be
    // gone after the cascade fires.
    await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "the-current-password", new_email: "z@example.com" },
    });

    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "the-current-password", confirm: "LÖSCHEN" },
    });
    expect(res.statusCode).toBe(204);

    const accCount = h.db.prepare("SELECT COUNT(*) AS c FROM accounts").get() as { c: number };
    expect(accCount.c).toBe(0);
    const sessCount = h.db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    expect(sessCount.c).toBe(0);
    const pendCount = h.db
      .prepare("SELECT COUNT(*) AS c FROM pending_email_changes")
      .get() as { c: number };
    expect(pendCount.c).toBe(0);

    const after = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
    });
    expect(after.statusCode).toBe(401);
  });
});

// Sec H-3 (review 2026-05-13): per-account lockout on bad-credentials.
// PATCH /me and DELETE /me both gate every change on current_password.
// Without a per-account counter, an attacker who holds one session
// can iterate the per-IP limit (10/hour) ≈ 240×/day per account.
describe("PATCH /api/me — per-account lockout (Sec H-3)", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  async function patchAttempt(cookie: string, currentPw: string): Promise<number> {
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: currentPw, new_email: "next@example.com" },
    });
    return res.statusCode;
  }

  it("5 wrong current_password attempts → 6th attempt is 423 locked", async () => {
    const cookie = await h.cookie();
    // 5 wrong-pw attempts (PATCH-level rate-limiter is disabled in
    // the test rig at line 33). The 5th hit engages the lockout per
    // the unified threshold across device + account flows.
    for (let i = 0; i < 5; i++) {
      const status = await patchAttempt(cookie, "wrong-pw-" + i);
      expect(status).toBe(403);
    }
    // 6th: locked. Even if the password is now correct we expect 423,
    // because the gate runs BEFORE argon2.
    const status = await patchAttempt(cookie, "the-current-password");
    expect(status).toBe(423);
    const body = await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "the-current-password", new_email: "x@y.test" },
    });
    expect(body.json().error).toBe("locked");
    expect(body.json().retryAfterSec).toBeGreaterThan(0);
  });

  it("successful PATCH resets the fail counter", async () => {
    const cookie = await h.cookie();
    // Two wrong attempts...
    await patchAttempt(cookie, "wrong1");
    await patchAttempt(cookie, "wrong2");
    // ...then a successful one resets to zero.
    const ok = await patchAttempt(cookie, "the-current-password");
    expect(ok).toBe(200);
    // We could now run 5 more wrong attempts before locking. Show
    // that 3 more wrongs do NOT lock (would be 5 total without the
    // reset).
    for (let i = 0; i < 3; i++) {
      const status = await patchAttempt(cookie, "wrong-again-" + i);
      expect(status).toBe(403);
    }
    // 4th wrong post-success: still not locked.
    const fourth = await patchAttempt(cookie, "still-wrong");
    expect(fourth).toBe(403);
  });

  it("DELETE /api/me observes the same per-account lockout", async () => {
    const cookie = await h.cookie();
    // Burn the counter via PATCH first.
    for (let i = 0; i < 5; i++) {
      await patchAttempt(cookie, "wrong-pw-" + i);
    }
    const del = await h.app.inject({
      method: "DELETE",
      url: "/api/me",
      headers: { cookie: `__Host-auffi_session=${cookie}` },
      payload: { current_password: "the-current-password", confirm: "LÖSCHEN" },
    });
    expect(del.statusCode).toBe(423);
    expect(del.json().error).toBe("locked");
  });
});
