import { describe, it, expect, vi } from "vitest";
import { InputCapture, printableKey, videoContentRect } from "../src/input-capture.js";

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
    new InputCapture(video, emit);
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

  // The sharer converts dy → wheel notches via trunc(dy / 120) and skips the
  // scroll when the result is 0 — so the viewer must only emit whole 120-px
  // notches and accumulate everything smaller (trackpad pixel streams,
  // Firefox line-mode events, Chrome's 100-px notches).
  it("normalizes DOM_DELTA_LINE wheel events so one 3-line notch becomes one 120-px notch", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE }));
    expect(emit).toHaveBeenCalledWith({ kind: "scroll", dx: 0, dy: 120 });
  });

  it("accumulates sub-notch pixel deltas until a whole notch is reached", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 60 }));
    expect(emit).not.toHaveBeenCalled();
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 60 }));
    expect(emit).toHaveBeenCalledExactlyOnceWith({ kind: "scroll", dx: 0, dy: 120 });
  });

  it("keeps the sub-notch remainder after emitting whole notches", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 300 }));
    expect(emit).toHaveBeenCalledExactlyOnceWith({ kind: "scroll", dx: 0, dy: 240 });
    // 60 px remainder + 60 px → next whole notch.
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 60 }));
    expect(emit).toHaveBeenLastCalledWith({ kind: "scroll", dx: 0, dy: 120 });
  });

  it("accumulates negative deltas symmetrically", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: -100 }));
    expect(emit).not.toHaveBeenCalled();
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: -100 }));
    expect(emit).toHaveBeenCalledExactlyOnceWith({ kind: "scroll", dx: 0, dy: -120 });
  });

  it("clamps a huge wheel delta to 100 notches and drops the excess", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 1e9 }));
    expect(emit).toHaveBeenCalledExactlyOnceWith({ kind: "scroll", dx: 0, dy: 100 * 120 });
    // The excess must not linger in the accumulator: the next notch is exact.
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 120 }));
    expect(emit).toHaveBeenLastCalledWith({ kind: "scroll", dx: 0, dy: 120 });
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("ignores non-finite wheel deltas without polluting the accumulator", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    // The WheelEvent constructor (WebIDL double) rejects non-finite values,
    // so inject one the way a hostile/buggy dispatcher could: via property
    // override on a real event object.
    const ev = new WheelEvent("wheel", { deltaX: 0, deltaY: 0 });
    Object.defineProperty(ev, "deltaY", { value: Infinity });
    video.dispatchEvent(ev);
    expect(emit).not.toHaveBeenCalled();
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 120 }));
    expect(emit).toHaveBeenCalledExactlyOnceWith({ kind: "scroll", dx: 0, dy: 120 });
  });

  it("forwards horizontal wheel deltas in whole notches too", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new WheelEvent("wheel", { deltaX: 240, deltaY: 0 }));
    expect(emit).toHaveBeenCalledExactlyOnceWith({ kind: "scroll", dx: 240, dy: 0 });
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

  // W3C `code` is a US-layout position name; a QWERTZ helper's Z key is
  // `KeyY`. The layout-resolved `key` travels alongside so the sharer types
  // what the helper sees on the cap — but only for single printable chars,
  // named keys ("Enter", "Dead", "Shift") keep the code-only shape.
  it("adds the layout-resolved key for printable characters", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyY", key: "z" }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "key", code: "KeyY", key: "z", pressed: true }));
    video.dispatchEvent(new KeyboardEvent("keyup", { code: "Quote", key: "ä" }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "key", code: "Quote", key: "ä", pressed: false }));
  });

  it("omits key for named keys and dead keys", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter", key: "Enter" }));
    video.dispatchEvent(new KeyboardEvent("keydown", { code: "Quote", key: "Dead" }));
    for (const call of emit.mock.calls) {
      expect(call[0]).not.toHaveProperty("key");
    }
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("printableKey accepts exactly one code point", () => {
    expect(printableKey("z")).toBe("z");
    expect(printableKey("ß")).toBe("ß");
    expect(printableKey("😀")).toBe("😀");
    expect(printableKey(" ")).toBe(" ");
    expect(printableKey("Enter")).toBeUndefined();
    expect(printableKey("Dead")).toBeUndefined();
    expect(printableKey("")).toBeUndefined();
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

  it("captures the pointer on pointerdown so releases outside the video still arrive", () => {
    const video = makeVideo();
    const setPointerCapture = vi.fn();
    (video as HTMLVideoElement & { setPointerCapture: (id: number) => void }).setPointerCapture = setPointerCapture;
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 7 }));
    expect(setPointerCapture).toHaveBeenCalledWith(7);
  });

  it("does not capture the pointer for unmapped buttons", () => {
    const video = makeVideo();
    const setPointerCapture = vi.fn();
    (video as HTMLVideoElement & { setPointerCapture: (id: number) => void }).setPointerCapture = setPointerCapture;
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new PointerEvent("pointerdown", { button: 5, pointerId: 7 }));
    expect(setPointerCapture).not.toHaveBeenCalled();
  });

  it("synthesizes button releases on pointercancel", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    emit.mockClear();
    video.dispatchEvent(new PointerEvent("pointercancel"));
    expect(emit).toHaveBeenCalledExactlyOnceWith({ kind: "mouse-button", button: "left", pressed: false });
    // The held-set is cleared — a second cancel must not re-release.
    emit.mockClear();
    video.dispatchEvent(new PointerEvent("pointercancel"));
    expect(emit).not.toHaveBeenCalled();
  });

  it("synthesizes button releases on lostpointercapture", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new PointerEvent("pointerdown", { button: 2 }));
    emit.mockClear();
    video.dispatchEvent(new Event("lostpointercapture"));
    expect(emit).toHaveBeenCalledExactlyOnceWith({ kind: "mouse-button", button: "right", pressed: false });
  });

  it("does not synthesize a release after a normal pointerup already released", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    video.dispatchEvent(new PointerEvent("pointerup", { button: 0 }));
    emit.mockClear();
    // Browsers fire lostpointercapture after the pointerup that ends an
    // implicit capture — that must not produce a duplicate release.
    video.dispatchEvent(new Event("lostpointercapture"));
    expect(emit).not.toHaveBeenCalled();
  });

  // Escape is the advertised local off-switch ("Esc zum Beenden"): ui.ts
  // disables capture on the document-level keydown right after this event, so
  // a forwarded Escape press could never be released and would stay held on
  // the shared machine for the rest of the stream.
  it("never forwards Escape (local off-switch, would stick remotely)", () => {
    const video = makeVideo();
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    video.dispatchEvent(new KeyboardEvent("keyup", { code: "Escape" }));
    expect(emit).not.toHaveBeenCalled();
    document.body.removeChild(video);
  });

  it("disable() releases everything still held before detaching (buttons + keys)", () => {
    const video = makeVideo();
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    video.dispatchEvent(new KeyboardEvent("keydown", { code: "ShiftLeft", shiftKey: true }));
    emit.mockClear();
    cap.disable();
    expect(emit).toHaveBeenCalledWith({ kind: "mouse-button", button: "left", pressed: false });
    expect(emit).toHaveBeenCalledWith({
      kind: "key", code: "ShiftLeft", pressed: false,
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    });
    expect(emit).toHaveBeenCalledTimes(2);
    // Second disable must not re-release.
    emit.mockClear();
    cap.disable();
    expect(emit).not.toHaveBeenCalled();
    document.body.removeChild(video);
  });

  it("does not release keys on disable that already got their keyup", () => {
    const video = makeVideo();
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
    video.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyA" }));
    emit.mockClear();
    cap.disable();
    expect(emit).not.toHaveBeenCalled();
    document.body.removeChild(video);
  });
});

describe("videoContentRect", () => {
  // With object-fit: contain the video ELEMENT box is the 16:9 wrapper while
  // the CONTENT is letterboxed inside — pointer coordinates must be
  // normalized against the content box or clicks land offset on non-16:9
  // shares.
  it("matches the element box when aspect ratios agree", () => {
    const rect = { left: 10, top: 20, width: 960, height: 540 };
    expect(videoContentRect(rect, 1920, 1080)).toEqual({ left: 10, top: 20, width: 960, height: 540 });
  });

  it("pillarboxes a 4:3 video inside a 16:9 element box", () => {
    const rect = { left: 0, top: 0, width: 960, height: 540 };
    // scale = min(960/1600, 540/1200) = 0.45 → 720 × 540, centered → left 120.
    expect(videoContentRect(rect, 1600, 1200)).toEqual({ left: 120, top: 0, width: 720, height: 540 });
  });

  it("letterboxes a 16:10 video inside a 16:9 element box", () => {
    const rect = { left: 0, top: 0, width: 960, height: 540 };
    // scale = min(960/1920, 540/1200) = 0.45 → 864 × 540, centered → left 48.
    expect(videoContentRect(rect, 1920, 1200)).toEqual({ left: 48, top: 0, width: 864, height: 540 });
  });

  it("falls back to the element box while video metadata is missing", () => {
    const rect = { left: 5, top: 5, width: 960, height: 540 };
    expect(videoContentRect(rect, 0, 0)).toEqual(rect);
  });
});

describe("InputCapture — non-16:9 coordinate mapping", () => {
  it("normalizes pointer coordinates against the letterboxed content box", async () => {
    // 4:3 source in a 960×540 element: content is 720×540 at left offset 120.
    const video = makeVideo(1600, 1200);
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}) });
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 480, clientY: 270 }));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    expect(emit).toHaveBeenCalledWith({ kind: "mouse-move", x: 0.5, y: 0.5 });
    document.body.removeChild(video);
  });

  it("clamps coordinates in the pillarbox bars to the content edge", async () => {
    const video = makeVideo(1600, 1200);
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}) });
    // 60 px into the left pillarbox bar (content starts at 120).
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 60, clientY: 270 }));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    expect(emit).toHaveBeenCalledWith({ kind: "mouse-move", x: 0, y: 0.5 });
    document.body.removeChild(video);
  });
});

describe("InputCapture: losing window focus releases what is held", () => {
  // Alt-Tab, a notification, clicking another monitor: the keyup for a key
  // held at that moment goes to the other window. The shared machine kept the
  // key (or mouse button) pressed until the session ended.
  it("synthesizes releases for held keys and buttons on window blur", () => {
    const video = makeVideo();
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    video.dispatchEvent(new KeyboardEvent("keydown", { code: "AltLeft", altKey: true }));
    emit.mockClear();
    window.dispatchEvent(new Event("blur"));
    expect(emit).toHaveBeenCalledWith({ kind: "mouse-button", button: "left", pressed: false });
    expect(emit).toHaveBeenCalledWith({
      kind: "key", code: "AltLeft", pressed: false,
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    });
    expect(emit).toHaveBeenCalledTimes(2);
    // Nothing is held any more, so disable() has nothing left to release.
    emit.mockClear();
    cap.disable();
    expect(emit).not.toHaveBeenCalled();
    document.body.removeChild(video);
  });

  it("stops listening for blur once disabled", () => {
    const video = makeVideo();
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    cap.disable();
    emit.mockClear();
    window.dispatchEvent(new Event("blur"));
    expect(emit).not.toHaveBeenCalled();
    document.body.removeChild(video);
  });
});
