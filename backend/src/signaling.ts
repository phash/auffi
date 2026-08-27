import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { SessionStore, Peer } from "./codes.js";
import { normalizeCode } from "./codes.js";
import { lookupCountry, type CountryLookup } from "./geoip.js";
import type {
  IncomingMessage,
  OutgoingMessage,
  TurnCredentialsPayload,
} from "./protocol.js";
import type { Db } from "./db.js";
import {
  getAutoAccept,
  parseBearerAuth,
  verifyBearerAuth,
  WS_CLOSE,
  UnattendedRegistry,
} from "./unattended.js";
import {
  checkLockout,
  recordPwFail,
  resetPwFail,
  UnattendedSessions,
} from "./unattended_sessions.js";
import {
  checkIpRateLimit as checkRateLimit,
  stripIpv4Mapped,
  type RateLimitConfig,
  type RateLimitEntry,
} from "./rate-limit.js";

// Re-exported so existing importers keep a stable surface; the canonical
// home is rate-limit.ts.
export type { RateLimitConfig, RateLimitEntry } from "./rate-limit.js";

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

/// Per-IP cap on WSS Bearer-auth attempts. Each attempt costs ~250 ms
/// of argon2 CPU on the backend (see Sec H-1, review 2026-05-13).
/// Without this cap an attacker can mount a CPU-exhaustion DoS by
/// opening WSS connections with syntactically valid but unknown
/// device-id/token pairs. Legitimate unattended sharers reconnect via
/// the heartbeat backoff loop (1s → 60s), so a healthy reconnect
/// pattern is well below 10/min. We pick 10/min/IP — generous for a
/// NAT'd network hosting multiple paired devices, tight enough to
/// blunt enumeration.
const DEFAULT_BEARER_AUTH_LIMIT: RateLimitConfig = { windowMs: 60_000, max: 10 };

export interface UnattendedDeps {
  db: Db;
  registry: UnattendedRegistry;
  sessions: UnattendedSessions;
  /**
   * Mint ephemeral TURN credentials for an authenticated unattended
   * sharer (`turn-credentials-request` frame). Omitted / returning
   * null when the deployment has no TURN configured — the sharer then
   * proceeds STUN-less. Same HMAC credentials as POST /turn-credentials.
   */
  turnCredentials?: () => TurnCredentialsPayload | null;
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
  /**
   * Per-IP rate-limit for bearer-auth attempts (Sec H-1). Defaults to
   * 10/min/IP; passing a tighter map+config lets tests force-trip the
   * gate quickly. The map is held by the caller so the sweep-task in
   * `createServer` can GC stale entries.
   */
  bearerCfg: RateLimitConfig = DEFAULT_BEARER_AUTH_LIMIT,
  bearerCounts: Map<string, RateLimitEntry> = new Map(),
  countryLookup: CountryLookup | null = null,
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

  // A code expiring out from under a waiting viewer must not be a
  // silent dead-end: tell the viewer the code expired (the protocol
  // reason existed but was never emitted) and hand the sharer the bye
  // its confirm dialog is waiting on. Registered here — not in
  // server.ts — so every signaling setup (tests included) gets the
  // wiring for free. Only unconfirmed sessions ever reach this
  // callback; confirmed ones are exempt from expiry (see SessionStore).
  store.setOnExpiredDrop((session) => {
    if (!session.viewer) return;
    const viewer = session.viewer as WebSocket;
    send(viewer, { type: "peer-rejected", reason: "expired" });
    viewer.close();
    send(session.sharer as WebSocket, { type: "relay", payload: { kind: "bye" } });
  });

  // Same idea for the unattended pre-confirm timeout: when the 60 s
  // sweep reaps a session stuck before "confirmed" (PW_ENTRY_TIMEOUT_MS),
  // close the abandoned viewer socket AND hand the sharer the bye its
  // pending pw wait / confirm dialog needs — without it the sharer only
  // learns via its own 60 s auto-decline, if at all.
  unattended?.sessions.setOnStaleReap((sess) => {
    send(sess.sharer, { type: "relay", payload: { kind: "bye" } });
    sess.viewer.close();
  });

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
      // Sec H-1 (review 2026-05-13): cap argon2-verify rate per IP
      // BEFORE calling verifyBearerAuth. Without this an attacker
      // can mount a CPU-exhaustion DoS at ~250 ms/attempt. We close
      // with the same 4401 code as a real auth failure so the
      // attacker can't distinguish "rate-limited" from "wrong
      // token". Legitimate unattended-mode sharers reconnect via
      // the heartbeat backoff (1s → 60s) and never approach the cap.
      if (!checkRateLimit(req.ip ?? "unknown", bearerCounts, bearerCfg)) {
        peer.close(WS_CLOSE.AUTH_FAILED, "rate limit");
        return;
      }
      const auth = parsed;
      const { db, registry, sessions, turnCredentials } = unattended;
      // verify is async (argon2). The message listener below attaches
      // synchronously while the verify is still in flight, but its
      // role guard answers every premature frame with the same generic
      // bad-message error until the verify resolves and promotes this
      // connection to unattended-sharer — so a wrong token never gets
      // to observe ad-hoc protocol behaviour (Sec H-1).
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
      // Real message handler for an authenticated unattended sharer.
      // Three kinds of frame are accepted:
      //   - pw-check-result: backend records the outcome and routes
      //     status to the paired viewer (gh #17)
      //   - relay:           after pw-ok, normal SDP/ICE flows
      //   - anything else:   protocol error
      peer.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        if (role !== "unattended-sharer") {
          send(peer, {
            type: "error",
            code: "bad-message",
            message: "wait for unattended-hello before sending",
          });
          return;
        }
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

        if (msg.type === "pw-check-result") {
          const sess = sessions.findBySharer(peer);
          if (!sess || sess.state !== "pw-in-flight") {
            // TC C-2 (review 2026-05-13): a sharer that took a long
            // manual-confirm window can land its result AFTER the
            // viewer gave up and dropped the WSS (the session is
            // removed in `peer.on("close")` for the viewer). Don't
            // surface that as a backend-error frame — the sharer's
            // heartbeat treats `error`/`backend-error` as a fatal
            // disconnect and would reconnect, killing every other
            // queued viewer attempt in the process. Silent drop is
            // the documented intent (signaling.ts close-handler
            // comment).
            return;
          }
          if (sess.viewer.readyState !== sess.viewer.OPEN) {
            // Same TC C-2 give-up, caught mid-handshake: the viewer's
            // close frame has been received (readyState CLOSING/CLOSED)
            // but its "close" event — which reaps the session — may not
            // have fired yet, so the session still looks intact here.
            // Reap it now and drop the result silently; forwarding
            // would hand the sharer a stray peer-joined for a viewer
            // that no longer exists.
            sessions.remove(sess.deviceId);
            return;
          }
          if (msg.result === "ok") {
            resetPwFail(db, sess.deviceId);
            sessions.transition(sess.deviceId, "confirmed");
            send(sess.viewer, { type: "peer-confirmed" });
            // Mirror peer-joined to the sharer so its WebRTC code path
            // matches the ad-hoc one (the viewer creates the offer once
            // confirmed; the sharer waits for it). NB: `req` here is
            // the SHARER's own upgrade request — the viewer's redacted
            // IP was captured at join time on the session.
            send(peer, {
              type: "peer-joined",
              viewerInfo: { ipPrefix: sess.viewerIpPrefix, country: null },
            });
            return;
          }
          if (msg.result === "rejected") {
            send(sess.viewer, { type: "rejected-by-user" });
            sess.viewer.close();
            sessions.remove(sess.deviceId);
            return;
          }
          // result === "fail"
          const outcome = recordPwFail(db, sess.deviceId);
          if (outcome.locked) {
            send(sess.viewer, {
              type: "locked",
              retryAfterSec: outcome.retryAfterSec,
            });
            sess.viewer.close();
            sessions.remove(sess.deviceId);
          } else {
            send(sess.viewer, {
              type: "wrong-password",
              attemptsLeft: outcome.attemptsLeft,
            });
            // Stay paired — viewer can try again. Back to awaiting-pw.
            sessions.transition(sess.deviceId, "awaiting-pw");
          }
          return;
        }

        if (msg.type === "relay") {
          const sess = sessions.findBySharer(peer);
          if (!sess || sess.state !== "confirmed") return;
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
          send(sess.viewer, { type: "relay", payload: msg.payload });
          return;
        }

        if (msg.type === "turn-credentials-request") {
          send(peer, {
            type: "turn-credentials",
            credentials: turnCredentials?.() ?? null,
          });
          return;
        }

        send(peer, { type: "error", code: "bad-message", message: "unexpected message" });
      });

      // Tear down any pending session if the sharer drops. The viewer
      // gets the same "sharer-gone" treatment as the ad-hoc flow.
      peer.on("close", () => {
        const sess = sessions.detachSharer(peer);
        if (sess) {
          send(sess.viewer, { type: "peer-rejected", reason: "sharer-gone" });
          sess.viewer.close();
        }
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
        const session = store.getJoinableSession(normalized);
        if (!session) {
          // gh #17: ad-hoc lookup miss → try registered unattended
          // device with the same code shape. The normaliser already
          // returned `NNN-NNN-NNN`, which is also the device-id
          // shape, so we can look up directly.
          if (unattended) {
            const live = unattended.registry.peer(normalized);
            if (live) {
              const lock = checkLockout(unattended.db, normalized);
              if (lock.locked) {
                send(peer, { type: "locked", retryAfterSec: lock.retryAfterSec });
                peer.close();
                return;
              }
              const begin = unattended.sessions.begin(
                normalized,
                peer,
                live,
                ipPrefix(req),
              );
              if (begin === "busy") {
                checkRateLimit(req.ip ?? "unknown", attemptCounts, rateLimitCfg);
                send(peer, { type: "error", code: "invalid-code", message: "session full" });
                peer.close();
                return;
              }
              role = "viewer";
              send(peer, { type: "needs-password" });
              return;
            }
          }
          if (!checkRateLimit(req.ip ?? "unknown", attemptCounts, rateLimitCfg)) {
            send(peer, { type: "error", code: "rate-limit", message: "too many attempts" });
            peer.close();
            return;
          }
          send(peer, { type: "error", code: "invalid-code", message: "no such session" });
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
          viewerInfo: {
            ipPrefix: ipPrefix(req),
            country: lookupCountry(countryLookup, stripIpv4Mapped(req.ip ?? "")),
          },
        });
        return;
      }

      if (msg.type === "confirm" && role === "sharer") {
        const found = store.findByPeer(peer as Peer);
        if (!found) return;
        if (msg.accepted) {
          // Accept is only meaningful while a viewer is attached. If
          // the viewer bailed while the dialog was up, leave the
          // session unconfirmed — otherwise the relay gate would stand
          // pre-opened for whichever viewer joins next (sharer
          // confirmation is mandatory).
          if (found.viewer) {
            store.markConfirmed(found.code);
            send(found.viewer as WebSocket, { type: "peer-confirmed" });
          }
        } else {
          // Ignore a `confirm:false` against a live confirmed session:
          // a sharer-side bug could otherwise tear down a running
          // stream by reaching this branch unintentionally. This guard
          // never swallows a user-driven decline: `detachViewer` resets
          // `confirmed`, so a decline aimed at a swapped-in (not yet
          // re-accepted) viewer passes it normally.
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

      // gh #17: viewer-side handler for the unattended pw flow.
      if (msg.type === "pw-attempt" && role === "viewer" && unattended) {
        const sess = unattended.sessions.findByViewer(peer);
        if (!sess || sess.state !== "awaiting-pw") {
          send(peer, {
            type: "error",
            code: "bad-message",
            message: "no pw-check expected",
          });
          return;
        }
        if (typeof msg.password !== "string" || msg.password.length === 0) {
          send(peer, {
            type: "error",
            code: "bad-message",
            message: "password missing",
          });
          return;
        }
        // Sec H-4 (review 2026-05-13): cap server-side BEFORE
        // forwarding. The WSS maxPayload (65 536 B) was the only
        // ceiling, letting a malicious viewer push ~60 KB strings
        // through the relay to the sharer on every attempt — pure
        // bandwidth/log abuse since argon2 cost doesn't scale with
        // input length. 256 chars matches `isAcceptablePassword`
        // upper-bound in auth/handlers.ts.
        if (msg.password.length > 256) {
          send(peer, {
            type: "error",
            code: "bad-message",
            message: "password too long",
          });
          return;
        }
        // gh #25: thread the device's auto_accept flag through to the
        // sharer so it knows whether to skip the manual-confirm step
        // after a successful argon2-verify. The flag is read fresh on
        // every pw-check so a dashboard toggle takes effect without
        // sharer reconnect.
        const autoAccept = getAutoAccept(unattended.db, sess.deviceId);
        unattended.sessions.transition(sess.deviceId, "pw-in-flight");
        send(sess.sharer, {
          type: "pw-check",
          attempt: msg.password,
          autoAccept,
        });
        return;
      }

      if (msg.type === "relay") {
        // First check for an unattended session this peer might be in
        // (state must be "confirmed"). Falls through to ad-hoc on miss.
        if (unattended) {
          const usess = unattended.sessions.findByViewer(peer);
          if (usess) {
            if (usess.state !== "confirmed") return;
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
            send(usess.sharer, { type: "relay", payload: msg.payload });
            return;
          }
        }
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
      // gh #17: viewer might be in an unattended session — tear that
      // down first so we don't accidentally fall through into the
      // ad-hoc cleanup.
      if (unattended) {
        const usess = unattended.sessions.detachViewer(peer);
        if (usess) {
          // The sharer's WSS stays open for the next viewer. If the
          // session was in flight, the sharer's pw-check-result (if it
          // ever arrives) will just be ignored by findBySharer
          // returning null. Pre-confirm, mirror the ad-hoc synthesized
          // bye: a tab-close sends nothing itself, and without the bye
          // the sharer's pending pw wait / confirm dialog points at a
          // gone viewer. Confirmed sessions deliberately get NO
          // synthesized bye — a Wi-Fi blip must keep the ICE grace /
          // reconnect window alive instead of tearing the stream down.
          if (usess.state !== "confirmed") {
            send(usess.sharer, { type: "relay", payload: { kind: "bye" } });
          }
          return;
        }
      }
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
        const wasConfirmed = found.confirmed;
        store.detachViewer(peer as Peer);
        if (!wasConfirmed) {
          // The pre-confirm relay gate swallowed any courteous bye the
          // viewer sent before bailing (and a tab-close sends nothing
          // at all), leaving the sharer's confirm dialog pointing at a
          // gone viewer. Deliver the bye on the viewer's behalf; a
          // later peer-joined re-opens the dialog for the next viewer.
          // Confirmed sessions deliberately get NO synthesized bye —
          // a Wi-Fi blip must keep the ICE grace / reconnect window
          // alive instead of tearing the stream down.
          send(found.sharer as WebSocket, { type: "relay", payload: { kind: "bye" } });
        }
      }
    });
  });

  return attemptCounts;
}
