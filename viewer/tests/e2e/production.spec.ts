/**
 * Live smoke against production: spawns scripts/mock-sharer.mjs against
 * wss://auffi.app/signal and connects the real auffi.app viewer to it.
 *
 * SIDE EFFECT — this mutates production usage statistics. The mock sharer's
 * `register` mints a real code, which writes a permanent `code_events` row
 * (the reliable usage counter, 365 d retention) and fires a Matomo
 * code_created event on the live instance. Opt in explicitly:
 *
 *   AUFFI_PROD_E2E=1 npx playwright test production.spec.ts
 */
import { test, expect } from "@playwright/test";
import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

test.skip(
  !process.env.AUFFI_PROD_E2E,
  "mutates prod usage stats (code_events + Matomo) — set AUFFI_PROD_E2E=1 to run",
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROD_VIEWER = "https://auffi.app";
const PROD_SIGNAL = "wss://auffi.app/signal";

let sharer: ChildProcess;
let code = "";
const sharerLines: string[] = [];

test.beforeAll(async () => {
  const script = resolve(__dirname, "../../../scripts/mock-sharer.mjs");
  sharer = spawn("node", [script, PROD_SIGNAL], {
    env: { ...process.env, MOCK_SHARER_ORIGIN: PROD_VIEWER },
  });
  const rl = createInterface({ input: sharer.stdout! });
  const codePromise = new Promise<string>((resolveP) => {
    rl.on("line", (line) => {
      sharerLines.push(line);
      const m = line.match(/^AUFFI_CODE=(.+)$/);
      if (m) resolveP(m[1]);
    });
  });
  const stderrLines: string[] = [];
  createInterface({ input: sharer.stderr! }).on("line", (l) => {
    stderrLines.push(l);
    sharerLines.push(`[stderr] ${l}`);
  });
  code = await Promise.race([
    codePromise,
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error(`no code in 15s. stderr: ${stderrLines.join("\n")}`)), 15000),
    ),
  ]);
});

test.afterAll(async () => {
  sharer?.kill("SIGTERM");
});

test("production viewer connects to mock-sharer via auffi.app", async ({ page }) => {
  // Capture browser console for diagnostics
  page.on("console", (msg) => sharerLines.push(`[browser] ${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => sharerLines.push(`[browser] pageerror: ${err.message}`));

  await page.goto(PROD_VIEWER);

  // Fill code, click connect
  await page.fill("#code", code);
  await page.click("#connect");

  // Status should become "Verbunden — empfange Stream…" after peer-confirmed + offer/answer
  // First, the mock-sharer auto-accepts confirms, so peer-confirmed flows quickly.
  // Then the SDP exchange and ICE happen.
  await expect(page.locator("#status")).toHaveText(/Verbunden|Stream/, { timeout: 30000 });

  // Video should become visible once tracks arrive
  await expect(page.locator("#remote-video")).toBeVisible({ timeout: 15000 });

  // Wait for actual frames (mock-sharer streams a moving teal rectangle at 30fps)
  await expect.poll(async () => {
    return await page.locator("#remote-video").evaluate((v: HTMLVideoElement) => v.videoWidth);
  }, { timeout: 20000, message: "video.videoWidth never went non-zero" }).toBeGreaterThan(0);

  console.log("Diagnostic lines captured:", sharerLines.slice(-30).join("\n"));
});
