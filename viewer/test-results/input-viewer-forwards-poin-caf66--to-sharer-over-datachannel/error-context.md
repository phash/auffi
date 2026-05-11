# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: input.spec.ts >> viewer forwards pointer-move events to sharer over datachannel
- Location: tests/e2e/input.spec.ts:277:1

# Error details

```
Error: Timed out waiting for SCREENIE_CODE
```

# Test source

```ts
  92  |     }
  93  |   }
  94  |   // Also handle lines that only contain the total (without id) for robustness:
  95  |   // `FILE_RECEIVED=<id>:<bytes>` is the canonical form, but allow a partial
  96  |   // scan if the transfer id is unknown at call time (not used here).
  97  |   return undefined;
  98  | }
  99  | 
  100 | /**
  101 |  * Find any FILE_RECEIVED line and return its byte count (used when the caller
  102 |  * does not know the transfer id in advance).
  103 |  */
  104 | function anyReceivedFileBytes(): number | undefined {
  105 |   for (const line of sharerOutputLines) {
  106 |     if (line.startsWith("FILE_RECEIVED=")) {
  107 |       const parts = line.slice("FILE_RECEIVED=".length).split(":");
  108 |       if (parts.length >= 2) {
  109 |         return Number(parts[1]);
  110 |       }
  111 |     }
  112 |   }
  113 |   return undefined;
  114 | }
  115 | 
  116 | test.beforeAll(async () => {
  117 |   if (process.env.MANAGE_BACKEND === "1") {
  118 |     await new Promise<void>((resolve, reject) => {
  119 |       const docker = spawn("docker", ["compose", "up", "-d", "backend"], {
  120 |         cwd: REPO_ROOT,
  121 |         stdio: "inherit",
  122 |       });
  123 |       docker.on("close", (code) => {
  124 |         if (code === 0) {
  125 |           backendStarted = true;
  126 |           resolve();
  127 |         } else {
  128 |           reject(new Error(`docker compose up exited with code ${code}`));
  129 |         }
  130 |       });
  131 |     });
  132 | 
  133 |     await waitForServerReady(BACKEND_WS_URL, 30_000);
  134 |   }
  135 | 
  136 |   if (process.env.MANAGE_VIEWER === "1") {
  137 |     const viewerDir = path.resolve(REPO_ROOT, "viewer");
  138 |     viewerProc = spawn("npm", ["run", "dev"], {
  139 |       cwd: viewerDir,
  140 |       stdio: ["ignore", "pipe", "pipe"],
  141 |       env: { ...process.env, FORCE_COLOR: "0" },
  142 |     });
  143 | 
  144 |     await new Promise<void>((resolve, reject) => {
  145 |       const timer = setTimeout(
  146 |         () => reject(new Error("Vite dev server did not become ready within 20s")),
  147 |         20_000,
  148 |       );
  149 |       function onData(chunk: Buffer | string): void {
  150 |         const text = chunk.toString();
  151 |         process.stdout.write(`[viewer-dev] ${text}`);
  152 |         if (text.includes("localhost")) {
  153 |           clearTimeout(timer);
  154 |           viewerProc?.stdout?.off("data", onData);
  155 |           resolve();
  156 |         }
  157 |       }
  158 |       viewerProc?.stdout?.on("data", onData);
  159 |       viewerProc?.stderr?.on("data", onData);
  160 |       viewerProc?.on("error", (err) => {
  161 |         clearTimeout(timer);
  162 |         reject(err);
  163 |       });
  164 |     });
  165 |   }
  166 | 
  167 |   const scriptsNodeModules = path.resolve(REPO_ROOT, "scripts/node_modules");
  168 |   if (!fs.existsSync(scriptsNodeModules)) {
  169 |     await new Promise<void>((resolve, reject) => {
  170 |       const install = spawn("npm", ["install"], {
  171 |         cwd: path.resolve(REPO_ROOT, "scripts"),
  172 |         stdio: "inherit",
  173 |       });
  174 |       install.on("close", (code) =>
  175 |         code === 0 ? resolve() : reject(new Error(`npm install failed with code ${code}`)),
  176 |       );
  177 |     });
  178 |   }
  179 | 
  180 |   mockSharerProc = spawn("node", [MOCK_SHARER_SCRIPT, BACKEND_WS_URL], {
  181 |     stdio: ["ignore", "pipe", "pipe"],
  182 |   });
  183 | 
  184 |   mockSharerProc.stderr?.on("data", (chunk: Buffer) => {
  185 |     process.stderr.write(`[mock-sharer stderr] ${chunk.toString()}`);
  186 |   });
  187 | 
  188 |   // Capture the sharer code from the first output line and then keep
  189 |   // collecting all subsequent lines into sharerOutputLines for test assertions.
  190 |   await new Promise<void>((resolve, reject) => {
  191 |     const timer = setTimeout(
> 192 |       () => reject(new Error("Timed out waiting for SCREENIE_CODE")),
      |                    ^ Error: Timed out waiting for SCREENIE_CODE
  193 |       15_000,
  194 |     );
  195 | 
  196 |     function onData(chunk: Buffer | string): void {
  197 |       const text = chunk.toString();
  198 |       process.stdout.write(`[mock-sharer] ${text}`);
  199 | 
  200 |       // Split on newlines; a single chunk may contain multiple lines.
  201 |       const lines = text.split("\n");
  202 |       for (const line of lines) {
  203 |         const trimmed = line.trim();
  204 |         if (!trimmed) continue;
  205 |         sharerOutputLines.push(trimmed);
  206 | 
  207 |         if (!sharerCode) {
  208 |           const m = trimmed.match(/SCREENIE_CODE=(\d{3}-\d{3}-\d{3})/);
  209 |           if (m) {
  210 |             sharerCode = m[1];
  211 |             clearTimeout(timer);
  212 |             resolve();
  213 |           }
  214 |         }
  215 |       }
  216 |     }
  217 | 
  218 |     mockSharerProc?.stdout?.on("data", onData);
  219 |     mockSharerProc?.on("error", (err) => {
  220 |       clearTimeout(timer);
  221 |       reject(err);
  222 |     });
  223 |   });
  224 | });
  225 | 
  226 | test.afterAll(async () => {
  227 |   mockSharerProc?.kill("SIGTERM");
  228 |   mockSharerProc = null;
  229 | 
  230 |   viewerProc?.kill("SIGTERM");
  231 |   viewerProc = null;
  232 | 
  233 |   if (backendStarted && process.env.MANAGE_BACKEND === "1") {
  234 |     await new Promise<void>((resolve) => {
  235 |       const docker = spawn("docker", ["compose", "down"], {
  236 |         cwd: REPO_ROOT,
  237 |         stdio: "inherit",
  238 |       });
  239 |       docker.on("close", () => resolve());
  240 |     });
  241 |   }
  242 | });
  243 | 
  244 | /**
  245 |  * Shared helper: navigate to the viewer, enter the sharer code, connect, and
  246 |  * wait until the video element is visible and has non-zero videoWidth.
  247 |  */
  248 | async function connectAndWaitForVideo(page: import("@playwright/test").Page): Promise<void> {
  249 |   if (!sharerCode) throw new Error("sharer code was not captured in beforeAll");
  250 | 
  251 |   page.on("console", (msg) => {
  252 |     process.stdout.write(`[browser ${msg.type()}] ${msg.text()}\n`);
  253 |   });
  254 |   page.on("pageerror", (err) => {
  255 |     process.stderr.write(`[browser error] ${err.message}\n`);
  256 |   });
  257 | 
  258 |   await page.goto("/");
  259 |   await page.locator("#code").fill(sharerCode);
  260 |   await page.locator("#connect").click();
  261 | 
  262 |   await expect(page.locator("#remote-video")).toBeVisible({ timeout: 30_000 });
  263 | 
  264 |   await expect
  265 |     .poll(
  266 |       async () => {
  267 |         return page.evaluate(() => {
  268 |           const vid = document.getElementById("remote-video") as HTMLVideoElement | null;
  269 |           return vid ? vid.videoWidth : 0;
  270 |         });
  271 |       },
  272 |       { timeout: 30_000, intervals: [500, 1000, 2000] },
  273 |     )
  274 |     .toBeGreaterThan(0);
  275 | }
  276 | 
  277 | test("viewer forwards pointer-move events to sharer over datachannel", async ({ page }) => {
  278 |   await connectAndWaitForVideo(page);
  279 | 
  280 |   // The toolbar with #input-toggle becomes visible when the stream is active.
  281 |   await expect(page.locator("#input-toggle")).toBeVisible({ timeout: 10_000 });
  282 | 
  283 |   // Enable input forwarding.
  284 |   await page.locator("#input-toggle").click();
  285 |   await expect(page.locator("#input-toggle")).toHaveAttribute("aria-pressed", "true");
  286 | 
  287 |   // Move the pointer to the center of the video element.
  288 |   const box = await page.locator("#remote-video").boundingBox();
  289 |   if (!box) throw new Error("video element has no bounding box");
  290 |   await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  291 | 
  292 |   // Poll until the mock-sharer logs a mouse-move event. The DataChannel is
```