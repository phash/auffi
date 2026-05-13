import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import { createServer } from "../src/server.js";

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = await createServer({ port: 0, host: "127.0.0.1", dbPath: ":memory:" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
});

describe("GET /healthz", () => {
  it("returns 200 with status ok", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; version: string; uptime: number };
    expect(body.status).toBe("ok");
  });

  it("includes version field (defaults to 'dev' when APP_VERSION unset)", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = await res.json() as { status: string; version: string; uptime: number };
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });

  it("includes uptime as a non-negative integer", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = await res.json() as { status: string; version: string; uptime: number };
    expect(Number.isInteger(body.uptime)).toBe(true);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /readyz", () => {
  it("returns 200 with status ok", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; version: string; uptime: number };
    expect(body.status).toBe("ok");
  });

  it("includes the same shape as /healthz", async () => {
    const [healthRes, readyRes] = await Promise.all([
      fetch(`${baseUrl}/healthz`),
      fetch(`${baseUrl}/readyz`),
    ]);
    const health = await healthRes.json() as { status: string; version: string; uptime: number };
    const ready = await readyRes.json() as { status: string; version: string; uptime: number };
    expect(Object.keys(ready).sort()).toEqual(Object.keys(health).sort());
    expect(ready.status).toBe(health.status);
    expect(ready.version).toBe(health.version);
  });
});
