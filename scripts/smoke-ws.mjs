/**
 * Minimal WebSocket smoke test for the auffi signaling backend.
 *
 * Usage:
 *   node scripts/smoke-ws.mjs [ws-url] [turn-url]
 *
 * Default ws-url: ws://localhost:8080/signal
 * turn-url (optional): POST /turn-credentials endpoint of the same backend,
 *   e.g. http://localhost:8080/turn-credentials
 *
 * Test sequence:
 *   1. Connect as sharer (register + receive code-assigned)
 *   2. Connect as viewer with that code (join + receive join-ack or equivalent)
 *   3. With turn-url: POST the live code to /turn-credentials while the
 *      session is still open and expect issued credentials. The route only
 *      issues for an allowed Origin AND a live session code, so this is the
 *      one place in the smoke run where the positive contract is testable.
 *   4. Close both sockets cleanly
 *
 * Exit 0 = PASS, exit 1 = FAIL
 */

import { WebSocket } from "ws";

const SIGNAL_URL = process.argv[2] ?? "ws://localhost:8080/signal";
const TURN_URL = process.argv[3];
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

/**
 * POST the live session code to /turn-credentials and require issued
 * credentials. Must run while the sharer socket is still open — the
 * session is torn down on sharer close and the route then answers
 * 403 "no active session".
 */
async function assertTurnCredentialsIssued(turnUrl, code, origin) {
  const res = await fetch(turnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(
      `Expected 200 from ${turnUrl}, got ${res.status}: ${text}`
    );
  }
  const body = JSON.parse(text);
  if (typeof body.username !== "string" || typeof body.credential !== "string") {
    throw new Error(
      `Expected username+credential in TURN response, got: ${text}`
    );
  }
  console.log(`[smoke-ws] TURN credentials issued (ttl=${body.ttl})`);
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

  // ---------- Step 3: TURN credentials for the live session ----------
  if (TURN_URL) {
    await assertTurnCredentialsIssued(TURN_URL, code, origin);
  }

  // ---------- Step 4: clean up ----------
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
