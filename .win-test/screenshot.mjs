#!/usr/bin/env node
// Screenshot of the Windows VM screen via dockur's noVNC page.
//
//   node .win-test/screenshot.mjs [out.png] [--click X,Y] [--type TEXT] [--key KEY]
//
// Click coordinates are pixels of the previous screenshot (the screenshot is the noVNC
// canvas at its rendered size), so a click lands where the picture shows it. Uses the
// viewer's Playwright install (cd viewer && npx playwright install chromium if missing).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "viewer", "package.json"));
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--") && !isValueOf(args, a)) ?? path.join(here, "share", "screen.png");
const click = valueOf("--click");
const type = valueOf("--type");
const key = valueOf("--key");

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
function isValueOf(list, a) {
  const i = list.indexOf(a);
  return i > 0 && list[i - 1].startsWith("--");
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto("http://127.0.0.1:8007/", { waitUntil: "domcontentloaded" });
// noVNC renders the guest into a canvas once the RFB handshake is through.
const canvas = page.locator("canvas").first();
await canvas.waitFor({ state: "visible", timeout: 30_000 });
await page.waitForTimeout(2_500);

const geometry = await canvas.evaluate((c) => {
  const r = c.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, guestW: c.width, guestH: c.height };
});

if (click) {
  // The screenshot IS the canvas at its rendered size, so screenshot pixels map
  // 1:1 onto canvas-relative page coordinates.
  const [sx, sy] = click.split(",").map(Number);
  await page.mouse.click(geometry.left + sx, geometry.top + sy);
  await page.waitForTimeout(800);
}
if (type) {
  await page.keyboard.type(type, { delay: 40 });
  await page.waitForTimeout(400);
}
if (key) {
  await page.keyboard.press(key);
  await page.waitForTimeout(800);
}
if (click || type || key) await page.waitForTimeout(1_500);

await canvas.screenshot({ path: out });
console.log(JSON.stringify({ out, guest: `${geometry.guestW}x${geometry.guestH}`, canvas: `${Math.round(geometry.width)}x${Math.round(geometry.height)}` }));
await browser.close();
