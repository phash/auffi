import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { decorateRequireSession } from "../src/auth/middleware.js";
import { registerAuthRoutes } from "../src/auth/handlers.js";
import { registerFeedbackRoutes } from "../src/feedback/handlers.js";
import { captureTransport } from "../src/email/transport.js";
import { buildAuthMailer } from "../src/email/mailer.js";
import { hashPassword } from "../src/auth/argon.js";

// A bearer cap of 1/window so the second sharer attempt trips immediately.
async function build(): Promise<{ app: FastifyInstance; db: Db }> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const mailer = buildAuthMailer({ dashboardUrl: "https://t/", transport: captureTransport() });
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  decorateRequireSession(app, db);
  registerAuthRoutes(app, { db, mailer });
  registerFeedbackRoutes(app, db, { bearerRateLimit: { windowMs: 60_000, max: 1 } });
  await app.ready();
  return { app, db };
}

const token = "deadbeef".repeat(8);
const deviceId = "555-555-555";

describe("POST /api/feedback bearer-auth rate limit (gates argon2 before verify)", () => {
  let h: Awaited<ReturnType<typeof build>>;

  beforeEach(async () => {
    h = await build();
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

  async function postSharer(authHeader: string): Promise<number> {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: { authorization: authHeader, "x-auffi-device-id": deviceId },
      payload: { source: "sharer", category: "bug", rating: 3, body: "hi" },
    });
    return res.statusCode;
  }

  it("429s the second valid sharer Bearer attempt within the window", async () => {
    expect(await postSharer(`Bearer ${token}`)).toBe(202);
    expect(await postSharer(`Bearer ${token}`)).toBe(429);
  });

  it("counts a wrong-but-wellformed Bearer toward the cap (the argon2 path is gated)", async () => {
    expect(await postSharer("Bearer " + "ff".repeat(32))).toBe(401);
    // Second attempt is rejected BEFORE the expensive verify runs.
    expect(await postSharer("Bearer " + "ff".repeat(32))).toBe(429);
  });

  it("does not apply the bearer cap to the cookie (dashboard) path", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "u@example.com", password: "dash-pw-12345678" },
    });
    const login = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "u@example.com", password: "dash-pw-12345678" },
    });
    const sc = login.headers["set-cookie"] as string | string[] | undefined;
    const cookie = (Array.isArray(sc) ? sc[0] : sc!).match(/^__Host-auffi_session=([^;]+)/)![1];

    for (let i = 0; i < 3; i++) {
      const res = await h.app.inject({
        method: "POST",
        url: "/api/feedback",
        headers: { cookie: `__Host-auffi_session=${cookie}` },
        payload: { source: "dashboard", category: "praise", rating: 5, body: "nice" },
      });
      expect(res.statusCode).toBe(202);
    }
  });
});
