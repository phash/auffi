import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import WebSocket from "ws";
import websocketPlugin from "@fastify/websocket";
import { createServer } from "../src/server.js";
import { registerSignaling } from "../src/signaling.js";
import { SessionStore } from "../src/codes.js";
import type { CountryLookup } from "../src/geoip.js";

let app: FastifyInstance;
let url: string;

beforeAll(async () => {
  // The test suite makes many sharer-register WS calls from 127.0.0.1.
  // The production register-rate-limit (5/min/IP) would trip during the
  // run; bypass via env. The dedicated per-IP-register-limit test below
  // builds its own Fastify instance with a tight cap so the gate
  // is still exercised end-to-end.
  process.env.REGISTER_RATE_LIMIT_MAX = "1000";
  // Same for the join cap: every join (hits included) costs one unit of the
  // 5/min budget, and this suite joins far more often than that.
  process.env.RATE_LIMIT_MAX = "1000";
  app = await createServer({ port: 0, host: "127.0.0.1", dbPath: ":memory:" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  url = `ws://127.0.0.1:${addr.port}/signal`;
});

afterAll(async () => {
  await app.close();
  delete process.env.RATE_LIMIT_MAX;
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

  it("viewer-swap: sharer's decline for the second viewer sends peer-rejected declined", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    // First viewer joins and is ACCEPTED.
    const viewer1 = openWs(url);
    await new Promise((r) => viewer1.once("open", r));
    viewer1.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined
    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
    await recv(viewer1); // peer-confirmed

    viewer1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Second viewer joins the still-open session.
    const viewer2 = openWs(url);
    await new Promise((r) => viewer2.once("open", r));
    viewer2.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined (again)

    // The relay gate must be CLOSED again for the swapped-in viewer.
    let viewer2GotRelay = false;
    viewer2.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "relay") viewer2GotRelay = true;
    });
    sharer.send(JSON.stringify({ type: "relay", payload: { kind: "hello", ts: 0 } }));
    await new Promise((r) => setTimeout(r, 100));
    expect(viewer2GotRelay).toBe(false);

    // And Ablehnen must actually reach viewer2 — not be a silent no-op.
    sharer.send(JSON.stringify({ type: "confirm", accepted: false }));
    const rejected = await recv(viewer2);
    expect(rejected.type).toBe("peer-rejected");
    expect(rejected.reason).toBe("declined");
    await new Promise<void>((r) => {
      if (viewer2.readyState === WebSocket.CLOSED) return r();
      viewer2.once("close", () => r());
    });
  });

  it("pre-confirm viewer loss delivers a synthesized bye to the sharer", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    const viewer = openWs(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined — sharer's confirm dialog is up

    // Viewer bails (Abbrechen / tab close) before the sharer decides.
    viewer.close();
    const bye = await recv(sharer);
    expect(bye).toEqual({ type: "relay", payload: { kind: "bye" } });
    sharer.close();
  });

  it("confirm accepted:true with no attached viewer does not pre-confirm the session", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    const viewer1 = openWs(url);
    await new Promise((r) => viewer1.once("open", r));
    viewer1.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined
    viewer1.close();
    await recv(sharer); // synthesized bye

    // Stale Akzeptieren races the viewer loss — must be ignored.
    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));

    const viewer2 = openWs(url);
    await new Promise((r) => viewer2.once("open", r));
    const v2msgs: Array<Record<string, unknown>> = [];
    viewer2.on("message", (data) => v2msgs.push(JSON.parse(data.toString())));
    viewer2.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined

    // Relay must still be gated — the stale accept must not have confirmed.
    sharer.send(JSON.stringify({ type: "relay", payload: { kind: "hello", ts: 7 } }));
    await new Promise((r) => setTimeout(r, 100));
    expect(v2msgs).toEqual([]);

    // A fresh accept with the viewer attached works normally.
    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
    await new Promise((r) => setTimeout(r, 100));
    expect(v2msgs).toEqual([{ type: "peer-confirmed" }]);

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

  // Valid JSON that is not an object: `JSON.parse("null")` returns null, and
  // the handler reached straight for `msg.type`. That TypeError escapes the ws
  // "message" listener — nothing catches it, there is no uncaughtException
  // handler — so one unauthenticated 4-byte frame took the whole signaling
  // process down with every live session on it. The other non-object literals
  // are harmless (`.type` is just undefined) but are pinned here so a future
  // refactor cannot reintroduce the asymmetry.
  it.each(["null", "123", '"a string"', "true", "[]"])(
    "non-object JSON %s → bad-message error, process survives",
    async (payload) => {
      const ws = openWs(url);
      await new Promise((r) => ws.once("open", r));
      ws.send(payload);
      const err = await recv(ws);
      expect(err.type).toBe("error");
      expect(err.code).toBe("bad-message");
      ws.close();
    },
  );

  it("a null frame does not kill the connection for everyone else", async () => {
    const { sharer, viewer } = await establishConfirmedPair(url);
    const attacker = openWs(url);
    await new Promise((r) => attacker.once("open", r));
    attacker.send("null");
    await recv(attacker);
    attacker.close();

    // The established pair must still be able to relay.
    viewer.send(JSON.stringify({ type: "relay", payload: { kind: "bye" } }));
    const relayed = await recv(sharer);
    expect(relayed.type).toBe("relay");
    sharer.close();
    viewer.close();
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

  // Regression (review 2026-07-02, finding B3): a replacement viewer that
  // redeems the SAME still-valid code after the first viewer left must be
  // re-confirmed. `detachViewer` now resets `Session.confirmed`, so the
  // relay gate stays closed for viewer2 until the sharer confirms again.
  it("replacement viewer on the same code must be re-confirmed (relay stays gated)", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    const viewer1 = openWs(url);
    await new Promise((r) => viewer1.once("open", r));
    viewer1.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined
    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
    await recv(viewer1); // peer-confirmed

    // Viewer1 leaves; the sharer stays online with the same code.
    viewer1.close();
    await new Promise((r) => setTimeout(r, 30));

    const viewer2 = openWs(url);
    await new Promise((r) => viewer2.once("open", r));
    viewer2.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined for viewer2

    // Without the reset, `confirmed` would still be latched true and this
    // relay would be forwarded to the sharer before any re-confirmation.
    viewer2.send(JSON.stringify({ type: "relay", payload: { kind: "hello", ts: 1 } }));
    const leaked = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 100);
      sharer.once("message", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(leaked).toBe(false);

    sharer.close();
    viewer2.close();
  });

  it("sharer CAN decline a replacement viewer on the reused code", async () => {
    const sharer = openWs(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    const viewer1 = openWs(url);
    await new Promise((r) => viewer1.once("open", r));
    viewer1.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer);
    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
    await recv(viewer1);
    viewer1.close();
    await new Promise((r) => setTimeout(r, 30));

    const viewer2 = openWs(url);
    await new Promise((r) => viewer2.once("open", r));
    viewer2.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined for viewer2

    // The sharer declines viewer2. Because confirmed was reset, the decline
    // path runs (rather than being swallowed by the already-confirmed guard).
    sharer.send(JSON.stringify({ type: "confirm", accepted: false }));
    const rej = await recv(viewer2);
    expect(rej.type).toBe("peer-rejected");
    expect(rej.reason).toBe("declined");

    sharer.close();
    viewer2.close();
  });

  // Coverage pin (review 2026-07-02, finding #10): the already-confirmed
  // guard still protects a LIVE viewer — a stray sharer `confirm:false`
  // against the currently-streaming peer must be ignored (no teardown).
  it("confirm:false against the live confirmed viewer is ignored", async () => {
    const { sharer, viewer } = await establishConfirmedPair(url);

    sharer.send(JSON.stringify({ type: "confirm", accepted: false }));
    const gotRejected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 120);
      viewer.once("message", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(gotRejected).toBe(false);
    expect(viewer.readyState).toBe(WebSocket.OPEN);

    // Relay still flows — the session is intact.
    viewer.send(JSON.stringify({ type: "relay", payload: { kind: "hello", ts: 2 } }));
    const relayed = await recv(sharer);
    expect(relayed.type).toBe("relay");

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
    const store = new SessionStore({ ttlMs: 60_000 });
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

describe("per-IP register rate limit", () => {
  let rApp: ReturnType<typeof Fastify>;
  let rUrl: string;

  beforeAll(async () => {
    rApp = Fastify({ logger: false });
    await rApp.register(websocketPlugin, {
      options: {
        maxPayload: 65_536,
        verifyClient(_info: unknown, cb: (result: boolean) => void) {
          cb(true);
        },
      },
    });
    const store = new SessionStore({ ttlMs: 60_000 });
    // Tight register cap (2/minute) so we can exhaust it without burning
    // dozens of test connections.
    registerSignaling(
      rApp,
      store,
      { windowMs: 60_000, max: 5 }, // join (existing)
      new Map(),
      undefined, // per-peer (defaults)
      { windowMs: 60_000, max: 2 }, // register (new)
      new Map(),
    );
    await rApp.listen({ port: 0, host: "127.0.0.1" });
    const addr = rApp.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    rUrl = `ws://127.0.0.1:${addr.port}/signal`;
  });

  afterAll(async () => {
    await rApp.close();
  });

  it("third sharer-register from same IP within the window is rate-limited", async () => {
    // The same client IP (127.0.0.1) — three back-to-back fresh WS upgrades
    // that each register as sharer. The third must trip the per-IP gate.
    async function registerOnce(): Promise<unknown[]> {
      const ws = new WebSocket(rUrl);
      await new Promise((r) => ws.once("open", r));
      const messages: unknown[] = [];
      ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
      ws.send(JSON.stringify({ type: "register", role: "sharer" }));
      // Wait for either code-assigned (success) or close (rejected).
      await new Promise<void>((resolve) => {
        const done = () => {
          ws.removeAllListeners();
          resolve();
        };
        ws.once("close", done);
        ws.on("message", () => {
          // Give a tick so the server's `peer.close()` arrives if any.
          setTimeout(done, 50);
        });
      });
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      return messages;
    }

    const first = await registerOnce();
    const second = await registerOnce();
    const third = await registerOnce();

    // First two: code-assigned, no rate-limit error.
    for (const msgs of [first, second]) {
      expect(
        msgs.some(
          (m) =>
            m !== null &&
            typeof m === "object" &&
            (m as Record<string, unknown>).type === "code-assigned",
        ),
      ).toBe(true);
    }
    // Third: rate-limit error, NO code-assigned.
    expect(
      third.some(
        (m) =>
          m !== null &&
          typeof m === "object" &&
          (m as Record<string, unknown>).type === "error" &&
          (m as Record<string, unknown>).code === "rate-limit",
      ),
    ).toBe(true);
    expect(
      third.some(
        (m) =>
          m !== null &&
          typeof m === "object" &&
          (m as Record<string, unknown>).type === "code-assigned",
      ),
    ).toBe(false);
  });
});

describe("country lookup in ad-hoc peer-joined", () => {
  let geoApp: ReturnType<typeof Fastify>;
  let geoUrl: string;

  beforeAll(async () => {
    geoApp = Fastify({ logger: false });
    await geoApp.register(websocketPlugin, {
      options: {
        maxPayload: 65_536,
        verifyClient(_info: unknown, cb: (result: boolean) => void) {
          cb(true);
        },
      },
    });
    const store = new SessionStore({ ttlMs: 60_000 });
    // Fake CountryLookup that always returns "DE"
    const fakeCountry: CountryLookup = {
      get: () => ({ country: { iso_code: "DE" } }),
    };
    registerSignaling(
      geoApp,
      store,
      { windowMs: 60_000, max: 100 },
      new Map(),
      undefined,
      { windowMs: 60_000, max: 100 },
      new Map(),
      undefined,
      { windowMs: 60_000, max: 10 },
      new Map(),
      fakeCountry,
    );
    await geoApp.listen({ port: 0, host: "127.0.0.1" });
    const addr = geoApp.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    geoUrl = `ws://127.0.0.1:${addr.port}/signal`;
  });

  afterAll(async () => {
    await geoApp.close();
  });

  it("ad-hoc peer-joined carries viewerInfo.country resolved via the injected CountryLookup", async () => {
    const sharer = new WebSocket(geoUrl);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const assigned = await new Promise<any>((r) =>
      sharer.once("message", (d) => r(JSON.parse(d.toString()))),
    );
    const code = assigned.code as string;

    const viewer = new WebSocket(geoUrl);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));

    const peerJoined = await new Promise<any>((r) =>
      sharer.once("message", (d) => r(JSON.parse(d.toString()))),
    );

    expect(peerJoined.type).toBe("peer-joined");
    expect(peerJoined.viewerInfo.country).toBe("DE");

    sharer.close();
    viewer.close();
  });
});

describe("code-TTL expiry vs live sessions", () => {
  // Short TTL + a handle on the store so tests can drive the sweep
  // directly instead of waiting for server.ts's 60 s interval.
  const TTL_MS = 500;
  let exApp: ReturnType<typeof Fastify>;
  let exUrl: string;
  let exStore: SessionStore;

  beforeAll(async () => {
    exApp = Fastify({ logger: false });
    await exApp.register(websocketPlugin, {
      options: {
        maxPayload: 65_536,
        verifyClient(_info: unknown, cb: (result: boolean) => void) {
          cb(true);
        },
      },
    });
    exStore = new SessionStore({ ttlMs: TTL_MS });
    registerSignaling(
      exApp,
      exStore,
      { windowMs: 60_000, max: 100 },
      new Map(),
      undefined,
      { windowMs: 60_000, max: 100 },
      new Map(),
    );
    await exApp.listen({ port: 0, host: "127.0.0.1" });
    const addr = exApp.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    exUrl = `ws://127.0.0.1:${addr.port}/signal`;
  });

  afterAll(async () => {
    await exApp.close();
  });

  function connect(): WebSocket {
    return new WebSocket(exUrl);
  }

  async function confirmedPair(): Promise<{ sharer: WebSocket; viewer: WebSocket; code: string }> {
    const sharer = connect();
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);
    const viewer = connect();
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined
    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
    await recv(viewer); // peer-confirmed
    return { sharer, viewer, code };
  }

  it("a confirmed pair keeps relaying past the code TTL; the sweep leaves it alone", async () => {
    const { sharer, viewer } = await confirmedPair();
    await new Promise((r) => setTimeout(r, TTL_MS + 200));
    exStore.sweepExpired(Date.now());

    // The viewer's courteous bye still reaches the sharer mid-stream.
    viewer.send(JSON.stringify({ type: "relay", payload: { kind: "bye" } }));
    const relayed = await recv(sharer);
    expect(relayed).toEqual({ type: "relay", payload: { kind: "bye" } });
    sharer.close();
    viewer.close();
  });

  it("an expired code is no longer joinable even while the confirmed session lives", async () => {
    const { sharer, viewer, code } = await confirmedPair();
    await new Promise((r) => setTimeout(r, TTL_MS + 200));

    const late = connect();
    await new Promise((r) => late.once("open", r));
    late.send(JSON.stringify({ type: "join", role: "viewer", code }));
    const err = await recv(late);
    expect(err.type).toBe("error");
    expect(err.code).toBe("invalid-code");
    sharer.close();
    viewer.close();
  });

  it("viewer waiting on the confirm dialog gets peer-rejected expired from the sweep; sharer gets a bye", async () => {
    const sharer = connect();
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);
    const viewer = connect();
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined — confirm dialog up, never answered

    await new Promise((r) => setTimeout(r, TTL_MS + 200));
    // Attach both listeners BEFORE the sweep — ws "message" events
    // don't queue for late subscribers.
    const rejectedPromise = recv(viewer);
    const byePromise = recv(sharer);
    exStore.sweepExpired(Date.now());

    expect(await rejectedPromise).toEqual({ type: "peer-rejected", reason: "expired" });
    await new Promise<void>((r) => {
      if (viewer.readyState === WebSocket.CLOSED) return r();
      viewer.once("close", () => r());
    });
    expect(await byePromise).toEqual({ type: "relay", payload: { kind: "bye" } });
    sharer.close();
  });

  it("a confirm landing after expiry lazily drops the session and notifies the viewer with expired", async () => {
    const sharer = connect();
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);
    const viewer = connect();
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined

    await new Promise((r) => setTimeout(r, TTL_MS + 200));
    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));

    const rejected = await recv(viewer);
    expect(rejected).toEqual({ type: "peer-rejected", reason: "expired" });
    sharer.close();
    viewer.close();
  });
});

// A viewer whose TCP path dies without a FIN (laptop lid, Wi-Fi → LTE, NAT
// mapping expiry) never fires `close` on its own, so `session.viewer` stays
// set and every rejoin of the still-displayed code answers "session full" —
// exactly the same-session reconnect product goal 2 promises. The backend
// must therefore ping and reap silent sockets itself; the sharer already
// does the same in the other direction (signaling.rs, 30 s / 90 s).
describe("server-side WS keepalive reaps silent sockets", () => {
  const PING_MS = 50;
  const DEADLINE_MS = 120;
  let kaApp: ReturnType<typeof Fastify>;
  let kaUrl: string;
  let kaStore: SessionStore;

  beforeAll(async () => {
    kaApp = Fastify({ logger: false });
    await kaApp.register(websocketPlugin, {
      options: {
        maxPayload: 65_536,
        verifyClient(_info: unknown, cb: (result: boolean) => void) {
          cb(true);
        },
      },
    });
    kaStore = new SessionStore({ ttlMs: 60_000 });
    registerSignaling(
      kaApp,
      kaStore,
      { windowMs: 60_000, max: 100 },
      new Map(),
      undefined,
      { windowMs: 60_000, max: 100 },
      new Map(),
      undefined,
      undefined,
      undefined,
      null,
      { pingIntervalMs: PING_MS, pongDeadlineMs: DEADLINE_MS },
    );
    await kaApp.listen({ port: 0, host: "127.0.0.1" });
    const addr = kaApp.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    kaUrl = `ws://127.0.0.1:${addr.port}/signal`;
  });

  afterAll(async () => {
    await kaApp.close();
  });

  function connect(opts: { autoPong: boolean }): WebSocket {
    return new WebSocket(kaUrl, { autoPong: opts.autoPong });
  }

  function closed(ws: WebSocket, withinMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve(true);
      const timer = setTimeout(() => resolve(false), withinMs);
      ws.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  it("terminates a confirmed viewer that stops answering pings and frees the slot for a rejoin", async () => {
    const sharer = connect({ autoPong: true });
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    const zombie = connect({ autoPong: false });
    await new Promise((r) => zombie.once("open", r));
    zombie.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined
    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
    await recv(zombie); // peer-confirmed

    expect(await closed(zombie, DEADLINE_MS * 4)).toBe(true);

    const helper = connect({ autoPong: true });
    await new Promise((r) => helper.once("open", r));
    const helperInbox: Array<Record<string, unknown>> = [];
    helper.on("message", (d) => helperInbox.push(JSON.parse(d.toString())));
    helper.send(JSON.stringify({ type: "join", role: "viewer", code }));
    const rejoined = await recv(sharer);
    expect(rejoined.type).toBe("peer-joined");
    // The reaped viewer's accept must not carry over — the sharer confirms
    // afresh, so the helper sees no peer-confirmed until it does.
    await new Promise((r) => setTimeout(r, 50));
    expect(helperInbox).toEqual([]);
    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(helperInbox).toEqual([{ type: "peer-confirmed" }]);

    sharer.close();
    helper.close();
  });

  it("leaves a viewer that answers pings connected across several deadlines", async () => {
    const sharer = connect({ autoPong: true });
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);
    const viewer = connect({ autoPong: true });
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer);

    expect(await closed(viewer, DEADLINE_MS * 4)).toBe(false);
    expect(viewer.readyState).toBe(WebSocket.OPEN);
    expect(sharer.readyState).toBe(WebSocket.OPEN);
    sharer.close();
    viewer.close();
  });

  it("terminates a silent sharer so its code is released", async () => {
    const sharer = connect({ autoPong: false });
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    expect(await closed(sharer, DEADLINE_MS * 4)).toBe(true);
    // The client observes the FIN a tick before the server's own close
    // handler (removeBySharer) has run.
    await new Promise((r) => setTimeout(r, 50));
    expect(kaStore.getSession(code)).toBeNull();

    const late = connect({ autoPong: true });
    await new Promise((r) => late.once("open", r));
    late.send(JSON.stringify({ type: "join", role: "viewer", code }));
    const err = await recv(late);
    expect(err).toMatchObject({ type: "error", code: "invalid-code" });
    late.close();
  });
});

