import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import WebSocket from "ws";
import { registerSignaling } from "../src/signaling.js";
import { SessionStore } from "../src/codes.js";
import { UnattendedRegistry } from "../src/unattended.js";
import { UnattendedSessions } from "../src/unattended_sessions.js";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "../src/db.js";
import { hashPassword } from "../src/auth/argon.js";
import type { CountryLookup } from "../src/geoip.js";

const TOKEN = "5678abcd".repeat(8);
const DEVICE_ID = "321-654-987";
const GENEROUS = { windowMs: 60_000, max: 1000 };

interface Harness {
  app: FastifyInstance;
  url: string;
  db: Db;
  store: SessionStore;
}

let open: Harness | null = null;

afterEach(async () => {
  if (open) {
    await open.app.close();
    if (open.db.open) open.db.close();
    open = null;
  }
});

async function start(opts: { country?: CountryLookup; ttlMs?: number } = {}): Promise<Harness> {
  const db = openDb(":memory:");
  applyMigrations(db, defaultMigrationsDir());
  db.prepare(
    "INSERT INTO accounts (id, email, password_hash, email_verified_at, created_at) VALUES (1, 'o@a', 'x', ?, ?)",
  ).run(Date.now(), Date.now());
  db.prepare(
    `INSERT INTO devices (id, owner_account_id, alias, token_hash, auto_accept, created_at)
     VALUES (?, 1, 'D', ?, 1, ?)`,
  ).run(DEVICE_ID, await hashPassword(TOKEN), Date.now());
  const app = Fastify();
  await app.register(websocketPlugin);
  const store = new SessionStore({ ttlMs: opts.ttlMs ?? 600_000 });
  registerSignaling(
    app,
    store,
    GENEROUS,
    undefined,
    undefined,
    GENEROUS,
    undefined,
    { db, registry: new UnattendedRegistry(), sessions: new UnattendedSessions() },
    GENEROUS,
    undefined,
    opts.country ?? null,
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  open = { app, url: `ws://127.0.0.1:${addr.port}/signal`, db, store };
  return open;
}

function recv(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) =>
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
}

async function openViewer(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.once("open", r));
  return ws;
}

async function openUnattendedSharer(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${TOKEN}`, "x-auffi-device-id": DEVICE_ID },
  });
  expect(await recv(ws)).toEqual({ type: "unattended-hello", deviceId: DEVICE_ID });
  return ws;
}

async function viewerAwaitingPassword(url: string): Promise<WebSocket> {
  const viewer = await openViewer(url);
  viewer.send(JSON.stringify({ type: "join", role: "viewer", code: DEVICE_ID }));
  expect(await recv(viewer)).toEqual({ type: "needs-password" });
  return viewer;
}

describe("unattended peer-joined carries the viewer's country", () => {
  it("resolves the country at join time, like the ad-hoc path", async () => {
    const h = await start({ country: { get: () => ({ country: { iso_code: "AT" } }) } });
    const sharer = await openUnattendedSharer(h.url);
    const viewer = await viewerAwaitingPassword(h.url);
    viewer.send(JSON.stringify({ type: "pw-attempt", password: "pw" }));
    expect(await recv(sharer)).toMatchObject({ type: "pw-check" });
    sharer.send(JSON.stringify({ type: "pw-check-result", result: "ok" }));
    const joined = await recv(sharer);
    expect(joined).toEqual({
      type: "peer-joined",
      viewerInfo: { ipPrefix: expect.any(String), country: "AT" },
    });
    viewer.close();
    sharer.close();
  });
});

// A throw inside a ws "message" listener is an uncaughtException that takes
// the whole process — every live session — down. A DB in a failing state
// (here: closed) is the realistic trigger for the handlers' DB calls.
describe("a failing DB inside a socket handler", () => {
  it("closes the viewer socket with 1011 on join, and the server keeps serving", async () => {
    const h = await start();
    const sharer = await openUnattendedSharer(h.url);
    h.db.close();
    const viewer = await openViewer(h.url);
    const gone = closed(viewer);
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code: DEVICE_ID }));
    expect((await gone).code).toBe(1011);

    const adhoc = await openViewer(h.url);
    adhoc.send(JSON.stringify({ type: "register", role: "sharer" }));
    expect(await recv(adhoc)).toMatchObject({ type: "code-assigned" });
    adhoc.close();
    sharer.close();
  });

  it("closes the viewer socket with 1011 on pw-attempt", async () => {
    const h = await start();
    const sharer = await openUnattendedSharer(h.url);
    const viewer = await viewerAwaitingPassword(h.url);
    h.db.close();
    const gone = closed(viewer);
    viewer.send(JSON.stringify({ type: "pw-attempt", password: "pw" }));
    expect((await gone).code).toBe(1011);
    sharer.close();
  });

  it("closes the unattended sharer socket with 1011 on pw-check-result", async () => {
    const h = await start();
    const sharer = await openUnattendedSharer(h.url);
    const viewer = await viewerAwaitingPassword(h.url);
    viewer.send(JSON.stringify({ type: "pw-attempt", password: "pw" }));
    await recv(sharer); // pw-check
    h.db.close();
    const gone = closed(sharer);
    sharer.send(JSON.stringify({ type: "pw-check-result", result: "fail" }));
    expect((await gone).code).toBe(1011);
    viewer.close();
  });
});
