import { vi } from "vitest";
import { buildUiTestDOM } from "./ui-dom.js";

/**
 * Drives ui.ts's bindUI() through a whole connect: stubbed `fetch`
 * (TURN credentials), a recording `WebSocket` (signaling) and a
 * recording `RTCPeerConnection` (media + data channels). The real
 * SignalingClient / ViewerPeer / DataChannelHub run on top, so the tests
 * exercise the actual wiring in ui.ts rather than a re-implementation.
 *
 * Every hop in ui.ts is a microtask (fetch → then → join → start), never a
 * timer, so `flush()` drains promise chains without touching the clock and
 * works with fake timers enabled.
 */

export class MockWS {
  static instances: MockWS[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWS.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  fakeOpen(): void {
    this.readyState = MockWS.OPEN;
    this.onopen?.({});
  }

  fakeMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((m) => m.type === type);
  }
}

export class MockDataChannel {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: Array<string | ArrayBuffer> = [];

  constructor(public label: string) {}

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = "closed";
  }

  addEventListener(): void {}

  removeEventListener(): void {}

  fakeOpen(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  fakeMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

export class MockPC {
  static instances: MockPC[] = [];
  ontrack: ((ev: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null;
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  iceConnectionState: RTCIceConnectionState = "new";
  channels: MockDataChannel[] = [];
  setRemoteDescription: (sdp: RTCSessionDescriptionInit) => Promise<void> = async () => {};

  constructor() {
    MockPC.instances.push(this);
  }

  createDataChannel(label: string): MockDataChannel {
    const ch = new MockDataChannel(label);
    this.channels.push(ch);
    return ch;
  }

  addTransceiver(): void {}

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\n" };
  }

  async setLocalDescription(): Promise<void> {}

  async addIceCandidate(): Promise<void> {}

  async getStats(): Promise<RTCStatsReport> {
    return new Map() as unknown as RTCStatsReport;
  }

  close(): void {
    this.iceConnectionState = "closed";
  }

  channel(label: "input" | "files"): MockDataChannel {
    const ch = this.channels.find((c) => c.label === label);
    if (!ch) throw new Error(`no ${label} channel created yet`);
    return ch;
  }

  fireIceState(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

export interface UiSession {
  ws: MockWS;
  /** Deliver peer-confirmed and wait for ViewerPeer.start() to create the PC. */
  confirm(): Promise<MockPC>;
  /** Fire the remote track (what setVideoStream / the toolbar keys off). */
  track(pc: MockPC): void;
  /** Open both data channels so DataChannelHub.ready() resolves. */
  openChannels(pc: MockPC): Promise<void>;
}

export async function startUiSession(code = "123-456-789"): Promise<UiSession> {
  buildUiTestDOM();
  MockWS.instances = [];
  MockPC.instances = [];
  vi.stubGlobal("WebSocket", MockWS);
  vi.stubGlobal("RTCPeerConnection", MockPC);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ urls: ["turn:relay.example"], username: "u", credential: "c" }),
    }),
  );
  const { bindUI } = await import("../../src/ui.js");
  bindUI("ws://localhost:8080/signal");

  (document.getElementById("code") as HTMLInputElement).value = code;
  (document.getElementById("connect") as HTMLButtonElement).click();
  await flush();
  const ws = MockWS.instances.at(-1);
  if (!ws) throw new Error("SignalingClient did not open a WebSocket");
  ws.fakeOpen();

  return {
    ws,
    async confirm() {
      ws.fakeMessage({ type: "peer-confirmed" });
      await flush();
      const pc = MockPC.instances.at(-1);
      if (!pc) throw new Error("ViewerPeer.start() did not create an RTCPeerConnection");
      return pc;
    },
    track(pc) {
      const stream = { id: "remote" } as unknown as MediaStream;
      pc.ontrack?.({ streams: [stream], track: {} as MediaStreamTrack });
    },
    async openChannels(pc) {
      pc.channel("input").fakeOpen();
      pc.channel("files").fakeOpen();
      await flush();
    },
  };
}
