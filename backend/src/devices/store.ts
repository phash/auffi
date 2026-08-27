import type { Db } from "../db.js";

/**
 * Delete a device row together with its per-device rate-limit buckets
 * (`device:<id>:%`, e.g. the unattended pwfail counter). The buckets
 * have no FK to the devices table, so without the sweep a re-paired
 * device would silently inherit the old device-id's lockout state.
 *
 * Shared by the owner-facing DELETE /api/devices/:id and the admin
 * DELETE /api/admin/devices/:id so both paths clean up identically.
 * Call inside the route's transaction where one exists.
 */
export function deleteDeviceCascade(db: Db, deviceId: string): void {
  db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
  db.prepare("DELETE FROM rate_limit_buckets WHERE key LIKE ?").run(`device:${deviceId}:%`);
}
