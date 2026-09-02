import type { FileEvent } from "./protocol.js";

export type FileOffer = {
  id: string;
  name: string;
  size: number;
  mime: string;
};

const CHUNK_SIZE = 16 * 1024;
const BACKPRESSURE_THRESHOLD = 1024 * 1024;

/**
 * Largest incoming transfer the viewer will reassemble in memory. Mirrors
 * `MAX_FILE_SIZE_BYTES` in `sharer/src-tauri/src/files.rs`. Without this an
 * offered file is reassembled into a single `Uint8Array` of unbounded size —
 * a malicious/compromised sharer could "offer 1 KB, stream 100 GB" and OOM
 * the browser tab. We reject the offer above the cap, and abort the receive
 * if the streamed bytes ever exceed the declared `size`.
 */
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Hard ceiling on the number of distinct chunks a single transfer may hold.
 * An honest sender slices by `CHUNK_SIZE`, so this is the chunk count for the
 * largest allowed file; it caps Map growth against a sender that fans out
 * many tiny, sparsely-numbered chunks to bloat the index.
 */
const MAX_CHUNKS = Math.ceil(MAX_FILE_SIZE_BYTES / CHUNK_SIZE);

/**
 * Sanitise a sharer-supplied filename so it's safe to land in `a.download`.
 * Mirrors `sanitize_filename` in `sharer/src-tauri/src/files.rs`:
 *
 * - strips path-traversal components (`..`, `.`) on both `/` and `\`
 * - joins surviving components with `_` (so `../etc/passwd` → `etc_passwd`)
 * - replaces ASCII control chars (U+0000–U+001F, U+007F) with `_`
 * - strips Unicode bidi-override / zero-width chars that browsers preserve
 *   in `a.download` but which can mask `.exe` as `.txt`
 * - strips leading dots
 * - truncates to 255 UTF-16 code units (browsers don't ship a tighter cap)
 * - falls back to `"untitled"` if empty
 */
export function sanitizeFilename(input: string): string {
  const parts = input
    .split(/[/\\]/)
    .filter((p) => p.length > 0 && p !== ".." && p !== ".");
  let s = parts.join("_");

  // Strip ASCII control chars + the Unicode chars that browsers honour
  // verbatim in `a.download` but render misleadingly:
  // - 0x202A–0x202E / 0x2066–0x2069: bidi overrides + isolates
  // - 0x200B–0x200D, 0xFEFF: zero-width spaces / joiners + BOM
  // Written as \u-escapes, not literal bytes: a raw NUL in the source made
  // git classify this security-relevant file as binary (diffs rendered as
  // "Binary files differ", text-mode greps skipped it).
  s = s
    // ASCII controls (U+0000-U+001F, U+007F)
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    // Bidi overrides + isolates
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "_")
    // Zero-width spaces / joiners + BOM
    .replace(/[\u200b-\u200d\ufeff]/g, "_");

  s = s.replace(/^\.+/, "");

  if (s.length === 0) return "untitled";
  if (s.length > 255) s = s.slice(0, 255);
  return s;
}

/**
 * Allowlist a sharer-supplied MIME type. The download already uses `a.download`
 * so the browser won't auto-execute, but we still prevent a `text/html`-labelled
 * blob from appearing on disk with that type (which some browsers open in-tab).
 * Any MIME not matching the allowlist falls back to `application/octet-stream`.
 *
 * SVG is excluded from the image branch: it is XML that runs inline `<script>`
 * and event handlers when opened in a browser, so labelling a blob with it
 * reintroduces exactly the hazard this allowlist exists to block.
 */
export function sanitizeMime(mime: string): string {
  if (/^image\/svg/i.test(mime)) return "application/octet-stream";
  if (
    /^image\//.test(mime) ||
    /^video\//.test(mime) ||
    /^audio\//.test(mime) ||
    mime === "application/pdf" ||
    mime === "application/zip" ||
    mime === "text/plain"
  ) {
    return mime;
  }
  return "application/octet-stream";
}

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
  /** Bytes accepted so far — abort if this ever exceeds `offer.size`. */
  receivedBytes: number;
  /**
   * Set once the helper clicked Annehmen and `file-accept` went out. A
   * sharer that streams before that is not waiting for consent — its
   * transfer is rejected and nothing it sent is kept.
   */
  accepted: boolean;
};

export class FileTransferManager {
  private offerHandler: ((offer: FileOffer) => Promise<boolean>) | null = null;
  private completeHandler: ((file: File) => void) | null = null;

  private pendingSend: Map<string, PendingSend> = new Map();
  private pendingReceive: Map<string, IncomingReceive> = new Map();
  /** Accepted transfers currently streaming; the flag lets a peer
   *  `file-error` or `cancelAll()` stop the chunk loop mid-file. */
  private activeStreams: Map<string, { aborted: boolean }> = new Map();

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
    const stream = { aborted: false };
    this.activeStreams.set(id, stream);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let seq = 0;

      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
        if (this.filesBufferedAmount() > BACKPRESSURE_THRESHOLD) {
          // Rejects when the files channel closes mid-wait — the abort path
          // that keeps this frame (and the whole file buffer) from being
          // suspended forever on a disconnect.
          await this.awaitFilesBufferedLow(BACKPRESSURE_THRESHOLD);
        }
        // Re-checked after every await: a file-error from the peer or a
        // teardown cancelAll() may have flagged the transfer meanwhile.
        if (stream.aborted) throw new Error("Transfer aborted");
        const slice = bytes.slice(offset, offset + CHUNK_SIZE);
        this.sendChunk(buildChunkFrame(id, seq, slice));
        seq++;
      }

      if (stream.aborted) throw new Error("Transfer aborted");
      this.sendEvent({ kind: "file-done", id });
    } finally {
      this.activeStreams.delete(id);
    }
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
        // Receive side: drop the partial reassembly buffer.
        this.pendingReceive.delete(event.id);
        // Send side: the sharer answers offers with file-error too
        // (too-many-active, file-too-large, cannot-open-file) — settle the
        // awaited send() promise and stop an already-running chunk stream.
        const pending = this.pendingSend.get(event.id);
        if (pending) {
          this.pendingSend.delete(event.id);
          pending.acceptReject(new Error(event.message));
        }
        const stream = this.activeStreams.get(event.id);
        if (stream) stream.aborted = true;
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

    if (payload.byteLength === 0) return; // honest senders never emit empty chunks
    for (const [id, state] of this.pendingReceive) {
      if (fnv1a32(id) === idHash) {
        if (!state.accepted) {
          // Data before Annehmen: the sharer is not waiting for consent, so
          // the helper's decision would be moot — refuse instead of buffering.
          this.rejectReceive(id);
          return;
        }
        // Ignore duplicate seqs (must not double-count bytes) and cap the
        // distinct-chunk count so sparse-seq fan-out can't bloat the Map.
        if (state.chunks.has(seq) || state.chunks.size >= MAX_CHUNKS) return;
        if (state.receivedBytes + payload.byteLength > state.offer.size) {
          // Sharer is streaming more than it offered — abort and free the
          // partial buffer rather than growing it unbounded.
          this.pendingReceive.delete(id);
          return;
        }
        state.chunks.set(seq, payload.slice());
        state.receivedBytes += payload.byteLength;
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
    // Accepted transfers are no longer in pendingSend — flag their running
    // streams so the chunk loops stop and the send() promises settle.
    for (const [, stream] of this.activeStreams) {
      stream.aborted = true;
    }
  }

  private handleIncomingOffer(offer: FileEvent & { kind: "file-offer" }): void {
    // Re-sanitise the sharer-supplied filename on the viewer side: the
    // sharer already strips path traversal locally, but it never echoes
    // its sanitised name back to us, so the value here is still
    // attacker-controlled. The Blob/File ends up in `a.download` at
    // save time — the browser preserves RTL-override, zero-width and
    // other Unicode shenanigans that can mask a `.exe` as `.txt`. Apply
    // the same sanitise rules the sharer uses so what the helper sees
    // in the offer dialog matches what eventually lands on disk.
    const fileOffer: FileOffer = {
      id: offer.id,
      name: sanitizeFilename(offer.name),
      size: offer.size,
      mime: offer.mime,
    };

    // Reject before showing the dialog if the declared size is malformed or
    // over the cap — keeps the helper from accepting a transfer that would
    // OOM the tab on reassembly.
    if (
      !Number.isInteger(offer.size) ||
      offer.size < 0 ||
      offer.size > MAX_FILE_SIZE_BYTES
    ) {
      this.sendEvent({ kind: "file-reject", id: offer.id });
      return;
    }

    const handler = this.offerHandler;
    if (!handler) {
      this.sendEvent({ kind: "file-reject", id: offer.id });
      return;
    }

    const state: IncomingReceive = {
      offer: fileOffer,
      chunks: new Map(),
      receivedBytes: 0,
      accepted: false,
    };
    this.pendingReceive.set(offer.id, state);

    handler(fileOffer).then((accepted) => {
      // The transfer may already be gone: force-rejected because the sharer
      // streamed early, or swept by cancelAll(). Then the dialog's answer has
      // nothing left to apply to, and a second reply would confuse the peer.
      if (this.pendingReceive.get(offer.id) !== state) return;
      if (accepted) {
        state.accepted = true;
        this.sendEvent({ kind: "file-accept", id: offer.id });
      } else {
        this.rejectReceive(offer.id);
      }
    }).catch(() => {
      if (this.pendingReceive.get(offer.id) !== state) return;
      this.rejectReceive(offer.id);
    });
  }

  private rejectReceive(id: string): void {
    this.pendingReceive.delete(id);
    this.sendEvent({ kind: "file-reject", id });
  }

  private finalizeReceive(id: string): void {
    const state = this.pendingReceive.get(id);
    if (!state) return;
    if (!state.accepted) {
      this.rejectReceive(id);
      return;
    }
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

    const safeMime = sanitizeMime(state.offer.mime);
    const blob = new Blob([merged], { type: safeMime });
    const file = new File([blob], state.offer.name, { type: safeMime });
    this.completeHandler?.(file);
  }
}
