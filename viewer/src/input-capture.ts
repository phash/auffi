import type { InputEvent, Modifier } from "./protocol.js";

const BUTTON_MAP: Record<number, "left" | "right" | "middle"> = {
  0: "left",
  1: "middle",
  2: "right",
};

function modifiers(e: KeyboardEvent | PointerEvent): Modifier {
  return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
}

export class InputCapture {
  private enabled = false;
  private handlers: Array<{ type: string; handler: EventListener }> = [];

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
    // mouse-move events; the unreliable SCTP stream serializes them and
    // the sharer's enigo apply-loop becomes the bottleneck. Coalescing
    // to one emit per animation frame (~60 Hz) keeps the cursor visibly
    // smooth while cutting the message rate 16x. Buttons/keys/wheel
    // stay immediate — they're rare and non-coalescable.
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
      pendingMove = {
        x: (ev.clientX - rect.left) / rect.width,
        y: (ev.clientY - rect.top) / rect.height,
      };
      if (!movePending) {
        movePending = true;
        requestAnimationFrame(flushMove);
      }
    };

    const onDown = (e: Event): void => {
      const ev = e as PointerEvent;
      const button = BUTTON_MAP[ev.button];
      if (button !== undefined) this.emit({ kind: "mouse-button", button, pressed: true });
    };

    const onUp = (e: Event): void => {
      const ev = e as PointerEvent;
      const button = BUTTON_MAP[ev.button];
      if (button !== undefined) this.emit({ kind: "mouse-button", button, pressed: false });
    };

    const onWheel = (e: Event): void => {
      const ev = e as WheelEvent;
      ev.preventDefault();
      this.emit({ kind: "scroll", dx: ev.deltaX, dy: ev.deltaY });
    };

    const onKeyDown = (e: Event): void => {
      const ev = e as KeyboardEvent;
      ev.preventDefault();
      this.emit({ kind: "key", code: ev.code, pressed: true, modifiers: modifiers(ev) });
    };

    const onKeyUp = (e: Event): void => {
      const ev = e as KeyboardEvent;
      ev.preventDefault();
      this.emit({ kind: "key", code: ev.code, pressed: false, modifiers: modifiers(ev) });
    };

    this.bind("pointermove", onMove);
    this.bind("pointerdown", onDown);
    this.bind("pointerup", onUp);
    this.bind("wheel", onWheel);
    this.bind("keydown", onKeyDown);
    this.bind("keyup", onKeyUp);
  }

  disable(): void {
    this.enabled = false;
    for (const { type, handler } of this.handlers) {
      this.video.removeEventListener(type, handler);
    }
    this.handlers = [];
  }

  private bind(type: string, handler: EventListener): void {
    this.video.addEventListener(type, handler, { passive: false });
    this.handlers.push({ type, handler });
  }
}
