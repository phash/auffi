import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { SessionStore, Peer } from "./codes.js";
import { normalizeCode } from "./codes.js";
import type {
  IncomingMessage,
  OutgoingMessage,
} from "./protocol.js";
import type { Db } from "./db.js";
import {
  parseBearerAuth,
  verifyBearerAuth,
  WS_CLOSE,
  UnattendedRegistry,
} from "./unattended.js";

export type RateLimitEntry = { count: number; resetAt: number };

export type RateLimitConfig = { windowMs: number; max: number };

export type PerPeerRateLimitConfig = { windowMs: number; max: number };

function checkPerPeerLimit(
  entry: RateLimitEntry,
  cfg: PerPeerRateLimitConfig
): boolean {
  const now = Date.now();
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + cfg.windowMs;
    return true;
  }
  entry.count += 1;
  return entry.count <= cfg.max;
}

function newPerPeerEntry(cfg: PerPeerRateLimitConfig): RateLimitEntry {
  return { count: 0, resetAt: Date.now() + cfg.windowMs };
}

function stripIpv4Mapped(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function checkRateLimit(
  rawIp: string,
  counts: Map<string, RateLimitEntry>,
  cfg: RateLimitConfig
): boolean {
  const ip = stripIpv4Mapped(rawIp);
  const now = Date.now();
  const entry = counts.get(ip);
  if (!entry || now > entry.resetAt) {
    counts.set(ip, { count: 1, resetAt: now + cfg.windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= cfg.max;
}

const DEFAULT_PER_PEER_LIMIT: PerPeerRateLimitConfig = { windowMs: 10_000, max: 50 };

/// Allowed values of `payload.kind` in a relay message. Anything else is a
/// protocol error and gets rejected before being forwarded to the other peer.
const RELAY_KINDS = new Set<string>(["sdp", "ice", "hello", "bye"]);

/// Per-IP cap on `register`-as-sharer messages. Caddy's `/signal`
/// path is excluded from its rate-limit zone (the WS connection itself
/// is long-lived), so without an app-level gate a single IP could open
/// thousands of WS upgrades and flood the SessionStore. Sharers
/// legitimately re-register on bootstrap-after-F5 / "Neuer Code", but 5
/// per minute is well above that pattern.
const DEFAULT_REGISTER_LIMIT: RateLimitConfig = { windowMs: 60_000, max: 5 };

export interface UnattendedDeps {
  db: Db;
  registry: UnattendedRegistry;
}

export function registerSignaling(
  app: FastifyInstance,
  store: SessionStore,
  rateLimitCfg: RateLimitConfig = { windowMs: 60_000, max: 5 },
  attemptCounts: Map<string, RateLimitEntry> = new Map(),
  perPeerCfg: PerPeerRateLimitConfig = DEFAULT_PER_PEER_LIMIT,
  registerCfg: RateLimitConfig = DEFAULT_REGISTER_LIMIT,
  registerCounts: Map<string, RateLimitEntry> = new Map(),
  /**
   * Optional unattended-sharer wiring. When omitted (legacy callers,
   * tests that don't care about unattended), every WSS upgrade falls
   * through to the ad-hoc browser-viewer path. When provided, an
   * incoming upgrade with `Authorization: Bearer <token>` +
   * `X-Auffi-Device-Id: <id>` is verified against the devices table
   * BEFORE the message handler runs; on success the peer is
   * registered with the registry and last_seen_at is bumped (gh #16).
   */
  unattended?: UnattendedDeps,
): Map<string, RateLimitEntry> {
  function send(peer: WebSocket, msg: OutgoingMessage): void {
    if (peer.readyState === peer.OPEN) peer.send(JSON.stringify(msg));
  }

  function ipPrefix(req: FastifyRequest): string {
    const ip = stripIpv4Mapped(req.ip ?? "");
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.xxx`;
    return ip.split(":").slice(0, 2).join(":") + ":xxx";
  }

  app.get("/signal", { websocket: true }, (socket, req) => {
    const peer = socket;
    let role: "sharer" | "viewer" | "unattended-sharer" | null = null;
    const peerMsgEntry = newPerPeerEntry(perPeerCfg);

    // ── Unattended bearer-auth path (gh #16) ──────────────────────
    // Runs BEFORE the message handler attaches so a wrong token never
    // observes ad-hoc protocol behaviour.
    const parsed = parseBearerAuth(req.headers);
    if (parsed === "malformed") {
      peer.close(WS_CLOSE.AUTH_FAILED, "invalid bearer auth");
      return;
    }
    if (parsed !== null) {
      if (!unattended) {
        // Server doesn't have device storage wired up yet; reject
        // the bearer attempt so a misconfigured deploy doesn't
        // silently look "authenticated" to the sharer.
        peer.close(WS_CLOSE.AUTH_FAILED, "unattended mode not configured");
        return;
      }
      const auth = parsed;
      const { db, registry } = unattended;
      // verify is async (argon2). Tell the handler to swallow any
      // incoming messages until we've answered. We attach the
      // message listener AFTER the verify resolves so timing
      // observers can't differentiate "rejected because invalid
      // token" from "rejected because rate-limited later".
      verifyBearerAuth(db, auth).then(
        (ok) => {
          if (peer.readyState !== peer.OPEN) return;
          if (!ok) {
            peer.close(WS_CLOSE.AUTH_FAILED, "invalid device token");
            return;
          }
          role = "unattended-sharer";
          registry.register(auth.deviceId, peer);
          peer.on("close", () => {
            registry.unregister(auth.deviceId, peer);
          });
          // Hello message so the sharer knows the bearer was
          // accepted and last_seen_at was bumped. The #17 flow
          // builds on top of this — for now the connection just
          // idles waiting for `pw-check` etc. frames forwarded by
          // the backend.
          send(peer, {
            type: "unattended-hello",
            deviceId: auth.deviceId,
          });
        },
        () => {
          // Unexpected error (DB closed during verify, …). Fail
          // closed: the sharer's reconnect loop will retry with
          // backoff.
          if (peer.readyState === peer.OPEN) {
            peer.close(WS_CLOSE.AUTH_FAILED, "verification error");
          }
        },
      );
      // Defensive: ignore any message that arrives before / during
      // verify. The legitimate flow has no messages from the sharer
      // until the backend forwards a `pw-check` first.
      peer.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        if (role !== "unattended-sharer") {
          send(peer, {
            type: "error",
            code: "bad-message",
            message: "wait for unattended-hello before sending",
          });
          return;
        }
        // gh #17 will land the real message handler here. Until
        // then any frame from the sharer side is a protocol error.
        void raw;
        send(peer, {
          type: "error",
          code: "bad-message",
          message: "unattended messages not yet implemented",
        });
      });
      return;
    }

    peer.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      if (!checkPerPeerLimit(peerMsgEntry, perPeerCfg)) {
        send(peer, { type: "error", code: "rate-limit", message: "message rate exceeded" });
        peer.close();
        return;
      }

      let msg: IncomingMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(peer, { type: "error", code: "bad-message", message: "invalid JSON" });
        return;
      }

      if (msg.type === "register" && msg.role === "sharer" && role === null) {
        if (!checkRateLimit(req.ip ?? "unknown", registerCounts, registerCfg)) {
          send(peer, { type: "error", code: "rate-limit", message: "too many registrations" });
          peer.close();
          return;
        }
        role = "sharer";
        const { code, session } = store.registerSharer(peer as Peer);
        const ttlSec = Math.floor((session.expiresAt - Date.now()) / 1000);
        send(peer, { type: "code-assigned", code, expiresInSec: ttlSec });
        return;
      }

      if (msg.type === "join" && msg.role === "viewer" && role === null) {
        const normalized = normalizeCode(msg.code);
        if (!normalized) {
          send(peer, { type: "error", code: "bad-message", message: "invalid code format" });
          peer.close();
          return;
        }
        const session = store.getSession(normalized);
        if (!session) {
          if (!checkRateLimit(req.ip ?? "unknown", attemptCounts, rateLimitCfg)) {
            send(peer, { type: "error", code: "rate-limit", message: "too many attempts" });
            peer.close();
            return;
          }
          // recordFailedAttempt is a no-op when no session exists (the code is
          // simply unknown), so `burned` will be false here. The branch below
          // only fires when a real session's attempt budget is exhausted.
          const burned = store.recordFailedAttempt(normalized);
          send(peer, {
            type: "error",
            code: burned ? "code-expired" : "invalid-code",
            message: burned ? "code burned after too many attempts" : "no such session",
          });
          peer.close();
          return;
        }
        if (session.viewer) {
          // Count this attempt in the IP limiter even though the code
          // *was* valid — otherwise an attacker can probe which 9-digit
          // codes resolve to a live-but-full session without budget
          // pressure. The same code from a legitimate retry-burst will
          // be back below the limit by the next window.
          checkRateLimit(req.ip ?? "unknown", attemptCounts, rateLimitCfg);
          send(peer, { type: "error", code: "invalid-code", message: "session full" });
          peer.close();
          return;
        }
        role = "viewer";
        store.attachViewer(normalized, peer as Peer);
        send(session.sharer as WebSocket, {
          type: "peer-joined",
          viewerInfo: { ipPrefix: ipPrefix(req), country: null },
        });
        return;
      }

      if (msg.type === "confirm" && role === "sharer") {
        const found = store.findByPeer(peer as Peer);
        if (!found) return;
        if (msg.accepted) {
          store.markConfirmed(found.code);
          if (found.viewer) send(found.viewer as WebSocket, { type: "peer-confirmed" });
        } else {
          // Ignore a `confirm:false` against an already-confirmed session:
          // a sharer-side bug could otherwise tear down a live stream
          // (and the new helper after viewer-swap) by reaching this branch
          // unintentionally. The user-driven decline path runs before the
          // session is ever confirmed, so the guard is invisible to it.
          if (found.confirmed) return;
          if (found.viewer) {
            const viewerSocket = found.viewer as WebSocket;
            send(viewerSocket, { type: "peer-rejected", reason: "declined" });
            viewerSocket.close();
          }
          store.removeBySharer(peer as Peer);
          peer.close();
        }
        return;
      }

      if (msg.type === "relay") {
        const found = store.findByPeer(peer as Peer);
        if (!found) return;
        if (!found.confirmed) return;
        // Runtime validate the payload shape — TS types are erased at runtime
        // and a malicious peer can send arbitrarily-shaped JSON. Reject any
        // payload whose `kind` is not one of the documented values; the
        // payload itself is forwarded opaquely but we want the discriminant
        // to be sane so the receiver can't be tricked into dispatching on a
        // confused tag.
        const payload = msg.payload as { kind?: unknown } | null;
        if (
          !payload ||
          typeof payload !== "object" ||
          typeof payload.kind !== "string" ||
          !RELAY_KINDS.has(payload.kind)
        ) {
          send(peer, { type: "error", code: "bad-message", message: "invalid relay payload" });
          return;
        }
        const target = role === "sharer" ? found.viewer : found.sharer;
        if (target) send(target as WebSocket, { type: "relay", payload: msg.payload });
        return;
      }

      send(peer, { type: "error", code: "bad-message", message: "unexpected message" });
    });

    peer.on("close", () => {
      const found = store.findByPeer(peer as Peer);
      if (!found) return;
      if (found.sharer === peer) {
        if (found.viewer) {
          const viewerSocket = found.viewer as WebSocket;
          send(viewerSocket, { type: "peer-rejected", reason: "sharer-gone" });
          viewerSocket.close();
        }
        store.removeBySharer(peer as Peer);
      } else if (found.viewer === peer) {
        store.detachViewer(peer as Peer);
      }
    });
  });

  return attemptCounts;
}
