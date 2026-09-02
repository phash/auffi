import type {
  OutgoingMessage,
  PwAttempt,
  RelayMsg,
  RelayPayload,
  ViewerJoin,
} from "./protocol.js";

export type WSFactory = (url: string) => WebSocket;

/**
 * Parse one incoming WS frame or return null. The signaling channel is
 * TLS-protected, so a bad frame means a server bug or a hostile proxy —
 * neither may throw out of onmessage (the join promise would hang forever)
 * or leak `undefined` into UI copy ("Noch undefined Versuche"). Only the
 * fields the client dereferences or interpolates are checked here.
 */
function parseFrame(data: unknown): OutgoingMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;
  if (typeof frame.type !== "string") return null;
  if (frame.type === "relay" && (typeof frame.payload !== "object" || frame.payload === null)) return null;
  if (frame.type === "wrong-password" && typeof frame.attemptsLeft !== "number") return null;
  return parsed as OutgoingMessage;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private relayListeners: Array<(payload: RelayPayload) => void> = [];
  private rejectionListeners: Array<(reason: string) => void> = [];
  private needsPasswordListeners: Array<() => void> = [];
  private wrongPasswordListeners: Array<(attemptsLeft: number) => void> = [];
  private settled = false;
  private pwAttemptInFlight = false;
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
    this.pwAttemptInFlight = false;

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join", role: "viewer", code } satisfies ViewerJoin));
      };
      ws.onmessage = (ev: MessageEvent) => {
        const msg = parseFrame(ev.data);
        if (msg === null) return;
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
          this.pwAttemptInFlight = false;
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
   *
   * At most one attempt is outstanding per prompt: the backend answers a
   * second pw-attempt while the first is in flight with a fatal
   * `bad-message`, which would tear down a session the user just
   * authenticated. Only `wrong-password` re-opens the gate.
   */
  sendPwAttempt(password: string): void {
    if (this.pwAttemptInFlight) return;
    this.pwAttemptInFlight = true;
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
