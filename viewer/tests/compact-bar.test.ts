import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  CompactBarController,
  formatBytes,
  formatDuration,
} from "../src/compact-bar.js";

describe("formatDuration", () => {
  it("pads to mm:ss under one hour", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(1500)).toBe("00:01");
    expect(formatDuration(65_000)).toBe("01:05");
    expect(formatDuration(59 * 60 * 1000 + 59_000)).toBe("59:59");
  });
  it("switches to h:mm:ss past one hour", () => {
    expect(formatDuration(60 * 60 * 1000)).toBe("1:00:00");
    expect(formatDuration(3 * 60 * 60 * 1000 + 4 * 60 * 1000 + 5_000)).toBe(
      "3:04:05",
    );
  });
  it("clamps negative input to 00:00", () => {
    expect(formatDuration(-5_000)).toBe("00:00");
  });
});

describe("formatBytes", () => {
  it("returns raw bytes under 1 KiB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });
  it("uses KB up to 1 MiB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1500)).toBe("1.5 KB");
  });
  it("uses MB up to 1 GiB", () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
  it("uses GB past 1 GiB", () => {
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
  it("handles NaN / negative defensively", () => {
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(-100)).toBe("0 B");
  });
});

describe("CompactBarController", () => {
  let app: HTMLElement;
  let toggle: HTMLButtonElement;
  let durationEl: HTMLElement;
  let bytesEl: HTMLElement;
  let statusTextEl: HTMLElement;
  let getBytesMock: ReturnType<typeof vi.fn>;
  let controller: CompactBarController;

  beforeEach(() => {
    document.body.replaceChildren();
    app = document.createElement("div");
    app.id = "app";
    toggle = document.createElement("button");
    durationEl = document.createElement("span");
    bytesEl = document.createElement("span");
    statusTextEl = document.createElement("span");
    document.body.append(app, toggle, durationEl, bytesEl, statusTextEl);

    // jsdom 29 doesn't ship localStorage by default in our vitest
    // env — stub a Map-backed Storage so the controller's
    // persistence path still gets exercised.
    const store = new Map<string, string>();
    const stub: Storage = {
      get length() { return store.size; },
      clear: () => store.clear(),
      getItem: (k) => (store.has(k) ? store.get(k)! : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      key: (i) => Array.from(store.keys())[i] ?? null,
    };
    vi.stubGlobal("localStorage", stub);

    getBytesMock = vi.fn().mockResolvedValue(0);
    controller = new CompactBarController({
      app,
      toggle,
      durationEl,
      bytesEl,
      statusTextEl,
      getBytes: getBytesMock as () => Promise<number>,
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    controller.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("toggles #app.compact on click + flips aria-expanded", () => {
    expect(app.classList.contains("compact")).toBe(false);
    toggle.click();
    expect(app.classList.contains("compact")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Bereich ausklappen");
    toggle.click();
    expect(app.classList.contains("compact")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("persists collapsed-preference in localStorage", () => {
    toggle.click(); // collapse
    expect(localStorage.getItem("auffi.viewer.compactBar.collapsed")).toBe("1");
    toggle.click(); // expand
    expect(localStorage.getItem("auffi.viewer.compactBar.collapsed")).toBe("0");
  });

  it("restores collapsed-preference on start()", () => {
    localStorage.setItem("auffi.viewer.compactBar.collapsed", "1");
    controller.start();
    expect(app.classList.contains("compact")).toBe(true);
  });

  it("starts the duration timer and ticks once per second", async () => {
    controller.start();
    expect(durationEl.textContent).toBe("00:00");
    // advanceTimersByTimeAsync only fires the timers within the
    // window (vs runAllTimersAsync which would loop forever on the
    // 1 s setInterval).
    await vi.advanceTimersByTimeAsync(3_000);
    expect(durationEl.textContent).toBe("00:03");
  });

  it("renders bytes from getBytes() in the ticker", async () => {
    getBytesMock.mockResolvedValue(2 * 1024 * 1024);
    controller.start();
    // Initial tick fires synchronously inside start(); allow the
    // deferred bytes-poll promise to resolve.
    await vi.advanceTimersByTimeAsync(100);
    expect(bytesEl.textContent).toBe("2.0 MB");
  });

  it("stop() resets compact + the displayed values", () => {
    controller.start();
    toggle.click();
    expect(app.classList.contains("compact")).toBe(true);
    controller.stop();
    expect(app.classList.contains("compact")).toBe(false);
    expect(durationEl.textContent).toBe("00:00");
    expect(bytesEl.textContent).toBe("0 B");
  });

  it("setStatus() updates the text element", () => {
    controller.setStatus("Stream läuft.");
    expect(statusTextEl.textContent).toBe("Stream läuft.");
  });
});
