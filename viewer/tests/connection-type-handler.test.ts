import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConnectionTypeHandler } from "../src/connection-type-handler.js";
import { FreeTierTimer } from "../src/free-tier-timer.js";

const WARNING_MS = 100;
const CUTOFF_MS = 200;

function makeHandler() {
  const onWarning = vi.fn();
  const onCutoff = vi.fn();
  const onLeftRelay = vi.fn();
  const handler = createConnectionTypeHandler(
    { onWarning, onCutoff, onLeftRelay },
    () => new FreeTierTimer({ warningMs: WARNING_MS, cutoffMs: CUTOFF_MS }),
  );
  return { handler, onWarning, onCutoff, onLeftRelay };
}

describe("createConnectionTypeHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the free-tier timer on relay: warning then cutoff fire", () => {
    const { handler, onWarning, onCutoff } = makeHandler();
    handler.handle("relay");
    vi.advanceTimersByTime(WARNING_MS + 1);
    expect(onWarning).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CUTOFF_MS);
    expect(onCutoff).toHaveBeenCalledTimes(1);
  });

  it("stops the timer on relay→p2p — no cutoff for a now-direct session", () => {
    const { handler, onCutoff, onLeftRelay } = makeHandler();
    handler.handle("relay");
    handler.handle("p2p");
    expect(onLeftRelay).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CUTOFF_MS * 5);
    expect(onCutoff).not.toHaveBeenCalled();
  });

  it("does not leak the old timer on relay→p2p→relay (single cutoff, on the new schedule)", () => {
    const { handler, onCutoff } = makeHandler();
    handler.handle("relay");
    vi.advanceTimersByTime(50);
    handler.handle("p2p");
    handler.handle("relay");
    // The first timer, were it leaked, would fire at t=200 (150 from here).
    vi.advanceTimersByTime(160);
    expect(onCutoff).not.toHaveBeenCalled();
    // The active timer fires at 200 ms after the re-entry.
    vi.advanceTimersByTime(50);
    expect(onCutoff).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels a running timer (teardown path)", () => {
    const { handler, onWarning, onCutoff } = makeHandler();
    handler.handle("relay");
    handler.stop();
    vi.advanceTimersByTime(CUTOFF_MS * 5);
    expect(onWarning).not.toHaveBeenCalled();
    expect(onCutoff).not.toHaveBeenCalled();
  });

  it("plain p2p fires onLeftRelay and never schedules anything", () => {
    const { handler, onWarning, onCutoff, onLeftRelay } = makeHandler();
    handler.handle("p2p");
    expect(onLeftRelay).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CUTOFF_MS * 5);
    expect(onWarning).not.toHaveBeenCalled();
    expect(onCutoff).not.toHaveBeenCalled();
  });
});
