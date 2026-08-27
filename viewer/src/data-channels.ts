import type { InputEvent, FileEvent } from "./protocol.js";

export class DataChannelHub {
  private inputChannel: RTCDataChannel | null = null;
  private filesChannel: RTCDataChannel | null = null;

  private fileHandlers: Array<(event: FileEvent) => void> = [];
  private fileChunkHandlers: Array<(buf: ArrayBuffer) => void> = [];

  private inputReady = false;
  private filesReady = false;
  private readyResolvers: Array<() => void> = [];
  private bufferedLowClosers: Array<() => void> = [];

  constructor(pc: RTCPeerConnection) {
    // The input channel is deliberately ordered + reliable: protocol.md
    // mandates reliability for buttons/keys, and a lost key-up/button-up
    // mid-session leaves a stuck key on the sharer (the gh #97 Drop-release
    // only covers disconnects). Input is low-bandwidth — pointermoves are
    // rAF-coalesced in InputCapture — so reliability costs nothing here.
    this.setupChannel(pc.createDataChannel("input", { ordered: true }));
    this.setupChannel(pc.createDataChannel("files", { ordered: true }));
  }

  private setupChannel(ch: RTCDataChannel): void {
    if (ch.label === "input") {
      // Input flows viewer → sharer only; nothing arrives on this channel.
      this.inputChannel = ch;
      ch.onopen = () => {
        this.inputReady = true;
        this.checkReady();
      };
    } else if (ch.label === "files") {
      this.filesChannel = ch;
      ch.onopen = () => {
        this.filesReady = true;
        this.checkReady();
      };
      ch.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          for (const h of this.fileChunkHandlers) h(ev.data);
        } else {
          try {
            const event = JSON.parse(ev.data as string) as FileEvent;
            for (const h of this.fileHandlers) h(event);
          } catch { return; }
        }
      };
    }
  }

  private checkReady(): void {
    if (this.inputReady && this.filesReady) {
      for (const resolve of this.readyResolvers) resolve();
      this.readyResolvers = [];
    }
  }

  // The send methods drop silently while a channel is not open: teardown
  // closes the channels before the last queued microtasks run (e.g. rejecting
  // a still-open file-offer toast), and RTCDataChannel.send() on a closed
  // channel throws InvalidStateError — which would surface as an unhandled
  // promise rejection at every session end.
  private static isOpen(ch: RTCDataChannel | null): ch is RTCDataChannel {
    return ch !== null && ch.readyState === "open";
  }

  sendInput(event: InputEvent): void {
    if (DataChannelHub.isOpen(this.inputChannel)) {
      this.inputChannel.send(JSON.stringify(event));
    }
  }

  sendFile(event: FileEvent): void {
    if (DataChannelHub.isOpen(this.filesChannel)) {
      this.filesChannel.send(JSON.stringify(event));
    }
  }

  onFile(handler: (event: FileEvent) => void): void {
    this.fileHandlers.push(handler);
  }

  sendFileChunk(buf: ArrayBuffer): void {
    if (DataChannelHub.isOpen(this.filesChannel)) {
      this.filesChannel.send(buf);
    }
  }

  onFileChunk(handler: (buf: ArrayBuffer) => void): void {
    this.fileChunkHandlers.push(handler);
  }

  filesBufferedAmount(): number {
    return this.filesChannel?.bufferedAmount ?? 0;
  }

  /**
   * Resolves once the files channel's bufferedAmount drops to `threshold`;
   * rejects if the channel closes or errors first (or already has). Without
   * the rejection path a disconnect mid-transfer would leave the waiter — and
   * the suspended streamFile frame holding the whole file buffer — pending
   * for good, with the send() promise never settling.
   */
  awaitFilesBufferedLow(threshold: number): Promise<void> {
    const ch = this.filesChannel;
    if (!ch || ch.readyState === "closing" || ch.readyState === "closed") {
      return Promise.reject(new Error("files channel closed"));
    }
    if (ch.bufferedAmount <= threshold) return Promise.resolve();
    return new Promise((resolve, reject) => {
      ch.bufferedAmountLowThreshold = threshold;
      const cleanup = (): void => {
        ch.removeEventListener("bufferedamountlow", onLow);
        ch.removeEventListener("close", onClosed);
        ch.removeEventListener("error", onClosed);
        this.bufferedLowClosers = this.bufferedLowClosers.filter((c) => c !== onClosed);
      };
      const onLow = (): void => {
        cleanup();
        resolve();
      };
      const onClosed = (): void => {
        cleanup();
        reject(new Error("files channel closed"));
      };
      ch.addEventListener("bufferedamountlow", onLow);
      ch.addEventListener("close", onClosed);
      ch.addEventListener("error", onClosed);
      // Also tracked hub-side: close() must be able to settle the waiter
      // itself, because the channel's close event fires asynchronously (or
      // not at all once the peer connection is torn down).
      this.bufferedLowClosers.push(onClosed);
    });
  }

  ready(): Promise<void> {
    if (this.inputReady && this.filesReady) return Promise.resolve();
    return new Promise((resolve) => {
      this.readyResolvers.push(resolve);
    });
  }

  close(): void {
    this.inputChannel?.close();
    this.filesChannel?.close();
    // Settle any pending ready() promises so their .then/.catch chains are
    // not left dangling after the hub is closed (prevents memory leaks and
    // ghost callbacks after teardown).
    for (const r of this.readyResolvers) r();
    this.readyResolvers = [];
    // Same for backpressure waiters — each closer rejects its own promise
    // and unregisters itself from the list.
    for (const c of [...this.bufferedLowClosers]) c();
  }
}
