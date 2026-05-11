/**
 * Node.js mock sharer for E2E tests.
 *
 * Usage: node scripts/mock-sharer.mjs [ws://localhost:8080/signal]
 *
 * Connects to the backend as a sharer, prints the assigned code as
 * `SCREENIE_CODE=NNN-NNN-NNN` so test harnesses can grep for it,
 * waits for a viewer to join, auto-confirms, negotiates WebRTC SDP/ICE,
 * and pushes a generated I420 video stream (moving colored rectangle at 30 fps).
 *
 * DataChannel handling:
 * - Accepts `input` channel: logs received events as `INPUT_EVENT=<json>`
 * - Accepts `files` channel: auto-accepts file offers, accumulates binary chunks,
 *   logs `FILE_RECEIVED=<id>:<byteCount>` on completion
 *
 * Exit cleanly on SIGINT / SIGTERM.
 */

import { createRequire } from "module";
import { WebSocket } from "ws";

// @roamhq/wrtc is a CommonJS package; use createRequire to import it from ESM.
const require = createRequire(import.meta.url);
const {
  RTCPeerConnection,
  RTCSessionDescription,
  nonstandard: { RTCVideoSource },
} = require("@roamhq/wrtc");

const SIGNAL_URL = process.argv[2] ?? "ws://localhost:8080/signal";

const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 360;
const FPS = 30;
const FRAME_INTERVAL_MS = Math.round(1000 / FPS);

/** Generate a single I420 frame. The moving colored rectangle shifts by `tick` pixels. */
function generateI420Frame(tick) {
  const ySize = VIDEO_WIDTH * VIDEO_HEIGHT;
  const uvSize = (VIDEO_WIDTH >> 1) * (VIDEO_HEIGHT >> 1);
  const data = new Uint8Array(ySize + 2 * uvSize);

  // Fill luma (Y) with a mid-gray so the background is visible.
  data.fill(128, 0, ySize);

  // Draw a 120×80 rectangle that moves horizontally.
  const rx = tick % (VIDEO_WIDTH - 120);
  const ry = (VIDEO_HEIGHT - 80) >> 1;
  const rectY = 210; // luma value for the rectangle (bright)
  for (let row = ry; row < ry + 80; row++) {
    const base = row * VIDEO_WIDTH + rx;
    data.fill(rectY, base, base + 120);
  }

  // Fill chroma planes: Cb (U) and Cr (V) — neutral (128) except in the rectangle.
  // U plane starts at ySize, V plane at ySize + uvSize.
  data.fill(128, ySize, ySize + 2 * uvSize);

  const uvWidth = VIDEO_WIDTH >> 1;
  const uvRx = rx >> 1;
  const uvRw = 60; // 120 >> 1
  const uvRy = ry >> 1;
  const uvRh = 40; // 80 >> 1
  for (let row = uvRy; row < uvRy + uvRh; row++) {
    const uBase = ySize + row * uvWidth + uvRx;
    const vBase = ySize + uvSize + row * uvWidth + uvRx;
    // Teal-ish color: low Cb, high Cr
    data.fill(80, uBase, uBase + uvRw);
    data.fill(180, vBase, vBase + uvRw);
  }

  return data;
}

function sendMsg(ws, msg) {
  ws.send(JSON.stringify(msg));
}

/**
 * FNV-1a 32-bit hash — must match the viewer's buildChunkFrame id-hash.
 * The binary chunk header carries this hash so we can identify which transfer
 * a chunk belongs to without repeating the full UUID on every frame.
 */
function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Wire up the `input` DataChannel (callee side).
 * Logs every received JSON event as `INPUT_EVENT=<json>` on stdout so that
 * Playwright tests can parse them from the process output buffer.
 */
function handleInputChannel(ch) {
  // Accumulate partial UTF-8 text across `data` events — the Node.js wrtc
  // implementation may deliver chunks of a single WebRTC message across
  // multiple `message` events for large payloads, but in practice JSON input
  // events are small enough that one message = one event. We still guard
  // against fragmentation by buffering incomplete lines.
  let lineBuffer = "";

  ch.onmessage = (ev) => {
    lineBuffer += typeof ev.data === "string" ? ev.data : ev.data.toString();

    // Each input event is a self-contained JSON object. Try to parse
    // everything buffered; if it throws we wait for more data.
    let parsed;
    try {
      parsed = JSON.parse(lineBuffer);
      lineBuffer = "";
    } catch {
      return;
    }

    process.stdout.write(`INPUT_EVENT=${JSON.stringify(parsed)}\n`);
  };
}

/**
 * Wire up the `files` DataChannel (callee side).
 * - On `file-offer`: immediately sends `file-accept` back.
 * - On binary chunks: accumulates raw bytes per transfer id (decoded from
 *   the 8-byte frame header: 4-byte id-hash LE, 4-byte seq LE).
 * - On `file-done`: logs `FILE_RECEIVED=<id>:<totalBytes>` on stdout.
 */
function handleFilesChannel(ch) {
  /** @type {Map<string, { idHash: number; seqChunks: Map<number, Uint8Array> }>} */
  const transfers = new Map();

  ch.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer || ArrayBuffer.isView(ev.data)) {
      const buf = ev.data instanceof ArrayBuffer ? ev.data : ev.data.buffer;
      if (buf.byteLength < 8) return;

      const view = new DataView(buf);
      const idHash = view.getUint32(0, true);
      const seq = view.getUint32(4, true);
      const payload = new Uint8Array(buf, 8);

      // Find which active transfer this hash belongs to.
      for (const [id, state] of transfers) {
        if (state.idHash === idHash) {
          state.seqChunks.set(seq, payload.slice());
          return;
        }
      }
      // Unknown hash — chunk arrived before offer or after done; ignore.
      return;
    }

    // JSON control message
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    } catch {
      return;
    }

    if (msg.kind === "file-offer") {
      transfers.set(msg.id, { idHash: fnv1a32(msg.id), seqChunks: new Map() });
      ch.send(JSON.stringify({ kind: "file-accept", id: msg.id }));
      return;
    }

    if (msg.kind === "file-done") {
      const state = transfers.get(msg.id);
      if (!state) return;
      transfers.delete(msg.id);

      const seqNums = Array.from(state.seqChunks.keys()).sort((a, b) => a - b);
      let totalBytes = 0;
      for (const seq of seqNums) {
        totalBytes += state.seqChunks.get(seq).byteLength;
      }

      process.stdout.write(`FILE_RECEIVED=${msg.id}:${totalBytes}\n`);
      return;
    }

    if (msg.kind === "file-reject" || msg.kind === "file-error") {
      transfers.delete(msg.id);
    }
  };
}

async function run() {
  const ws = new WebSocket(SIGNAL_URL, { headers: { origin: "http://localhost:5174" } });

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  sendMsg(ws, { type: "register", role: "sharer" });

  /** @type {RTCPeerConnection | null} */
  let pc = null;
  let videoInterval = null;

  function cleanup(signal) {
    if (videoInterval !== null) {
      clearInterval(videoInterval);
      videoInterval = null;
    }
    pc?.close();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    if (signal) process.exit(0);
  }

  process.on("SIGINT", () => cleanup(true));
  process.on("SIGTERM", () => cleanup(true));

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "code-assigned") {
      // Print in a format that test harnesses can grep.
      process.stdout.write(`SCREENIE_CODE=${msg.code}\n`);
      return;
    }

    if (msg.type === "peer-joined") {
      sendMsg(ws, { type: "confirm", accepted: true });
      return;
    }

    if (msg.type === "peer-confirmed") {
      // Viewer will send its SDP offer via relay; nothing to do here yet.
      return;
    }

    if (msg.type === "relay") {
      const payload = msg.payload;

      if (payload.kind === "sdp" && payload.sdp.type === "offer") {
        pc = await createPeerConnection(ws, payload.sdp);
        return;
      }

      if (payload.kind === "ice" && pc !== null) {
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch {
          // Benign: candidate may arrive before remote description is set.
        }
        return;
      }
    }

    if (msg.type === "error") {
      process.stderr.write(`Backend error [${msg.code}]: ${msg.message}\n`);
    }
  });

  ws.on("close", () => {
    cleanup(false);
  });

  ws.on("error", (err) => {
    process.stderr.write(`WebSocket error: ${err.message}\n`);
    cleanup(false);
  });

  /**
   * Create an RTCPeerConnection, attach a video source, answer the viewer's offer,
   * wire ICE, and start pushing frames.
   * Also registers `ondatachannel` to accept `input` and `files` channels.
   */
  async function createPeerConnection(socket, offerSdp) {
    const videoSource = new RTCVideoSource({ isScreencast: true });
    const videoTrack = videoSource.createTrack();

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    connection.addTrack(videoTrack);

    // Callee side: register handlers for DataChannels opened by the viewer.
    connection.ondatachannel = (ev) => {
      const ch = ev.channel;
      if (ch.label === "input") {
        handleInputChannel(ch);
      } else if (ch.label === "files") {
        handleFilesChannel(ch);
      }
    };

    connection.onicecandidate = ({ candidate }) => {
      if (candidate === null) return;
      sendMsg(socket, {
        type: "relay",
        payload: {
          kind: "ice",
          candidate: {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            usernameFragment: candidate.usernameFragment,
          },
        },
      });
    };

    connection.oniceconnectionstatechange = () => {
      const state = connection.iceConnectionState;
      if (state === "connected" || state === "completed") {
        process.stdout.write(`ICE connected (state: ${state})\n`);
      }
      if (state === "failed" || state === "closed") {
        cleanup(false);
      }
    };

    await connection.setRemoteDescription(new RTCSessionDescription(offerSdp));
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);

    sendMsg(socket, {
      type: "relay",
      payload: {
        kind: "sdp",
        sdp: { type: answer.type, sdp: answer.sdp },
      },
    });

    let tick = 0;
    videoInterval = setInterval(() => {
      const frameData = generateI420Frame(tick);
      videoSource.onFrame({
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT,
        data: frameData,
      });
      tick = (tick + 1) % (VIDEO_WIDTH - 120);
    }, FRAME_INTERVAL_MS);

    return connection;
  }
}

await run();
