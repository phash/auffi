import type {
  OutgoingMessage,
  PwAttempt,
  RelayMsg,
  RelayPayload,
  ViewerJoin,
} from "./protocol.js";

export type WSFactory = (url: string) => WebSocket;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private relayListeners: Array<(payload: RelayPayload) => void> = [];
  private rejectionListeners: Array<(reason: string) => void> = [];
  private needsPasswordListeners: Array<() => void> = [];
  private wrongPasswordListeners: Array<(attemptsLeft: number) => void> = [];
  private settled = false;
  private _closed = false;

  constructor(
    private url: string,
    private opts: { factory?: WSFactory } = {}
  ) {}

  join(code: string): Promise<void> {
    const factory = this.opts.factory ?? ((u) => new WebSocket(u));
    const ws = factory(this.url);
    this.ws = ws;
    this.settled = false;

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join", role: "viewer", code } satisfies ViewerJoin));
      };
      ws.onmessage = (ev: MessageEvent) => {
        // Don't let a malformed frame throw out of the handler — that
        // leaves the promise unsettled and the UI hangs forever. The
        // signaling channel is TLS-protected so this would have to be a
        // server bug or a hostile reverse-proxy mid-path, but neither
        // case should silently brick the viewer.
        let msg: OutgoingMessage;
        try {
          msg = JSON.parse(ev.data as string) as OutgoingMessage;
        } catch {
          return;
        }
        // A terminal frame settles the join promise while it is pending. After
        // peer-confirmed the promise is already resolved and `reject` would be
        // a silent no-op — but the backend still sends `peer-rejected:
        // sharer-gone` / `error` on a live session (sharer WS dropped, session
        // already deleted server-side), so those must reach the disconnect
        // listeners instead of vanishing.
        const fail = (raw: string): void => {
          if (this.settled) {
            for (const l of this.rejectionListeners) l(raw);
            return;
          }
          this.settled = true;
          reject(new Error(raw));
        };
        if (msg.type === "peer-confirmed") {
          this.settled = true;
          resolve();
        } else if (msg.type === "peer-rejected") {
          fail(`peer-rejected: ${msg.reason}`);
        } else if (msg.type === "error") {
          fail(`${msg.code}: ${msg.message}`);
        } else if (msg.type === "relay") {
          for (const l of this.relayListeners) l(msg.payload);
        } else if (msg.type === "needs-password") {
          // gh #36 — unattended-mode flow. Don't settle the join
          // promise yet; the UI will prompt the user and call
          // sendPwAttempt, then either peer-confirmed (success) or
          // wrong-password / locked / rejected-by-user (terminal)
          // arrives later.
          for (const l of this.needsPasswordListeners) l();
        } else if (msg.type === "wrong-password") {
          // Stay unsettled — the UI re-shows the prompt and the user
          // can try again until backend lockout fires.
          for (const l of this.wrongPasswordListeners) l(msg.attemptsLeft);
        } else if (msg.type === "locked") {
          fail(`locked:${msg.retryAfterSec}`);
        } else if (msg.type === "rejected-by-user") {
          fail("rejected-by-user");
        }
      };
      ws.onclose = () => {
        if (this._closed) return;
        if (!this.settled) {
          for (const l of this.rejectionListeners) l("closed");
        }
      };
    });
  }

  sendRelay(payload: RelayPayload): void {
    this.ws?.send(JSON.stringify({ type: "relay", payload } satisfies RelayMsg));
  }

  /**
   * Send the user-supplied unattended password attempt. The backend
   * routes it to the sharer via pw-check; the response arrives as
   * `wrong-password`, `locked`, `rejected-by-user`, or `peer-confirmed`
   * on the same WS.
   */
  sendPwAttempt(password: string): void {
    this.ws?.send(JSON.stringify({ type: "pw-attempt", password } satisfies PwAttempt));
  }

  onRelay(fn: (payload: RelayPayload) => void): void {
    this.relayListeners.push(fn);
  }

  onDisconnect(fn: (reason: string) => void): void {
    this.rejectionListeners.push(fn);
  }

  onNeedsPassword(fn: () => void): void {
    this.needsPasswordListeners.push(fn);
  }

  onWrongPassword(fn: (attemptsLeft: number) => void): void {
    this.wrongPasswordListeners.push(fn);
  }

  close(): void {
    this._closed = true;
    this.ws?.close();
  }
}
