import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createIceStateHandler, DEFAULT_ICE_DISCONNECTED_GRACE_MS } from "../src/ice-state-handler.js";

describe("createIceStateHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tears down immediately on 'failed'", () => {
    const teardown = vi.fn();
    const setStatus = vi.fn();
    const handler = createIceStateHandler({ teardown, setStatus, isStreaming: () => true });

    handler.handle("failed");
    expect(teardown).toHaveBeenCalledWith("Verbindung verloren.", "err", true);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("tears down immediately on 'closed'", () => {
    const teardown = vi.fn();
    const setStatus = vi.fn();
    const handler = createIceStateHandler({ teardown, setStatus, isStreaming: () => true });

    handler.handle("closed");
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("does NOT tear down immediately on 'disconnected' — only after the grace window", () => {
    const teardown = vi.fn();
    const setStatus = vi.fn();
    const handler = createIceStateHandler({ teardown, setStatus, isStreaming: () => true });

    handler.handle("disconnected");
    expect(teardown).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith(
      "Verbindung instabil — versuche, sie wiederherzustellen…",
      "info",
    );
    expect(handler.isPending()).toBe(true);

    vi.advanceTimersByTime(DEFAULT_ICE_DISCONNECTED_GRACE_MS - 1);
    expect(teardown).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(teardown).toHaveBeenCalledWith("Verbindung verloren.", "err", true);
    expect(handler.isPending()).toBe(false);
  });

  it("recovers if state returns to 'connected' within the grace window", () => {
    const teardown = vi.fn();
    const setStatus = vi.fn();
    const handler = createIceStateHandler({ teardown, setStatus, isStreaming: () => true });

    handler.handle("disconnected");
    expect(handler.isPending()).toBe(true);

    vi.advanceTimersByTime(5_000);
    handler.handle("connected");

    expect(handler.isPending()).toBe(false);
    expect(setStatus).toHaveBeenLastCalledWith("Stream läuft.", "ok");

    // Advance well past the original grace window to prove the timer was
    // genuinely cancelled, not just refreshed.
    vi.advanceTimersByTime(60_000);
    expect(teardown).not.toHaveBeenCalled();
  });

  it("recovers on 'completed' the same way as 'connected'", () => {
    const teardown = vi.fn();
    const setStatus = vi.fn();
    const handler = createIceStateHandler({ teardown, setStatus, isStreaming: () => true });

    handler.handle("disconnected");
    handler.handle("completed");
    expect(handler.isPending()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(teardown).not.toHaveBeenCalled();
  });

  it("does not stack multiple grace timers if 'disconnected' fires repeatedly", () => {
    const teardown = vi.fn();
    const setStatus = vi.fn();
    const handler = createIceStateHandler({ teardown, setStatus, isStreaming: () => true });

    handler.handle("disconnected");
    handler.handle("disconnected");
    handler.handle("disconnected");

    vi.advanceTimersByTime(DEFAULT_ICE_DISCONNECTED_GRACE_MS + 100);
    // Only one teardown call — repeated 'disconnected' must not extend or
    // duplicate the timer.
    expect(teardown).toHaveBeenCalledTimes(1);
    // setStatus was only called once with the "instabil" message.
    expect(setStatus).toHaveBeenCalledTimes(1);
  });

  it("does not call setStatus 'Stream läuft.' on a fresh 'connected' (only on recovery)", () => {
    const teardown = vi.fn();
    const setStatus = vi.fn();
    const handler = createIceStateHandler({ teardown, setStatus, isStreaming: () => true });

    handler.handle("connected");
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("clear() cancels a pending grace timer", () => {
    const teardown = vi.fn();
    const setStatus = vi.fn();
    const handler = createIceStateHandler({ teardown, setStatus, isStreaming: () => true });

    handler.handle("disconnected");
    expect(handler.isPending()).toBe(true);
    handler.clear();
    expect(handler.isPending()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(teardown).not.toHaveBeenCalled();
  });

  it("ignores benign intermediate states like 'checking' and 'new'", () => {
    const teardown = vi.fn();
    const setStatus = vi.fn();
    const handler = createIceStateHandler({ teardown, setStatus, isStreaming: () => true });

    handler.handle("new");
    handler.handle("checking");
    expect(teardown).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  // ICE failing before a single frame arrived is the blocked-network case
  // (P2P impossible, TURN unreachable). "Verbindung verloren." suggested a
  // working connection had dropped; the firewall hint says what to try.
  describe("before the first frame", () => {
    const FIREWALL = "Verbindung konnte nicht hergestellt werden. Falls du in einem Firmen- oder Hochschulnetz bist";

    it("'failed' shows the firewall hint", () => {
      const teardown = vi.fn();
      const handler = createIceStateHandler({ teardown, setStatus: vi.fn(), isStreaming: () => false });
      handler.handle("failed");
      expect(teardown).toHaveBeenCalledWith(expect.stringContaining(FIREWALL), "err", true);
    });

    it("an expired disconnected-grace shows the firewall hint", () => {
      const teardown = vi.fn();
      const handler = createIceStateHandler({ teardown, setStatus: vi.fn(), isStreaming: () => false });
      handler.handle("disconnected");
      vi.advanceTimersByTime(DEFAULT_ICE_DISCONNECTED_GRACE_MS);
      expect(teardown).toHaveBeenCalledWith(expect.stringContaining(FIREWALL), "err", true);
    });
  });
});
