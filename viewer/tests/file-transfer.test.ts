import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { FileTransferManager, sanitizeFilename, sanitizeMime, type FileOffer, type TransferStatus } from "../src/file-transfer.js";
import type { FileEvent } from "../src/protocol.js";

describe("sanitizeMime", () => {
  it("rejects image/svg+xml — the one image type that executes script", () => {
    // The allowlist exists so a sharer-supplied blob cannot land on disk with
    // a browser-renderable, script-capable type. SVG is XML that runs inline
    // <script> and event handlers when opened, i.e. the same hazard class as
    // text/html, which the comment already names as the threat.
    expect(sanitizeMime("image/svg+xml")).toBe("application/octet-stream");
    expect(sanitizeMime("image/svg+xml; charset=utf-8")).toBe("application/octet-stream");
    expect(sanitizeMime("IMAGE/SVG+XML")).toBe("application/octet-stream");
  });

  it("allows image/* types", () => {
    expect(sanitizeMime("image/png")).toBe("image/png");
    expect(sanitizeMime("image/jpeg")).toBe("image/jpeg");
    expect(sanitizeMime("image/gif")).toBe("image/gif");
  });

  it("allows video/* types", () => {
    expect(sanitizeMime("video/mp4")).toBe("video/mp4");
    expect(sanitizeMime("video/webm")).toBe("video/webm");
  });

  it("allows audio/* types", () => {
    expect(sanitizeMime("audio/mpeg")).toBe("audio/mpeg");
    expect(sanitizeMime("audio/ogg")).toBe("audio/ogg");
  });

  it("allows specific safe application/* types", () => {
    expect(sanitizeMime("application/pdf")).toBe("application/pdf");
    expect(sanitizeMime("application/zip")).toBe("application/zip");
  });

  it("allows text/plain", () => {
    expect(sanitizeMime("text/plain")).toBe("text/plain");
  });

  it("rejects text/html and falls back to octet-stream", () => {
    expect(sanitizeMime("text/html")).toBe("application/octet-stream");
  });

  it("rejects application/javascript and falls back to octet-stream", () => {
    expect(sanitizeMime("application/javascript")).toBe("application/octet-stream");
  });

  it("rejects unknown / empty MIME and falls back to octet-stream", () => {
    expect(sanitizeMime("")).toBe("application/octet-stream");
    expect(sanitizeMime("x-custom/type")).toBe("application/octet-stream");
    expect(sanitizeMime("application/octet-stream")).toBe("application/octet-stream");
  });
});

describe("sanitizeFilename", () => {
  it("strips path-traversal on both unix and windows separators", () => {
    expect(sanitizeFilename("../etc/passwd")).toBe("etc_passwd");
    expect(sanitizeFilename("..\\windows\\system32")).toBe("windows_system32");
    expect(sanitizeFilename("/absolute/path/file")).toBe("absolute_path_file");
  });

  it("replaces ASCII control chars with underscore", () => {
    expect(sanitizeFilename("safe\x00name")).toBe("safe_name");
    expect(sanitizeFilename("with\x1ftab")).toBe("with_tab");
    expect(sanitizeFilename("del\x7fchar")).toBe("del_char");
  });

  it("strips Unicode bidi-override chars that mask file extensions", () => {
    // U+202E (Right-to-Left Override) is the classic exe-as-txt trick.
    expect(sanitizeFilename("safe‮txt.exe")).toBe("safe_txt.exe");
    expect(sanitizeFilename("a⁦b⁩c")).toBe("a_b_c");
  });

  it("strips zero-width characters + BOM", () => {
    expect(sanitizeFilename("a​b")).toBe("a_b");
    expect(sanitizeFilename("﻿﻿bomstart")).toBe("__bomstart");
  });

  it("strips C1 control characters like the sharer does", () => {
    expect(sanitizeFilename("a\u0085b\u009bc.txt")).toBe("a_b_c.txt");
  });

  it("strips leading dots", () => {
    expect(sanitizeFilename(".hidden")).toBe("hidden");
    expect(sanitizeFilename("...still")).toBe("still");
  });

  it("falls back to 'untitled' for empty results", () => {
    expect(sanitizeFilename("")).toBe("untitled");
    expect(sanitizeFilename("/")).toBe("untitled");
    expect(sanitizeFilename("..")).toBe("untitled");
  });

  it("truncates to 255 chars", () => {
    const longName = "a".repeat(300) + ".txt";
    expect(sanitizeFilename(longName).length).toBe(255);
  });
});

// FNV-1a 32-bit hash of a UUID string (same algorithm used in file-transfer.ts)
function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (Math.imul(hash, 0x01000193) >>> 0);
  }
  return hash >>> 0;
}

function makeChunkBuffer(id: string, seq: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(8 + payload.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, fnv1a32(id), true);
  view.setUint32(4, seq, true);
  new Uint8Array(buf, 8).set(payload);
  return buf;
}

describe("FileTransferManager — send", () => {
  let sentEvents: FileEvent[];
  let sentChunks: ArrayBuffer[];
  let bufferedAmount: number;
  let manager: FileTransferManager;

  beforeEach(() => {
    sentEvents = [];
    sentChunks = [];
    bufferedAmount = 0;
    manager = new FileTransferManager(
      (ev) => sentEvents.push(ev),
      (buf) => sentChunks.push(buf),
      () => bufferedAmount,
      () => Promise.resolve(),
    );
  });

  it("rejects when offer is rejected by remote", async () => {
    const content = new Uint8Array([1, 2, 3]);
    const file = new File([content], "test.txt", { type: "text/plain" });

    const sendPromise = manager.send(file);

    // Wait for the file-offer to be emitted (must use expect to make waitFor retry)
    await vi.waitFor(() => {
      expect(sentEvents.length).toBeGreaterThan(0);
    });

    const offer = sentEvents[0];
    expect(offer.kind).toBe("file-offer");
    if (offer.kind !== "file-offer") throw new Error("expected file-offer");

    // Simulate remote rejection
    manager.handle({ kind: "file-reject", id: offer.id });

    await expect(sendPromise).rejects.toThrow("rejected");
  });

  it("streams chunks after accept and resolves on file-done", async () => {
    const content = new Uint8Array(new Array(20000).fill(42));
    const file = new File([content], "big.bin", { type: "application/octet-stream" });

    const sendPromise = manager.send(file);

    await vi.waitFor(() => {
      expect(sentEvents.length).toBeGreaterThan(0);
    });

    const offer = sentEvents[0];
    expect(offer.kind).toBe("file-offer");
    if (offer.kind !== "file-offer") throw new Error("expected file-offer");
    expect(offer.name).toBe("big.bin");
    expect(offer.size).toBe(20000);

    // Accept the transfer and wait for completion
    manager.handle({ kind: "file-accept", id: offer.id });

    // sendPromise resolves when file-done is emitted and streaming is complete
    await expect(sendPromise).resolves.toBeUndefined();

    // 20000 bytes / 16384 bytes per chunk = 2 chunks
    expect(sentChunks.length).toBe(2);

    // Verify chunk frame format: first 4 bytes = FNV-1a hash, next 4 = seq
    const view0 = new DataView(sentChunks[0]);
    expect(view0.getUint32(0, true)).toBe(fnv1a32(offer.id));
    expect(view0.getUint32(4, true)).toBe(0);

    const view1 = new DataView(sentChunks[1]);
    expect(view1.getUint32(0, true)).toBe(fnv1a32(offer.id));
    expect(view1.getUint32(4, true)).toBe(1);

    const lastEvent = sentEvents[sentEvents.length - 1];
    expect(lastEvent.kind).toBe("file-done");
  });

  it("rejects the send() promise when the sharer answers the offer with file-error", async () => {
    // The sharer really does answer offers with file-error (too-many-active,
    // file-too-large). Previously only pendingReceive was cleaned up and the
    // awaited send() stayed pending until session teardown.
    const file = new File([new Uint8Array([1, 2, 3])], "big.iso", { type: "application/octet-stream" });
    const sendPromise = manager.send(file);

    await vi.waitFor(() => {
      expect(sentEvents.length).toBeGreaterThan(0);
    });
    const offer = sentEvents[0];
    if (offer.kind !== "file-offer") throw new Error("expected file-offer");

    manager.handle({ kind: "file-error", id: offer.id, message: "file-too-large" });

    await expect(sendPromise).rejects.toThrow("file-too-large");
  });

  it("file-error mid-stream aborts the chunk loop (no further chunks, no file-done)", async () => {
    let awaitResolve: () => void = () => {};
    const awaitLow = (): Promise<void> =>
      new Promise((resolve) => {
        awaitResolve = resolve;
      });
    // High bufferedAmount from the start → streamFile blocks on the first
    // chunk's backpressure wait, giving the test a window to inject the error.
    const mgr = new FileTransferManager(
      (ev) => sentEvents.push(ev),
      (buf) => sentChunks.push(buf),
      () => 2 * 1024 * 1024,
      awaitLow,
    );

    const file = new File([new Uint8Array(20000)], "abort.bin", { type: "application/octet-stream" });
    const sendPromise = mgr.send(file);
    await vi.waitFor(() => {
      expect(sentEvents.length).toBeGreaterThan(0);
    });
    const offer = sentEvents[0];
    if (offer.kind !== "file-offer") throw new Error("expected file-offer");

    mgr.handle({ kind: "file-accept", id: offer.id });
    // Let streamFile reach the backpressure wait, then error + unblock.
    await new Promise((r) => setTimeout(r, 10));
    mgr.handle({ kind: "file-error", id: offer.id, message: "cannot-open-file" });
    awaitResolve();

    await expect(sendPromise).rejects.toThrow(/aborted/i);
    expect(sentChunks).toHaveLength(0);
    expect(sentEvents.some((e) => e.kind === "file-done")).toBe(false);
  });

  it("cancelAll aborts an accepted in-flight stream so send() settles", async () => {
    let awaitResolve: () => void = () => {};
    const awaitLow = (): Promise<void> =>
      new Promise((resolve) => {
        awaitResolve = resolve;
      });
    const mgr = new FileTransferManager(
      (ev) => sentEvents.push(ev),
      (buf) => sentChunks.push(buf),
      () => 2 * 1024 * 1024,
      awaitLow,
    );

    const file = new File([new Uint8Array(20000)], "teardown.bin", { type: "application/octet-stream" });
    const sendPromise = mgr.send(file);
    await vi.waitFor(() => {
      expect(sentEvents.length).toBeGreaterThan(0);
    });
    const offer = sentEvents[0];
    if (offer.kind !== "file-offer") throw new Error("expected file-offer");

    mgr.handle({ kind: "file-accept", id: offer.id });
    await new Promise((r) => setTimeout(r, 10));
    mgr.cancelAll();
    awaitResolve();

    await expect(sendPromise).rejects.toThrow(/aborted/i);
    expect(sentEvents.some((e) => e.kind === "file-done")).toBe(false);
  });

  it("send() rejects instead of hanging when the backpressure wait rejects (channel closed)", async () => {
    const mgr = new FileTransferManager(
      (ev) => sentEvents.push(ev),
      (buf) => sentChunks.push(buf),
      () => 2 * 1024 * 1024,
      () => Promise.reject(new Error("files channel closed")),
    );

    const file = new File([new Uint8Array(20000)], "closed.bin", { type: "application/octet-stream" });
    const sendPromise = mgr.send(file);
    await vi.waitFor(() => {
      expect(sentEvents.length).toBeGreaterThan(0);
    });
    const offer = sentEvents[0];
    if (offer.kind !== "file-offer") throw new Error("expected file-offer");

    mgr.handle({ kind: "file-accept", id: offer.id });
    await expect(sendPromise).rejects.toThrow(/closed/);
    expect(sentEvents.some((e) => e.kind === "file-done")).toBe(false);
  });

  it("respects backpressure threshold — waits when bufferedAmount is high", async () => {
    let awaitCalled = false;
    let awaitResolve: () => void = () => {};

    const awaitLow = (): Promise<void> =>
      new Promise((resolve) => {
        awaitCalled = true;
        awaitResolve = resolve;
      });

    // First call returns high bufferedAmount, subsequent calls return 0
    let callCount = 0;
    const getBuffered = (): number => {
      callCount++;
      return callCount === 1 ? 2 * 1024 * 1024 : 0;
    };

    const mgr = new FileTransferManager(
      (ev) => sentEvents.push(ev),
      (buf) => sentChunks.push(buf),
      getBuffered,
      awaitLow,
    );

    const content = new Uint8Array(new Array(20000).fill(7));
    const file = new File([content], "bp.bin", { type: "application/octet-stream" });
    const sendPromise = mgr.send(file);

    await vi.waitFor(() => {
      expect(sentEvents.length).toBeGreaterThan(0);
    });
    const offer = sentEvents[0];
    if (offer.kind !== "file-offer") throw new Error("expected file-offer");

    mgr.handle({ kind: "file-accept", id: offer.id });

    // Wait for backpressure check to trigger
    await vi.waitFor(() => {
      expect(awaitCalled).toBe(true);
    }, { timeout: 3000 });

    // Unblock the backpressure wait
    awaitResolve();

    await expect(sendPromise).resolves.toBeUndefined();
    expect(sentChunks.length).toBe(2);
  });
});

describe("FileTransferManager — receive", () => {
  let sentEvents: FileEvent[];
  let manager: FileTransferManager;
  let completedFiles: File[];

  beforeEach(() => {
    sentEvents = [];
    completedFiles = [];
    manager = new FileTransferManager(
      (ev) => sentEvents.push(ev),
      () => {},
      () => 0,
      () => Promise.resolve(),
    );
    manager.onIncomingComplete((f) => completedFiles.push(f));
  });

  it("incoming offer triggers accept handler with correct offer details", async () => {
    const handlerCalled = vi.fn().mockResolvedValue(true);
    manager.onIncomingOffer(handlerCalled);

    manager.handle({
      kind: "file-offer",
      id: "test-id-123",
      name: "document.pdf",
      size: 5000,
      mime: "application/pdf",
    });

    await vi.waitFor(() => {
      expect(handlerCalled.mock.calls.length).toBeGreaterThan(0);
    });

    expect(handlerCalled).toHaveBeenCalledWith({
      id: "test-id-123",
      name: "document.pdf",
      size: 5000,
      mime: "application/pdf",
    });
  });

  it("chunks accumulate and file-done produces a complete File", async () => {
    manager.onIncomingOffer(() => Promise.resolve(true));

    const fileId = "file-abc-456";
    const chunk0 = new Uint8Array([10, 20, 30]);
    const chunk1 = new Uint8Array([40, 50, 60]);

    manager.handle({
      kind: "file-offer",
      id: fileId,
      name: "out.bin",
      size: 6,
      mime: "application/octet-stream",
    });

    // Wait for file-accept to be sent
    await vi.waitFor(() => {
      expect(sentEvents.some((e) => e.kind === "file-accept")).toBe(true);
    });

    manager.handleChunk(makeChunkBuffer(fileId, 0, chunk0));
    manager.handleChunk(makeChunkBuffer(fileId, 1, chunk1));
    manager.handle({ kind: "file-done", id: fileId });

    await vi.waitFor(() => {
      expect(completedFiles.length).toBeGreaterThan(0);
    });

    const result = completedFiles[0];
    expect(result.name).toBe("out.bin");
    expect(result.size).toBe(6);

    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(Array.from(bytes)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it("rejected offer emits file-reject and does not call complete handler", async () => {
    manager.onIncomingOffer(() => Promise.resolve(false));

    const fileId = "rejected-id";
    manager.handle({
      kind: "file-offer",
      id: fileId,
      name: "nope.txt",
      size: 10,
      mime: "text/plain",
    });

    await vi.waitFor(() => {
      expect(sentEvents.some((e) => e.kind === "file-reject")).toBe(true);
    });

    const rejectEvent = sentEvents.find((e) => e.kind === "file-reject");
    expect(rejectEvent).toBeDefined();
    if (rejectEvent?.kind !== "file-reject") throw new Error("type guard");
    expect(rejectEvent.id).toBe(fileId);

    // No complete handler should fire
    await new Promise((r) => setTimeout(r, 20));
    expect(completedFiles).toHaveLength(0);
  });

  it("cancelAll clears pending state without throwing", () => {
    manager.onIncomingOffer(() => Promise.resolve(true));
    manager.handle({
      kind: "file-offer",
      id: "cancel-me",
      name: "file.txt",
      size: 100,
      mime: "text/plain",
    });

    expect(() => manager.cancelAll()).not.toThrow();
  });

  it("chunks out of order are reassembled in sequence order", async () => {
    manager.onIncomingOffer(() => Promise.resolve(true));

    const fileId = "out-of-order-id";
    const chunk0 = new Uint8Array([0xaa, 0xbb]);
    const chunk1 = new Uint8Array([0xcc, 0xdd]);

    manager.handle({
      kind: "file-offer",
      id: fileId,
      name: "ordered.bin",
      size: 4,
      mime: "application/octet-stream",
    });

    await vi.waitFor(() => {
      expect(sentEvents.some((e) => e.kind === "file-accept")).toBe(true);
    });

    // Deliver chunk 1 before chunk 0
    manager.handleChunk(makeChunkBuffer(fileId, 1, chunk1));
    manager.handleChunk(makeChunkBuffer(fileId, 0, chunk0));
    manager.handle({ kind: "file-done", id: fileId });

    await vi.waitFor(() => {
      expect(completedFiles.length).toBeGreaterThan(0);
    });

    const bytes = new Uint8Array(await completedFiles[0].arrayBuffer());
    expect(Array.from(bytes)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it("file-offer without registered handler auto-rejects", async () => {
    // No onIncomingOffer set
    manager.handle({
      kind: "file-offer",
      id: "no-handler-id",
      name: "ghost.bin",
      size: 1,
      mime: "application/octet-stream",
    });

    await vi.waitFor(() => {
      expect(sentEvents.some((e) => e.kind === "file-reject")).toBe(true);
    });

    const rejectEvent = sentEvents.find((e) => e.kind === "file-reject");
    expect(rejectEvent).toBeDefined();
    if (rejectEvent?.kind !== "file-reject") throw new Error("type guard");
    expect(rejectEvent.id).toBe("no-handler-id");
  });

  it("handler that throws rejects the transfer", async () => {
    manager.onIncomingOffer(() => Promise.reject(new Error("handler error")));

    manager.handle({
      kind: "file-offer",
      id: "throw-handler-id",
      name: "bad.bin",
      size: 1,
      mime: "application/octet-stream",
    });

    await vi.waitFor(() => {
      expect(sentEvents.some((e) => e.kind === "file-reject")).toBe(true);
    });

    const rejectEvent = sentEvents.find((e) => e.kind === "file-reject");
    if (rejectEvent?.kind !== "file-reject") throw new Error("type guard");
    expect(rejectEvent.id).toBe("throw-handler-id");
  });

  it("file-error event removes pending receive state", () => {
    manager.onIncomingOffer(() => Promise.resolve(true));
    manager.handle({
      kind: "file-offer",
      id: "err-id",
      name: "err.bin",
      size: 100,
      mime: "application/octet-stream",
    });

    expect(() =>
      manager.handle({ kind: "file-error", id: "err-id", message: "something went wrong" }),
    ).not.toThrow();

    // file-done after error should be a no-op
    expect(() => manager.handle({ kind: "file-done", id: "err-id" })).not.toThrow();
    expect(completedFiles).toHaveLength(0);
  });

  it("handleChunk with too-short buffer is ignored gracefully", () => {
    expect(() => manager.handleChunk(new ArrayBuffer(4))).not.toThrow();
  });

  it("rejects an offer whose declared size exceeds the 2 GiB cap (no OOM)", async () => {
    manager.onIncomingOffer(() => Promise.resolve(true));
    manager.handle({
      kind: "file-offer",
      id: "too-big",
      name: "huge.bin",
      size: 2 * 1024 * 1024 * 1024 + 1,
      mime: "application/octet-stream",
    });
    await vi.waitFor(() => {
      expect(sentEvents.some((e) => e.kind === "file-reject")).toBe(true);
    });
    // Handler must never run for an over-cap offer.
    const reject = sentEvents.find((e) => e.kind === "file-reject");
    if (reject?.kind !== "file-reject") throw new Error("type guard");
    expect(reject.id).toBe("too-big");
  });

  it("rejects an offer with a malformed (negative / non-integer) size", async () => {
    manager.onIncomingOffer(() => Promise.resolve(true));
    manager.handle({ kind: "file-offer", id: "neg", name: "n.bin", size: -1, mime: "x" });
    manager.handle({ kind: "file-offer", id: "frac", name: "f.bin", size: 1.5, mime: "x" });
    await vi.waitFor(() => {
      expect(sentEvents.filter((e) => e.kind === "file-reject").length).toBe(2);
    });
  });

  it("aborts the receive when streamed bytes exceed the declared size", async () => {
    manager.onIncomingOffer(() => Promise.resolve(true));
    const fileId = "overflow";
    manager.handle({ kind: "file-offer", id: fileId, name: "o.bin", size: 4, mime: "x" });
    await vi.waitFor(() => {
      expect(sentEvents.some((e) => e.kind === "file-accept")).toBe(true);
    });
    // Declared 4 bytes; stream 4 then 4 more — the second chunk overflows and
    // the partial buffer is dropped, so file-done produces no file.
    manager.handleChunk(makeChunkBuffer(fileId, 0, new Uint8Array([1, 2, 3, 4])));
    manager.handleChunk(makeChunkBuffer(fileId, 1, new Uint8Array([5, 6, 7, 8])));
    manager.handle({ kind: "file-done", id: fileId });
    await new Promise((r) => setTimeout(r, 20));
    expect(completedFiles).toHaveLength(0);
  });

  it("ignores empty and duplicate chunks", async () => {
    manager.onIncomingOffer(() => Promise.resolve(true));
    const fileId = "dup";
    manager.handle({ kind: "file-offer", id: fileId, name: "d.bin", size: 2, mime: "x" });
    await vi.waitFor(() => {
      expect(sentEvents.some((e) => e.kind === "file-accept")).toBe(true);
    });
    manager.handleChunk(makeChunkBuffer(fileId, 0, new Uint8Array([9, 9])));
    // duplicate seq 0 (must not double-count → would overflow size 2) + empty chunk
    manager.handleChunk(makeChunkBuffer(fileId, 0, new Uint8Array([7, 7])));
    manager.handleChunk(makeChunkBuffer(fileId, 1, new Uint8Array([])));
    manager.handle({ kind: "file-done", id: fileId });
    await vi.waitFor(() => {
      expect(completedFiles.length).toBeGreaterThan(0);
    });
    const bytes = new Uint8Array(await completedFiles[0].arrayBuffer());
    expect(Array.from(bytes)).toEqual([9, 9]);
  });
});

describe("FileTransferManager — nothing lands before the helper accepts", () => {
  let sentEvents: FileEvent[];
  let manager: FileTransferManager;
  let completedFiles: File[];

  beforeEach(() => {
    sentEvents = [];
    completedFiles = [];
    manager = new FileTransferManager(
      (ev) => sentEvents.push(ev),
      () => {},
      () => 0,
      () => Promise.resolve(),
    );
    manager.onIncomingComplete((f) => completedFiles.push(f));
  });

  it("a sharer that streams before file-accept gets rejected and nothing is saved", async () => {
    // The offer dialog is still open: the handler never resolves during the test.
    manager.onIncomingOffer(() => new Promise<boolean>(() => {}));
    const fileId = "pushy-sharer";
    manager.handle({ kind: "file-offer", id: fileId, name: "evil.exe", size: 3, mime: "application/octet-stream" });

    manager.handleChunk(makeChunkBuffer(fileId, 0, new Uint8Array([1, 2, 3])));
    manager.handle({ kind: "file-done", id: fileId });

    await new Promise((r) => setTimeout(r, 20));
    expect(completedFiles).toHaveLength(0);
    expect(sentEvents.some((e) => e.kind === "file-accept")).toBe(false);
    const reject = sentEvents.find((e) => e.kind === "file-reject");
    expect(reject && reject.kind === "file-reject" ? reject.id : null).toBe(fileId);
  });

  it("a late Annehmen on a transfer the sharer already forced is a no-op (no second answer)", async () => {
    let resolveOffer: ((v: boolean) => void) | null = null;
    manager.onIncomingOffer(() => new Promise<boolean>((r) => { resolveOffer = r; }));
    const fileId = "forced-then-accepted";
    manager.handle({ kind: "file-offer", id: fileId, name: "x.bin", size: 2, mime: "application/octet-stream" });
    manager.handleChunk(makeChunkBuffer(fileId, 0, new Uint8Array([7, 7])));

    resolveOffer!(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(sentEvents.filter((e) => e.kind === "file-accept")).toHaveLength(0);
    expect(sentEvents.filter((e) => e.kind === "file-reject")).toHaveLength(1);
    expect(completedFiles).toHaveLength(0);
  });

  it("chunks that arrive after Annehmen still reassemble normally", async () => {
    manager.onIncomingOffer(() => Promise.resolve(true));
    const fileId = "polite-sharer";
    manager.handle({ kind: "file-offer", id: fileId, name: "ok.bin", size: 2, mime: "application/octet-stream" });
    await vi.waitFor(() => {
      expect(sentEvents.some((e) => e.kind === "file-accept")).toBe(true);
    });
    manager.handleChunk(makeChunkBuffer(fileId, 0, new Uint8Array([4, 2])));
    manager.handle({ kind: "file-done", id: fileId });
    await vi.waitFor(() => {
      expect(completedFiles).toHaveLength(1);
    });
    expect(completedFiles[0].name).toBe("ok.bin");
  });
});

describe("FileTransferManager — receive integrity", () => {
  let sentEvents: FileEvent[];
  let manager: FileTransferManager;
  let completedFiles: File[];

  beforeEach(() => {
    sentEvents = [];
    completedFiles = [];
    manager = new FileTransferManager(
      (ev) => sentEvents.push(ev),
      () => {},
      () => 0,
      () => Promise.resolve(),
    );
    manager.onIncomingComplete((f) => completedFiles.push(f));
    manager.onIncomingOffer(() => Promise.resolve(true));
  });

  async function accepted(id: string, size: number): Promise<void> {
    manager.handle({ kind: "file-offer", id, name: "f.bin", size, mime: "application/octet-stream" });
    await vi.waitFor(() => {
      expect(sentEvents.some((e) => e.kind === "file-accept" && e.id === id)).toBe(true);
    });
  }

  function errors(): Array<{ id: string; message: string }> {
    return sentEvents.flatMap((e) => (e.kind === "file-error" ? [{ id: e.id, message: e.message }] : []));
  }

  // A file-done with a hole in the sequence used to save a silently
  // truncated file — the helper would open a corrupt document.
  it("a file-done with a missing chunk saves nothing and answers file-error", async () => {
    await accepted("gap", 6);
    manager.handleChunk(makeChunkBuffer("gap", 0, new Uint8Array([1, 2, 3])));
    manager.handleChunk(makeChunkBuffer("gap", 2, new Uint8Array([4, 5, 6])));
    manager.handle({ kind: "file-done", id: "gap" });
    await new Promise((r) => setTimeout(r, 10));
    expect(completedFiles).toHaveLength(0);
    expect(errors()).toEqual([{ id: "gap", message: "incomplete-transfer" }]);
  });

  it("a file-done before the declared size arrived saves nothing and answers file-error", async () => {
    await accepted("short", 10);
    manager.handleChunk(makeChunkBuffer("short", 0, new Uint8Array([1, 2, 3])));
    manager.handle({ kind: "file-done", id: "short" });
    await new Promise((r) => setTimeout(r, 10));
    expect(completedFiles).toHaveLength(0);
    expect(errors()).toEqual([{ id: "short", message: "incomplete-transfer" }]);
  });

  // Silently dropping the transfer left the sharer streaming into the void.
  it("streaming past the declared size answers file-error", async () => {
    await accepted("over", 2);
    manager.handleChunk(makeChunkBuffer("over", 0, new Uint8Array([1, 2, 3])));
    expect(errors()).toEqual([{ id: "over", message: "size-exceeded" }]);
  });

  it("an empty file completes with no chunks at all", async () => {
    await accepted("empty", 0);
    manager.handle({ kind: "file-done", id: "empty" });
    await vi.waitFor(() => expect(completedFiles).toHaveLength(1));
    expect(completedFiles[0].size).toBe(0);
    expect(errors()).toEqual([]);
  });

  // At the 2 GiB cap, chunks + a merged copy + the Blob's own copy was
  // ~6 GiB and crashed the tab; the File is now built from the parts.
  it("does not copy the chunks into one merged buffer before saving", async () => {
    await accepted("big", 4);
    manager.handleChunk(makeChunkBuffer("big", 0, new Uint8Array([1, 2])));
    manager.handleChunk(makeChunkBuffer("big", 1, new Uint8Array([3, 4])));
    const RealFile = File;
    const fileParts: BlobPart[][] = [];
    vi.stubGlobal(
      "File",
      class extends RealFile {
        constructor(bits: BlobPart[], name: string, opts?: FilePropertyBag) {
          fileParts.push(bits);
          super(bits, name, opts);
        }
      },
    );
    try {
      manager.handle({ kind: "file-done", id: "big" });
    } finally {
      vi.unstubAllGlobals();
    }
    await vi.waitFor(() => expect(completedFiles).toHaveLength(1));
    expect(fileParts).toHaveLength(1);
    expect(fileParts[0].every((p) => p instanceof Uint8Array && p.byteLength === 2)).toBe(true);
    expect(Array.from(new Uint8Array(await completedFiles[0].arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });
});

describe("FileTransferManager — malformed offers", () => {
  let sentEvents: FileEvent[];
  let manager: FileTransferManager;
  let offerHandler: Mock<(offer: FileOffer) => Promise<boolean>>;

  beforeEach(() => {
    sentEvents = [];
    manager = new FileTransferManager(
      (ev) => sentEvents.push(ev),
      () => {},
      () => 0,
      () => Promise.resolve(),
    );
    offerHandler = vi.fn<(offer: FileOffer) => Promise<boolean>>().mockResolvedValue(true);
    manager.onIncomingOffer(offerHandler);
  });

  // JSON from the data channel is only cast to FileEvent, never checked; a
  // non-string name made sanitizeFilename throw inside the hub's handler and
  // the sharer never got an answer.
  it.each([
    ["name is a number", { name: 42, mime: "text/plain" }],
    ["name is missing", { mime: "text/plain" }],
    ["mime is an object", { name: "a.txt", mime: {} }],
  ])("answers file-reject when the %s", (_label, fields) => {
    const ev = { kind: "file-offer", id: "bad", size: 3, ...fields } as unknown as FileEvent;
    expect(() => manager.handle(ev)).not.toThrow();
    expect(sentEvents).toEqual([{ kind: "file-reject", id: "bad" }]);
    expect(offerHandler).not.toHaveBeenCalled();
  });

  it("ignores an offer without a usable id (nothing to answer to)", () => {
    const ev = { kind: "file-offer", id: 7, name: "a", size: 1, mime: "x" } as unknown as FileEvent;
    expect(() => manager.handle(ev)).not.toThrow();
    expect(sentEvents).toEqual([]);
    expect(offerHandler).not.toHaveBeenCalled();
  });
});

describe("FileTransferManager — transfer status for the UI", () => {
  let sentEvents: FileEvent[];
  let manager: FileTransferManager;
  let statuses: TransferStatus[];

  beforeEach(() => {
    sentEvents = [];
    statuses = [];
    manager = new FileTransferManager(
      (ev) => sentEvents.push(ev),
      () => {},
      () => 0,
      () => Promise.resolve(),
    );
    manager.onTransferStatus((s) => statuses.push(s));
  });

  function lastOfferId(): string {
    const offer = sentEvents.find((e) => e.kind === "file-offer");
    if (!offer) throw new Error("no offer sent");
    return offer.id;
  }

  it("send: waiting → progress → done", async () => {
    const p = manager.send(new File([new Uint8Array(40000)], "gross.bin"));
    const id = lastOfferId();
    expect(statuses).toEqual([{ id, name: "gross.bin", direction: "send", phase: "waiting" }]);
    manager.handle({ kind: "file-accept", id });
    await p;
    expect(statuses.at(-1)).toEqual({ id, name: "gross.bin", direction: "send", phase: "done" });
    const percents = statuses.flatMap((s) => (s.phase === "progress" ? [s.percent] : []));
    expect(percents).toEqual([0, 40, 81, 100]);
  });

  it("send: the other side rejects", async () => {
    const p = manager.send(new File([new Uint8Array(3)], "nein.txt"));
    const id = lastOfferId();
    manager.handle({ kind: "file-reject", id });
    await expect(p).rejects.toThrow();
    expect(statuses.at(-1)).toEqual({ id, name: "nein.txt", direction: "send", phase: "rejected" });
  });

  it("send: the other side answers file-error", async () => {
    const p = manager.send(new File([new Uint8Array(3)], "kaputt.txt"));
    const id = lastOfferId();
    manager.handle({ kind: "file-error", id, message: "file-too-large" });
    await expect(p).rejects.toThrow();
    expect(statuses.at(-1)).toEqual({ id, name: "kaputt.txt", direction: "send", phase: "failed" });
  });

  it("receive: progress after accept, then done", async () => {
    manager.onIncomingOffer(() => Promise.resolve(true));
    manager.onIncomingComplete(() => {});
    manager.handle({ kind: "file-offer", id: "r", name: "rein.bin", size: 4, mime: "x" });
    await vi.waitFor(() => expect(sentEvents.some((e) => e.kind === "file-accept")).toBe(true));
    manager.handleChunk(makeChunkBuffer("r", 0, new Uint8Array([1, 2])));
    manager.handleChunk(makeChunkBuffer("r", 1, new Uint8Array([3, 4])));
    manager.handle({ kind: "file-done", id: "r" });
    expect(statuses).toEqual([
      { id: "r", name: "rein.bin", direction: "receive", phase: "progress", percent: 0 },
      { id: "r", name: "rein.bin", direction: "receive", phase: "progress", percent: 50 },
      { id: "r", name: "rein.bin", direction: "receive", phase: "progress", percent: 100 },
      { id: "r", name: "rein.bin", direction: "receive", phase: "done" },
    ]);
  });

  it("receive: the sharer aborts with file-error", async () => {
    manager.onIncomingOffer(() => Promise.resolve(true));
    manager.handle({ kind: "file-offer", id: "r", name: "rein.bin", size: 4, mime: "x" });
    await vi.waitFor(() => expect(sentEvents.some((e) => e.kind === "file-accept")).toBe(true));
    manager.handle({ kind: "file-error", id: "r", message: "disk full" });
    expect(statuses.at(-1)).toEqual({ id: "r", name: "rein.bin", direction: "receive", phase: "failed" });
  });

  it("receive: an incomplete transfer is reported as failed", async () => {
    manager.onIncomingOffer(() => Promise.resolve(true));
    manager.handle({ kind: "file-offer", id: "r", name: "rein.bin", size: 4, mime: "x" });
    await vi.waitFor(() => expect(sentEvents.some((e) => e.kind === "file-accept")).toBe(true));
    manager.handle({ kind: "file-done", id: "r" });
    expect(statuses.at(-1)).toEqual({ id: "r", name: "rein.bin", direction: "receive", phase: "failed" });
  });

  it("receive: a declined offer reports nothing (the helper chose it)", async () => {
    manager.onIncomingOffer(() => Promise.resolve(false));
    manager.handle({ kind: "file-offer", id: "r", name: "rein.bin", size: 4, mime: "x" });
    await vi.waitFor(() => expect(sentEvents.some((e) => e.kind === "file-reject")).toBe(true));
    expect(statuses).toEqual([]);
  });
});
