import { describe, it, expect, vi } from "vitest";
import { InputCapture } from "../src/input-capture.js";

function makeVideo(width = 1920, height = 1080): HTMLVideoElement {
  const v = document.createElement("video");
  Object.defineProperty(v, "videoWidth", { value: width });
  Object.defineProperty(v, "videoHeight", { value: height });
  Object.defineProperty(v, "clientWidth", { value: 960 });
  Object.defineProperty(v, "clientHeight", { value: 540 });
  return v;
}

describe("InputCapture", () => {
  it("emits normalized mouse-move on pointermove when enabled (rAF-throttled)", async () => {
    const video = makeVideo();
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}) });
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 480, clientY: 270 }));
    // Coalesced — flushed on next animation frame.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    expect(emit).toHaveBeenCalledWith({ kind: "mouse-move", x: 0.5, y: 0.5 });
    document.body.removeChild(video);
  });

  it("coalesces a burst of pointermoves into one emit per frame", async () => {
    const video = makeVideo();
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    // Five rapid moves — the rAF-throttle should only emit the LAST one.
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, clientY: 10 }));
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 20, clientY: 20 }));
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 30, clientY: 30 }));
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 40, clientY: 40 }));
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 50, clientY: 50 }));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ kind: "mouse-move", x: 0.5, y: 0.5 });
    document.body.removeChild(video);
  });

  it("ignores events when disabled", async () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 100, clientY: 100 }));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits mouse-button on pointerdown/up with correct button mapping", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    expect(emit).toHaveBeenCalledWith({ kind: "mouse-button", button: "left", pressed: true });
    video.dispatchEvent(new PointerEvent("pointerup", { button: 2 }));
    expect(emit).toHaveBeenCalledWith({ kind: "mouse-button", button: "right", pressed: false });
  });

  it("emits scroll on wheel events", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 120 }));
    expect(emit).toHaveBeenCalledWith({ kind: "scroll", dx: 0, dy: 120 });
  });

  it("emits key events with modifiers when video has focus", () => {
    const video = makeVideo();
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.focus();
    video.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", shiftKey: true }));
    expect(emit).toHaveBeenCalledWith({
      kind: "key", code: "KeyA", pressed: true,
      modifiers: { shift: true, ctrl: false, alt: false, meta: false },
    });
    document.body.removeChild(video);
  });

  it("does NOT flush a pointermove that was queued just before disable()", async () => {
    // The rAF-throttle queues the latest pointermove and flushes it on
    // the next animation frame. If disable() runs between enqueue and
    // flush, the flushed event would otherwise leak a coordinate the
    // user already cancelled.
    const video = makeVideo();
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 50, clientY: 50 }));
    // disable BEFORE the rAF tick fires:
    cap.disable();
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    expect(emit).not.toHaveBeenCalled();
    document.body.removeChild(video);
  });

  it("stops emitting after disable is called", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    cap.disable();
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 100, clientY: 100 }));
    video.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 120 }));
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits middle-button mapping correctly", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new PointerEvent("pointerdown", { button: 1 }));
    expect(emit).toHaveBeenCalledWith({ kind: "mouse-button", button: "middle", pressed: true });
  });

  it("emits keyup events with pressed: false", () => {
    const video = makeVideo();
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyZ", ctrlKey: true }));
    expect(emit).toHaveBeenCalledWith({
      kind: "key", code: "KeyZ", pressed: false,
      modifiers: { shift: false, ctrl: true, alt: false, meta: false },
    });
    document.body.removeChild(video);
  });

  it("does not emit mouse-button for unmapped button index", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new PointerEvent("pointerdown", { button: 5 }));
    video.dispatchEvent(new PointerEvent("pointerup", { button: 5 }));
    expect(emit).not.toHaveBeenCalled();
  });

  it("calling enable twice does not double-register handlers", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    cap.enable();
    video.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
