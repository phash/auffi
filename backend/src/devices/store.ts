import type { Db } from "../db.js";

/**
 * Delete a device row together with its per-device rate-limit buckets
 * (`device:<id>:%`, e.g. the unattended pwfail counter). The buckets
 * have no FK to the devices table, so without the sweep a re-paired
 * device would silently inherit the old device-id's lockout state.
 *
 * Shared by the two revoke paths in devices/handlers.ts — the owner's
 * cookie-authenticated DELETE /api/devices/:id and the sharer's own
 * Bearer-authenticated self-revoke on the same route — so both clean up
 * identically. Admins revoke devices only indirectly, by suspending or
 * deleting the owning account. Call inside the route's transaction.
 */
export function deleteDeviceCascade(db: Db, deviceId: string): void {
  db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
  db.prepare("DELETE FROM rate_limit_buckets WHERE key LIKE ?").run(`device:${deviceId}:%`);
}
