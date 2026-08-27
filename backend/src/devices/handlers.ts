import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomInt } from "node:crypto";
import type { Db } from "../db.js";
import { hashPassword } from "../auth/argon.js";
import { newToken, hashToken } from "../auth/tokens.js";
import { parseBearerAuth, verifyBearerAuth, type UnattendedRegistry } from "../unattended.js";
import { listConnectionLog, MAX_LIMIT as LOG_MAX_LIMIT } from "../connection_log.js";
import { deleteDeviceCascade } from "./store.js";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const ONLINE_WINDOW_MS = 90 * 1000;
const DEVICE_ID_MAX_ATTEMPTS = 10;

export interface DevicesDeps {
  db: Db;
  /**
   * Optional registry of open unattended-sharer WSS connections.
   * When provided, DELETE /api/devices/:id force-closes the sharer's
   * live connection with WS code 4401 so a revoked device can't keep
   * relaying messages until its next reconnect (gh #16 acceptance).
   */
  registry?: UnattendedRegistry;
}

function bad(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: code, message });
}

/**
 * Mint a fresh pairing code shaped XXX-XXX-XX (8 chars + 2 dashes).
 * Uppercase alphanumerics minus ambiguous glyphs (I/O/0/1) so a user
 * reading off a phone screen has fewer ways to misread.
 */
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function mintPairingCode(): string {
  const chars: string[] = [];
  for (let i = 0; i < 8; i++) {
    chars.push(PAIRING_ALPHABET[randomInt(0, PAIRING_ALPHABET.length)]);
  }
  return `${chars.slice(0, 3).join("")}-${chars.slice(3, 6).join("")}-${chars.slice(6, 8).join("")}`;
}

/**
 * Normalise a user-supplied pairing-code string: uppercase, strip every
 * character that isn't a valid alphabet member or a dash. This makes
 * paste-from-mail-client robust (smart-quotes, surrounding whitespace,
 * lower-case typing).
 */
export function normalizePairingCode(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .replace(/-+/g, "-");
  return cleaned;
}

/**
 * Mint a 9-digit device-id of the form `NNN-NNN-NNN`. The 0-999 999 999
 * space is huge so collisions are extremely rare, but the caller
 * (redeem) still retries on conflict up to DEVICE_ID_MAX_ATTEMPTS times.
 */
function mintDeviceId(): string {
  const n = randomInt(0, 1_000_000_000).toString().padStart(9, "0");
  return `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6, 9)}`;
}

export function registerDeviceRoutes(app: FastifyInstance, deps: DevicesDeps): void {
  const { db, registry } = deps;

  // ── POST /api/devices/pairing-code ──────────────────────────────────
  // Auth-required; only the account owner mints codes for their own
  // pairings. 5/h/IP per spec §9.
  app.post(
    "/api/devices/pairing-code",
    {
      preHandler: app.requireSession,
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const code = mintPairingCode();
      const expiresAt = Date.now() + PAIRING_TTL_MS;
      db.prepare(
        `INSERT INTO device_pairings (code_hash, account_id, expires_at, used_at)
         VALUES (?, ?, ?, NULL)`,
      ).run(hashToken(code), req.account!.id, expiresAt);
      return reply.status(200).send({ code, expiresAt });
    },
  );

  // ── POST /api/devices/redeem ────────────────────────────────────────
  // No session auth — the SHARER calls this with the user-supplied
  // pairing code. 5/min/IP per spec §9 (modest, the code is one-shot
  // and short-lived so guessing isn't a serious risk).
  app.post(
    "/api/devices/redeem",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as { code?: unknown; alias?: unknown };
      const codeRaw = typeof body.code === "string" ? body.code : "";
      const aliasRaw = typeof body.alias === "string" ? body.alias.trim() : "";

      const code = normalizePairingCode(codeRaw);
      if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{2}$/.test(code)) {
        return bad(reply, 400, "bad-code", "pairing code shape invalid");
      }
      const alias = aliasRaw.slice(0, 80);
      if (!alias) {
        return bad(reply, 400, "bad-alias", "alias must be non-empty");
      }

      const row = db
        .prepare<[string, number], { account_id: number; used_at: number | null }>(
          `SELECT account_id, used_at FROM device_pairings
            WHERE code_hash = ? AND expires_at > ?`,
        )
        .get(hashToken(code), Date.now());
      if (!row) return bad(reply, 410, "code-invalid", "pairing code expired or unknown");
      if (row.used_at !== null) return bad(reply, 410, "code-used", "pairing code already used");

      // Mint a fresh device-id with collision retry. randomInt over 10^9
      // makes collisions vanishingly rare on a single-host install, but
      // a deterministic retry loop is cheap insurance.
      let deviceId: string | null = null;
      for (let attempt = 0; attempt < DEVICE_ID_MAX_ATTEMPTS; attempt++) {
        const candidate = mintDeviceId();
        const exists = db
          .prepare<[string], { id: string }>("SELECT id FROM devices WHERE id = ?")
          .get(candidate);
        if (!exists) {
          deviceId = candidate;
          break;
        }
      }
      if (!deviceId) {
        return bad(reply, 503, "id-collision", "could not mint a unique device-id");
      }

      const token = newToken();
      const tokenHash = await hashPassword(token);
      const now = Date.now();

      // The used_at pre-check above and this transaction straddle the
      // ~250 ms argon2 token-hash, so two overlapping redeems can both
      // pass the pre-check. The guarded claim-UPDATE is what actually
      // enforces one-shot: only the request whose UPDATE matches the
      // still-unused row gets to insert the device.
      const claimed = db.transaction((): boolean => {
        const claim = db
          .prepare("UPDATE device_pairings SET used_at = ? WHERE code_hash = ? AND used_at IS NULL")
          .run(now, hashToken(code));
        if (claim.changes === 0) return false;
        db.prepare(
          `INSERT INTO devices (id, owner_account_id, alias, token_hash, auto_accept, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, 1, ?, NULL)`,
        ).run(deviceId, row.account_id, alias, tokenHash, now);
        return true;
      })();
      if (!claimed) return bad(reply, 410, "code-used", "pairing code already used");

      // Token leaves the API exactly once — the sharer must persist it
      // to Tauri Secure Storage immediately. After this response is
      // sent, the plaintext token cannot be recovered.
      return reply.status(200).send({ deviceId, token });
    },
  );

  // ── PATCH /api/devices/:id ──────────────────────────────────────────
  // Owner-auth: 403 on cross-account access (NOT 404 — 404 reveals
  // existence per spec acceptance for #15). Validates alias length and
  // auto_accept type.
  app.patch(
    "/api/devices/:id",
    {
      preHandler: app.requireSession,
      // Sec M-5 (review 2026-05-13): tighter per-route cap than the
      // global 1000/min. A hijacked session shouldn't be able to
      // enumerate auto_accept toggles or alias-spam via this route.
      // 30/min/IP is generous for a legitimate user clicking through
      // device settings.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { alias?: unknown; auto_accept?: unknown };

      const dev = db
        .prepare<[string], { owner_account_id: number }>(
          "SELECT owner_account_id FROM devices WHERE id = ?",
        )
        .get(id);
      if (!dev || dev.owner_account_id !== req.account!.id) {
        return bad(reply, 403, "forbidden", "not your device");
      }

      const updates: string[] = [];
      const params: (string | number)[] = [];
      if (body.alias !== undefined) {
        const alias = typeof body.alias === "string" ? body.alias.trim() : "";
        if (alias.length < 1 || alias.length > 80) {
          return bad(reply, 400, "bad-alias", "alias must be 1-80 characters");
        }
        updates.push("alias = ?");
        params.push(alias);
      }
      if (body.auto_accept !== undefined) {
        if (typeof body.auto_accept !== "boolean") {
          return bad(reply, 400, "bad-auto-accept", "auto_accept must be a boolean");
        }
        updates.push("auto_accept = ?");
        params.push(body.auto_accept ? 1 : 0);
      }
      if (updates.length === 0) {
        return bad(reply, 400, "no-changes", "specify alias and/or auto_accept");
      }

      params.push(id);
      db.prepare(`UPDATE devices SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      return reply.status(200).send({ ok: true });
    },
  );

  // ── DELETE /api/devices/:id ─────────────────────────────────────────
  // Hard-deletes the row; FK cascade removes connection_log entries.
  // If the sharer is currently WSS-connected with this device's
  // bearer token, `registry.evict()` below force-closes the
  // connection immediately (gh #16) — the heartbeat layer doesn't
  // need to time out.
  //
  // Two auth modes (gh #16/#17): the dashboard owner deletes any of
  // their devices via the session cookie; the SHARER can revoke ITSELF
  // via its own device bearer token (the "Entkoppeln" button) — a
  // device token may only delete the row it belongs to. The preHandler
  // lets a well-formed bearer through and the handler verifies it; a
  // cookie-only request goes through the normal session gate.
  app.delete(
    "/api/devices/:id",
    {
      preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
        const bearer = parseBearerAuth(req.headers);
        if (bearer !== null && bearer !== "malformed") return;
        return app.requireSession(req, reply);
      },
      // Sec M-5: tighter cap. Lower than PATCH because deletion is
      // a one-shot per device — a legitimate user has no reason to
      // call DELETE 30 times per minute.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };

      const bearer = parseBearerAuth(req.headers);
      if (bearer !== null && bearer !== "malformed") {
        // Device self-revoke: the token must belong to the device it is
        // trying to delete, and it must argon2-verify.
        if (bearer.deviceId !== id) {
          return bad(reply, 403, "forbidden", "token does not match device");
        }
        const ok = await verifyBearerAuth(db, bearer);
        if (!ok) {
          return bad(reply, 401, "bad-token", "invalid device token");
        }
        db.prepare("DELETE FROM devices WHERE id = ?").run(id);
        registry?.evict(id);
        return reply.status(204).send();
      }

      // Owner path (session cookie).
      const dev = db
        .prepare<[string], { owner_account_id: number }>(
          "SELECT owner_account_id FROM devices WHERE id = ?",
        )
        .get(id);
      if (!dev || dev.owner_account_id !== req.account!.id) {
        return bad(reply, 403, "forbidden", "not your device");
      }
      db.transaction(() => deleteDeviceCascade(db, id))();
      // Force-close any live WSS for this device with WS code 4401
      // so the sharer's reconnect loop immediately sees "auth
      // failed" instead of relaying frames for the next 30 s window.
      registry?.evict(id);
      return reply.status(204).send();
    },
  );

  // ── GET /api/devices ────────────────────────────────────────────────
  // Lists this account's devices with a computed online flag (true if
  // last_seen_at is within ONLINE_WINDOW_MS of now). Spec §9.
  app.get(
    "/api/devices",
    { preHandler: app.requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const rows = db
        .prepare<
          [number],
          {
            id: string;
            alias: string;
            auto_accept: number;
            created_at: number;
            last_seen_at: number | null;
          }
        >(
          `SELECT id, alias, auto_accept, created_at, last_seen_at
             FROM devices WHERE owner_account_id = ?
            ORDER BY created_at`,
        )
        .all(req.account!.id);

      const now = Date.now();
      const items = rows.map((r) => ({
        id: r.id,
        alias: r.alias,
        autoAccept: r.auto_accept === 1,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        online: r.last_seen_at !== null && now - r.last_seen_at < ONLINE_WINDOW_MS,
      }));
      return reply.status(200).send({ items });
    },
  );

  // ── GET /api/devices/:id/log ────────────────────────────────────────
  // Cursor-paginated connection log for a single device (spec
  // section 18). Owner-only — 403 on cross-account access so we
  // don't leak device existence. `cursor` is the smallest id seen on
  // the previous page; omit on page 1. `limit` is clamped to
  // [`LOG_MAX_LIMIT`].
  app.get(
    "/api/devices/:id/log",
    { preHandler: app.requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const dev = db
        .prepare<[string], { owner_account_id: number }>(
          "SELECT owner_account_id FROM devices WHERE id = ?",
        )
        .get(id);
      if (!dev || dev.owner_account_id !== req.account!.id) {
        return bad(reply, 403, "forbidden", "not your device");
      }
      const q = req.query as { cursor?: unknown; limit?: unknown };
      const cursor =
        typeof q.cursor === "string" && /^\d+$/.test(q.cursor)
          ? Number(q.cursor)
          : undefined;
      const limit =
        typeof q.limit === "string" && /^\d+$/.test(q.limit)
          ? Number(q.limit)
          : 20;
      const page = listConnectionLog(db, id, cursor, limit);
      return reply.status(200).send({
        items: page.items,
        nextCursor: page.nextCursor,
        maxLimit: LOG_MAX_LIMIT,
      });
    },
  );
}
