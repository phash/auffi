# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: connect.spec.ts >> viewer connects to mock sharer and receives stream
- Location: tests/e2e/connect.spec.ts:186:1

# Error details

```
Error: Timed out after 15000ms waiting for pattern /SCREENIE_CODE=\d{3}-\d{3}-\d{3}/
```

# Test source

```ts
  1   | /**
  2   |  * E2E test: viewer + mock-sharer + backend.
  3   |  *
  4   |  * Prerequisites (all three must be satisfied before running):
  5   |  *   1. Backend:       `cd /path/to/repo && docker compose up -d backend`
  6   |  *   2. Viewer dev:    `cd viewer && npm run dev`   (or set VIEWER_URL env var)
  7   |  *   3. Mock-sharer:   spawned by this test automatically.
  8   |  *
  9   |  * Environment variables:
  10  |  *   BACKEND_WS_URL  — WebSocket URL for the signaling server
  11  |  *                     (default: ws://localhost:8080/signal)
  12  |  *   VIEWER_URL      — Base URL of the viewer (default: http://localhost:5173)
  13  |  *                     Playwright config also reads this.
  14  |  *   MANAGE_BACKEND  — If set to "1", the test will start/stop Docker backend.
  15  |  *   MANAGE_VIEWER   — If set to "1", the test will start/stop the Vite dev server.
  16  |  */
  17  | 
  18  | import { test, expect } from "@playwright/test";
  19  | import { spawn, type ChildProcess } from "child_process";
  20  | import * as path from "path";
  21  | import * as fs from "fs";
  22  | import { fileURLToPath } from "url";
  23  | 
  24  | const __filename = fileURLToPath(import.meta.url);
  25  | const __dirname = path.dirname(__filename);
  26  | 
  27  | const BACKEND_WS_URL = process.env.BACKEND_WS_URL ?? "ws://localhost:8080/signal";
  28  | const MOCK_SHARER_SCRIPT = path.resolve(__dirname, "../../../scripts/mock-sharer.mjs");
  29  | const REPO_ROOT = path.resolve(__dirname, "../../..");
  30  | 
  31  | /**
  32  |  * Attach a one-shot listener that resolves when a line matching `pattern`
  33  |  * appears on `proc.stdout`. Must be called before the process produces output.
  34  |  */
  35  | function waitForLine(proc: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
  36  |   return new Promise((resolve, reject) => {
  37  |     const timer = setTimeout(() => {
> 38  |       reject(new Error(`Timed out after ${timeoutMs}ms waiting for pattern ${pattern}`));
      |              ^ Error: Timed out after 15000ms waiting for pattern /SCREENIE_CODE=\d{3}-\d{3}-\d{3}/
  39  |     }, timeoutMs);
  40  | 
  41  |     function onData(chunk: Buffer | string): void {
  42  |       const text = chunk.toString();
  43  |       process.stdout.write(`[mock-sharer] ${text}`);
  44  |       const match = text.match(pattern);
  45  |       if (match) {
  46  |         clearTimeout(timer);
  47  |         proc.stdout?.off("data", onData);
  48  |         resolve(match[0]);
  49  |       }
  50  |     }
  51  | 
  52  |     proc.stdout?.on("data", onData);
  53  |     proc.on("error", (err) => {
  54  |       clearTimeout(timer);
  55  |       reject(err);
  56  |     });
  57  |   });
  58  | }
  59  | 
  60  | function waitForServerReady(url: string, timeoutMs: number): Promise<void> {
  61  |   const httpUrl = url.replace(/^ws/, "http");
  62  |   const deadline = Date.now() + timeoutMs;
  63  |   return new Promise((resolve, reject) => {
  64  |     function attempt(): void {
  65  |       fetch(httpUrl)
  66  |         .then(() => resolve())
  67  |         .catch(() => {
  68  |           if (Date.now() >= deadline) {
  69  |             reject(new Error(`Server at ${httpUrl} not ready within ${timeoutMs}ms`));
  70  |           } else {
  71  |             setTimeout(attempt, 500);
  72  |           }
  73  |         });
  74  |     }
  75  |     attempt();
  76  |   });
  77  | }
  78  | 
  79  | let mockSharerProc: ChildProcess | null = null;
  80  | let viewerProc: ChildProcess | null = null;
  81  | let backendStarted = false;
  82  | let sharerCode = "";
  83  | 
  84  | test.beforeAll(async () => {
  85  |   if (process.env.MANAGE_BACKEND === "1") {
  86  |     await new Promise<void>((resolve, reject) => {
  87  |       const docker = spawn("docker", ["compose", "up", "-d", "backend"], {
  88  |         cwd: REPO_ROOT,
  89  |         stdio: "inherit",
  90  |       });
  91  |       docker.on("close", (code) => {
  92  |         if (code === 0) {
  93  |           backendStarted = true;
  94  |           resolve();
  95  |         } else {
  96  |           reject(new Error(`docker compose up exited with code ${code}`));
  97  |         }
  98  |       });
  99  |     });
  100 | 
  101 |     await waitForServerReady(BACKEND_WS_URL, 30_000);
  102 |   }
  103 | 
  104 |   if (process.env.MANAGE_VIEWER === "1") {
  105 |     const viewerDir = path.resolve(REPO_ROOT, "viewer");
  106 |     viewerProc = spawn("npm", ["run", "dev"], {
  107 |       cwd: viewerDir,
  108 |       stdio: ["ignore", "pipe", "pipe"],
  109 |       env: { ...process.env, FORCE_COLOR: "0" },
  110 |     });
  111 | 
  112 |     await new Promise<void>((resolve, reject) => {
  113 |       const timer = setTimeout(
  114 |         () => reject(new Error("Vite dev server did not become ready within 20s")),
  115 |         20_000,
  116 |       );
  117 |       function onData(chunk: Buffer | string): void {
  118 |         const text = chunk.toString();
  119 |         process.stdout.write(`[viewer-dev] ${text}`);
  120 |         if (text.includes("localhost")) {
  121 |           clearTimeout(timer);
  122 |           viewerProc?.stdout?.off("data", onData);
  123 |           resolve();
  124 |         }
  125 |       }
  126 |       viewerProc?.stdout?.on("data", onData);
  127 |       viewerProc?.stderr?.on("data", onData);
  128 |       viewerProc?.on("error", (err) => {
  129 |         clearTimeout(timer);
  130 |         reject(err);
  131 |       });
  132 |     });
  133 |   }
  134 | 
  135 |   const scriptsNodeModules = path.resolve(REPO_ROOT, "scripts/node_modules");
  136 |   if (!fs.existsSync(scriptsNodeModules)) {
  137 |     await new Promise<void>((resolve, reject) => {
  138 |       const install = spawn("npm", ["install"], {
```