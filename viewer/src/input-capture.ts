import type { InputEvent, Modifier } from "./protocol.js";

const BUTTON_MAP: Record<number, "left" | "right" | "middle"> = {
  0: "left",
  1: "middle",
  2: "right",
};

/** One remote wheel notch on the wire, in pixels — the sharer converts with
 *  `trunc(dy / 120)` and skips the scroll entirely when that is 0, so only
 *  whole multiples of this may ever be emitted. */
const WHEEL_NOTCH_PX = 120;

/** DOM_DELTA_LINE → px. Browsers emit 3 lines per physical wheel notch and
 *  one notch must map to one 120-px wire notch, so a line is 40 px here —
 *  deliberately NOT the ~16-px typographic line: this is wheel calibration,
 *  not text layout. */
const LINE_PX = WHEEL_NOTCH_PX / 3;

/** DOM_DELTA_PAGE → px: one page scrolls like 10 wheel notches. */
const PAGE_PX = WHEEL_NOTCH_PX * 10;

/** Mirrors the sharer's ±100-line clamp — anything larger would be dropped
 *  there anyway, so the excess is discarded instead of accumulated. */
const MAX_NOTCHES_PER_EVENT = 100;

const NO_MODIFIERS: Modifier = { shift: false, ctrl: false, alt: false, meta: false };

function modifiers(e: KeyboardEvent | PointerEvent): Modifier {
  return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export interface ContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The sub-rectangle of the video ELEMENT that actually shows content under
 * `object-fit: contain`. The element box is the fixed 16:9 wrapper; a
 * non-16:9 share is letter-/pillarboxed inside it, so pointer coordinates
 * must be normalized against this content box — otherwise clicks land offset
 * on the remote machine. Falls back to the element box while the video's
 * intrinsic size is still unknown (metadata not loaded).
 */
export function videoContentRect(
  rect: { left: number; top: number; width: number; height: number },
  videoWidth: number,
  videoHeight: number,
): ContentRect {
  if (videoWidth <= 0 || videoHeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  };
}

/**
 * The layout-resolved character for a key event, or `undefined` for named
 * keys ("Enter", "Shift", "Dead", …). W3C `code` names US-layout positions —
 * a QWERTZ helper's Z key is `KeyY` — so the sharer needs `key` to type what
 * the helper actually sees; it must not receive named keys as text.
 */
export function printableKey(key: string): string | undefined {
  return [...key].length === 1 ? key : undefined;
}

function keyEvent(ev: KeyboardEvent, pressed: boolean): InputEvent {
  const key = printableKey(ev.key);
  return {
    kind: "key",
    code: ev.code,
    ...(key === undefined ? {} : { key }),
    pressed,
    modifiers: modifiers(ev),
  };
}

export class InputCapture {
  private enabled = false;
  private handlers: Array<{ type: string; handler: EventListener }> = [];

  // Everything we've forwarded a press for without a matching release.
  // disable() and pointercancel synthesize the releases — otherwise the
  // remote OS keeps the button/key held (mid-session variant of gh #97).
  private heldButtons = new Set<"left" | "right" | "middle">();
  private heldKeys = new Set<string>();
  // Window-level: a keyup after Alt-Tab lands in the other window, so the
  // held key would stay pressed on the shared machine until the session ends.
  private onWindowBlur: EventListener | null = null;

  private wheelAccX = 0;
  private wheelAccY = 0;

  constructor(
    private video: HTMLVideoElement,
    private emit: (event: InputEvent) => void,
  ) {}

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.video.tabIndex = 0;

    // requestAnimationFrame throttle for pointermove. Without this, a
    // 1000 Hz mouse floods the input data channel with JSON-serialized
    // mouse-move events; the SCTP stream serializes them and the sharer's
    // enigo apply-loop becomes the bottleneck. Coalescing to one emit per
    // animation frame (~60 Hz) keeps the cursor visibly smooth while
    // cutting the message rate 16x. Buttons/keys/wheel stay immediate —
    // they're rare and non-coalescable.
    let pendingMove: { x: number; y: number } | null = null;
    let movePending = false;
    const flushMove = (): void => {
      movePending = false;
      // Re-check enabled at flush time. A pointermove queued microseconds
      // before disable() runs would otherwise still fire on the next rAF
      // tick and leak a coordinate the user already cancelled.
      if (!this.enabled || pendingMove === null) {
        pendingMove = null;
        return;
      }
      const { x, y } = pendingMove;
      pendingMove = null;
      this.emit({ kind: "mouse-move", x, y });
    };
    const onMove = (e: Event): void => {
      const ev = e as PointerEvent;
      const rect = this.video.getBoundingClientRect();
      const content = videoContentRect(rect, this.video.videoWidth, this.video.videoHeight);
      if (content.width <= 0 || content.height <= 0) return;
      pendingMove = {
        x: clamp01((ev.clientX - content.left) / content.width),
        y: clamp01((ev.clientY - content.top) / content.height),
      };
      if (!movePending) {
        movePending = true;
        requestAnimationFrame(flushMove);
      }
    };

    const onDown = (e: Event): void => {
      const ev = e as PointerEvent;
      const button = BUTTON_MAP[ev.button];
      if (button === undefined) return;
      // Capture the pointer so the matching pointerup reaches us even when
      // the user releases outside the video (drag toward the viewport edge,
      // over the overlaid toolbar) — without it no release is forwarded and
      // the remote OS keeps the button held until session teardown.
      if (typeof this.video.setPointerCapture === "function") {
        try {
          this.video.setPointerCapture(ev.pointerId);
        } catch {
          // Spec-allowed NotFoundError for an already-inactive pointer;
          // the pointercancel/lostpointercapture handlers cover the
          // release in that case.
        }
      }
      this.emit({ kind: "mouse-button", button, pressed: true });
      this.heldButtons.add(button);
    };

    const onUp = (e: Event): void => {
      const ev = e as PointerEvent;
      const button = BUTTON_MAP[ev.button];
      if (button === undefined) return;
      this.emit({ kind: "mouse-button", button, pressed: false });
      this.heldButtons.delete(button);
    };

    // No further pointerup will be delivered for this pointer (touch
    // cancelled, capture lost, element detached) — synthesize the releases
    // so the remote side doesn't keep buttons held.
    const onPointerGone = (): void => {
      this.releaseHeldButtons();
    };

    const onWheel = (e: Event): void => {
      const ev = e as WheelEvent;
      ev.preventDefault();
      const scale =
        ev.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? LINE_PX
          : ev.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? PAGE_PX
            : 1;
      const dxPx = ev.deltaX * scale;
      const dyPx = ev.deltaY * scale;
      if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;
      this.wheelAccX += dxPx;
      this.wheelAccY += dyPx;
      const dx = this.takeWholeNotches("wheelAccX");
      const dy = this.takeWholeNotches("wheelAccY");
      if (dx !== 0 || dy !== 0) {
        this.emit({ kind: "scroll", dx, dy });
      }
    };

    const onKeyDown = (e: Event): void => {
      const ev = e as KeyboardEvent;
      ev.preventDefault();
      // Escape is the advertised local off-switch ("Esc zum Beenden"):
      // ui.ts disables capture on its document-level keydown right after
      // this handler, so a forwarded Escape press could never be released
      // and would stay held on the shared machine — and it would also
      // dismiss dialogs over there. Never forward it.
      if (ev.code === "Escape") return;
      this.emit(keyEvent(ev, true));
      this.heldKeys.add(ev.code);
    };

    const onKeyUp = (e: Event): void => {
      const ev = e as KeyboardEvent;
      ev.preventDefault();
      if (ev.code === "Escape") return;
      this.emit(keyEvent(ev, false));
      this.heldKeys.delete(ev.code);
    };

    this.bind("pointermove", onMove);
    this.bind("pointerdown", onDown);
    this.bind("pointerup", onUp);
    this.bind("pointercancel", onPointerGone);
    this.bind("lostpointercapture", onPointerGone);
    this.bind("wheel", onWheel);
    this.bind("keydown", onKeyDown);
    this.bind("keyup", onKeyUp);

    const onBlur = (): void => this.releaseEverything();
    window.addEventListener("blur", onBlur);
    this.onWindowBlur = onBlur;
  }

  disable(): void {
    this.enabled = false;
    // Release before detaching, while the input channel is still up:
    // teardown calls disable() before closing the peer, and the Esc-to-stop
    // path removes the listeners before the user's keyup can arrive.
    this.releaseEverything();
    for (const { type, handler } of this.handlers) {
      this.video.removeEventListener(type, handler);
    }
    this.handlers = [];
    if (this.onWindowBlur) {
      window.removeEventListener("blur", this.onWindowBlur);
      this.onWindowBlur = null;
    }
    this.wheelAccX = 0;
    this.wheelAccY = 0;
  }

  /** Forward a release for every button and key still held. */
  private releaseEverything(): void {
    this.releaseHeldButtons();
    for (const code of this.heldKeys) {
      this.emit({ kind: "key", code, pressed: false, modifiers: NO_MODIFIERS });
    }
    this.heldKeys.clear();
  }

  private releaseHeldButtons(): void {
    for (const button of this.heldButtons) {
      this.emit({ kind: "mouse-button", button, pressed: false });
    }
    this.heldButtons.clear();
  }

  /** Drain whole 120-px notches from a wheel accumulator, keeping the
   *  sub-notch remainder; a clamped (malicious/buggy) burst discards its
   *  excess instead of replaying it on later events. */
  private takeWholeNotches(axis: "wheelAccX" | "wheelAccY"): number {
    const notches = Math.trunc(this[axis] / WHEEL_NOTCH_PX);
    if (notches === 0) return 0;
    if (Math.abs(notches) >= MAX_NOTCHES_PER_EVENT) {
      this[axis] = 0;
      return Math.sign(notches) * MAX_NOTCHES_PER_EVENT * WHEEL_NOTCH_PX;
    }
    this[axis] -= notches * WHEEL_NOTCH_PX;
    return notches * WHEEL_NOTCH_PX;
  }

  private bind(type: string, handler: EventListener): void {
    this.video.addEventListener(type, handler, { passive: false });
    this.handlers.push({ type, handler });
  }
}
