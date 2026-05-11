import { describe, it, expect, vi, beforeEach } from "vitest";
import { DataChannelHub } from "../src/data-channels.js";
import type { InputEvent, FileEvent } from "../src/protocol.js";

type OpenHandler = () => void;
type MessageHandler = (e: { data: string | ArrayBuffer }) => void;

class MockDataChannel {
  label: string;
  ordered: boolean;
  maxRetransmits: number | null;
  readyState: RTCDataChannelState = "connecting";
  onopen: OpenHandler | null = null;
  onmessage: MessageHandler | null = null;

  private sent: Array<string | ArrayBuffer> = [];

  constructor(label: string, init?: RTCDataChannelInit) {
    this.label = label;
    this.ordered = init?.ordered ?? true;
    this.maxRetransmits = init?.maxRetransmits ?? null;
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  getSent(): Array<string | ArrayBuffer> {
    return this.sent;
  }

  simulateOpen(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  simulateMessage(data: string | ArrayBuffer): void {
    this.onmessage?.({ data });
  }

  close(): void {
    this.readyState = "closed";
  }
}

class MockPeerConnectionCaller {
  channels: MockDataChannel[] = [];
  ondatachannel: null = null;

  createDataChannel(label: string, init?: RTCDataChannelInit): MockDataChannel {
    const ch = new MockDataChannel(label, init);
    this.channels.push(ch);
    return ch;
  }
}

class MockPeerConnectionCallee {
  channels: MockDataChannel[] = [];
  ondatachannel: ((e: { channel: MockDataChannel }) => void) | null = null;

  simulateIncoming(ch: MockDataChannel): void {
    this.channels.push(ch);
    this.ondatachannel?.({ channel: ch });
  }
}

describe("DataChannelHub — caller role", () => {
  let pc: MockPeerConnectionCaller;
  let hub: DataChannelHub;

  beforeEach(() => {
    pc = new MockPeerConnectionCaller();
    hub = new DataChannelHub(
      pc as unknown as RTCPeerConnection,
      "caller",
    );
  });

  it("opens both 'input' and 'files' channels on construction", () => {
    const labels = pc.channels.map((c) => c.label);
    expect(labels).toContain("input");
    expect(labels).toContain("files");
    expect(pc.channels).toHaveLength(2);
  });

  it("creates input channel as lossy (ordered:false, maxRetransmits:0)", () => {
    const input = pc.channels.find((c) => c.label === "input")!;
    expect(input.ordered).toBe(false);
    expect(input.maxRetransmits).toBe(0);
  });

  it("creates files channel as reliable ordered", () => {
    const files = pc.channels.find((c) => c.label === "files")!;
    expect(files.ordered).toBe(true);
  });

  it("sendInput JSON-serializes and sends on the input channel", () => {
    const input = pc.channels.find((c) => c.label === "input")!;
    const event: InputEvent = { kind: "mouse-move", x: 0.5, y: 0.25 };
    hub.sendInput(event);
    expect(input.getSent()).toHaveLength(1);
    expect(JSON.parse(input.getSent()[0] as string)).toEqual(event);
  });

  it("onInput handler fires with parsed InputEvent when input channel receives text", () => {
    const input = pc.channels.find((c) => c.label === "input")!;
    const handler = vi.fn();
    hub.onInput(handler);
    const event: InputEvent = { kind: "key", code: "KeyA", pressed: true, modifiers: { shift: false, ctrl: false, alt: false, meta: false } };
    input.simulateMessage(JSON.stringify(event));
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("sendFile JSON-serializes and sends on the files channel", () => {
    const files = pc.channels.find((c) => c.label === "files")!;
    const event: FileEvent = { kind: "file-offer", id: "abc", name: "test.pdf", size: 1024, mime: "application/pdf" };
    hub.sendFile(event);
    expect(files.getSent()).toHaveLength(1);
    expect(JSON.parse(files.getSent()[0] as string)).toEqual(event);
  });

  it("onFile handler fires with parsed FileEvent when files channel receives text", () => {
    const files = pc.channels.find((c) => c.label === "files")!;
    const handler = vi.fn();
    hub.onFile(handler);
    const event: FileEvent = { kind: "file-accept", id: "abc" };
    files.simulateMessage(JSON.stringify(event));
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("sendFileChunk sends ArrayBuffer on the files channel", () => {
    const files = pc.channels.find((c) => c.label === "files")!;
    const buf = new ArrayBuffer(8);
    hub.sendFileChunk(buf);
    expect(files.getSent()).toHaveLength(1);
    expect(files.getSent()[0]).toBe(buf);
  });

  it("onFileChunk handler fires with ArrayBuffer on binary messages", () => {
    const files = pc.channels.find((c) => c.label === "files")!;
    const handler = vi.fn();
    hub.onFileChunk(handler);
    const buf = new ArrayBuffer(16);
    files.simulateMessage(buf);
    expect(handler).toHaveBeenCalledWith(buf);
  });

  it("ready() resolves when both channels open", async () => {
    const input = pc.channels.find((c) => c.label === "input")!;
    const files = pc.channels.find((c) => c.label === "files")!;

    const promise = hub.ready();
    input.simulateOpen();
    files.simulateOpen();
    await expect(promise).resolves.toBeUndefined();
  });

  it("ready() does not resolve if only one channel opens", async () => {
    const input = pc.channels.find((c) => c.label === "input")!;

    let resolved = false;
    hub.ready().then(() => { resolved = true; });
    input.simulateOpen();

    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
  });

  it("close() closes both channels", () => {
    hub.close();
    for (const ch of pc.channels) {
      expect(ch.readyState).toBe("closed");
    }
  });
});

describe("DataChannelHub — callee role", () => {
  let pc: MockPeerConnectionCallee;
  let hub: DataChannelHub;

  beforeEach(() => {
    pc = new MockPeerConnectionCallee();
    hub = new DataChannelHub(
      pc as unknown as RTCPeerConnection,
      "callee",
    );
  });

  it("callee does not call createDataChannel on construction", () => {
    expect(pc.channels).toHaveLength(0);
  });

  it("callee receives input channel via ondatachannel", () => {
    const ch = new MockDataChannel("input");
    pc.simulateIncoming(ch);
    const event: InputEvent = { kind: "scroll", dx: 0, dy: 120 };
    const handler = vi.fn();
    hub.onInput(handler);
    ch.simulateMessage(JSON.stringify(event));
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("callee receives files channel via ondatachannel", () => {
    const ch = new MockDataChannel("files");
    pc.simulateIncoming(ch);
    const event: FileEvent = { kind: "file-done", id: "xyz" };
    const handler = vi.fn();
    hub.onFile(handler);
    ch.simulateMessage(JSON.stringify(event));
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("callee ready() resolves when both channels arrive and open", async () => {
    const inputCh = new MockDataChannel("input");
    const filesCh = new MockDataChannel("files");

    const promise = hub.ready();
    pc.simulateIncoming(inputCh);
    pc.simulateIncoming(filesCh);
    inputCh.simulateOpen();
    filesCh.simulateOpen();

    await expect(promise).resolves.toBeUndefined();
  });
});
