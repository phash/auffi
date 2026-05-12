import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import WebSocket from "ws";
import websocketPlugin from "@fastify/websocket";
import { createServer } from "../src/server.js";
import { registerSignaling } from "../src/signaling.js";
import { SessionStore } from "../src/codes.js";

let app: FastifyInstance;
let url: string;

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

function openWs(target: string): WebSocket {
  return new WebSocket(target, { headers: { origin: "http://127.0.0.1" } });
}

function recv(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

/**
 * Connect a sharer + viewer pair, complete code-assigned → join →
 * peer-joined → confirm → peer-confirmed, and return the open sockets.
 *
 * Backend silently drops relay messages from a peer that is not yet
 * confirmed (no error response) — tests that exercise relay-validation
 * need a fully-confirmed pair before they can observe the validation
 * behaviour.
 */
async function establishConfirmedPair(target: string): Promise<{ sharer: WebSocket; viewer: WebSocket }> {
  const sharer = openWs(target);
  await new Promise((r) => sharer.once("open", r));
  sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
  const { code } = await recv(sharer);

  const viewer = openWs(target);
  await new Promise((r) => viewer.once("open", r));
  viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
  await recv(sharer); // peer-joined

  sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
  await recv(viewer); // peer-confirmed
  return { sharer, viewer };
}

describe("signaling handshake", () => {
  it("sharer registers and gets a code", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const msg = await recv(sharer);
    expect(msg.type).toBe("code-assigned");
    expect(msg.code).toMatch(/^\d{3}-\d{3}-\d{3}$/);
    sharer.close();
  });

  it("viewer joins with valid code and sharer receives peer-joined", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const assigned = await recv(sharer);
    const code = assigned.code;

    const viewer = openWs(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));

    const peerJoined = await recv(sharer);
    expect(peerJoined.type).toBe("peer-joined");

    sharer.close();
    viewer.close();
  });

  it("viewer with invalid code receives error", async () => {
    const viewer = openWs(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(
      JSON.stringify({ type: "join", role: "viewer", code: "000-000-000" })
    );
    const err = await recv(viewer);
    expect(err.type).toBe("error");
    expect(err.code).toBe("invalid-code");
    viewer.close();
  });

  it("sharer confirms, viewer receives peer-confirmed", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    const viewer = openWs(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined

    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
    const confirmed = await recv(viewer);
    expect(confirmed.type).toBe("peer-confirmed");

    sharer.close();
    viewer.close();
  });

  it("relay message flows from viewer to sharer", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    const viewer = openWs(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined

    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
    await recv(viewer); // peer-confirmed

    viewer.send(
      JSON.stringify({ type: "relay", payload: { kind: "hello", ts: 0 } })
    );
    const relayed = await recv(sharer);
    expect(relayed.type).toBe("relay");
    expect(relayed.payload).toEqual({ kind: "hello", ts: 0 });

    sharer.close();
    viewer.close();
  });

  it("relay message flows from sharer to viewer", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    const viewer = openWs(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined

    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
    await recv(viewer); // peer-confirmed

    sharer.send(
      JSON.stringify({ type: "relay", payload: { kind: "hello", ts: 1 } })
    );
    const relayed = await recv(viewer);
    expect(relayed.type).toBe("relay");
    expect(relayed.payload).toEqual({ kind: "hello", ts: 1 });

    sharer.close();
    viewer.close();
  });

  it("confirm with accepted:false → viewer receives peer-rejected, session cleaned up", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    const viewer = openWs(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined

    sharer.send(JSON.stringify({ type: "confirm", accepted: false }));
    const rejected = await recv(viewer);
    expect(rejected.type).toBe("peer-rejected");
    expect(rejected.reason).toBe("declined");

    // viewer socket should close after rejection
    await new Promise<void>((r) => {
      if (viewer.readyState === WebSocket.CLOSED) return r();
      viewer.once("close", () => r());
    });
    expect(viewer.readyState).toBe(WebSocket.CLOSED);
  });

  it("viewer disconnect → session kept, new viewer can attach with same code", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    // first viewer joins and then disconnects
    const viewer1 = openWs(url);
    await new Promise((r) => viewer1.once("open", r));
    viewer1.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined

    // close viewer — sharer session should survive
    viewer1.close();
    // wait a tick for the close event to propagate on the server side
    await new Promise((r) => setTimeout(r, 50));

    // second viewer can now attach with the same code
    const viewer2 = openWs(url);
    await new Promise((r) => viewer2.once("open", r));
    viewer2.send(JSON.stringify({ type: "join", role: "viewer", code }));
    const peerJoined2 = await recv(sharer);
    expect(peerJoined2.type).toBe("peer-joined");

    sharer.close();
    viewer2.close();
  });

  it("invalid JSON → receives bad-message error and connection stays open", async () => {
    const ws = openWs(url);
    await new Promise((r) => ws.once("open", r));
    ws.send("not-valid-json{{{");
    const err = await recv(ws);
    expect(err.type).toBe("error");
    expect(err.code).toBe("bad-message");
    ws.close();
  });

  it("unexpected message type after register → bad-message error", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    await recv(sharer); // code-assigned

    sharer.send(JSON.stringify({ type: "unknown-type", data: 42 }));
    const err = await recv(sharer);
    expect(err.type).toBe("error");
    expect(err.code).toBe("bad-message");

    sharer.close();
  });

  it("relay payload with invalid kind → bad-message error, not forwarded", async () => {
    const { sharer, viewer } = await establishConfirmedPair(url);

    // Inject an unexpected kind that the backend must reject (defence in
    // depth — protocol only allows sdp/ice/hello/bye). The viewer must not
    // receive the message.
    let viewerReceivedRelay = false;
    viewer.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === "relay") viewerReceivedRelay = true;
    });

    sharer.send(JSON.stringify({ type: "relay", payload: { kind: "exec", cmd: "rm -rf /" } }));
    const err = await recv(sharer);
    expect(err.type).toBe("error");
    expect(err.code).toBe("bad-message");
    expect(err.message).toContain("relay");

    // Give any (forbidden) forwarded message a moment to arrive
    await new Promise((r) => setTimeout(r, 100));
    expect(viewerReceivedRelay).toBe(false);

    sharer.close();
    viewer.close();
  });

  it("relay payload missing kind → bad-message error", async () => {
    const { sharer, viewer } = await establishConfirmedPair(url);

    sharer.send(JSON.stringify({ type: "relay", payload: { foo: "bar" } }));
    const err = await recv(sharer);
    expect(err.type).toBe("error");
    expect(err.code).toBe("bad-message");

    sharer.close();
    viewer.close();
  });

  it("relay with payload that is not an object → bad-message error", async () => {
    const { sharer, viewer } = await establishConfirmedPair(url);

    sharer.send(JSON.stringify({ type: "relay", payload: "string-not-object" }));
    const err = await recv(sharer);
    expect(err.type).toBe("error");
    expect(err.code).toBe("bad-message");

    sharer.close();
    viewer.close();
  });

  it("viewer joins with un-dashed code and matches canonical session", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer); // e.g. "284-915-073"

    // Remove dashes → "284915073"
    const undashed = code.replace(/-/g, "");

    const viewer = openWs(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: undashed }));

    const peerJoined = await recv(sharer);
    expect(peerJoined.type).toBe("peer-joined");

    sharer.close();
    viewer.close();
  });

  it("connection with disallowed Origin is rejected", async () => {
    const ws = new WebSocket(url, { headers: { origin: "https://evil.example.com" } });
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.once("error", () => resolve());
    });
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("relay sent before sharer confirms is silently dropped", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    const viewer = openWs(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined — sharer has NOT confirmed yet

    // Viewer sends relay before confirmation
    viewer.send(JSON.stringify({ type: "relay", payload: { kind: "hello", ts: 0 } }));

    // Sharer should NOT receive any message — wait 100 ms and check nothing arrived
    const received = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 100);
      sharer.once("message", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(received).toBe(false);

    sharer.close();
    viewer.close();
  });
});

describe("per-peer message rate limit", () => {
  let rlApp: FastifyInstance;
  let rlUrl: string;

  beforeAll(async () => {
    rlApp = Fastify({ logger: false });
    await rlApp.register(websocketPlugin, {
      options: {
        maxPayload: 65_536,
        verifyClient(_info: unknown, cb: (result: boolean) => void) {
          cb(true);
        },
      },
    });
    const store = new SessionStore({ ttlMs: 60_000, maxAttempts: 5 });
    registerSignaling(
      rlApp,
      store,
      { windowMs: 60_000, max: 5 },
      new Map(),
      { windowMs: 10_000, max: 3 }
    );
    await rlApp.listen({ port: 0, host: "127.0.0.1" });
    const addr = rlApp.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    rlUrl = `ws://127.0.0.1:${addr.port}/signal`;
  });

  afterAll(async () => {
    await rlApp.close();
  });

  it("connection is closed after exceeding per-peer message rate limit", async () => {
    const ws = new WebSocket(rlUrl);
    await new Promise((r) => ws.once("open", r));

    const messages: unknown[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));

    // Send 4 messages — 4th exceeds the limit of 3 and triggers close
    for (let i = 0; i < 4; i++) {
      ws.send(JSON.stringify({ type: "register", role: "sharer" }));
    }

    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once("close", () => resolve());
    });

    expect(ws.readyState).toBe(WebSocket.CLOSED);

    const rateError = messages.find(
      (m) =>
        m !== null &&
        typeof m === "object" &&
        (m as Record<string, unknown>).type === "error" &&
        (m as Record<string, unknown>).code === "rate-limit"
    );
    expect(rateError).toBeDefined();
  });
});
