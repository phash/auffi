import type { FastifyInstance } from "fastify";
import { statSync } from "node:fs";
import type { Db } from "../db.js";
import { queryCodeStats } from "../tracking/code_events.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;
const ONLINE_WINDOW_MS = 90 * 1000;
const STATS_CACHE_TTL_MS = 30_000;

const SERVER_START_MS = Date.now();

interface AdminStats {
  users: {
    total: number;
    verified: number;
    suspended: number;
    active_24h: number;
    active_7d: number;
    active_30d: number;
    new_24h: number;
    new_7d: number;
  };
  devices: {
    total: number;
    online_now: number;
    paired_24h: number;
  };
  connections: {
    today: number;
    week: number;
    p2p_today: number;
    relay_today: number;
    relay_bytes_today: number;
  };
  system: {
    db_size_bytes: number;
    uptime_seconds: number;
  };
}

let cache: { stats: AdminStats; expiresAt: number } | null = null;

/**
 * Visible for testing — flushes the in-process cache so successive tests
 * don't observe stale numbers.
 */
export function _clearStatsCache(): void {
  cache = null;
}

function dbFilePathOf(db: Db): string | null {
  // sqlite3's pragma returns the database file path; ":memory:" returns ""
  // (or an empty string).
  const rows = db
    .prepare<[], { file: string }>("PRAGMA database_list")
    .all() as Array<{ file: string; name?: string; seq?: number }>;
  const main = rows.find((r) => (r as { name?: string }).name === "main") ?? rows[0];
  return main?.file && main.file.length > 0 ? main.file : null;
}

export function computeAdminStats(db: Db, now: number = Date.now()): AdminStats {
  const yest = now - ONE_DAY_MS;
  const week = now - SEVEN_DAYS_MS;
  const month = now - THIRTY_DAYS_MS;
  const today_start = new Date(now).setUTCHours(0, 0, 0, 0);
  const week_start = now - SEVEN_DAYS_MS;

  // Each metric is a single SELECT — no N+1, no nested calls per row.
  const num = (sql: string, params: unknown[] = []): number => {
    const row = db.prepare(sql).get(...params) as { c?: number } | undefined;
    return row?.c ?? 0;
  };

  const users = {
    total: num("SELECT COUNT(*) AS c FROM accounts WHERE deleted_at IS NULL"),
    verified: num(
      "SELECT COUNT(*) AS c FROM accounts WHERE deleted_at IS NULL AND email_verified_at IS NOT NULL",
    ),
    suspended: num(
      "SELECT COUNT(*) AS c FROM accounts WHERE deleted_at IS NULL AND suspended_at IS NOT NULL",
    ),
    active_24h: num(
      `SELECT COUNT(DISTINCT account_id) AS c FROM sessions
        WHERE last_seen_at >= ?`,
      [yest],
    ),
    active_7d: num(
      `SELECT COUNT(DISTINCT account_id) AS c FROM sessions
        WHERE last_seen_at >= ?`,
      [week],
    ),
    active_30d: num(
      `SELECT COUNT(DISTINCT account_id) AS c FROM sessions
        WHERE last_seen_at >= ?`,
      [month],
    ),
    new_24h: num(
      "SELECT COUNT(*) AS c FROM accounts WHERE created_at >= ? AND deleted_at IS NULL",
      [yest],
    ),
    new_7d: num(
      "SELECT COUNT(*) AS c FROM accounts WHERE created_at >= ? AND deleted_at IS NULL",
      [week],
    ),
  };

  const devices = {
    total: num("SELECT COUNT(*) AS c FROM devices"),
    online_now: num("SELECT COUNT(*) AS c FROM devices WHERE last_seen_at >= ?", [
      now - ONLINE_WINDOW_MS,
    ]),
    paired_24h: num("SELECT COUNT(*) AS c FROM devices WHERE created_at >= ?", [yest]),
  };

  const todayRow = db
    .prepare<
      [number, number],
      { c: number; p2p: number; relay: number; bytes: number }
    >(
      `SELECT COUNT(*) AS c,
              SUM(CASE WHEN connection_type = 'p2p' THEN 1 ELSE 0 END) AS p2p,
              SUM(CASE WHEN connection_type = 'relay' THEN 1 ELSE 0 END) AS relay,
              COALESCE(SUM(CASE WHEN connection_type = 'relay' THEN bytes_relayed ELSE 0 END), 0) AS bytes
         FROM connection_log
        WHERE started_at >= ? AND started_at <= ?`,
    )
    .get(today_start, now + 1);
  const connections = {
    today: todayRow?.c ?? 0,
    week: num("SELECT COUNT(*) AS c FROM connection_log WHERE started_at >= ?", [week_start]),
    p2p_today: todayRow?.p2p ?? 0,
    relay_today: todayRow?.relay ?? 0,
    relay_bytes_today: todayRow?.bytes ?? 0,
  };

  const dbPath = dbFilePathOf(db);
  let dbSize = 0;
  if (dbPath) {
    try {
      dbSize = statSync(dbPath).size;
    } catch {
      dbSize = 0;
    }
  }
  const system = {
    db_size_bytes: dbSize,
    uptime_seconds: Math.floor((now - SERVER_START_MS) / 1000),
  };

  return { users, devices, connections, system };
}

export function registerAdminStatsRoutes(app: FastifyInstance, db: Db): void {
  app.get(
    "/api/admin/stats",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async () => {
      const now = Date.now();
      if (cache && cache.expiresAt > now) return cache.stats;
      const stats = computeAdminStats(db, now);
      cache = { stats, expiresAt: now + STATS_CACHE_TTL_MS };
      return stats;
    },
  );

  // Code-Mint-Statistik — DB-Quelle, unabhaengig von Matomo. Liefert
  // total + windowed (24h/7d/30d) + perDay-Buckets fuer die letzten
  // 30 Tage. Kein Caching: Tabelle ist klein und Admins fragen selten
  // an, da reicht ein direktes COUNT.
  app.get(
    "/api/admin/stats/codes",
    { preHandler: [app.requireSession, app.requireAdmin] },
    async () => queryCodeStats(db, Date.now()),
  );
}
