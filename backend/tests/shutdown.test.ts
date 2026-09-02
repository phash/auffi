import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";

// `docker stop` sends SIGTERM. Node's default disposition on SIGTERM is an
// immediate exit, so without a handler none of the onClose hooks server.ts
// registers (sweep + purge timers, db.close, the WS close frames
// @fastify/websocket sends its clients) ever ran in production: every
// deploy handed connected peers a TCP reset instead of a close frame and
// left SQLite to WAL crash-recovery. The entry point must close cleanly.
describe("index.ts shutdown", () => {
  it("closes the server and exits 0 on SIGTERM", async () => {
    const backendDir = join(import.meta.dirname, "..");
    const child = spawn(
      join(backendDir, "node_modules", ".bin", "tsx"),
      ["src/index.ts"],
      {
        cwd: backendDir,
        env: {
          ...process.env,
          PORT: "0",
          HOST: "127.0.0.1",
          AUFFI_DB_PATH: ":memory:",
          // Production logger = plain JSON lines, parseable below.
          NODE_ENV: "production",
          ALLOWED_ORIGINS: "http://127.0.0.1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      out += d.toString();
    });

    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server never listened:\n${out}`)), 15_000);
      const poll = setInterval(() => {
        if (out.includes('"msg":"server listening"')) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });

    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no exit after SIGTERM:\n${out}`)), 5_000)),
    ]);
    expect(code).toBe(0);
    expect(out).toContain('"msg":"shutting down"');
  }, 30_000);
});
