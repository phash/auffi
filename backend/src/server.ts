import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { SessionStore } from "./codes.js";
import { registerSignaling } from "./signaling.js";

export type ServerConfig = {
  port: number;
  host: string;
};

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envList(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const SESSION_TTL_MS = envNumber("SESSION_TTL_MS", 600_000);
const MAX_FAILED_ATTEMPTS = envNumber("MAX_FAILED_ATTEMPTS", 5);
const RATE_LIMIT_WINDOW_MS = envNumber("RATE_LIMIT_WINDOW_MS", 60_000);
const RATE_LIMIT_MAX = envNumber("RATE_LIMIT_MAX", 5);
const ALLOWED_ORIGINS = envList("ALLOWED_ORIGINS", [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost",
  "http://127.0.0.1",
]);

export async function createServer(_cfg: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      base: null,
      redact: {
        paths: [
          "req.remoteAddress",
          "req.remotePort",
          'req.headers["x-forwarded-for"]',
          'req.headers["x-real-ip"]',
          "req.headers.cookie",
          "req.headers.authorization",
        ],
        remove: true,
      },
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
          };
        },
      },
    },
  });

  await app.register(websocketPlugin, {
    options: {
      maxPayload: 65_536,
      verifyClient(info, cb) {
        const origin = info.req.headers.origin as string | undefined;
        if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
          cb(false, 1008, "Origin not allowed");
          return;
        }
        cb(true);
      },
    },
  });

  const store = new SessionStore({ ttlMs: SESSION_TTL_MS, maxAttempts: MAX_FAILED_ATTEMPTS });
  const attemptCounts = registerSignaling(app, store, {
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
  });

  const sweepHandle = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of attemptCounts) {
      if (entry.resetAt < now) attemptCounts.delete(key);
    }
  }, 60_000);

  app.addHook("onClose", () => {
    clearInterval(sweepHandle);
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  return app;
}
