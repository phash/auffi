import type { WebSocket } from "ws";
import type { Db } from "./db.js";
import { verifyPassword } from "./auth/argon.js";

/**
 * In-memory registry of open WSS connections from authenticated
 * unattended sharers, keyed by device-id. Used by signaling.ts to
 * remember which device-id a connection belongs to, and by
 * devices/handlers.ts to force-close a connection when the owner
 * deletes the device from the dashboard (spec section 16 acceptance).
 *
 * Not persisted across restarts — a restart drops every connection
 * anyway; the next reconnect re-authenticates fresh.
 */
export class UnattendedRegistry {
  private readonly conns = new Map<string, WebSocket>();

  register(deviceId: string, peer: WebSocket): void {
    const prev = this.conns.get(deviceId);
    if (prev && prev !== peer) {
      try {
        prev.close(4408, "superseded by newer connection");
      } catch {
        /* prev already closing — ignore */
      }
    }
    this.conns.set(deviceId, peer);
  }

  unregister(deviceId: string, peer: WebSocket): void {
    const current = this.conns.get(deviceId);
    if (current === peer) this.conns.delete(deviceId);
  }

  evict(deviceId: string): void {
    const peer = this.conns.get(deviceId);
    if (!peer) return;
    this.conns.delete(deviceId);
    try {
      peer.close(4401, "device revoked");
    } catch {
      /* already closing — ignore */
    }
  }

  has(deviceId: string): boolean {
    return this.conns.has(deviceId);
  }

  /**
   * Return the live WSS for `deviceId`, or `undefined` if no sharer
   * is currently connected for that device. Used by signaling.ts to
   * find the paired sharer when a viewer joins with a code that
   * matches a registered device-id (gh #17).
   */
  peer(deviceId: string): WebSocket | undefined {
    return this.conns.get(deviceId);
  }

  size(): number {
    return this.conns.size;
  }
}

export const WS_CLOSE = {
  AUTH_FAILED: 4401,
  SUPERSEDED: 4408,
} as const;

export interface BearerAuth {
  deviceId: string;
  token: string;
}

const DEVICE_ID_RE = /^\d{3}-\d{3}-\d{3}$/;

/**
 * Parse the upgrade headers for a bearer-auth attempt. Returns:
 *   - null         — no bearer headers at all (ad-hoc path)
 *   - BearerAuth   — both headers present and well-shaped (verify next)
 *   - "malformed"  — bearer attempt that does not match the shape;
 *                    caller MUST close with 4401 rather than fall
 *                    through, otherwise an attacker could mask
 *                    unattended-mode brute-forcing as ad-hoc reconnects.
 *
 * Pure: takes a plain header bag so it is trivial to unit-pin.
 */
export function parseBearerAuth(
  headers: Record<string, string | string[] | undefined>,
): BearerAuth | "malformed" | null {
  const auth = pickString(headers.authorization ?? headers.Authorization);
  const did = pickString(headers["x-auffi-device-id"] ?? headers["X-Auffi-Device-Id"]);
  if (auth === undefined && did === undefined) return null;
  if (auth === undefined || did === undefined) return "malformed";
  const m = /^Bearer\s+(\S+)\s*$/.exec(auth);
  if (!m) return "malformed";
  if (!DEVICE_ID_RE.test(did)) return "malformed";
  if (!/^[0-9a-f]{64}$/.test(m[1])) return "malformed";
  return { deviceId: did, token: m[1] };
}

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Verify a parsed bearer auth against the devices table. Returns
 * `true` iff the device exists and the presented token argon2-verifies
 * against the stored token_hash.
 *
 * Updates last_seen_at = now on success.
 */
/**
 * Read the device's `auto_accept` flag fresh from the DB. Used by
 * signaling.ts when forwarding a viewer's `pw-attempt` as `pw-check`
 * so the value reflects the latest dashboard toggle (gh #25).
 * Returns `false` for an unknown device-id — the dashboard would
 * have to mint a fresh row before the pair, so an unknown id at
 * this point is a protocol error caught upstream.
 */
export function getAutoAccept(db: Db, deviceId: string): boolean {
  const row = db
    .prepare<[string], { auto_accept: number }>(
      "SELECT auto_accept FROM devices WHERE id = ?",
    )
    .get(deviceId);
  return row !== undefined && row.auto_accept === 1;
}

export async function verifyBearerAuth(
  db: Db,
  auth: BearerAuth,
  now: number = Date.now(),
): Promise<boolean> {
  const row = db
    .prepare<[string], { token_hash: string }>(
      "SELECT token_hash FROM devices WHERE id = ?",
    )
    .get(auth.deviceId);
  if (!row) return false;
  const ok = await verifyPassword(row.token_hash, auth.token);
  if (!ok) return false;
  db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(
    now,
    auth.deviceId,
  );
  return true;
}
