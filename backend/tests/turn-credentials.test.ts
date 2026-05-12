import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { createServer } from "../src/server.js";

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
    app = await createServer({ port: 0, host: "127.0.0.1" });
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

describe("POST /turn-credentials — rate limiting", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    setTurnEnv();
    app = await createServer({ port: 0, host: "127.0.0.1" });
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
