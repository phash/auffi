import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
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
    const res = await fetch(`${getBaseUrl(app)}/turn-credentials`, {
      method: "POST",
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TurnBody;
    expect(body.urls).toContain("turn:turn.auffi.local:3478");
    expect(body.username).toMatch(/^\d+:[a-z0-9-]+$/);
    expect(body.credential).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(body.ttl).toBeGreaterThan(60);
  });

  it("username encodes the unix timestamp + identifier", async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await fetch(`${getBaseUrl(app)}/turn-credentials`, {
      method: "POST",
      headers: { Origin: "http://localhost:5173" },
    });
    const body = (await res.json()) as TurnBody;
    const [tsStr] = body.username.split(":");
    const ts = Number(tsStr);
    expect(ts).toBeGreaterThanOrEqual(before + body.ttl - 5);
    expect(ts).toBeLessThanOrEqual(before + body.ttl + 5);
  });

  it("credential is HMAC-SHA1(secret, username) base64", async () => {
    const res = await fetch(`${getBaseUrl(app)}/turn-credentials`, {
      method: "POST",
      headers: { Origin: "http://localhost:5173" },
    });
    const body = (await res.json()) as TurnBody;
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha1", "test-secret-32-chars-minimum")
      .update(body.username)
      .digest("base64");
    expect(body.credential).toBe(expected);
  });

  it("rejects POST from a disallowed origin with 403", async () => {
    const res = await fetch(`${getBaseUrl(app)}/turn-credentials`, {
      method: "POST",
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST with no Origin header with 403", async () => {
    const res = await fetch(`${getBaseUrl(app)}/turn-credentials`, {
      method: "POST",
    });
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
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${getBaseUrl(app)}/turn-credentials`, {
        method: "POST",
        headers: { Origin: "http://localhost:5173" },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
