import { describe, it, expect } from "vitest";
import {
  SessionTracker,
  formatDuration,
  formatFileSize,
  formatConnectionType,
} from "../src/session-summary.js";

describe("SessionTracker (gh #73)", () => {
  it("starts not-live until markStreamStarted is called", () => {
    const t = new SessionTracker();
    expect(t.isLive()).toBe(false);
    expect(t.summary()).toBeNull();
  });

  it("isLive flips after markStreamStarted", () => {
    let now = 1_000;
    const t = new SessionTracker(() => now);
    t.markStreamStarted();
    expect(t.isLive()).toBe(true);
  });

  it("only records the first start time even if called multiple times", () => {
    let now = 1_000;
    const t = new SessionTracker(() => now);
    t.markStreamStarted();
    now = 5_000;
    t.markStreamStarted();
    now = 10_000;
    t.markEnded();
    expect(t.summary()!.durationMs).toBe(9_000);
  });

  it("captures connection type", () => {
    let now = 1_000;
    const t = new SessionTracker(() => now);
    t.markStreamStarted();
    t.setConnectionType("p2p");
    expect(t.summary()!.connectionType).toBe("p2p");
  });

  it("captures received files in order", () => {
    let now = 1_000;
    const t = new SessionTracker(() => now);
    t.markStreamStarted();
    t.recordReceivedFile({ name: "a.png", size: 100 });
    t.recordReceivedFile({ name: "b.txt", size: 2048 });
    expect(t.summary()!.receivedFiles).toEqual([
      { name: "a.png", size: 100 },
      { name: "b.txt", size: 2048 },
    ]);
  });

  it("summary() returns a copy of receivedFiles — mutating it doesn't mutate the tracker", () => {
    let now = 1_000;
    const t = new SessionTracker(() => now);
    t.markStreamStarted();
    t.recordReceivedFile({ name: "a.png", size: 100 });
    const s = t.summary()!;
    s.receivedFiles.push({ name: "tampered.txt", size: 0 });
    expect(t.summary()!.receivedFiles).toHaveLength(1);
  });

  it("durationMs floors at 0 (defensive against clock skew)", () => {
    let now = 1_000;
    const t = new SessionTracker(() => now);
    t.markStreamStarted();
    now = 500; // clock went backwards
    t.markEnded();
    expect(t.summary()!.durationMs).toBe(0);
  });

  it("if markEnded never fires, summary uses 'now' for duration", () => {
    let now = 1_000;
    const t = new SessionTracker(() => now);
    t.markStreamStarted();
    now = 3_500;
    expect(t.summary()!.durationMs).toBe(2_500);
  });
});

describe("formatDuration", () => {
  it("under a minute shows only seconds", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(999)).toBe("0 s");
    expect(formatDuration(45_500)).toBe("45 s");
  });

  it("zero-pads seconds when minutes are present", () => {
    expect(formatDuration(60_000)).toBe("1 min 00 s");
    expect(formatDuration(65_000)).toBe("1 min 05 s");
    expect(formatDuration(12 * 60_000 + 34_000)).toBe("12 min 34 s");
  });
});

describe("formatFileSize", () => {
  it("uses B / kB / MB depending on magnitude", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 kB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.00 MB");
  });
});

describe("formatConnectionType", () => {
  it("renders user-friendly labels", () => {
    expect(formatConnectionType("p2p")).toBe("Direkt (peer-to-peer)");
    expect(formatConnectionType("relay")).toBe("Über Relay-Server");
    expect(formatConnectionType(null)).toBe("Unbekannt");
  });
});
