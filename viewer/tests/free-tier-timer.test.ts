import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FreeTierTimer } from "../src/free-tier-timer.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FreeTierTimer", () => {
  it("fires onWarning at the configured warningMs", () => {
    const timer = new FreeTierTimer({ warningMs: 500, cutoffMs: 1_000 });
    const onWarning = vi.fn();
    const onCutoff = vi.fn();

    timer.start({ onWarning, onCutoff });

    vi.advanceTimersByTime(499);
    expect(onWarning).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onWarning).toHaveBeenCalledOnce();
    expect(onCutoff).not.toHaveBeenCalled();
  });

  it("fires onCutoff at the configured cutoffMs", () => {
    const timer = new FreeTierTimer({ warningMs: 500, cutoffMs: 1_000 });
    const onWarning = vi.fn();
    const onCutoff = vi.fn();

    timer.start({ onWarning, onCutoff });

    vi.advanceTimersByTime(999);
    expect(onCutoff).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onCutoff).toHaveBeenCalledOnce();
  });

  it("stop cancels both pending timers", () => {
    const timer = new FreeTierTimer({ warningMs: 500, cutoffMs: 1_000 });
    const onWarning = vi.fn();
    const onCutoff = vi.fn();

    timer.start({ onWarning, onCutoff });
    timer.stop();

    vi.advanceTimersByTime(2_000);
    expect(onWarning).not.toHaveBeenCalled();
    expect(onCutoff).not.toHaveBeenCalled();
  });

  it("start is idempotent — does not register additional timers when called twice", () => {
    const timer = new FreeTierTimer({ warningMs: 500, cutoffMs: 1_000 });
    const onWarning = vi.fn();
    const onCutoff = vi.fn();
    const onWarning2 = vi.fn();
    const onCutoff2 = vi.fn();

    timer.start({ onWarning, onCutoff });
    timer.start({ onWarning: onWarning2, onCutoff: onCutoff2 });

    vi.advanceTimersByTime(1_000);

    expect(onWarning).toHaveBeenCalledOnce();
    expect(onCutoff).toHaveBeenCalledOnce();
    expect(onWarning2).not.toHaveBeenCalled();
    expect(onCutoff2).not.toHaveBeenCalled();
  });

  it("fires both warning and cutoff in order with default timings (8 min / 10 min)", () => {
    const timer = new FreeTierTimer();
    const order: string[] = [];

    timer.start({
      onWarning: () => order.push("warning"),
      onCutoff: () => order.push("cutoff"),
    });

    vi.advanceTimersByTime(8 * 60 * 1_000);
    expect(order).toEqual(["warning"]);

    vi.advanceTimersByTime(2 * 60 * 1_000);
    expect(order).toEqual(["warning", "cutoff"]);
  });

  it("stop after warning still cancels the cutoff timer", () => {
    const timer = new FreeTierTimer({ warningMs: 500, cutoffMs: 1_000 });
    const onWarning = vi.fn();
    const onCutoff = vi.fn();

    timer.start({ onWarning, onCutoff });

    vi.advanceTimersByTime(500);
    expect(onWarning).toHaveBeenCalledOnce();

    timer.stop();
    vi.advanceTimersByTime(500);
    expect(onCutoff).not.toHaveBeenCalled();
  });
});
