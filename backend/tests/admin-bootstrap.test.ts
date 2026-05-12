import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { registerAuthRoutes } from "../src/auth/handlers.js";
import { captureTransport } from "../src/email/transport.js";
import { buildAuthMailer } from "../src/email/mailer.js";
import { bootstrapInitialAdmin, maybePromoteToAdmin } from "../src/admin/bootstrap.js";

describe("maybePromoteToAdmin (signup hook)", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    db.prepare(
      `INSERT INTO accounts (email, password_hash, email_verified_at, created_at)
       VALUES (?, '$argon2id$dummy$dummy', NULL, ?)`,
    ).run("ada@example.com", Date.now());
  });
  afterEach(() => db.close());

  it("returns false when INITIAL_ADMIN_EMAIL is unset", () => {
    const ok = maybePromoteToAdmin(db, "ada@example.com", {});
    expect(ok).toBe(false);
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(0);
  });

  it("returns true and promotes when email matches (case-insensitive)", () => {
    const ok = maybePromoteToAdmin(db, "ada@example.com", { INITIAL_ADMIN_EMAIL: "ADA@example.com" });
    expect(ok).toBe(true);
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(1);
  });

  it("returns false and leaves admin=0 when email differs", () => {
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

  it("promotes an existing account when env matches", () => {
    db.prepare(
      `INSERT INTO accounts (email, password_hash, email_verified_at, created_at)
       VALUES (?, 'dummy', NULL, ?)`,
    ).run("boot@example.com", Date.now());

    const out = bootstrapInitialAdmin(db, { INITIAL_ADMIN_EMAIL: "boot@example.com" });
    expect(out.promoted).toBe(true);
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(1);
  });

  it("is idempotent on already-admin accounts", () => {
    db.prepare(
      `INSERT INTO accounts (email, password_hash, email_verified_at, created_at, admin)
       VALUES (?, 'dummy', NULL, ?, 1)`,
    ).run("boot@example.com", Date.now());

    const out = bootstrapInitialAdmin(db, { INITIAL_ADMIN_EMAIL: "boot@example.com" });
    expect(out.promoted).toBe(false);
  });
});

describe("signup integration with INITIAL_ADMIN_EMAIL", () => {
  let app: FastifyInstance;
  let db: Db;

  async function setup(env: NodeJS.ProcessEnv): Promise<void> {
    db = openDb(":memory:");
    applyMigrations(db, defaultMigrationsDir());
    Object.assign(process.env, env);
    const transport = captureTransport();
    const mailer = buildAuthMailer({ dashboardUrl: "https://t/", transport });
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

  it("promotes the brand-new account when env matches its email at signup time", async () => {
    await setup({ INITIAL_ADMIN_EMAIL: "first@example.com" });
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "first@example.com", password: "admin-bootstrap-pw" },
    });
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(1);
  });

  it("leaves a non-matching signup at admin=0", async () => {
    await setup({ INITIAL_ADMIN_EMAIL: "other@example.com" });
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "first@example.com", password: "admin-bootstrap-pw" },
    });
    const row = db.prepare<[], { admin: number }>("SELECT admin FROM accounts WHERE id = 1").get();
    expect(row?.admin).toBe(0);
  });
});
