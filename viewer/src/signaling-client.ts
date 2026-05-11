import type { OutgoingMessage, RelayPayload } from "./protocol.js";

export type WSFactory = (url: string) => WebSocket;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private relayListeners: Array<(payload: RelayPayload) => void> = [];
  private rejectionListeners: Array<(reason: string) => void> = [];
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
        ws.send(JSON.stringify({ type: "join", role: "viewer", code }));
      };
      ws.onmessage = (ev: MessageEvent) => {
        const msg = JSON.parse(ev.data as string) as OutgoingMessage;
        if (msg.type === "peer-confirmed") {
          this.settled = true;
          resolve();
        } else if (msg.type === "peer-rejected") {
          this.settled = true;
          reject(new Error(`peer-rejected: ${msg.reason}`));
        } else if (msg.type === "error") {
          this.settled = true;
          reject(new Error(`${msg.code}: ${msg.message}`));
        } else if (msg.type === "relay") {
          for (const l of this.relayListeners) l(msg.payload);
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

  sendRelay(payload: unknown): void {
    this.ws?.send(JSON.stringify({ type: "relay", payload }));
  }

  onRelay(fn: (payload: RelayPayload) => void): void {
    this.relayListeners.push(fn);
  }

  onDisconnect(fn: (reason: string) => void): void {
    this.rejectionListeners.push(fn);
  }

  close(): void {
    this._closed = true;
    this.ws?.close();
  }
}
