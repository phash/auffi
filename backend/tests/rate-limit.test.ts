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
  app = await createServer({ port: 0, host: "127.0.0.1" });
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
