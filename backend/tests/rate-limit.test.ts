import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { createServer } from "../src/server.js";

let app: FastifyInstance;
let url: string;

function openWs(target: string): WebSocket {
  return new WebSocket(target, { headers: { origin: "http://127.0.0.1" } });
}

beforeAll(async () => {
  // Other suites raise RATE_LIMIT_MAX to 1000 for their join-heavy flows;
  // this file pins the production default and must not inherit that.
  delete process.env.RATE_LIMIT_MAX;
  app = await createServer({ port: 0, host: "127.0.0.1", dbPath: ":memory:" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  url = `ws://127.0.0.1:${addr.port}/signal`;
});

afterAll(async () => {
  await app.close();
});

describe("rate limiting", () => {
  it("rate-limits more than 5 invalid joins per minute from same IP", async () => {
    const attempts = [];
    for (let i = 0; i < 7; i++) {
      const ws = openWs(url);
      await new Promise((r) => ws.once("open", r));
      ws.send(JSON.stringify({ type: "join", role: "viewer", code: "000-000-000" }));
      const msg = await new Promise<{ type: string; code: string }>((r) =>
        ws.once("message", (d) => r(JSON.parse(d.toString())))
      );
      attempts.push(msg);
      ws.close();
    }
    // First 5 should be "invalid-code", 6th+ should be "rate-limit"
    expect(attempts.slice(0, 5).every((m) => m.code === "invalid-code")).toBe(true);
    expect(attempts.slice(5).every((m) => m.code === "rate-limit")).toBe(true);
  });
});

// CLAUDE.md § Product Goals promises the 9-digit code is "bounded against
// guessing by a per-IP rate-limit (5/min)". That only holds if the budget is
// checked BEFORE the code lookup — otherwise an IP that burned its budget on
// wrong guesses still gets attached on its first correct one, and the limiter
// merely rewords the error on misses.
describe("join rate limit gates correct guesses too", () => {
  let limitedApp: FastifyInstance;
  let limitedUrl: string;

  beforeAll(async () => {
    delete process.env.RATE_LIMIT_MAX;
    limitedApp = await createServer({ port: 0, host: "127.0.0.1", dbPath: ":memory:" });
    await limitedApp.listen({ port: 0, host: "127.0.0.1" });
    const addr = limitedApp.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    limitedUrl = `ws://127.0.0.1:${addr.port}/signal`;
  });

  afterAll(async () => {
    await limitedApp.close();
  });

  function recv(ws: WebSocket): Promise<{ type: string; code?: string }> {
    return new Promise((r) => ws.once("message", (d) => r(JSON.parse(d.toString()))));
  }

  async function joinOnce(code: string): Promise<{ type: string; code?: string }> {
    const ws = openWs(limitedUrl);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "join", role: "viewer", code }));
    const msg = await recv(ws);
    ws.close();
    return msg;
  }

  it("an IP that exhausted its budget on wrong codes cannot attach with the right one", async () => {
    const sharer = openWs(limitedUrl);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = (await recv(sharer)) as { code: string };
    const sharerInbox: unknown[] = [];
    sharer.on("message", (d) => sharerInbox.push(JSON.parse(d.toString())));

    for (let i = 0; i < 5; i++) {
      expect((await joinOnce("000-000-001")).code).toBe("invalid-code");
    }

    const guess = await joinOnce(code);
    expect(guess).toEqual({ type: "error", code: "rate-limit", message: "too many attempts" });
    await new Promise((r) => setTimeout(r, 80));
    expect(sharerInbox).toEqual([]);
    sharer.close();
  });
});
