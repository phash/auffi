import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { SessionStore, Peer } from "./codes.js";
import { normalizeCode } from "./codes.js";
import type {
  IncomingMessage,
  OutgoingMessage,
} from "./protocol.js";

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

export function registerSignaling(
  app: FastifyInstance,
  store: SessionStore,
  rateLimitCfg: RateLimitConfig = { windowMs: 60_000, max: 5 },
  attemptCounts: Map<string, RateLimitEntry> = new Map(),
  perPeerCfg: PerPeerRateLimitConfig = DEFAULT_PER_PEER_LIMIT
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
    let role: "sharer" | "viewer" | null = null;
    const peerMsgEntry = newPerPeerEntry(perPeerCfg);

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
