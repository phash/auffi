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

    const onMove = (e: Event): void => {
      const ev = e as PointerEvent;
      const rect = this.video.getBoundingClientRect();
      const x = (ev.clientX - rect.left) / rect.width;
      const y = (ev.clientY - rect.top) / rect.height;
      this.emit({ kind: "mouse-move", x, y });
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
