import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import rateLimitPlugin from "@fastify/rate-limit";
import corsPlugin from "@fastify/cors";
import { SessionStore } from "./codes.js";
import { registerSignaling } from "./signaling.js";
import type { RateLimitEntry } from "./signaling.js";
import { registerTurnEndpoint } from "./turn-credentials.js";
import { openDb, applyMigrations, defaultMigrationsDir, type Db } from "./db.js";
import { mailerFromEnv } from "./email/mailer.js";
import { decorateRequireSession } from "./auth/middleware.js";
import { decorateRequireAdmin } from "./admin/middleware.js";
import { registerAuthRoutes } from "./auth/handlers.js";
import { registerMeRoutes } from "./account/me.js";
import { registerDeviceRoutes } from "./devices/handlers.js";
import { registerAdminUsersRoutes } from "./admin/users.js";
import { registerAdminDevicesRoutes } from "./admin/devices.js";
import { registerAdminAuditRoutes } from "./admin/audit.js";
import { registerAdminStatsRoutes } from "./admin/stats.js";
import { registerAdminTimeseriesRoutes } from "./admin/timeseries.js";
import { bootstrapInitialAdmin } from "./admin/bootstrap.js";

export type ServerConfig = {
  port: number;
  host: string;
  /**
   * Override the DB path. When undefined the server falls back to
   * `process.env.AUFFI_DB_PATH` / `db.ts:DEFAULT_DB_PATH`. Tests pass
   * `:memory:` for hermetic runs.
   */
  dbPath?: string;
  /**
   * Optional pre-built DB handle. When provided, the server skips
   * `openDb` entirely and uses this one as-is. Tests that need to
   * pre-seed rows before any route registers will pass their own
   * handle here.
   */
  db?: Db;
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

function readEnvConfig() {
  return {
    sessionTtlMs: envNumber("SESSION_TTL_MS", 600_000),
    maxFailedAttempts: envNumber("MAX_FAILED_ATTEMPTS", 5),
    rateLimitWindowMs: envNumber("RATE_LIMIT_WINDOW_MS", 60_000),
    rateLimitMax: envNumber("RATE_LIMIT_MAX", 5),
    registerRateLimitWindowMs: envNumber("REGISTER_RATE_LIMIT_WINDOW_MS", 60_000),
    registerRateLimitMax: envNumber("REGISTER_RATE_LIMIT_MAX", 5),
    allowedOrigins: envList("ALLOWED_ORIGINS", [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost",
      "http://127.0.0.1",
    ]),
  };
}

const REDACT_PATHS = [
  "req.remoteAddress",
  "req.remotePort",
  'req.headers["x-forwarded-for"]',
  'req.headers["x-real-ip"]',
  "req.headers.cookie",
  "req.headers.authorization",
];

const REQ_SERIALIZER = {
  req(request: { method: string; url: string }) {
    return { method: request.method, url: request.url };
  },
};

function buildLoggerOptions(nodeEnv: string | undefined) {
  const redact = { paths: REDACT_PATHS, remove: true };
  if (nodeEnv !== "production") {
    return {
      level: "debug",
      base: null,
      redact,
      serializers: REQ_SERIALIZER,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, ignore: "pid,hostname" },
      },
    };
  }
  return {
    level: "info",
    base: null,
    redact,
    serializers: REQ_SERIALIZER,
  };
}

export async function createServer(cfg: ServerConfig): Promise<FastifyInstance> {
  // Read env at call-time so tests can override values per-server.
  const env = readEnvConfig();
  const turnSharedSecret = process.env.TURN_SHARED_SECRET ?? "";
  const turnRealm = process.env.TURN_REALM ?? "localhost";
  const turnHosts = envList("TURN_HOSTS", []);
  const turnTtlSec = envNumber("TURN_TTL_SEC", 3600);
  const app = Fastify({
    logger: buildLoggerOptions(process.env.NODE_ENV),
    // We run behind the cluster's Caddy reverse-proxy (which sets
    // X-Forwarded-For). Without this, req.ip resolves to the proxy's
    // address for every request and the per-IP rate limiters
    // (signaling joins, /turn-credentials, auth endpoints) collapse to
    // a single bucket. The backend port is not exposed outside the
    // internal docker network so the trust is safe.
    trustProxy: true,
  });

  await app.register(rateLimitPlugin, { global: true, max: 1000, timeWindow: "1 minute" });

  await app.register(corsPlugin, {
    origin: env.allowedOrigins,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    // The dashboard sends credentials (auffi_session cookie) on every
    // authenticated request. Without this the browser strips the
    // cookie on cross-origin requests in dev mode.
    credentials: true,
  });

  await app.register(websocketPlugin, {
    options: {
      maxPayload: 65_536,
      verifyClient(info, cb) {
        const origin = info.req.headers.origin as string | undefined;
        if (!origin || !env.allowedOrigins.includes(origin)) {
          // 403 is the correct pre-handshake reject status. 1008 (Policy
          // Violation) is a WebSocket close code, NOT a valid HTTP status —
          // reverse proxies reject the malformed response as 502.
          cb(false, 403, "Origin not allowed");
          return;
        }
        cb(true);
      },
    },
  });

  const store = new SessionStore({ ttlMs: env.sessionTtlMs, maxAttempts: env.maxFailedAttempts });
  const registerCounts: Map<string, RateLimitEntry> = new Map();
  const attemptCounts = registerSignaling(
    app,
    store,
    { windowMs: env.rateLimitWindowMs, max: env.rateLimitMax },
    undefined,
    undefined,
    { windowMs: env.registerRateLimitWindowMs, max: env.registerRateLimitMax },
    registerCounts,
  );

  const sweepHandle = setInterval(() => {
    const now = Date.now();
    for (const map of [attemptCounts, registerCounts]) {
      for (const [key, entry] of map) {
        if (entry.resetAt < now) map.delete(key);
      }
    }
  }, 60_000);

  app.addHook("onClose", () => {
    clearInterval(sweepHandle);
  });

  const healthPayload = () => ({
    status: "ok",
    version: process.env.APP_VERSION ?? "dev",
    uptime: Math.floor(process.uptime()),
  });

  app.get("/healthz", async () => healthPayload());
  app.get("/readyz", async () => healthPayload());

  if (!turnSharedSecret) {
    app.log.warn("TURN_SHARED_SECRET not set — /turn-credentials endpoint disabled");
  } else {
    registerTurnEndpoint(app, {
      sharedSecret: turnSharedSecret,
      realm: turnRealm,
      urls: turnHosts,
      ttlSec: turnTtlSec,
      allowedOrigins: env.allowedOrigins,
      sessionStore: store,
    });
  }

  // ── SQLite-backed surfaces: accounts, devices, /me, admin ──────────
  // Before this hook landed, all of these route registrars existed in
  // the codebase but were never invoked from `createServer` — the
  // /api/auth/*, /api/me/*, /api/devices/*, /api/admin/* surfaces were
  // dead code in v0.3.0 (Sec OBS-1, fixed here). End-to-end pairing,
  // the unattended WSS Bearer flow (gh #16/#17), and the dashboard all
  // depend on these being live.
  //
  // Tests pass an in-memory DB (or a pre-seeded handle) via `cfg`. In
  // production we open a file-backed connection from AUFFI_DB_PATH (or
  // the volume-mounted default at /var/lib/auffi/auffi.db) and apply
  // migrations every boot — idempotent if no new files appear.
  const ownsDb = cfg.db === undefined;
  const db: Db = cfg.db ?? openDb(cfg.dbPath);
  if (ownsDb) {
    applyMigrations(db, defaultMigrationsDir());
  }

  const { mailer, accountMailer } = mailerFromEnv();

  decorateRequireSession(app, db);
  decorateRequireAdmin(app, db);

  registerAuthRoutes(app, { db, mailer });
  registerMeRoutes(app, { db, mailer: accountMailer });
  registerDeviceRoutes(app, { db });
  registerAdminUsersRoutes(app, db);
  registerAdminDevicesRoutes(app, db);
  registerAdminAuditRoutes(app, db);
  registerAdminStatsRoutes(app, db);
  registerAdminTimeseriesRoutes(app, db);

  // Promote the configured INITIAL_ADMIN_EMAIL on every boot.
  // Idempotent — if the account doesn't exist yet (first deploy), the
  // next signup will trigger the same check via `maybePromoteToAdmin`.
  const bootstrap = bootstrapInitialAdmin(db);
  if (bootstrap.promoted) {
    app.log.info({ email: bootstrap.email }, "promoted initial admin account");
  }

  // Close the DB on shutdown only if we opened it; injected handles
  // belong to the caller.
  if (ownsDb) {
    app.addHook("onClose", () => {
      db.close();
    });
  }

  return app;
}
