import type { Db } from "./db.js";

export interface ConnectionLogRow {
  id: number;
  deviceId: string;
  startedAt: number;
  endedAt: number | null;
  viewerIpPrefix: string;
  connectionType: "p2p" | "relay";
  bytesRelayed: number;
}

// The WRITE path (startConnectionLog / endConnectionLog, fed by the
// connection-started / connection-ended wire frames) was removed as
// dead code: no client ever emitted the frames, so connection_log rows
// were never produced in production. gh #109 tracks (re)introducing
// the telemetry end-to-end. The READ surface below stays — the table
// exists, GET /api/devices/:id/log and the admin stats query it, and
// purge.ts enforces its 30-day retention.

/**
 * Page of connection_log rows for a device, newest first. The
 * `cursor` is the smallest id seen on the previous page — pass
 * `undefined` for page 1. `limit` is clamped to `MAX_LIMIT` so a
 * malicious caller can't ask for the whole table.
 */
export const MAX_LIMIT = 100;

interface RawRow {
  id: number;
  device_id: string;
  started_at: number;
  ended_at: number | null;
  viewer_ip_prefix: string;
  connection_type: string;
  bytes_relayed: number;
}

export function listConnectionLog(
  db: Db,
  deviceId: string,
  cursor: number | undefined,
  limit: number,
): { items: ConnectionLogRow[]; nextCursor: number | null } {
  const safeLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
  // The only difference between the cursor and no-cursor cases is
  // one extra `AND id < ?` predicate and one extra bind param.
  // Build the SQL once, dispatch once.
  const cursorPredicate = cursor !== undefined ? " AND id < ?" : "";
  const sql =
    `SELECT id, device_id, started_at, ended_at, viewer_ip_prefix,
            connection_type, bytes_relayed
     FROM connection_log
     WHERE device_id = ?${cursorPredicate}
     ORDER BY id DESC
     LIMIT ?`;
  const stmt = db.prepare<unknown[], RawRow>(sql);
  const rows =
    cursor !== undefined
      ? stmt.all(deviceId, cursor, safeLimit + 1)
      : stmt.all(deviceId, safeLimit + 1);

  const hasMore = rows.length > safeLimit;
  const page = hasMore ? rows.slice(0, safeLimit) : rows;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  return {
    items: page.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      viewerIpPrefix: r.viewer_ip_prefix,
      connectionType: r.connection_type as "p2p" | "relay",
      bytesRelayed: r.bytes_relayed,
    })),
    nextCursor,
  };
}
