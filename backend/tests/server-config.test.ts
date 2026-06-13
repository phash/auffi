import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createServer, CODE_TTL_HARD_CAP_MS } from "../src/server.js";
import type { FastifyInstance } from "fastify";

const savedEnv = { ...process.env };
afterEach(() => {
  // Restore every key we might have touched so tests stay independent.
  process.env = { ...savedEnv };
});

function recv(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (d) => resolve(JSON.parse(d.toString())));
  });
}

describe("code-TTL hard cap", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it("clamps an over-large SESSION_TTL_MS to the 10-minute hard cap", async () => {
    // An operator sets an hour — the ad-hoc code TTL must still cap at 10 min.
    process.env.SESSION_TTL_MS = String(60 * 60 * 1000);
    process.env.REGISTER_RATE_LIMIT_MAX = "1000";
    app = await createServer({ port: 0, host: "127.0.0.1", dbPath: ":memory:" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");

    const sharer = new WebSocket(`ws://127.0.0.1:${addr.port}/signal`, {
      headers: { origin: "http://127.0.0.1" },
    });
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const msg = await recv(sharer);
    sharer.close();

    expect(msg.type).toBe("code-assigned");
    expect(msg.expiresInSec as number).toBeLessThanOrEqual(CODE_TTL_HARD_CAP_MS / 1000);
  });
});

describe("production CORS fail-closed", () => {
  it("refuses to start in production without ALLOWED_ORIGINS", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ALLOWED_ORIGINS;
    await expect(
      createServer({ port: 0, host: "127.0.0.1", dbPath: ":memory:" }),
    ).rejects.toThrow(/ALLOWED_ORIGINS must be set in production/);
  });

  it("starts in production when ALLOWED_ORIGINS is set", async () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOWED_ORIGINS = "https://auffi.app";
    const app = await createServer({ port: 0, host: "127.0.0.1", dbPath: ":memory:" });
    expect(app).toBeTruthy();
    await app.close();
  });
});
