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
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: OpenHandler | null = null;
  onmessage: MessageHandler | null = null;

  private sent: Array<string | ArrayBuffer> = [];
  private listeners: Map<string, EventListener[]> = new Map();

  constructor(label: string, init?: RTCDataChannelInit) {
    this.label = label;
    this.ordered = init?.ordered ?? true;
    this.maxRetransmits = init?.maxRetransmits ?? null;
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== "open") {
      throw new DOMException("channel not open", "InvalidStateError");
    }
    this.sent.push(data);
  }

  getSent(): Array<string | ArrayBuffer> {
    return this.sent;
  }

  addEventListener(type: string, handler: EventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(handler);
  }

  removeEventListener(type: string, handler: EventListener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((h) => h !== handler));
  }

  simulateEvent(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(new Event(type));
    }
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

class MockPeerConnection {
  channels: MockDataChannel[] = [];

  createDataChannel(label: string, init?: RTCDataChannelInit): MockDataChannel {
    const ch = new MockDataChannel(label, init);
    this.channels.push(ch);
    return ch;
  }
}

describe("DataChannelHub", () => {
  let pc: MockPeerConnection;
  let hub: DataChannelHub;

  beforeEach(() => {
    pc = new MockPeerConnection();
    hub = new DataChannelHub(pc as unknown as RTCPeerConnection);
  });

  function openAll(): { input: MockDataChannel; files: MockDataChannel } {
    const input = pc.channels.find((c) => c.label === "input")!;
    const files = pc.channels.find((c) => c.label === "files")!;
    input.simulateOpen();
    files.simulateOpen();
    return { input, files };
  }

  it("opens both 'input' and 'files' channels on construction", () => {
    const labels = pc.channels.map((c) => c.label);
    expect(labels).toContain("input");
    expect(labels).toContain("files");
    expect(pc.channels).toHaveLength(2);
  });

  it("creates the input channel ordered + reliable (protocol.md: buttons/keys must not be lost)", () => {
    // A lost or reordered key-up / button-up leaves a stuck key on the
    // sharer mid-session — the same failure class the sharer's Drop-release
    // only covers for disconnects (gh #97).
    const input = pc.channels.find((c) => c.label === "input")!;
    expect(input.ordered).toBe(true);
    expect(input.maxRetransmits).toBeNull();
  });

  it("creates files channel as reliable ordered", () => {
    const files = pc.channels.find((c) => c.label === "files")!;
    expect(files.ordered).toBe(true);
  });

  it("sendInput JSON-serializes and sends on the open input channel", () => {
    const { input } = openAll();
    const event: InputEvent = { kind: "mouse-move", x: 0.5, y: 0.25 };
    hub.sendInput(event);
    expect(input.getSent()).toHaveLength(1);
    expect(JSON.parse(input.getSent()[0] as string)).toEqual(event);
  });

  it("sendFile JSON-serializes and sends on the open files channel", () => {
    const { files } = openAll();
    const event: FileEvent = { kind: "file-offer", id: "abc", name: "test.pdf", size: 1024, mime: "application/pdf" };
    hub.sendFile(event);
    expect(files.getSent()).toHaveLength(1);
    expect(JSON.parse(files.getSent()[0] as string)).toEqual(event);
  });

  it("onFile handler fires with parsed FileEvent when files channel receives text", () => {
    const { files } = openAll();
    const handler = vi.fn();
    hub.onFile(handler);
    const event: FileEvent = { kind: "file-accept", id: "abc" };
    files.simulateMessage(JSON.stringify(event));
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("sendFileChunk sends ArrayBuffer on the open files channel", () => {
    const { files } = openAll();
    const buf = new ArrayBuffer(8);
    hub.sendFileChunk(buf);
    expect(files.getSent()).toHaveLength(1);
    expect(files.getSent()[0]).toBe(buf);
  });

  it("onFileChunk handler fires with ArrayBuffer on binary messages", () => {
    const { files } = openAll();
    const handler = vi.fn();
    hub.onFileChunk(handler);
    const buf = new ArrayBuffer(16);
    files.simulateMessage(buf);
    expect(handler).toHaveBeenCalledWith(buf);
  });

  it("silently drops sends on a channel that is not open (no InvalidStateError)", () => {
    // Teardown closes the channels before the last queued microtasks run
    // (e.g. rejecting a still-open file-offer toast) — send() on a closed
    // RTCDataChannel throws InvalidStateError, which previously surfaced as
    // an unhandled promise rejection on every teardown with an open offer.
    const { input, files } = openAll();
    input.close();
    files.close();
    expect(() => hub.sendInput({ kind: "scroll", dx: 0, dy: 120 })).not.toThrow();
    expect(() => hub.sendFile({ kind: "file-reject", id: "x" })).not.toThrow();
    expect(() => hub.sendFileChunk(new ArrayBuffer(8))).not.toThrow();
    expect(input.getSent()).toHaveLength(0);
    expect(files.getSent()).toHaveLength(0);
  });

  it("ready() resolves when both channels open", async () => {
    const promise = hub.ready();
    openAll();
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

  it("close() settles pending ready() promises so they don't leak", async () => {
    const promise = hub.ready();
    let settled = false;
    promise.then(() => { settled = true; });

    hub.close();

    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(true);
  });

  it("files channel onmessage ignores malformed JSON without throwing", () => {
    const { files } = openAll();
    const handler = vi.fn();
    hub.onFile(handler);
    expect(() => files.simulateMessage("{broken")).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("filesBufferedAmount returns the files channel bufferedAmount", () => {
    const { files } = openAll();
    files.bufferedAmount = 512;
    expect(hub.filesBufferedAmount()).toBe(512);
  });

  it("awaitFilesBufferedLow resolves immediately when bufferedAmount is within threshold", async () => {
    const { files } = openAll();
    files.bufferedAmount = 100;
    await expect(hub.awaitFilesBufferedLow(1024)).resolves.toBeUndefined();
  });

  it("awaitFilesBufferedLow resolves on bufferedamountlow event when above threshold", async () => {
    const { files } = openAll();
    files.bufferedAmount = 2 * 1024 * 1024;

    const promise = hub.awaitFilesBufferedLow(1024 * 1024);
    files.simulateEvent("bufferedamountlow");

    await expect(promise).resolves.toBeUndefined();
  });

  it("awaitFilesBufferedLow rejects when the channel closes while above threshold", async () => {
    // Without this, a disconnect mid-transfer leaves the waiter pending
    // forever and the suspended streamFile frame retains the whole file
    // buffer (up to 2 GB) — the send() promise never settles.
    const { files } = openAll();
    files.bufferedAmount = 2 * 1024 * 1024;

    const promise = hub.awaitFilesBufferedLow(1024 * 1024);
    files.readyState = "closed";
    files.simulateEvent("close");

    await expect(promise).rejects.toThrow(/closed/);
  });

  it("awaitFilesBufferedLow rejects on a channel error while above threshold", async () => {
    const { files } = openAll();
    files.bufferedAmount = 2 * 1024 * 1024;

    const promise = hub.awaitFilesBufferedLow(1024 * 1024);
    files.simulateEvent("error");

    await expect(promise).rejects.toThrow(/closed/);
  });

  it("hub.close() rejects outstanding buffered-low waiters", async () => {
    // close() must settle these like it settles ready() resolvers — the
    // channel's own close event fires asynchronously (or not at all in a
    // torn-down peer), so the hub cannot rely on it.
    const { files } = openAll();
    files.bufferedAmount = 2 * 1024 * 1024;

    const promise = hub.awaitFilesBufferedLow(1024 * 1024);
    hub.close();

    await expect(promise).rejects.toThrow(/closed/);
  });

  it("awaitFilesBufferedLow rejects immediately on an already-closed channel", async () => {
    const { files } = openAll();
    files.bufferedAmount = 2 * 1024 * 1024;
    files.close();
    await expect(hub.awaitFilesBufferedLow(1024)).rejects.toThrow(/closed/);
  });
});
