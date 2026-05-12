/**
 * Minimal WebSocket smoke test for the auffi signaling backend.
 *
 * Usage:
 *   node scripts/smoke-ws.mjs [ws-url]
 *
 * Default ws-url: ws://localhost:8080/signal
 *
 * Test sequence:
 *   1. Connect as sharer (register + receive code-assigned)
 *   2. Connect as viewer with that code (join + receive join-ack or equivalent)
 *   3. Close both sockets cleanly
 *
 * Exit 0 = PASS, exit 1 = FAIL
 */

import { WebSocket } from "ws";

const SIGNAL_URL = process.argv[2] ?? "ws://localhost:8080/signal";
const TIMEOUT_MS = 10_000;

/** Promisified timeout helper */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Open a WebSocket and resolve once OPEN, reject on error. */
function openWs(url, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { origin } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WebSocket open timed out: ${url}`));
    }, TIMEOUT_MS);

    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Wait for the next message from a WebSocket; reject on timeout. */
function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for WebSocket message"));
    }, TIMEOUT_MS);

    ws.once("message", (raw) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw.toString()));
      } catch {
        resolve({ raw: raw.toString() });
      }
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function run() {
  const origin = "http://localhost";

  // ---------- Step 1: sharer connects and registers ----------
  console.log(`[smoke-ws] Connecting sharer to ${SIGNAL_URL} ...`);
  const sharer = await openWs(SIGNAL_URL, origin);

  sharer.send(JSON.stringify({ type: "register", role: "sharer" }));

  const codeMsg = await nextMessage(sharer);
  if (codeMsg.type !== "code-assigned" || typeof codeMsg.code !== "string") {
    throw new Error(
      `Expected code-assigned, got: ${JSON.stringify(codeMsg)}`
    );
  }
  const code = codeMsg.code;
  console.log(`[smoke-ws] Sharer received code: ${code}`);

  // ---------- Step 2: viewer connects and joins ----------
  console.log(`[smoke-ws] Connecting viewer to ${SIGNAL_URL} ...`);
  const viewer = await openWs(SIGNAL_URL, origin);

  // Protocol: ViewerJoin = { type: "join"; role: "viewer"; code: string }
  viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));

  // The sharer receives { type: "peer-joined", viewerInfo: {...} }.
  // The viewer stays silent (it waits for sharer to confirm/decline).
  // We race: take the first message from the sharer side.
  const sharerMsg = await nextMessage(sharer);

  console.log(`[smoke-ws] sharer notification: ${JSON.stringify(sharerMsg)}`);

  if (sharerMsg.type !== "peer-joined") {
    throw new Error(
      `Expected peer-joined on sharer socket, got: ${JSON.stringify(sharerMsg)}`
    );
  }

  // Send confirm from sharer so the viewer gets peer-confirmed.
  sharer.send(JSON.stringify({ type: "confirm", accepted: true }));

  const viewerMsg = await nextMessage(viewer);
  console.log(`[smoke-ws] viewer notification: ${JSON.stringify(viewerMsg)}`);

  if (viewerMsg.type !== "peer-confirmed") {
    throw new Error(
      `Expected peer-confirmed on viewer socket, got: ${JSON.stringify(viewerMsg)}`
    );
  }

  // ---------- Step 3: clean up ----------
  sharer.close(1000);
  viewer.close(1000);

  // Give sockets a moment to drain.
  await sleep(200);

  console.log("[smoke-ws] PASS");
}

run().catch((err) => {
  console.error(`[smoke-ws] FAIL — ${err.message}`);
  process.exit(1);
});
