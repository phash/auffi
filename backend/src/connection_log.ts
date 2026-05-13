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

/**
 * Insert a fresh connection_log row at WebRTC-connect time.
 * `viewerIpPrefix` is the redacted form (e.g. "84.xxx") — see
 * signaling.ts's `ipPrefix()` helper. `bytesRelayed` starts at 0 and
 * gets updated when the sharer reports `connection-ended` at session
 * close (spec section 18).
 *
 * Returns the new row's id so callers can `endConnectionLog` later.
 */
export function startConnectionLog(
  db: Db,
  deviceId: string,
  viewerIpPrefix: string,
  connectionType: "p2p" | "relay",
  now: number = Date.now(),
): number {
  const res = db
    .prepare(
      `INSERT INTO connection_log
         (device_id, started_at, ended_at, viewer_ip_prefix, connection_type, bytes_relayed)
       VALUES (?, ?, NULL, ?, ?, 0)`,
    )
    .run(deviceId, now, viewerIpPrefix, connectionType);
  return Number(res.lastInsertRowid);
}

/**
 * Finalise a connection_log row. Sets `ended_at` and the final
 * `bytes_relayed` count. Idempotent — calling with a non-existent id
 * is a no-op.
 */
export function endConnectionLog(
  db: Db,
  id: number,
  bytesRelayed: number,
  now: number = Date.now(),
): void {
  db.prepare(
    "UPDATE connection_log SET ended_at = ?, bytes_relayed = ? WHERE id = ?",
  ).run(now, bytesRelayed, id);
}

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
