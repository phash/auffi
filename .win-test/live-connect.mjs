#!/usr/bin/env node
// Browser half of a live ad-hoc connect against the sharer running in the
// Windows VM: open auffi.app with the 9-digit code the VM screenshot shows,
// click Verbinden, and report what the viewer sees over the next seconds.
//
//   node .win-test/live-connect.mjs 123-456-789 [--wait 40] [--out share/viewer.png] [--url https://auffi.app/]
//
// While this waits, click Akzeptieren in the VM (node .win-test/screenshot.mjs
// --click X,Y). Exit code 0 when the remote video started playing.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "viewer", "package.json"));
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const code = args.find((a) => /^\d{3}-?\d{3}-?\d{3}$/.test(a));
if (!code) {
  console.error("usage: live-connect.mjs NNN-NNN-NNN [--wait SECONDS] [--out FILE] [--url URL]");
  process.exit(2);
}
const opt = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const waitSec = Number(opt("--wait", "40"));
const out = opt("--out", path.join(here, "share", "viewer.png"));
const url = opt("--url", "https://auffi.app/");

const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "de-DE" });
await page.goto(`${url}?code=${code.replace(/-/g, "")}`, { waitUntil: "domcontentloaded" });
// Consent banner (if any) must not sit on top of the connect button.
await page.locator("#code").waitFor({ state: "visible", timeout: 20_000 });
const prefilled = await page.locator("#code").inputValue();
if (prefilled.replace(/\D/g, "") !== code.replace(/\D/g, "")) {
  await page.locator("#code").fill(code);
}
await page.locator("#connect").click();

const started = Date.now();
let last = "";
let playing = false;
while (Date.now() - started < waitSec * 1000) {
  const status = (await page.locator("#status").innerText().catch(() => "")).trim();
  if (status !== last) {
    console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${status}`);
    last = status;
  }
  const video = await page
    .evaluate(() => {
      const v = document.getElementById("remote-video");
      return v ? { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, paused: v.paused } : null;
    })
    .catch(() => null);
  if (video && video.w > 0 && video.t > 0) {
    console.log(`video playing: ${video.w}x${video.h} t=${video.t.toFixed(1)}s`);
    playing = true;
    break;
  }
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
console.log(JSON.stringify({ out, playing, lastStatus: last }));
await browser.close();
process.exit(playing ? 0 : 1);
