import { randomUUID, createHmac } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SessionStore } from "./codes.js";
import { normalizeCode } from "./codes.js";

export type TurnConfig = {
  sharedSecret: string;
  realm: string;
  urls: string[];
  ttlSec: number;
  allowedOrigins: string[];
  /**
   * Optional: when provided, /turn-credentials requires the caller to
   * include the 9-digit session code in the JSON body and only issues
   * credentials if `store.getSession(code)` finds a live session. This
   * ties credential issuance to an active session and prevents harvesting
   * by non-browser callers that have figured out a working Origin header
   * (gh #60).
   */
  sessionStore?: SessionStore;
  /**
   * Optional: when provided, credential issuance is also accepted for
   * callers that present a code matching a live unattended session's
   * deviceId. Without this, unattended viewers behind symmetric NAT /
   * firewalls were denied TURN credentials (403 "no active session")
   * even though a valid pairing existed in UnattendedSessions.
   */
  unattendedSessions?: { findByDeviceId(id: string): unknown | null };
  /**
   * Optional: also accept a code matching a CONNECTED unattended
   * device (its sharer holds a live bearer-authenticated WSS). The
   * viewer fetches ICE servers BEFORE joining, when no
   * UnattendedSession exists yet — the registry is the only gate that
   * is already populated at that point.
   */
  unattendedRegistry?: { has(id: string): boolean };
};

export function makeCredentials(cfg: TurnConfig): {
  urls: string[];
  username: string;
  credential: string;
  ttl: number;
} {
  const expiresAt = Math.floor(Date.now() / 1000) + cfg.ttlSec;
  const username = `${expiresAt}:${randomUUID()}`;
  // coturn use-auth-secret requires HMAC-SHA1 per RFC 5766 §10.2 — SHA-256 is not supported
  const credential = createHmac("sha1", cfg.sharedSecret)
    .update(username)
    .digest("base64");
  return { urls: cfg.urls, username, credential, ttl: cfg.ttlSec };
}

export function registerTurnEndpoint(
  app: FastifyInstance,
  cfg: TurnConfig
): void {
  app.post(
    "/turn-credentials",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const origin = req.headers.origin as string | undefined;
      if (!origin || !cfg.allowedOrigins.includes(origin)) {
        return reply.status(403).send({ error: "origin not allowed" });
      }
      // Gate issuance on a live signaling session: the caller must include
      // the assigned 9-digit code in the JSON body. Origin alone is forgeable
      // by non-browser callers — the code is only known to peers that have
      // already gone through register / join (gh #60).
      if (cfg.sessionStore) {
        const body = (req.body ?? {}) as { code?: unknown };
        const raw = typeof body.code === "string" ? body.code : "";
        const normalized = normalizeCode(raw);
        const hasAdHoc = normalized !== null && cfg.sessionStore.getSession(normalized) !== null;
        const hasUnattended =
          normalized !== null &&
          ((cfg.unattendedSessions?.findByDeviceId(normalized) ?? null) !== null ||
            (cfg.unattendedRegistry?.has(normalized) ?? false));
        if (!hasAdHoc && !hasUnattended) {
          return reply.status(403).send({ error: "no active session" });
        }
      }
      return makeCredentials(cfg);
    }
  );
}
