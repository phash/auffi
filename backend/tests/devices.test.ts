import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { decorateRequireSession } from "../src/auth/middleware.js";
import { registerAuthRoutes } from "../src/auth/handlers.js";
import { registerDeviceRoutes, normalizePairingCode } from "../src/devices/handlers.js";
import { captureTransport } from "../src/email/transport.js";
import { buildAuthMailer } from "../src/email/mailer.js";

async function build(): Promise<{ app: FastifyInstance; db: Db; cookie: () => Promise<string> }> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  const transport = captureTransport();
  const mailer = buildAuthMailer({ dashboardUrl: "https://t/", transport });
  const app = Fastify();
  // global: false means each route's `config.rateLimit` opts in
  // explicitly; the default cap is enforced PER route. The
  // per-route limits (pairing-code 5/h, redeem 5/min, PATCH 30/min,
  // DELETE 10/min) are what the regression tests below pin.
  await app.register(rateLimit, { global: false });
  decorateRequireSession(app, db);
  registerAuthRoutes(app, { db, mailer });
  registerDeviceRoutes(app, { db });
  await app.ready();

  async function cookie(): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "owner@example.com", password: "owner-account-pw" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@example.com", password: "owner-account-pw" },
    });
    const sc = login.headers["set-cookie"] as string | string[] | undefined;
    const raw = Array.isArray(sc) ? sc[0] : sc!;
    return raw.match(/^auffi_session=([^;]+)/)![1];
  }

  return { app, db, cookie };
}

describe("normalizePairingCode", () => {
  it("uppercases and strips punctuation but keeps dashes", () => {
    expect(normalizePairingCode("abc-d3f-7k")).toBe("ABC-D3F-7K");
    expect(normalizePairingCode("  abc-d3f-7k  ")).toBe("ABC-D3F-7K");
    expect(normalizePairingCode("a*b–c d3f 7k")).toBe("ABCD3F7K");
  });

  it("collapses runs of dashes", () => {
    expect(normalizePairingCode("abc--d3f---7k")).toBe("ABC-D3F-7K");
  });
});

describe("POST /api/devices/pairing-code", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("mints a code shaped XXX-XXX-XX and stores the hash", async () => {
    const c = await h.cookie();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/devices/pairing-code",
      headers: { cookie: `auffi_session=${c}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{2}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    const row = h.db
      .prepare<[number], { c: number }>(
        "SELECT COUNT(*) AS c FROM device_pairings WHERE account_id = ?",
      )
      .get(1);
    expect(row?.c).toBe(1);
  });

  it("requires auth (401 without cookie)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/devices/pairing-code",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/devices/redeem", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  async function mintCode(c: string): Promise<string> {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/devices/pairing-code",
      headers: { cookie: `auffi_session=${c}` },
    });
    return res.json().code;
  }

  it("redeems a fresh code → returns deviceId + token, persists device", async () => {
    const c = await h.cookie();
    const code = await mintCode(c);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code, alias: "Home-PC" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deviceId).toMatch(/^\d{3}-\d{3}-\d{3}$/);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBe(64);

    const dev = h.db
      .prepare<
        [string],
        { alias: string; auto_accept: number; token_hash: string }
      >("SELECT alias, auto_accept, token_hash FROM devices WHERE id = ?")
      .get(body.deviceId);
    expect(dev?.alias).toBe("Home-PC");
    expect(dev?.auto_accept).toBe(1);
    // token_hash must be an argon2id encoded string, NOT a plain hex sha
    expect(dev?.token_hash.startsWith("$argon2id$")).toBe(true);

    // Pairing marked used
    const pairings = h.db.prepare("SELECT COUNT(*) AS c FROM device_pairings WHERE used_at IS NOT NULL").get() as { c: number };
    expect(pairings.c).toBe(1);
  });

  it("rejects a second redeem of the same code with 410", async () => {
    const c = await h.cookie();
    const code = await mintCode(c);
    await h.app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code, alias: "First" },
    });
    const second = await h.app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code, alias: "Second" },
    });
    expect(second.statusCode).toBe(410);
  });

  it("rejects an expired code with 410", async () => {
    const c = await h.cookie();
    const code = await mintCode(c);
    h.db.prepare("UPDATE device_pairings SET expires_at = 1").run();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code, alias: "Late" },
    });
    expect(res.statusCode).toBe(410);
  });

  it("rejects a malformed code with 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code: "obviously wrong", alias: "Bad" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects empty alias with 400", async () => {
    const c = await h.cookie();
    const code = await mintCode(c);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code, alias: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a lowercase / whitespace-padded code via normalization", async () => {
    const c = await h.cookie();
    const code = await mintCode(c);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code: `  ${code.toLowerCase()}  `, alias: "Spaced" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /api/devices", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("lists devices owned by the account, with online=false when never heartbeated", async () => {
    const c = await h.cookie();
    const code = (
      await h.app.inject({
        method: "POST",
        url: "/api/devices/pairing-code",
        headers: { cookie: `auffi_session=${c}` },
      })
    ).json().code;
    await h.app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code, alias: "TheBox" },
    });

    const res = await h.app.inject({
      method: "GET",
      url: "/api/devices",
      headers: { cookie: `auffi_session=${c}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].alias).toBe("TheBox");
    expect(body.items[0].online).toBe(false);
    expect(body.items[0].autoAccept).toBe(true);
  });

  it("reports online=true when last_seen_at is within 90 s", async () => {
    const c = await h.cookie();
    const code = (
      await h.app.inject({
        method: "POST",
        url: "/api/devices/pairing-code",
        headers: { cookie: `auffi_session=${c}` },
      })
    ).json().code;
    const redeem = await h.app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code, alias: "TheBox" },
    });
    const deviceId: string = redeem.json().deviceId;

    h.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(Date.now(), deviceId);

    const res = await h.app.inject({
      method: "GET",
      url: "/api/devices",
      headers: { cookie: `auffi_session=${c}` },
    });
    expect(res.json().items[0].online).toBe(true);
  });

  it("does not list other accounts' devices", async () => {
    const c = await h.cookie();
    // Second account, paired + redeemed
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "other@example.com", password: "other-account-pw" },
    });
    const other = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "other@example.com", password: "other-account-pw" },
    });
    const sc = other.headers["set-cookie"] as string | string[] | undefined;
    const otherCookie = (Array.isArray(sc) ? sc[0] : sc!).match(/^auffi_session=([^;]+)/)![1];
    const otherCode = (
      await h.app.inject({
        method: "POST",
        url: "/api/devices/pairing-code",
        headers: { cookie: `auffi_session=${otherCookie}` },
      })
    ).json().code;
    await h.app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code: otherCode, alias: "OtherBox" },
    });

    // First account's GET shouldn't see the other account's device
    const res = await h.app.inject({
      method: "GET",
      url: "/api/devices",
      headers: { cookie: `auffi_session=${c}` },
    });
    expect(res.json().items).toHaveLength(0);
  });

  it("requires auth (401 without cookie)", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/devices" });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /api/devices/:id", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  let deviceId: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.cookie();
    const code = (
      await h.app.inject({
        method: "POST",
        url: "/api/devices/pairing-code",
        headers: { cookie: `auffi_session=${cookie}` },
      })
    ).json().code;
    deviceId = (
      await h.app.inject({
        method: "POST",
        url: "/api/devices/redeem",
        payload: { code, alias: "original-alias" },
      })
    ).json().deviceId;
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("updates alias", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: `auffi_session=${cookie}` },
      payload: { alias: "renamed" },
    });
    expect(res.statusCode).toBe(200);
    const row = h.db.prepare("SELECT alias FROM devices WHERE id = ?").get(deviceId) as {
      alias: string;
    };
    expect(row.alias).toBe("renamed");
  });

  it("updates auto_accept", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: `auffi_session=${cookie}` },
      payload: { auto_accept: false },
    });
    expect(res.statusCode).toBe(200);
    const row = h.db.prepare("SELECT auto_accept FROM devices WHERE id = ?").get(deviceId) as {
      auto_accept: number;
    };
    expect(row.auto_accept).toBe(0);
  });

  it("rejects empty alias with 400", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: `auffi_session=${cookie}` },
      payload: { alias: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects 81-character alias with 400", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: `auffi_session=${cookie}` },
      payload: { alias: "x".repeat(81) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-bool auto_accept with 400", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: `auffi_session=${cookie}` },
      payload: { auto_accept: "no" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects with 400 when no changes are specified", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: `auffi_session=${cookie}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 (NOT 404) when the device belongs to another account", async () => {
    // Mint a second account + device
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "rival@example.com", password: "rival-account-pw" },
    });
    const rivalLogin = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "rival@example.com", password: "rival-account-pw" },
    });
    const sc = rivalLogin.headers["set-cookie"] as string | string[] | undefined;
    const rivalCookie = (Array.isArray(sc) ? sc[0] : sc!).match(/^auffi_session=([^;]+)/)![1];

    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: `auffi_session=${rivalCookie}` },
      payload: { alias: "stolen" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 (not 404) when the device id does not exist", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: "/api/devices/999-999-999",
      headers: { cookie: `auffi_session=${cookie}` },
      payload: { alias: "ghost" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 when anonymous", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      payload: { alias: "anon" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/devices/:id", () => {
  let h: Awaited<ReturnType<typeof build>>;
  let cookie: string;
  let deviceId: string;
  beforeEach(async () => {
    h = await build();
    cookie = await h.cookie();
    const code = (
      await h.app.inject({
        method: "POST",
        url: "/api/devices/pairing-code",
        headers: { cookie: `auffi_session=${cookie}` },
      })
    ).json().code;
    deviceId = (
      await h.app.inject({
        method: "POST",
        url: "/api/devices/redeem",
        payload: { code, alias: "to-delete" },
      })
    ).json().deviceId;
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("hard-deletes the device and cascades connection_log", async () => {
    // Plant a connection_log row to verify cascade.
    h.db
      .prepare(
        `INSERT INTO connection_log (device_id, started_at, viewer_ip_prefix, connection_type)
         VALUES (?, ?, ?, ?)`,
      )
      .run(deviceId, Date.now(), "84.xxx", "p2p");

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: `auffi_session=${cookie}` },
    });
    expect(res.statusCode).toBe(204);

    const dev = h.db.prepare("SELECT COUNT(*) AS c FROM devices WHERE id = ?").get(deviceId) as {
      c: number;
    };
    expect(dev.c).toBe(0);
    const log = h.db
      .prepare("SELECT COUNT(*) AS c FROM connection_log WHERE device_id = ?")
      .get(deviceId) as { c: number };
    expect(log.c).toBe(0);
  });

  it("returns 403 on cross-account access (NOT 404)", async () => {
    await h.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "thief@example.com", password: "thief-account-pw" },
    });
    const tl = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "thief@example.com", password: "thief-account-pw" },
    });
    const sc = tl.headers["set-cookie"] as string | string[] | undefined;
    const thiefCookie = (Array.isArray(sc) ? sc[0] : sc!).match(/^auffi_session=([^;]+)/)![1];

    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: `auffi_session=${thiefCookie}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 when anonymous", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/devices/${deviceId}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// TC H-6 / H-7 (review 2026-05-13): pin the per-route rate limits.
// Without these, a silent halving of the limit in handlers.ts ships
// unnoticed — the production deploy has no other backstop because
// Caddy's global zone tops out at 300/min/IP and these routes were
// excluded from the auth-bucket already.
describe("device-route rate limits (TC H-6 / H-7 / Sec M-5)", () => {
  let h: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it("POST /api/devices/pairing-code locks the 6th call within the hour (limit: 5)", async () => {
    const c = await h.cookie();
    for (let i = 0; i < 5; i++) {
      const ok = await h.app.inject({
        method: "POST",
        url: "/api/devices/pairing-code",
        headers: { cookie: `auffi_session=${c}` },
      });
      expect(ok.statusCode).toBe(200);
    }
    const sixth = await h.app.inject({
      method: "POST",
      url: "/api/devices/pairing-code",
      headers: { cookie: `auffi_session=${c}` },
    });
    expect(sixth.statusCode).toBe(429);
  });

  it("POST /api/devices/redeem locks the 6th call within the minute (limit: 5)", async () => {
    // Each call uses an invalid code so the route exits early but
    // still after the rate-limit hook runs. The 6th call's 429
    // proves the limit is in place.
    for (let i = 0; i < 5; i++) {
      const r = await h.app.inject({
        method: "POST",
        url: "/api/devices/redeem",
        payload: { code: "XYZ-XYZ-99", alias: "test" },
      });
      // Either 410 (code-invalid) or 400 (bad-code) is fine —
      // we only care that they aren't 429 yet.
      expect(r.statusCode).not.toBe(429);
    }
    const sixth = await h.app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code: "XYZ-XYZ-99", alias: "test" },
    });
    expect(sixth.statusCode).toBe(429);
  });

  it("PATCH /api/devices/:id locks the 31st call within the minute (limit: 30)", async () => {
    const c = await h.cookie();
    // Mint a device by redeeming a real pairing code first so the
    // PATCH route hits a real row, not a 403-forbidden short-circuit.
    const mint = await h.app.inject({
      method: "POST",
      url: "/api/devices/pairing-code",
      headers: { cookie: `auffi_session=${c}` },
    });
    const code = mint.json().code;
    const redeem = await h.app.inject({
      method: "POST",
      url: "/api/devices/redeem",
      payload: { code, alias: "loop-test-dev" },
    });
    const deviceId = redeem.json().deviceId;

    for (let i = 0; i < 30; i++) {
      const r = await h.app.inject({
        method: "PATCH",
        url: `/api/devices/${deviceId}`,
        headers: { cookie: `auffi_session=${c}` },
        payload: { alias: `name-${i}` },
      });
      expect(r.statusCode).toBe(200);
    }
    const overflow = await h.app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: `auffi_session=${c}` },
      payload: { alias: "burst-overflow" },
    });
    expect(overflow.statusCode).toBe(429);
  });

  it("DELETE /api/devices/:id locks the 11th call within the minute (limit: 10)", async () => {
    const c = await h.cookie();
    // 11 calls against a non-existent id all 403 quickly (route
    // short-circuits on ownership check) BUT pass through the
    // rate-limit hook first, so the 11th hits the cap.
    for (let i = 0; i < 10; i++) {
      const r = await h.app.inject({
        method: "DELETE",
        url: "/api/devices/000-000-000",
        headers: { cookie: `auffi_session=${c}` },
      });
      expect(r.statusCode).toBe(403);
    }
    const eleventh = await h.app.inject({
      method: "DELETE",
      url: "/api/devices/000-000-000",
      headers: { cookie: `auffi_session=${c}` },
    });
    expect(eleventh.statusCode).toBe(429);
  });
});
