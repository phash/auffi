import type { OutgoingMessage, RelayPayload } from "./protocol.js";

export type WSFactory = (url: string) => WebSocket;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private relayListeners: Array<(payload: RelayPayload) => void> = [];
  private rejectionListeners: Array<(reason: string) => void> = [];

  constructor(
    private url: string,
    private opts: { factory?: WSFactory } = {}
  ) {}

  join(code: string): Promise<void> {
    const factory = this.opts.factory ?? ((u) => new WebSocket(u));
    const ws = factory(this.url);
    this.ws = ws;

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join", role: "viewer", code }));
      };
      ws.onmessage = (ev: MessageEvent) => {
        const msg = JSON.parse(ev.data as string) as OutgoingMessage;
        if (msg.type === "peer-confirmed") {
          resolve();
        } else if (msg.type === "peer-rejected") {
          reject(new Error(`peer-rejected: ${msg.reason}`));
        } else if (msg.type === "error") {
          reject(new Error(`${msg.code}: ${msg.message}`));
        } else if (msg.type === "relay") {
          for (const l of this.relayListeners) l(msg.payload);
        }
      };
      ws.onclose = () => {
        for (const l of this.rejectionListeners) l("closed");
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
    this.ws?.close();
  }
}
