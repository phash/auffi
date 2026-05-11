import type { InputEvent, FileEvent } from "./protocol.js";

export class DataChannelHub {
  private inputChannel: RTCDataChannel | null = null;
  private filesChannel: RTCDataChannel | null = null;

  private inputHandlers: Array<(event: InputEvent) => void> = [];
  private fileHandlers: Array<(event: FileEvent) => void> = [];
  private fileChunkHandlers: Array<(buf: ArrayBuffer) => void> = [];

  private inputReady = false;
  private filesReady = false;
  private readyResolvers: Array<() => void> = [];

  constructor(private pc: RTCPeerConnection, role: "caller" | "callee") {
    if (role === "caller") {
      this.setupChannel(
        pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 }),
      );
      this.setupChannel(
        pc.createDataChannel("files", { ordered: true }),
      );
    } else {
      pc.ondatachannel = (ev) => {
        this.setupChannel(ev.channel);
      };
    }
  }

  private setupChannel(ch: RTCDataChannel): void {
    if (ch.label === "input") {
      this.inputChannel = ch;
      ch.onopen = () => {
        this.inputReady = true;
        this.checkReady();
      };
      ch.onmessage = (ev) => {
        const event = JSON.parse(ev.data as string) as InputEvent;
        for (const h of this.inputHandlers) h(event);
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
          const event = JSON.parse(ev.data as string) as FileEvent;
          for (const h of this.fileHandlers) h(event);
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

  sendInput(event: InputEvent): void {
    this.inputChannel?.send(JSON.stringify(event));
  }

  onInput(handler: (event: InputEvent) => void): void {
    this.inputHandlers.push(handler);
  }

  sendFile(event: FileEvent): void {
    this.filesChannel?.send(JSON.stringify(event));
  }

  onFile(handler: (event: FileEvent) => void): void {
    this.fileHandlers.push(handler);
  }

  sendFileChunk(buf: ArrayBuffer): void {
    this.filesChannel?.send(buf);
  }

  onFileChunk(handler: (buf: ArrayBuffer) => void): void {
    this.fileChunkHandlers.push(handler);
  }

  filesBufferedAmount(): number {
    return this.filesChannel?.bufferedAmount ?? 0;
  }

  awaitFilesBufferedLow(threshold: number): Promise<void> {
    const ch = this.filesChannel;
    if (!ch || ch.bufferedAmount <= threshold) return Promise.resolve();
    return new Promise((resolve) => {
      ch.bufferedAmountLowThreshold = threshold;
      const onLow = (): void => {
        ch.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      ch.addEventListener("bufferedamountlow", onLow);
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
  }
}
