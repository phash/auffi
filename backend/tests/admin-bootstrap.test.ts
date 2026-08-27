import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { registerAuthRoutes, type AuthMailer } from "../src/auth/handlers.js";
import { bootstrapInitialAdmin, maybePromoteToAdmin } from "../src/admin/bootstrap.js";

// The INITIAL_ADMIN_EMAIL promotion is gated on a VERIFIED account: the
// admin role only lands once the mailbox ownership is proven. Otherwise
// anyone who signs up first with a guessable admin@… address would hold
// a fully working admin session with zero mailbox proof.

describe("maybePromoteToAdmin (verify hook)", () => {
  let db: Db;

  function seedAccount(verified: boolean): void {
    db.prepare(
      `INSERT INTO accounts (email, password_hash, email_verified_at, created_at)
       VALUES (?, '$argon2id$dummy$dummy', ?, ?)`,
    ).run("ada@example.com", verified ? Date.now() : null, Date.now());
  }

  beforeEach(() => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
  });
  afterEach(() => db.close());

  it("returns false when INITIAL_ADMIN_EMAIL is unset", () => {
    seedAccount(true);
    const ok = maybePromoteToAdmin(db, "ada@example.com", {});
    expect(ok).toBe(false);
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(0);
  });

  it("returns true and promotes a VERIFIED account when email matches (case-insensitive)", () => {
    seedAccount(true);
    const ok = maybePromoteToAdmin(db, "ada@example.com", { INITIAL_ADMIN_EMAIL: "ADA@example.com" });
    expect(ok).toBe(true);
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(1);
  });

  it("refuses to promote an UNVERIFIED account even when the email matches", () => {
    seedAccount(false);
    const ok = maybePromoteToAdmin(db, "ada@example.com", { INITIAL_ADMIN_EMAIL: "ada@example.com" });
    expect(ok).toBe(false);
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(0);
  });

  it("returns false and leaves admin=0 when email differs", () => {
    seedAccount(true);
    const ok = maybePromoteToAdmin(db, "ada@example.com", { INITIAL_ADMIN_EMAIL: "bob@example.com" });
    expect(ok).toBe(false);
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(0);
  });
});

describe("bootstrapInitialAdmin (boot hook)", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
  });
  afterEach(() => db.close());

  it("returns {promoted:false} when env is unset", () => {
    expect(bootstrapInitialAdmin(db, {})).toEqual({ promoted: false, email: null });
  });

  it("returns {promoted:false} when env matches no existing account", () => {
    const out = bootstrapInitialAdmin(db, { INITIAL_ADMIN_EMAIL: "ghost@example.com" });
    expect(out).toEqual({ promoted: false, email: "ghost@example.com" });
  });

  it("promotes an existing VERIFIED account when env matches", () => {
    db.prepare(
      `INSERT INTO accounts (email, password_hash, email_verified_at, created_at)
       VALUES (?, 'dummy', ?, ?)`,
    ).run("boot@example.com", Date.now(), Date.now());

    const out = bootstrapInitialAdmin(db, { INITIAL_ADMIN_EMAIL: "boot@example.com" });
    expect(out.promoted).toBe(true);
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(1);
  });

  it("refuses to promote an UNVERIFIED account — a pre-registered squatter must not gain admin at restart", () => {
    db.prepare(
      `INSERT INTO accounts (email, password_hash, email_verified_at, created_at)
       VALUES (?, 'dummy', NULL, ?)`,
    ).run("boot@example.com", Date.now());

    const out = bootstrapInitialAdmin(db, { INITIAL_ADMIN_EMAIL: "boot@example.com" });
    expect(out.promoted).toBe(false);
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(0);
  });

  it("is idempotent on already-admin accounts", () => {
    db.prepare(
      `INSERT INTO accounts (email, password_hash, email_verified_at, created_at, admin)
       VALUES (?, 'dummy', ?, ?, 1)`,
    ).run("boot@example.com", Date.now(), Date.now());

    const out = bootstrapInitialAdmin(db, { INITIAL_ADMIN_EMAIL: "boot@example.com" });
    expect(out.promoted).toBe(false);
  });
});

type MailerRecord = { to: string; token: string };

function recordingMailer(): AuthMailer & { sent: MailerRecord[] } {
  const sent: MailerRecord[] = [];
  return {
    sent,
    async sendVerifyEmail(to, token) {
      sent.push({ to, token });
    },
    async sendResetEmail() {
      /* not exercised here */
    },
  };
}

describe("signup + verify integration with INITIAL_ADMIN_EMAIL", () => {
  let app: FastifyInstance;
  let db: Db;
  let mailer: AuthMailer & { sent: MailerRecord[] };

  async function setup(env: NodeJS.ProcessEnv): Promise<void> {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    Object.assign(process.env, env);
    mailer = recordingMailer();
    app = Fastify();
    await app.register(rateLimit, { global: false });
    registerAuthRoutes(app, { db, mailer });
    await app.ready();
  }

  afterEach(async () => {
    if (app) await app.close();
    if (db) db.close();
    delete process.env.INITIAL_ADMIN_EMAIL;
  });

  it("keeps admin=0 at signup time — the verification mail is NOT decorative", async () => {
    await setup({ INITIAL_ADMIN_EMAIL: "first@example.com" });
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "first@example.com", password: "admin-bootstrap-pw" },
    });
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(0);
  });

  it("promotes on the verify-link click — first VERIFIED owner of the address gets admin", async () => {
    await setup({ INITIAL_ADMIN_EMAIL: "first@example.com" });
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "first@example.com", password: "admin-bootstrap-pw" },
    });
    const token = mailer.sent[0].token;
    const res = await app.inject({ method: "GET", url: `/api/auth/verify/${token}` });
    expect(res.statusCode).toBe(200);
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(1);
  });

  it("leaves a non-matching signup at admin=0 even after verification", async () => {
    await setup({ INITIAL_ADMIN_EMAIL: "other@example.com" });
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "first@example.com", password: "admin-bootstrap-pw" },
    });
    const token = mailer.sent[0].token;
    await app.inject({ method: "GET", url: `/api/auth/verify/${token}` });
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(0);
  });
});
