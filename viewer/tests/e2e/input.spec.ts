/**
 * E2E test: input forwarding + file transfer via DataChannels.
 *
 * Prerequisites (all satisfied before running):
 *   1. Backend:    `docker compose up -d backend`
 *   2. Viewer dev: `cd viewer && npm run dev` (or MANAGE_VIEWER=1)
 *   3. Mock-sharer: spawned automatically by this file.
 *
 * Environment variables (same as connect.spec.ts):
 *   BACKEND_WS_URL  — signaling server WebSocket URL (default: ws://localhost:8080/signal)
 *   VIEWER_URL      — viewer base URL (default: http://localhost:5173)
 *   MANAGE_BACKEND  — "1" to start/stop Docker backend
 *   MANAGE_VIEWER   — "1" to start/stop the Vite dev server
 *
 * File transfer note:
 *   The test uses Playwright's `setInputFiles` on the hidden `#file-input` element
 *   to inject a synthetic 5 KB file. The viewer's UI wires this element to the
 *   FileTransferManager so the full WebRTC DataChannel path is exercised.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKEND_WS_URL = process.env.BACKEND_WS_URL ?? "ws://localhost:8080/signal";
const MOCK_SHARER_SCRIPT = path.resolve(__dirname, "../../../scripts/mock-sharer.mjs");
const REPO_ROOT = path.resolve(__dirname, "../../..");

function waitForServerReady(url: string, timeoutMs: number): Promise<void> {
  const httpUrl = url.replace(/^ws/, "http");
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt(): void {
      fetch(httpUrl)
        .then(() => resolve())
        .catch(() => {
          if (Date.now() >= deadline) {
            reject(new Error(`Server at ${httpUrl} not ready within ${timeoutMs}ms`));
          } else {
            setTimeout(attempt, 500);
          }
        });
    }
    attempt();
  });
}

let mockSharerProc: ChildProcess | null = null;
let viewerProc: ChildProcess | null = null;
let backendStarted = false;
let sharerCode = "";

/**
 * Lines emitted by the mock-sharer process on stdout, collected in the order
 * they arrive. Tests poll this array to verify DataChannel delivery.
 */
const sharerOutputLines: string[] = [];

/**
 * Parse all `INPUT_EVENT=<json>` lines accumulated so far and return the
 * decoded objects. Events are small JSON objects so one line = one event.
 */
function parsedInputEvents(): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const line of sharerOutputLines) {
    const prefix = "INPUT_EVENT=";
    if (line.startsWith(prefix)) {
      try {
        result.push(JSON.parse(line.slice(prefix.length)) as Record<string, unknown>);
      } catch {
        // Malformed line — skip.
      }
    }
  }
  return result;
}

/**
 * Find any FILE_RECEIVED line and return its byte count (used when the caller
 * does not know the transfer id in advance).
 */
function anyReceivedFileBytes(): number | undefined {
  for (const line of sharerOutputLines) {
    if (line.startsWith("FILE_RECEIVED=")) {
      const parts = line.slice("FILE_RECEIVED=".length).split(":");
      if (parts.length >= 2) {
        return Number(parts[1]);
      }
    }
  }
  return undefined;
}

test.beforeAll(async () => {
  if (process.env.MANAGE_BACKEND === "1") {
    await new Promise<void>((resolve, reject) => {
      const docker = spawn("docker", ["compose", "up", "-d", "backend"], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
      docker.on("close", (code) => {
        if (code === 0) {
          backendStarted = true;
          resolve();
        } else {
          reject(new Error(`docker compose up exited with code ${code}`));
        }
      });
    });

    await waitForServerReady(BACKEND_WS_URL, 30_000);
  }

  if (process.env.MANAGE_VIEWER === "1") {
    const viewerDir = path.resolve(REPO_ROOT, "viewer");
    viewerProc = spawn("npm", ["run", "dev"], {
      cwd: viewerDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Vite dev server did not become ready within 20s")),
        20_000,
      );
      function onData(chunk: Buffer | string): void {
        const text = chunk.toString();
        process.stdout.write(`[viewer-dev] ${text}`);
        if (text.includes("localhost")) {
          clearTimeout(timer);
          viewerProc?.stdout?.off("data", onData);
          resolve();
        }
      }
      viewerProc?.stdout?.on("data", onData);
      viewerProc?.stderr?.on("data", onData);
      viewerProc?.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  const scriptsNodeModules = path.resolve(REPO_ROOT, "scripts/node_modules");
  if (!fs.existsSync(scriptsNodeModules)) {
    await new Promise<void>((resolve, reject) => {
      const install = spawn("npm", ["install"], {
        cwd: path.resolve(REPO_ROOT, "scripts"),
        stdio: "inherit",
      });
      install.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`npm install failed with code ${code}`)),
      );
    });
  }

  mockSharerProc = spawn("node", [MOCK_SHARER_SCRIPT, BACKEND_WS_URL], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  mockSharerProc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[mock-sharer stderr] ${chunk.toString()}`);
  });

  // Capture the sharer code from the first output line and then keep
  // collecting all subsequent lines into sharerOutputLines for test assertions.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for AUFFI_CODE")),
      15_000,
    );

    function onData(chunk: Buffer | string): void {
      const text = chunk.toString();
      process.stdout.write(`[mock-sharer] ${text}`);

      // Split on newlines; a single chunk may contain multiple lines.
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        sharerOutputLines.push(trimmed);

        if (!sharerCode) {
          const m = trimmed.match(/AUFFI_CODE=(\d{3}-\d{3}-\d{3})/);
          if (m) {
            sharerCode = m[1];
            clearTimeout(timer);
            resolve();
          }
        }
      }
    }

    mockSharerProc?.stdout?.on("data", onData);
    mockSharerProc?.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
});

test.afterAll(async () => {
  mockSharerProc?.kill("SIGTERM");
  mockSharerProc = null;

  viewerProc?.kill("SIGTERM");
  viewerProc = null;

  if (backendStarted && process.env.MANAGE_BACKEND === "1") {
    await new Promise<void>((resolve) => {
      const docker = spawn("docker", ["compose", "down"], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
      docker.on("close", () => resolve());
    });
  }
});

/**
 * Shared helper: navigate to the viewer, enter the sharer code, connect, and
 * wait until the video element is visible and has non-zero videoWidth.
 */
async function connectAndWaitForVideo(page: import("@playwright/test").Page): Promise<void> {
  if (!sharerCode) throw new Error("sharer code was not captured in beforeAll");

  page.on("console", (msg) => {
    process.stdout.write(`[browser ${msg.type()}] ${msg.text()}\n`);
  });
  page.on("pageerror", (err) => {
    process.stderr.write(`[browser error] ${err.message}\n`);
  });

  await page.goto("/");
  await page.locator("#code").fill(sharerCode);
  await page.locator("#connect").click();

  await expect(page.locator("#remote-video")).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(
      async () => {
        return page.evaluate(() => {
          const vid = document.getElementById("remote-video") as HTMLVideoElement | null;
          return vid ? vid.videoWidth : 0;
        });
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBeGreaterThan(0);
}

test("viewer forwards pointer-move events to sharer over datachannel", async ({ page }) => {
  await connectAndWaitForVideo(page);

  // The toolbar with #input-toggle becomes visible when the stream is active.
  await expect(page.locator("#input-toggle")).toBeVisible({ timeout: 10_000 });

  // Enable input forwarding.
  await page.locator("#input-toggle").click();
  await expect(page.locator("#input-toggle")).toHaveAttribute("aria-pressed", "true");

  // Move the pointer to the center of the video element.
  const box = await page.locator("#remote-video").boundingBox();
  if (!box) throw new Error("video element has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Poll until the mock-sharer logs a mouse-move event. The input channel is
  // ordered + reliable (protocol.md; data-channels.ts), so nothing is lost —
  // the repeated moves only cover the rAF coalescing in InputCapture and the
  // channel still settling after ICE, where a single move can land before
  // the channel is open.
  await expect
    .poll(
      async () => {
        await page.mouse.move(
          box.x + box.width / 2 + (Math.random() * 4 - 2),
          box.y + box.height / 2 + (Math.random() * 4 - 2),
        );
        return parsedInputEvents().find((e) => e["kind"] === "mouse-move");
      },
      { timeout: 10_000, intervals: [200, 400, 600, 800, 1000] },
    )
    .toBeTruthy();
});

test("viewer sends file to sharer via file picker and sharer receives all bytes", async ({
  page,
}) => {
  await connectAndWaitForVideo(page);

  // Wait for the toolbar (stream active).
  await expect(page.locator("#disconnect")).toBeVisible({ timeout: 10_000 });

  // Prepare a synthetic 5 120-byte file (5 × 1 024 bytes).
  const FILE_SIZE = 5 * 1024;
  const fileContent = Buffer.alloc(FILE_SIZE, 0x42); // fill with 'B'

  // The `#file-send-btn` click opens a file picker via `#file-input.click()`.
  // We intercept the filechooser event that Playwright would normally require
  // user interaction to dismiss, by setting the files on the hidden input
  // directly — this is the standard Playwright pattern for hidden file inputs.
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator("#file-send-btn").click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "test-transfer.bin",
    mimeType: "application/octet-stream",
    buffer: fileContent,
  });

  // The mock-sharer auto-accepts the offer and logs FILE_RECEIVED=<id>:<bytes>
  // once all chunks have arrived and `file-done` is received.
  await expect
    .poll(
      () => anyReceivedFileBytes(),
      { timeout: 15_000, intervals: [500, 1000, 2000] },
    )
    .toBe(FILE_SIZE);
});
