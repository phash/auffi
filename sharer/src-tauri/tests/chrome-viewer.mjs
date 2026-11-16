#!/usr/bin/env node
// Headless-Chrome viewer for the sharer's real-browser interop test
// (`webrtc_peer::tests::chrome`). It plays the part viewer/src/webrtc-client.ts
// plays in production: offers a recvonly VP8 transceiver plus the "input" and
// "files" DataChannels, and reports whether the video actually decodes.
//
// Wire: newline-delimited JSON. stdout carries {offer}, {candidate},
// {stats}, and a final {result}; stdin carries {answer} and {candidate}.
// Uses the viewer's Playwright install (cd viewer && npx playwright install chromium).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "..", "..", "viewer", "package.json"));
const { chromium } = require("playwright");

const deadlineMs = Number(process.argv[2] ?? 20_000);
const emit = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.exposeFunction("emit", emit);
await page.setContent("<video autoplay muted playsinline></video>");

await page.evaluate(async () => {
  const pc = new RTCPeerConnection();
  window.pc = pc;
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.createDataChannel("input");
  pc.createDataChannel("files");
  pc.ontrack = (ev) => {
    const video = document.querySelector("video");
    video.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
    video.play().catch(() => {});
  };
  pc.onicecandidate = (ev) => {
    if (ev.candidate) window.emit({ candidate: ev.candidate.toJSON() });
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  window.emit({ offer: offer.sdp });
});

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.answer) {
    void page.evaluate((sdp) => window.pc.setRemoteDescription({ type: "answer", sdp }), msg.answer);
  } else if (msg.candidate) {
    void page.evaluate((c) => window.pc.addIceCandidate(c), msg.candidate);
  }
});

const started = Date.now();
let result = { result: "timeout" };
while (Date.now() - started < deadlineMs) {
  await page.waitForTimeout(500);
  const stats = await page.evaluate(async () => {
    const out = { iceState: window.pc.iceConnectionState, state: window.pc.connectionState };
    for (const s of (await window.pc.getStats()).values()) {
      if (s.type === "inbound-rtp" && s.kind === "video") {
        Object.assign(out, {
          packetsReceived: s.packetsReceived,
          framesDecoded: s.framesDecoded,
          keyFramesDecoded: s.keyFramesDecoded,
          pliCount: s.pliCount,
          firCount: s.firCount,
        });
      }
    }
    const video = document.querySelector("video");
    out.videoWidth = video.videoWidth;
    out.videoHeight = video.videoHeight;
    return out;
  });
  emit({ stats });
  if (stats.framesDecoded > 0 && stats.videoWidth > 0) {
    result = { result: "playing", width: stats.videoWidth, height: stats.videoHeight };
    break;
  }
}
emit(result);
await browser.close();
process.exit(0);
