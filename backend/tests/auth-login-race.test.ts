import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { registerAuthRoutes } from "../src/auth/handlers.js";
import { captureTransport, type CaptureTransport } from "../src/email/transport.js";
import { buildAuthMailer } from "../src/email/mailer.js";
import { verifyPasswordTimingSafe } from "../src/auth/argon.js";

// The login handler reads the account row, then spends ~250 ms in argon2,
// then decides. These tests hold argon2 open with a deferred promise so a
// suspend / password reset can land inside that window deterministically.
// Lives in its own file: auth.test.ts relies on the real argon2 timing.
vi.mock("../src/auth/argon.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/argon.js")>();
  return { ...actual, verifyPasswordTimingSafe: vi.fn(actual.verifyPasswordTimingSafe) };
});

const verifyMock = vi.mocked(verifyPasswordTimingSafe);

/**
 * A promise the test resolves by hand, plus a signal that the handler has
 * actually started awaiting it (so the concurrent mutation lands INSIDE
 * the argon2 window, not before the account row was read).
 */
function argonGate(): { entered: Promise<void>; release: (ok: boolean) => void } {
  let markEntered!: () => void;
  let release!: (ok: boolean) => void;
  const entered = new Promise<void>((r) => (markEntered = r));
  const result = new Promise<boolean>((r) => (release = r));
  verifyMock.mockImplementationOnce(() => {
    markEntered();
    return result;
  });
  return { entered, release };
}

async function build(): Promise<{ app: FastifyInstance; db: Db; transport: CaptureTransport }> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const transport = captureTransport();
  const mailer = buildAuthMailer({ dashboardUrl: "https://t/", transport });
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  registerAuthRoutes(app, { db, mailer });
  await app.ready();
  return { app, db, transport };
}

const EMAIL = "racer@example.com";
const OLD_PW = "old-password-123";

describe("POST /api/auth/login — decisions taken after the argon2 await", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    verifyMock.mockReset();
    h = await build();
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: EMAIL, password: OLD_PW },
    });
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  function sessionCount(): number {
    return (h.db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c;
  }

  it("refuses with 403 when the account was suspended while argon2 was running", async () => {
    const gate = argonGate();
    const pending = h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: OLD_PW },
    });
    await gate.entered;

    // What PATCH /api/admin/users/:id {action:"suspend"} does.
    h.db.prepare("UPDATE accounts SET suspended_at = ? WHERE email = ?").run(Date.now(), EMAIL);
    h.db.prepare("DELETE FROM sessions").run();

    gate.release(true);
    const res = await pending;
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("account-suspended");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(sessionCount()).toBe(0);
  });

  it("refuses with 401 when the password was reset while argon2 verified the old one", async () => {
    const gate = argonGate();
    const pending = h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: OLD_PW },
    });
    await gate.entered;

    await h.app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: EMAIL } });
    const token = h.transport.captured[1].text.match(/\/reset\/([A-Za-z0-9_-]+)/)![1];
    const reset = await h.app.inject({
      method: "POST",
      url: `/api/auth/reset/${token}`,
      payload: { password: "brand-new-password-456" },
    });
    expect(reset.statusCode).toBe(200);

    gate.release(true);
    const res = await pending;
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("bad-credentials");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(sessionCount()).toBe(0);
  });

  it("still issues a session when nothing changed during argon2", async () => {
    const gate = argonGate();
    const pending = h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: OLD_PW },
    });
    await gate.entered;
    gate.release(true);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(sessionCount()).toBe(1);
  });
});
