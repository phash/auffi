import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileTransferManager, sanitizeFilename, sanitizeMime } from "../src/file-transfer.js";
import type { FileEvent } from "../src/protocol.js";

describe("sanitizeMime", () => {
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
});
