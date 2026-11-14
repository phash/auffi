import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimitPlugin from "@fastify/rate-limit";
import { WebSocket } from "ws";
import { createServer } from "../src/server.js";
import { registerTurnEndpoint } from "../src/turn-credentials.js";
import { SessionStore, TURN_CREDENTIALS_UP_FRONT } from "../src/codes.js";
import { UnattendedSessions } from "../src/unattended_sessions.js";

function setTurnEnv(): void {
  process.env.TURN_SHARED_SECRET = "test-secret-32-chars-minimum";
  process.env.TURN_HOSTS =
    "turn:turn.auffi.local:3478,turns:turn.auffi.local:5349";
  process.env.ALLOWED_ORIGINS = "http://localhost:5173";
}

function clearTurnEnv(): void {
  delete process.env.TURN_SHARED_SECRET;
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
    app = await createServer({ dbPath: ":memory:" });
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
    app = await createServer({ dbPath: ":memory:" });
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
    app = await createServer({ dbPath: ":memory:" });
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
    clearTurnEnv();
  });

  it("rate-limits to 10 requests per minute per IP", async () => {
    // Spread over three codes so no code's own issuance budget runs out
    // first — the per-IP limit is what is under test here.
    const sessions = [
      await obtainSessionCode(app),
      await obtainSessionCode(app),
      await obtainSessionCode(app),
    ];
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await turnPost(app, { code: sessions[i % 3].code });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    for (const { ws } of sessions) ws.close();
  });
});

// Every credential is a distinct TURN username, and coturn caps allocations
// server-wide. A live ad-hoc code was enough to mint them without end — and
// anyone gets a code by registering as a sharer. Issuance per code is
// therefore budgeted: a few up front (the viewer fetches BEFORE it joins),
// plus one pair (viewer + sharer) for every viewer that actually joins.
describe("POST /turn-credentials — per-code issuance budget", () => {
  let app: FastifyInstance;
  let store: SessionStore;

  beforeAll(async () => {
    store = new SessionStore({ ttlMs: 600_000 });
    app = Fastify();
    await app.register(rateLimitPlugin, { global: true, max: 1000, timeWindow: "1 minute" });
    registerTurnEndpoint(app, {
      sharedSecret: "test-secret-32-chars-minimum",
      urls: ["turn:turn.auffi.local:3478"],
      ttlSec: 3600,
      allowedOrigins: ["http://localhost:5173"],
      sessionStore: store,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // A fresh source address per request keeps the route's own 10/min/IP
  // limiter out of the picture — the per-code budget is what is under test.
  let nextIp = 1;
  async function status(code: string): Promise<number> {
    const res = await app.inject({
      method: "POST",
      url: "/turn-credentials",
      remoteAddress: `10.9.0.${nextIp++}`,
      headers: { origin: "http://localhost:5173" },
      payload: { code },
    });
    return res.statusCode;
  }

  it("refuses a code that nobody joins once its up-front budget is spent", async () => {
    const { code } = store.registerSharer({});
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push(await status(code));
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });

  it("serves a session with repeated viewer reconnects (viewer pre-join + sharer per join)", async () => {
    const { code } = store.registerSharer({});
    for (let round = 0; round < 6; round++) {
      const viewer = {};
      expect(await status(code), `viewer fetch, round ${round}`).toBe(200);
      store.attachViewer(code, viewer);
      store.markConfirmed(code);
      expect(await status(code), `sharer fetch, round ${round}`).toBe(200);
      store.detachViewer(viewer);
    }
  });
});

// The viewer fetches ICE servers BEFORE joining, so a connected unattended
// device must be accepted before any UnattendedSession exists — without that,
// cross-NAT unattended connects never got a relay. gh #139: that id is the
// number a helper types, not a secret, so the pre-join path is budgeted per
// device like an ad-hoc code, and only a verified password opens more.
describe("POST /turn-credentials — unattended device ids", () => {
  let app: FastifyInstance;
  let sessions: UnattendedSessions;
  const CONNECTED_DEVICE_ID = "321-654-987";

  beforeAll(async () => {
    sessions = new UnattendedSessions();
    app = Fastify();
    await app.register(rateLimitPlugin, { global: true, max: 1000, timeWindow: "1 minute" });
    registerTurnEndpoint(app, {
      sharedSecret: "test-secret-32-chars-minimum",
      urls: ["turn:turn.auffi.local:3478"],
      ttlSec: 3600,
      allowedOrigins: ["http://localhost:5173"],
      sessionStore: new SessionStore({ ttlMs: 600_000 }),
      unattendedSessions: sessions,
      unattendedRegistry: {
        has(id: string): boolean {
          return id === CONNECTED_DEVICE_ID;
        },
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let nextIp = 1;
  async function post(code: string): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: "POST",
      url: "/turn-credentials",
      remoteAddress: `10.8.0.${nextIp++}`,
      headers: { origin: "http://localhost:5173" },
      payload: { code },
    });
    return { status: res.statusCode, body: res.json() };
  }

  it("serves a connected device's pre-join fetches up to the up-front budget, then 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= TURN_CREDENTIALS_UP_FRONT; i++) statuses.push((await post(CONNECTED_DEVICE_ID)).status);
    expect(statuses).toEqual([...Array(TURN_CREDENTIALS_UP_FRONT).fill(200), 429]);
    expect((await post(CONNECTED_DEVICE_ID)).body).toEqual({ error: "turn credential budget exhausted" });
  });

  it("refuses a code with no session and no connected device", async () => {
    expect((await post("999-888-777")).status).toBe(403);
  });

  it("refuses a device id whose sharer is not connected, even with budget left", async () => {
    expect(sessions.claimViewerTurnCredential("111-222-333")).toBe("ok");
    expect((await post("111-222-333")).status).toBe(403);
  });
});
