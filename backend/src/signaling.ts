import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { SessionStore, Peer } from "./codes.js";
import type {
  IncomingMessage,
  OutgoingMessage,
} from "./protocol.js";

export function registerSignaling(
  app: FastifyInstance,
  store: SessionStore
): void {
  function send(peer: WebSocket, msg: OutgoingMessage): void {
    if (peer.readyState === peer.OPEN) peer.send(JSON.stringify(msg));
  }

  function ipPrefix(req: FastifyRequest): string {
    const ip = req.ip;
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.xxx`;
    return ip.split(":").slice(0, 2).join(":") + ":xxx";
  }

  app.get("/signal", { websocket: true }, (socket, req) => {
    const peer = socket;
    let role: "sharer" | "viewer" | null = null;

    peer.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
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
        const session = store.getSession(msg.code);
        if (!session) {
          const burned = store.recordFailedAttempt(msg.code);
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
        store.attachViewer(msg.code, peer as Peer);
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
}
