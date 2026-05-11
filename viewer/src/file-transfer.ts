import type { FileEvent } from "./protocol.js";

export type FileOffer = {
  id: string;
  name: string;
  size: number;
  mime: string;
};

const CHUNK_SIZE = 16 * 1024;
const BACKPRESSURE_THRESHOLD = 1024 * 1024;

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (Math.imul(hash, 0x01000193) >>> 0);
  }
  return hash >>> 0;
}

function buildChunkFrame(id: string, seq: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(8 + payload.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, fnv1a32(id), true);
  view.setUint32(4, seq, true);
  new Uint8Array(buf, 8).set(payload);
  return buf;
}

type PendingSend = {
  acceptResolve: () => void;
  acceptReject: (err: Error) => void;
};

type IncomingReceive = {
  offer: FileOffer;
  chunks: Map<number, Uint8Array>;
};

export class FileTransferManager {
  private offerHandler: ((offer: FileOffer) => Promise<boolean>) | null = null;
  private completeHandler: ((file: File) => void) | null = null;

  private pendingSend: Map<string, PendingSend> = new Map();
  private pendingReceive: Map<string, IncomingReceive> = new Map();

  constructor(
    private sendEvent: (event: FileEvent) => void,
    private sendChunk: (buf: ArrayBuffer) => void,
    private filesBufferedAmount: () => number,
    private awaitFilesBufferedLow: (threshold: number) => Promise<void>,
  ) {}

  send(file: File): Promise<void> {
    const id = crypto.randomUUID();

    const acceptPromise = new Promise<void>((resolve, reject) => {
      this.pendingSend.set(id, { acceptResolve: resolve, acceptReject: reject });
    });

    this.sendEvent({
      kind: "file-offer",
      id,
      name: file.name,
      size: file.size,
      mime: file.type,
    });

    return acceptPromise.then(() => this.streamFile(id, file));
  }

  private async streamFile(id: string, file: File): Promise<void> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let seq = 0;

    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
      if (this.filesBufferedAmount() > BACKPRESSURE_THRESHOLD) {
        await this.awaitFilesBufferedLow(BACKPRESSURE_THRESHOLD);
      }
      const slice = bytes.slice(offset, offset + CHUNK_SIZE);
      this.sendChunk(buildChunkFrame(id, seq, slice));
      seq++;
    }

    this.sendEvent({ kind: "file-done", id });
  }

  onIncomingOffer(handler: (offer: FileOffer) => Promise<boolean>): void {
    this.offerHandler = handler;
  }

  onIncomingComplete(handler: (file: File) => void): void {
    this.completeHandler = handler;
  }

  handle(event: FileEvent): void {
    switch (event.kind) {
      case "file-accept": {
        const pending = this.pendingSend.get(event.id);
        if (pending) {
          this.pendingSend.delete(event.id);
          pending.acceptResolve();
        }
        break;
      }
      case "file-reject": {
        const pending = this.pendingSend.get(event.id);
        if (pending) {
          this.pendingSend.delete(event.id);
          pending.acceptReject(new Error("Transfer rejected"));
        }
        break;
      }
      case "file-offer": {
        this.handleIncomingOffer(event);
        break;
      }
      case "file-done": {
        this.finalizeReceive(event.id);
        break;
      }
      case "file-error": {
        this.pendingReceive.delete(event.id);
        break;
      }
    }
  }

  handleChunk(buf: ArrayBuffer): void {
    if (buf.byteLength < 8) return;
    const view = new DataView(buf);
    const idHash = view.getUint32(0, true);
    const seq = view.getUint32(4, true);
    const payload = new Uint8Array(buf, 8);

    for (const [id, state] of this.pendingReceive) {
      if (fnv1a32(id) === idHash) {
        state.chunks.set(seq, payload.slice());
        return;
      }
    }
  }

  cancelAll(): void {
    for (const [, pending] of this.pendingSend) {
      pending.acceptReject(new Error("Cancelled"));
    }
    this.pendingSend.clear();
    this.pendingReceive.clear();
  }

  private handleIncomingOffer(offer: FileEvent & { kind: "file-offer" }): void {
    const fileOffer: FileOffer = {
      id: offer.id,
      name: offer.name,
      size: offer.size,
      mime: offer.mime,
    };

    const handler = this.offerHandler;
    if (!handler) {
      this.sendEvent({ kind: "file-reject", id: offer.id });
      return;
    }

    this.pendingReceive.set(offer.id, { offer: fileOffer, chunks: new Map() });

    handler(fileOffer).then((accepted) => {
      if (accepted) {
        this.sendEvent({ kind: "file-accept", id: offer.id });
      } else {
        this.pendingReceive.delete(offer.id);
        this.sendEvent({ kind: "file-reject", id: offer.id });
      }
    }).catch(() => {
      this.pendingReceive.delete(offer.id);
      this.sendEvent({ kind: "file-reject", id: offer.id });
    });
  }

  private finalizeReceive(id: string): void {
    const state = this.pendingReceive.get(id);
    if (!state) return;
    this.pendingReceive.delete(id);

    const seqNums = Array.from(state.chunks.keys()).sort((a, b) => a - b);
    const parts = seqNums.map((seq) => state.chunks.get(seq)!);
    const total = parts.reduce((acc, p) => acc + p.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }

    const blob = new Blob([merged], { type: state.offer.mime });
    const file = new File([blob], state.offer.name, { type: state.offer.mime });
    this.completeHandler?.(file);
  }
}
