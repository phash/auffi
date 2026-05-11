# Screenie Phase 3 — Remote-Control + Dateitransfer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan.

**Goal:** Viewer steuert Maus & Tastatur des Sharer-Rechners; bidirektionaler Dateitransfer zwischen beiden Seiten — beides über WebRTC-DataChannels (P2P, verschlüsselt).

**Voraussetzung:** Phase 2 läuft. Video-Stream Viewer ↔ Sharer steht.

**Architecture deltas:**
- Neuer DataChannel `input` (Viewer → Sharer, unreliable für Maus-Move, reliable für Buttons/Keys).
- Neuer DataChannel `files` (bidirektional, reliable ordered).
- Sharer-Rust: `enigo` für Input-Injection (Linux: uinput / X11, Windows: SendInput).
- Sharer: globaler Hotkey-Listener (Ctrl+Alt+Pause) für Sicherheits-Pause.

**Tests:** Erweiterung der Playwright-E2E (mock-sharer akzeptiert Input-Events + bestätigt Empfang), Rust-Unit-Tests für Input-Mapping und Datei-Chunking, Viewer-Vitest für UI-Capture-Logik.

---

## File Structure

```
docs/protocol.md                                 # add DataChannel sub-protocols
backend/src/protocol.ts                          # (unchanged — backend doesn't see datachannel traffic)
viewer/src/protocol.ts                           # add InputEvent, FileFrame types
viewer/src/input-capture.ts                      # new — capture pointer/keyboard from <video>
viewer/src/data-channels.ts                      # new — wrapper around RTCDataChannel pair
viewer/src/file-transfer.ts                      # new — chunking + reassembly
viewer/src/ui.ts                                 # wire DataChannels into existing UI
viewer/index.html                                # add file drop zone, input toggle
viewer/tests/input-capture.test.ts               # new
viewer/tests/file-transfer.test.ts               # new

sharer/src-tauri/src/input.rs                    # new — enigo wrapper
sharer/src-tauri/src/files.rs                    # new — chunked file receive/send
sharer/src-tauri/src/data_channels.rs            # new — DataChannel listeners
sharer/src-tauri/src/hotkey.rs                   # new — pause hotkey
sharer/src-tauri/src/lib.rs                      # wire datachannels + commands

scripts/mock-sharer.mjs                          # extend to handle input events + files
```

---

## Task 1: Protocol — Input + File Event Schema

**Files:**
- Modify: `docs/protocol.md`
- Modify: `viewer/src/protocol.ts`

- [x] **Step 1: Document the two DataChannel sub-protocols in `docs/protocol.md`**

Append a new section "DataChannel Sub-Protocols" describing:
- Channel `input` (Viewer → Sharer): JSON messages
  ```json
  { "kind": "mouse-move", "x": 0.5, "y": 0.5 }         // normalized 0..1
  { "kind": "mouse-button", "button": "left|right|middle", "pressed": true }
  { "kind": "scroll", "dx": 0, "dy": 120 }
  { "kind": "key", "code": "KeyA", "pressed": true, "modifiers": { "shift": false, "ctrl": false, "alt": false, "meta": false } }
  ```
- Channel `files` (bidirectional): JSON messages with optional binary payload
  ```json
  { "kind": "file-offer", "id": "uuid", "name": "report.pdf", "size": 12345, "mime": "application/pdf" }
  { "kind": "file-accept", "id": "uuid" }
  { "kind": "file-reject", "id": "uuid" }
  { "kind": "file-chunk", "id": "uuid", "seq": 0, "data": "<base64>" }  // chunks 16 KB
  { "kind": "file-done", "id": "uuid" }
  { "kind": "file-error", "id": "uuid", "message": "..." }
  ```

- [x] **Step 2: Add the types to `viewer/src/protocol.ts`**

```ts
export type Modifier = { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
export type InputEvent =
  | { kind: "mouse-move"; x: number; y: number }
  | { kind: "mouse-button"; button: "left" | "right" | "middle"; pressed: boolean }
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "key"; code: string; pressed: boolean; modifiers: Modifier };

export type FileEvent =
  | { kind: "file-offer"; id: string; name: string; size: number; mime: string }
  | { kind: "file-accept"; id: string }
  | { kind: "file-reject"; id: string }
  | { kind: "file-chunk"; id: string; seq: number; data: string }  // base64
  | { kind: "file-done"; id: string }
  | { kind: "file-error"; id: string; message: string };
```

- [x] **Step 3: Commit**

```bash
git add docs/protocol.md viewer/src/protocol.ts
git commit -m "feat(protocol): input events + file transfer message schemas"
```

---

## Task 2: Viewer — Input Capture (TDD)

**Files:**
- Create: `viewer/src/input-capture.ts`, `viewer/tests/input-capture.test.ts`

- [x] **Step 1: Write failing tests**

```ts
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
  it("emits normalized mouse-move on pointermove when enabled", () => {
    const video = makeVideo();
    document.body.appendChild(video);
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    cap.enable();
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}) });
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 480, clientY: 270 }));
    expect(emit).toHaveBeenCalledWith({ kind: "mouse-move", x: 0.5, y: 0.5 });
    document.body.removeChild(video);
  });

  it("ignores events when disabled", () => {
    const video = makeVideo();
    const emit = vi.fn();
    const cap = new InputCapture(video, emit);
    video.dispatchEvent(new PointerEvent("pointermove", { clientX: 100, clientY: 100 }));
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
});
```

Add `environment: "jsdom"` to `viewer/vitest.config.ts` (install `jsdom` exact pin). Run, verify fail.

- [x] **Step 2: Implement `viewer/src/input-capture.ts`**

```ts
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
      if (button) this.emit({ kind: "mouse-button", button, pressed: true });
    };
    const onUp = (e: Event): void => {
      const ev = e as PointerEvent;
      const button = BUTTON_MAP[ev.button];
      if (button) this.emit({ kind: "mouse-button", button, pressed: false });
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
```

- [x] **Step 3: Run tests pass, coverage ≥ 70%. Commit.**

```bash
git add viewer/src/input-capture.ts viewer/tests/input-capture.test.ts viewer/vitest.config.ts viewer/package.json viewer/package-lock.json
git commit -m "feat(viewer): pointer + keyboard capture from <video>"
```

---

## Task 3: Viewer — DataChannel Wrapper (TDD)

**Files:**
- Create: `viewer/src/data-channels.ts`, `viewer/tests/data-channels.test.ts`
- Modify: `viewer/src/webrtc-client.ts` to expose `createDataChannel` + `onDataChannel`

- [ ] **Step 1: Tests**

Test that `DataChannelPair`:
- Opens `input` and `files` channels on the underlying RTCPeerConnection (caller side)
- Receives them via `ondatachannel` (callee side)
- `sendInput(event)` JSON-serializes and writes to the input channel
- `onInput(handler)` receives parsed events

Use a mock pair of RTCPeerConnection that pipes datachannel messages between them. Or use `@roamhq/wrtc` in tests (already a dev dep via mock-sharer scripts/).

- [ ] **Step 2: Implement `viewer/src/data-channels.ts`**

Manages two named DataChannels. Caller (viewer) calls `pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 })` and `pc.createDataChannel("files", { ordered: true })`. Listens for incoming data, dispatches by channel label.

Expose:
```ts
class DataChannelHub {
  constructor(pc: RTCPeerConnection, role: "caller" | "callee") {}
  sendInput(event: InputEvent): void;
  onInput(handler: (event: InputEvent) => void): void;
  sendFile(event: FileEvent): void;
  onFile(handler: (event: FileEvent) => void): void;
  ready(): Promise<void>;  // resolves when both channels are open
}
```

- [ ] **Step 3: Wire into `ViewerPeer`**

Add `getDataHub(): DataChannelHub` method. Construct on `start()` as caller.

- [ ] **Step 4: Tests pass, commit.**

```bash
git commit -m "feat(viewer): DataChannelHub for input and file transfer"
```

---

## Task 4: Viewer — Wire Input Capture to DataChannel + UI Toggle

**Files:**
- Modify: `viewer/index.html`, `viewer/src/ui.ts`

- [ ] **Step 1: UI changes in `index.html`**

After the `<video>` element, add a small floating toolbar (visible when video is active):

```html
<div id="video-toolbar" class="toolbar">
  <button id="input-toggle" class="toolbar-btn" aria-pressed="false">
    <span class="indicator-dot"></span>
    Steuerung aktivieren
  </button>
</div>
```

CSS: small pill, default state shows "Steuerung aktivieren" with neutral dot; when pressed, switches to "Steuerung aktiv (Esc zum Beenden)" with accent-colored dot.

- [ ] **Step 2: Wire in `ui.ts`**

```ts
import { InputCapture } from "./input-capture.js";

// ... inside connect flow, after stream arrives:
const hub = peer.getDataHub();
await hub.ready();
const capture = new InputCapture(videoEl, (ev) => hub.sendInput(ev));
inputToggleBtn.addEventListener("click", () => {
  if (inputToggleBtn.getAttribute("aria-pressed") === "true") {
    capture.disable();
    inputToggleBtn.setAttribute("aria-pressed", "false");
  } else {
    capture.enable();
    inputToggleBtn.setAttribute("aria-pressed", "true");
    videoEl.focus();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && inputToggleBtn.getAttribute("aria-pressed") === "true") {
    capture.disable();
    inputToggleBtn.setAttribute("aria-pressed", "false");
  }
});
```

- [ ] **Step 3: Build + commit.**

```bash
git commit -m "feat(viewer): input control toggle + escape-to-disable"
```

---

## Task 5: Sharer — `enigo` Input Injection (TDD)

**Files:**
- Modify: `sharer/src-tauri/Cargo.toml`
- Create: `sharer/src-tauri/src/input.rs`

- [x] **Step 1: Add `enigo` to Cargo.toml**

```
cargo search enigo
```

Pin exact. Verify it supports Linux+Windows. Note: on Linux, `enigo` defaults to X11 — that's compatible with the existing `x11rb` capture path. Wayland would need `wayland-protocols` and is out of scope for MVP.

- [x] **Step 2: Implement `input.rs` with TDD**

```rust
use enigo::{Enigo, Key, KeyboardControllable, MouseButton, MouseControllable, Settings};
use serde::Deserialize;

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum InputEvent {
    MouseMove { x: f64, y: f64 },
    MouseButton { button: Button, pressed: bool },
    Scroll { dx: f64, dy: f64 },
    Key { code: String, pressed: bool, modifiers: Modifiers },
}

#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Button { Left, Right, Middle }

#[derive(Deserialize, Debug, Default, Clone, Copy)]
pub struct Modifiers { pub shift: bool, pub ctrl: bool, pub alt: bool, pub meta: bool }

pub struct InputController {
    enigo: Enigo,
    width: u32,
    height: u32,
    paused: bool,
}

impl InputController {
    pub fn new(width: u32, height: u32) -> Result<Self, String> {
        let enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        Ok(Self { enigo, width, height, paused: false })
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
    }

    pub fn apply(&mut self, event: InputEvent) -> Result<(), String> {
        if self.paused { return Ok(()); }
        match event {
            InputEvent::MouseMove { x, y } => {
                let px = (x * self.width as f64) as i32;
                let py = (y * self.height as f64) as i32;
                self.enigo.mouse_move_to(px, py);
            }
            InputEvent::MouseButton { button, pressed } => {
                let b = match button { Button::Left => MouseButton::Left, Button::Right => MouseButton::Right, Button::Middle => MouseButton::Middle };
                if pressed { self.enigo.mouse_down(b); } else { self.enigo.mouse_up(b); }
            }
            InputEvent::Scroll { dy, .. } => {
                let lines = (dy / 120.0) as i32;
                if lines != 0 { self.enigo.mouse_scroll_y(lines); }
            }
            InputEvent::Key { code, pressed, modifiers: _ } => {
                let key = parse_key(&code).ok_or_else(|| format!("unknown key: {code}"))?;
                if pressed { self.enigo.key_down(key); } else { self.enigo.key_up(key); }
            }
        }
        Ok(())
    }
}

fn parse_key(code: &str) -> Option<Key> {
    // Standard W3C codes mapped to enigo::Key. Cover common cases; for letter/digit codes use Key::Layout.
    match code {
        "Enter" => Some(Key::Return), "Escape" => Some(Key::Escape), "Backspace" => Some(Key::Backspace),
        "Tab" => Some(Key::Tab), "Space" => Some(Key::Space),
        "ArrowUp" => Some(Key::UpArrow), "ArrowDown" => Some(Key::DownArrow),
        "ArrowLeft" => Some(Key::LeftArrow), "ArrowRight" => Some(Key::RightArrow),
        "ShiftLeft" | "ShiftRight" => Some(Key::Shift),
        "ControlLeft" | "ControlRight" => Some(Key::Control),
        "AltLeft" | "AltRight" => Some(Key::Alt),
        "MetaLeft" | "MetaRight" => Some(Key::Meta),
        s if s.starts_with("Key") && s.len() == 4 => s.chars().last().map(|c| Key::Layout(c.to_ascii_lowercase())),
        s if s.starts_with("Digit") && s.len() == 6 => s.chars().last().map(Key::Layout),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_mouse_move() {
        let json = r#"{"kind":"mouse-move","x":0.5,"y":0.7}"#;
        let ev: InputEvent = serde_json::from_str(json).unwrap();
        matches!(ev, InputEvent::MouseMove { x: 0.5, y: 0.7 });
    }

    #[test]
    fn deserialize_key_event() {
        let json = r#"{"kind":"key","code":"KeyA","pressed":true,"modifiers":{"shift":false,"ctrl":false,"alt":false,"meta":false}}"#;
        let ev: InputEvent = serde_json::from_str(json).unwrap();
        if let InputEvent::Key { code, pressed, .. } = ev {
            assert_eq!(code, "KeyA");
            assert!(pressed);
        } else { panic!("wrong variant"); }
    }

    #[test]
    fn parse_letter_keys() {
        assert!(matches!(parse_key("KeyA"), Some(Key::Layout('a'))));
        assert!(matches!(parse_key("KeyZ"), Some(Key::Layout('z'))));
    }

    #[test]
    fn parse_arrow_keys() {
        assert!(matches!(parse_key("ArrowUp"), Some(Key::UpArrow)));
    }
}
```

(`Enigo::new` may require X11 environment for unit tests; the parsing tests above are pure and run anywhere.)

- [x] **Step 3: Run tests, build, commit.**

```bash
git commit -m "feat(sharer): input controller with enigo (mouse + keyboard + scroll)"
```

---

## Task 6: Sharer — DataChannel Listener for Input

**Files:**
- Create: `sharer/src-tauri/src/data_channels.rs`
- Modify: `sharer/src-tauri/src/webrtc.rs` (or wherever `SharerPeer` lives)
- Modify: `sharer/src-tauri/src/lib.rs`

- [ ] **Step 1: In `webrtc.rs`, register a handler `on_data_channel` that listens for the `input` channel**

When `pc.on_data_channel` fires with `dc.label() == "input"`, spawn a tokio task that reads messages and forwards parsed `InputEvent`s into a `tokio::sync::mpsc::Sender<InputEvent>` provided by the caller.

- [ ] **Step 2: In `lib.rs`, when `start_streaming` is called, also spawn an "input-applier" task**

```rust
let (input_tx, mut input_rx) = mpsc::channel::<InputEvent>(256);
let mut controller = InputController::new(width, height)?;
tauri::async_runtime::spawn(async move {
    while let Some(ev) = input_rx.recv().await {
        if let Err(e) = controller.apply(ev) { log::warn!("input apply: {e}"); }
    }
});
```

Wire the controller's `set_paused(true|false)` to a state flag exposed via a Tauri command and a hotkey listener (Task 8).

- [ ] **Step 3: Build, commit.**

```bash
git commit -m "feat(sharer): apply remote input events from datachannel"
```

---

## Task 7: Sharer — Sicherheits-Pause Hotkey

**Files:**
- Create: `sharer/src-tauri/src/hotkey.rs`
- Modify: `sharer/src-tauri/Cargo.toml` (add `global-hotkey` crate)

- [ ] **Step 1: Add `global-hotkey` exact-pinned**

- [ ] **Step 2: Implement `hotkey.rs`**

Register `Ctrl+Alt+Pause` (or `Ctrl+Alt+P` for keyboards without a Pause key). On press, toggle a shared `Arc<AtomicBool>` flag.

- [ ] **Step 3: Wire into `lib.rs`**

When sharer app starts, register the hotkey. Pass the `AtomicBool` to the `InputController` (`set_paused` reads it).

UI feedback: when paused, the floating panel (Task 8) shows "Steuerung pausiert (Ctrl+Alt+Pause)" in a warning color.

- [ ] **Step 4: Manual smoke test** — run sharer, observe that pressing hotkey toggles the flag. Add a log line.

- [ ] **Step 5: Commit.**

```bash
git commit -m "feat(sharer): Ctrl+Alt+Pause hotkey for input pause"
```

---

## Task 8: Sharer — Visual Indicators (Roter Rahmen + Floating Panel)

**Files:**
- Modify: `sharer/src-tauri/tauri.conf.json` — add a second always-on-top transparent window
- Modify: `sharer/src-tauri/src/lib.rs`

- [ ] **Step 1: Add a `border` window in `tauri.conf.json`**

```json
"windows": [
  { ... existing main window ... },
  {
    "label": "border",
    "title": "screenie-active",
    "transparent": true,
    "decorations": false,
    "alwaysOnTop": true,
    "skipTaskbar": true,
    "resizable": false,
    "visible": false,
    "width": 1920, "height": 1080
  }
]
```

- [ ] **Step 2: In `lib.rs`, when streaming starts:**

- Resize/position the `border` window to cover the chosen monitor
- Set its content to an HTML page that draws a red border (`box-shadow: inset 0 0 0 6px #f00; background: transparent;`) and a floating panel in the top-right with "Verbunden mit ip-prefix • Trennen"
- Show the window

When streaming ends or sharer disconnects: hide the window.

- [ ] **Step 3: Build, smoke test.** Open sharer, simulate streaming, verify the red border appears on the right monitor.

- [ ] **Step 4: Commit.**

```bash
git commit -m "feat(sharer): red-border overlay + floating disconnect panel during stream"
```

---

## Task 9: Protocol — File Transfer Types in Backend (no behavior change)

Backend protocol stays unchanged (DataChannels are P2P). This task only documents the file schema in `docs/protocol.md` (already partly done in Task 1 if file types were included). If not, complete here. Commit `docs(protocol): finalize file transfer schema`.

---

## Task 10: Viewer — File Transfer Module (TDD)

**Files:**
- Create: `viewer/src/file-transfer.ts`, `viewer/tests/file-transfer.test.ts`
- Modify: `viewer/index.html` (add file drop zone)
- Modify: `viewer/src/ui.ts` (wire drop zone)

- [ ] **Step 1: TDD `FileTransferManager`**

Tests cover:
- Sending: `send(file)` reads file in chunks, emits `file-offer` then chunks via a writer callback; resolves when remote sends `file-done` ack.
- Receiving: `receive(offer, accept=true)` writes chunks to a Blob; emits a `File`-shaped result on `file-done`.
- Reject path: `receive(offer, accept=false)` emits `file-reject`.
- Backpressure: respects a `bufferedAmount` threshold of 1 MB (uses an async generator that waits on `bufferedamountlow`).

- [ ] **Step 2: Implementation**

Pure module — takes a `(event: FileEvent) => void` writer (provided by the DataChannelHub) and exposes:
```ts
class FileTransferManager {
  send(file: File): Promise<void>;
  onIncomingOffer(handler: (offer: FileOffer) => Promise<boolean>): void;  // returns accept?
  onIncomingComplete(handler: (file: File) => void): void;
  handle(event: FileEvent): void;
}
```

Chunk size: 16 KB. Base64 encoding for binary-over-JSON (alternative: raw `ArrayBuffer` over datachannel — preferred but requires a small frame header. **Use raw `ArrayBuffer` for chunks** — `file-offer`/`file-accept`/`file-done` stay JSON, only `file-chunk` is binary. Adjust the protocol doc.)

- [ ] **Step 3: Drop zone UI**

`index.html` adds a small "Datei senden" button next to the input toggle. When clicked, opens a file picker. Drop-on-video also works (`<video>` accepts drop, prevents default, then triggers `send`).

When a file-offer arrives from sharer-side: show a confirmation toast in the viewer ("Sharer möchte X senden — annehmen?"). On accept, file streams in, and when done, browser triggers a download via `<a download>` link.

- [ ] **Step 4: Tests pass, build, commit.**

```bash
git commit -m "feat(viewer): bidirectional file transfer over DataChannel"
```

---

## Task 11: Sharer — File Handling

**Files:**
- Create: `sharer/src-tauri/src/files.rs`
- Modify: `sharer/src-tauri/src/lib.rs`
- Modify: `sharer/src/main.ts` (webview UI)

- [ ] **Step 1: Implement `files.rs`**

- Receive: maintain `HashMap<file_id, FileReceiveState>` with name, total_size, received bytes, output file handle.
- Sanitize filename: reject `..`, absolute paths, non-printable characters. Final path: `~/Downloads/Screenie/<sanitized>`.
- Emit Tauri event `file-offer` to webview when offer arrives. Webview shows confirmation dialog. Webview invokes `accept_file(id)` or `reject_file(id)`.
- Write chunks to disk as they arrive (don't buffer entire file in memory).
- On `file-done`, close file, emit `file-received` event.

Send side:
- Webview has "Datei senden"-Button. On click, calls `invoke("pick_and_send_file")` which uses Tauri's `tauri-plugin-dialog` to open a file picker, then sends chunks.

- [ ] **Step 2: Add `tauri-plugin-dialog` dep**

- [ ] **Step 3: Unit tests for filename sanitization**

```rust
#[test]
fn sanitize_strips_path_traversal() {
    assert_eq!(sanitize("../etc/passwd"), "etc_passwd");
    assert_eq!(sanitize("/absolute/path"), "absolute_path");
    assert_eq!(sanitize("normal.txt"), "normal.txt");
    assert_eq!(sanitize("..\\..\\windows\\bad"), "windows_bad");
}
```

- [ ] **Step 4: Manual smoke test** — drop a file into viewer, accept on sharer, verify it lands in `~/Downloads/Screenie/`.

- [ ] **Step 5: Commit.**

```bash
git commit -m "feat(sharer): chunked file receive + send with sanitized filenames"
```

---

## Task 12: Playwright E2E — Input + File Transfer

**Files:**
- Modify: `scripts/mock-sharer.mjs` to handle input + file datachannels (logs received events, echoes file-done)
- Modify: `viewer/tests/e2e/connect.spec.ts` to add a new test case OR new file `input.spec.ts`

- [ ] **Step 1: Extend mock-sharer**

When the viewer creates the `input` and `files` channels, mock-sharer opens them and logs received events. Echo `file-done` after receiving all chunks for a `file-offer`. Print received input events as `INPUT_EVENT=<json>` lines on stdout so the test can parse them.

- [ ] **Step 2: Add Playwright test**

```ts
test("viewer sends pointer-move to sharer over datachannel", async ({ page }) => {
  // ... existing setup (mock-sharer + viewer running)
  await page.fill("#code", code);
  await page.click("#connect");
  await expect(page.locator("#remote-video")).toBeVisible({ timeout: 30000 });

  // Enable input
  await page.click("#input-toggle");
  await expect(page.locator("#input-toggle")).toHaveAttribute("aria-pressed", "true");

  // Move pointer over video center
  const box = await page.locator("#remote-video").boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

  // Wait for mock-sharer to log a mouse-move event
  await expect.poll(() => mockSharerEvents.find((e) => e.kind === "mouse-move"))
    .toBeTruthy({ timeout: 5000 });
});
```

Where `mockSharerEvents` is a buffer fed from parsing `INPUT_EVENT=` lines.

- [ ] **Step 3: Run.** Expect green. Commit.

```bash
git commit -m "test(e2e): viewer forwards pointer events to sharer over datachannel"
```

---

## Phase 3 — Done When

- All 12 tasks committed
- All existing tests still pass: backend 30+, viewer 17+, sharer Rust unit tests ≥ 11
- New tests: `input-capture` ≥ 5 tests, `file-transfer` ≥ 5 tests, `data-channels` ≥ 3 tests, sharer `input.rs` ≥ 4 tests, sharer `files.rs` sanitize ≥ 4 tests
- Coverage ≥ 70% lines on all new modules
- Playwright e2e: input event forwarding confirmed, file transfer round-trip confirmed
- Manual smoke test: real keyboard typed into viewer types into a notepad on sharer; a file dropped into viewer lands on sharer's `~/Downloads/Screenie/`

## Out of Scope (still)

- Wayland input injection (X11 only via `enigo`)
- macOS testing
- Clipboard sync
- Audio
- Unattended access
