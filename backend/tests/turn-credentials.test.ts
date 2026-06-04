import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimitPlugin from "@fastify/rate-limit";
import { WebSocket } from "ws";
import { createServer } from "../src/server.js";
import { registerTurnEndpoint } from "../src/turn-credentials.js";
import { SessionStore } from "../src/codes.js";

function setTurnEnv(): void {
  process.env.TURN_SHARED_SECRET = "test-secret-32-chars-minimum";
  process.env.TURN_REALM = "turn.auffi.local";
  process.env.TURN_HOSTS =
    "turn:turn.auffi.local:3478,turns:turn.auffi.local:5349";
  process.env.ALLOWED_ORIGINS = "http://localhost:5173";
}

function clearTurnEnv(): void {
  delete process.env.TURN_SHARED_SECRET;
  delete process.env.TURN_REALM;
  delete process.env.TURN_HOSTS;
  delete process.env.ALLOWED_ORIGINS;
}

type TurnBody = {
  urls: string[];
  username: string;
  credential: string;
  ttl: number;
};

function getBaseUrl(app: FastifyInstance): string {
  const addr = app.server.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  return `http://127.0.0.1:${addr.port}`;
}

/**
 * Spin up a sharer WS, register, and return the assigned 9-digit code.
 * Tests gating-by-session need a live session in the store before they
 * can hit POST /turn-credentials with a valid code (gh #60).
 */
async function obtainSessionCode(app: FastifyInstance): Promise<{ code: string; ws: WebSocket }> {
  const addr = app.server.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/signal`, {
    headers: { origin: "http://localhost:5173" },
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "register", role: "sharer" }));
  const msg: { type: string; code: string } = await new Promise((r) =>
    ws.once("message", (data: Buffer) => r(JSON.parse(data.toString()))),
  );
  if (msg.type !== "code-assigned") throw new Error("expected code-assigned");
  return { code: msg.code, ws };
}

function turnPost(
  app: FastifyInstance,
  opts: { code?: string; origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers["Origin"] = opts.origin ?? "http://localhost:5173";
  if (opts.code !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${getBaseUrl(app)}/turn-credentials`, {
    method: "POST",
    headers,
    body: opts.code !== undefined ? JSON.stringify({ code: opts.code }) : undefined,
  });
}

describe("POST /turn-credentials — credentials", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    setTurnEnv();
    app = await createServer({ port: 0, host: "127.0.0.1", dbPath: ":memory:" });
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
    clearTurnEnv();
  });

  it("returns ephemeral credentials with TURN URLs from allowed origin", async () => {
    const { code, ws } = await obtainSessionCode(app);
    const res = await turnPost(app, { code });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TurnBody;
    expect(body.urls).toContain("turn:turn.auffi.local:3478");
    expect(body.username).toMatch(/^\d+:[a-z0-9-]+$/);
    expect(body.credential).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(body.ttl).toBeGreaterThan(60);
    ws.close();
  });

  it("username encodes the unix timestamp + identifier", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { code, ws } = await obtainSessionCode(app);
    const res = await turnPost(app, { code });
    const body = (await res.json()) as TurnBody;
    const [tsStr] = body.username.split(":");
    const ts = Number(tsStr);
    expect(ts).toBeGreaterThanOrEqual(before + body.ttl - 5);
    expect(ts).toBeLessThanOrEqual(before + body.ttl + 5);
    ws.close();
  });

  it("credential is HMAC-SHA1(secret, username) base64", async () => {
    const { code, ws } = await obtainSessionCode(app);
    const res = await turnPost(app, { code });
    const body = (await res.json()) as TurnBody;
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha1", "test-secret-32-chars-minimum")
      .update(body.username)
      .digest("base64");
    expect(body.credential).toBe(expected);
    ws.close();
  });

  it("rejects POST from a disallowed origin with 403", async () => {
    const { code, ws } = await obtainSessionCode(app);
    const res = await turnPost(app, { code, origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
    ws.close();
  });

  it("rejects POST with no Origin header with 403", async () => {
    const { code, ws } = await obtainSessionCode(app);
    const res = await turnPost(app, { code, origin: null });
    expect(res.status).toBe(403);
    ws.close();
  });

  it("rejects POST without session code with 403 (gh #60)", async () => {
    // Even with a valid Origin, no code means no active session — refuse.
    const res = await turnPost(app, {});
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("session");
  });

  it("rejects POST with unknown session code with 403 (gh #60)", async () => {
    const res = await turnPost(app, { code: "999-999-999" });
    expect(res.status).toBe(403);
  });

  it("rejects POST with malformed session code with 403 (gh #60)", async () => {
    const res = await turnPost(app, { code: "not-a-code" });
    expect(res.status).toBe(403);
  });

  it("preflight from evil origin does not expose Access-Control-Allow-Origin", async () => {
    const res = await fetch(`${getBaseUrl(app)}/turn-credentials`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    const acao = res.headers.get("Access-Control-Allow-Origin");
    expect(acao).not.toBe("https://evil.example.com");
  });
});

describe("POST /turn-credentials — TURN_SHARED_SECRET unset", () => {
  // If the operator forgets to set TURN_SHARED_SECRET, server.ts logs a
  // warning and intentionally does NOT register /turn-credentials — a
  // safer default than serving credentials that resolve to "no secret".
  // This test pins the "no route registered" outcome so a regression
  // can't accidentally register the route with an empty secret. (gh #83)
  let app: FastifyInstance;

  beforeAll(async () => {
    setTurnEnv();
    delete process.env.TURN_SHARED_SECRET; // explicit
    app = await createServer({ port: 0, host: "127.0.0.1", dbPath: ":memory:" });
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
    clearTurnEnv();
  });

  it("returns 404 for POST /turn-credentials (route not registered)", async () => {
    const res = await fetch(`${getBaseUrl(app)}/turn-credentials`, {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123-456-789" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /turn-credentials — rate limiting", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    setTurnEnv();
    app = await createServer({ port: 0, host: "127.0.0.1", dbPath: ":memory:" });
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
    clearTurnEnv();
  });

  it("rate-limits to 10 requests per minute per IP", async () => {
    const { code, ws } = await obtainSessionCode(app);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await turnPost(app, { code });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    ws.close();
  });
});

describe("POST /turn-credentials — unattended session gate", () => {
  // Tests that a code with no ad-hoc session but a live unattended
  // session → 200, and both missing → 403.
  let app: FastifyInstance;
  let baseUrl: string;
  const LIVE_DEVICE_ID = "123-456-789";
  const DEAD_CODE = "000-000-000";

  beforeAll(async () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    // No ad-hoc sessions registered — only the unattended stub has the code.
    const unattendedSessions = {
      findByDeviceId(id: string): object | null {
        return id === LIVE_DEVICE_ID ? { deviceId: id } : null;
      },
    };

    app = Fastify();
    await app.register(rateLimitPlugin, { global: true, max: 100, timeWindow: "1 minute" });
    registerTurnEndpoint(app, {
      sharedSecret: "test-secret-32-chars-minimum",
      realm: "turn.auffi.local",
      urls: ["turn:turn.auffi.local:3478"],
      ttlSec: 3600,
      allowedOrigins: ["http://localhost:5173"],
      sessionStore: store,
      unattendedSessions,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  async function post(code: string): Promise<Response> {
    return fetch(`${baseUrl}/turn-credentials`, {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  }

  it("issues credentials when no ad-hoc session exists but a live unattended session matches the deviceId", async () => {
    const res = await post(LIVE_DEVICE_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { urls: string[]; username: string };
    expect(body.urls).toContain("turn:turn.auffi.local:3478");
    expect(body.username).toMatch(/^\d+:[a-z0-9-]+$/);
  });

  it("returns 403 when neither ad-hoc nor unattended session matches the code", async () => {
    const res = await post(DEAD_CODE);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("session");
  });
});
