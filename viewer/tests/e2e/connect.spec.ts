/**
 * E2E test: viewer + mock-sharer + backend.
 *
 * Prerequisites (all three must be satisfied before running):
 *   1. Backend:       `cd /path/to/repo && docker compose up -d backend`
 *   2. Viewer dev:    `cd viewer && npm run dev`   (or set VIEWER_URL env var)
 *   3. Mock-sharer:   spawned by this test automatically.
 *
 * Environment variables:
 *   BACKEND_WS_URL  — WebSocket URL for the signaling server
 *                     (default: ws://localhost:8080/signal)
 *   VIEWER_URL      — Base URL of the viewer (default: http://localhost:5173)
 *                     Playwright config also reads this.
 *   MANAGE_BACKEND  — If set to "1", the test will start/stop Docker backend.
 *   MANAGE_VIEWER   — If set to "1", the test will start/stop the Vite dev server.
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

/**
 * Attach a one-shot listener that resolves when a line matching `pattern`
 * appears on `proc.stdout`. Must be called before the process produces output.
 */
function waitForLine(proc: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for pattern ${pattern}`));
    }, timeoutMs);

    function onData(chunk: Buffer | string): void {
      const text = chunk.toString();
      process.stdout.write(`[mock-sharer] ${text}`);
      const match = text.match(pattern);
      if (match) {
        clearTimeout(timer);
        proc.stdout?.off("data", onData);
        resolve(match[0]);
      }
    }

    proc.stdout?.on("data", onData);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

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

  const codeLine = await waitForLine(
    mockSharerProc,
    /SCREENIE_CODE=\d{3}-\d{3}-\d{3}/,
    15_000,
  );
  sharerCode = codeLine.replace("SCREENIE_CODE=", "").trim();

  mockSharerProc.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[mock-sharer] ${chunk.toString()}`);
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

test("viewer connects to mock sharer and receives stream", async ({ page }) => {
  if (!sharerCode) throw new Error("sharer code was not captured in beforeAll");

  page.on("console", (msg) => {
    process.stdout.write(`[browser ${msg.type()}] ${msg.text()}\n`);
  });
  page.on("pageerror", (err) => {
    process.stderr.write(`[browser error] ${err.message}\n`);
  });

  await page.goto("/");

  const codeInput = page.locator("#code");
  await codeInput.fill(sharerCode);

  await page.locator("#connect").click();

  await expect(page.locator("#status")).toHaveText("Verbunden — empfange Stream…", {
    timeout: 30_000,
  });

  await expect(page.locator("#remote-video")).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(
      async () => {
        const width = await page.evaluate(() => {
          const vid = document.getElementById("remote-video") as HTMLVideoElement | null;
          return vid ? vid.videoWidth : 0;
        });
        return width;
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBeGreaterThan(0);
});
