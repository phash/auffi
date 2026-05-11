# Screenshare Phase 2 — WebRTC + Screen-Streaming

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan.

**Goal:** Video-Stream vom Sharer-Bildschirm zum Viewer-Browser über WebRTC. Sharer kann unter mehreren Monitoren wählen.

**Architecture:**
- Backend: unchanged. Relay messages now carry `{ kind: "sdp" | "ice", ... }` payloads.
- Viewer: native `RTCPeerConnection` + `<video>`. Generates SDP offer on `peer-confirmed`.
- Sharer (Rust): `scap` for screen capture + `webrtc-rs` for PeerConnection. Encodes frames as VP8 via `vpx-rs` (transitively libvpx).

**Tech additions:**
- Sharer (Rust): `scap`, `webrtc`, `vpx-encode` crates. System dep: libvpx (already in many distros).
- Viewer (TS): no new deps — uses browser-native WebRTC.

**Test strategy:** E2E test of viewer ↔ backend ↔ sharer requires webkit2gtk on dev host. Until that's available, this phase verifies:
- Backend protocol extension (unit + integration tests)
- Viewer WebRTC layer (unit tests with mocked PeerConnection)
- Sharer Rust modules (compile-verified via `cargo check`)
- A Node.js mock-sharer script enables E2E Playwright testing of the viewer **without** needing the real Tauri sharer.

---

## Files Touched / Created

```
docs/protocol.md                                # extended with relay-kind discrimination
viewer/src/protocol.ts                          # add RelayKind types
viewer/src/webrtc-client.ts                     # new — wraps RTCPeerConnection
viewer/src/ui.ts                                # extend with <video> + connect flow
viewer/index.html                               # add <video> element
viewer/tests/webrtc-client.test.ts              # new — unit tests with mocks
backend/src/protocol.ts                         # add RelayKind types (kept synced)

sharer/src-tauri/Cargo.toml                     # add scap, webrtc, vpx-encode deps
sharer/src-tauri/src/capture.rs                 # new — screen capture wrapper
sharer/src-tauri/src/encoder.rs                 # new — VP8 encoder wrapper
sharer/src-tauri/src/webrtc.rs                  # new — PeerConnection + track
sharer/src-tauri/src/lib.rs                     # wire monitor enum + start_streaming command
sharer/src/main.ts                              # webview UI for monitor select
sharer/index.html                               # add monitor select UI

scripts/mock-sharer.mjs                         # Node.js mock sharer for E2E tests
```

---

## Task 1: Protocol — Relay Kind Discrimination

**Files:**
- Modify: `backend/src/protocol.ts`, `viewer/src/protocol.ts`, `docs/protocol.md`

- [ ] **Step 1: Extend RelayMsg with a discriminated payload type**

In both `backend/src/protocol.ts` and `viewer/src/protocol.ts` (keep byte-identical), replace `payload: unknown` on `RelayMsg` with a discriminated union:

```ts
export type RelaySdp = { kind: "sdp"; sdp: RTCSessionDescriptionInit };
export type RelayIce = { kind: "ice"; candidate: RTCIceCandidateInit };
export type RelayHello = { kind: "hello"; ts: number };   // kept for phase-1 smoke tests
export type RelayPayload = RelaySdp | RelayIce | RelayHello;

export type RelayMsg = { type: "relay"; payload: RelayPayload };
```

The viewer file should NOT import DOM types — for the backend file replace `RTCSessionDescriptionInit` and `RTCIceCandidateInit` with structural equivalents:

```ts
// backend/src/protocol.ts
export type SdpDescription = { type: "offer" | "answer" | "pranswer" | "rollback"; sdp?: string };
export type IceCandidateInit = { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null };

export type RelaySdp = { kind: "sdp"; sdp: SdpDescription };
export type RelayIce = { kind: "ice"; candidate: IceCandidateInit };
```

Update `docs/protocol.md` accordingly.

- [ ] **Step 2: Update existing tests so they still pass with the new payload shape.**

In `backend/tests/signaling.test.ts`, the existing "relay" test uses `{ hello: "world" }` — change to `{ kind: "hello", ts: 0 }` (or similar that satisfies the union).

- [ ] **Step 3: Run `cd backend && npm test`. All pass. Commit.**

```bash
git add backend/src/protocol.ts backend/tests/signaling.test.ts viewer/src/protocol.ts docs/protocol.md
git commit -m "feat(protocol): discriminated relay payloads (sdp/ice/hello)"
```

---

## Task 2: Viewer — RTCPeerConnection Wrapper (TDD)

**Files:**
- Create: `viewer/src/webrtc-client.ts`, `viewer/tests/webrtc-client.test.ts`

- [ ] **Step 1: Write failing tests with a mock RTCPeerConnection**

`viewer/tests/webrtc-client.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ViewerPeer } from "../src/webrtc-client.js";

class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = [];
  localDescription: RTCSessionDescription | null = null;
  ontrack: ((e: { streams: MediaStream[] }) => void) | null = null;
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  iceConnectionState: RTCIceConnectionState = "new";
  constructor(_config?: RTCConfiguration) {
    MockRTCPeerConnection.instances.push(this);
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n" };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = { ...d, toJSON: () => ({}) } as RTCSessionDescription;
  }
  async setRemoteDescription(_d: RTCSessionDescriptionInit): Promise<void> {}
  async addIceCandidate(_c: RTCIceCandidateInit): Promise<void> {}
  addTransceiver(_kind: string, _init: { direction: RTCRtpTransceiverDirection }): void {}
  close(): void { this.iceConnectionState = "closed"; }
}

describe("ViewerPeer", () => {
  it("creates an SDP offer when started", async () => {
    MockRTCPeerConnection.instances = [];
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const offer = await peer.start();
    expect(offer.type).toBe("offer");
    expect(offer.sdp).toContain("v=0");
  });

  it("emits onTrack when remote track arrives", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onTrack(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    const stream = { id: "s1" } as unknown as MediaStream;
    pc.ontrack?.({ streams: [stream] });
    expect(handler).toHaveBeenCalledWith(stream);
  });

  it("emits onIceCandidate for outgoing candidates", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    const handler = vi.fn();
    peer.onIceCandidate(handler);
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    pc.onicecandidate?.({ candidate: { candidate: "candidate:...", sdpMid: "0", sdpMLineIndex: 0 } as RTCIceCandidate });
    expect(handler).toHaveBeenCalled();
  });

  it("accepts remote answer", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    await peer.start();
    await expect(peer.acceptAnswer({ type: "answer", sdp: "v=0\r\n" })).resolves.toBeUndefined();
  });

  it("accepts remote ICE candidates", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    await peer.start();
    await expect(
      peer.addRemoteIceCandidate({ candidate: "candidate:...", sdpMid: "0", sdpMLineIndex: 0 })
    ).resolves.toBeUndefined();
  });

  it("close terminates the underlying PC", async () => {
    const peer = new ViewerPeer({
      pcFactory: () => new MockRTCPeerConnection() as unknown as RTCPeerConnection,
    });
    await peer.start();
    const pc = MockRTCPeerConnection.instances.at(-1)!;
    peer.close();
    expect(pc.iceConnectionState).toBe("closed");
  });
});
```

- [ ] **Step 2: Run, verify fail.**

```bash
cd viewer && npm test -- webrtc-client
```

- [ ] **Step 3: Implement `viewer/src/webrtc-client.ts`**

```ts
export type IceServers = { urls: string | string[]; username?: string; credential?: string }[];

export type ViewerPeerOpts = {
  iceServers?: IceServers;
  pcFactory?: (config: RTCConfiguration) => RTCPeerConnection;
};

const DEFAULT_ICE: IceServers = [{ urls: "stun:stun.l.google.com:19302" }];

export class ViewerPeer {
  private pc: RTCPeerConnection | null = null;
  private trackHandlers: Array<(stream: MediaStream) => void> = [];
  private iceHandlers: Array<(candidate: RTCIceCandidateInit | null) => void> = [];
  private stateHandlers: Array<(state: RTCIceConnectionState) => void> = [];

  constructor(private opts: ViewerPeerOpts = {}) {}

  async start(): Promise<RTCSessionDescriptionInit> {
    const factory = this.opts.pcFactory ?? ((c) => new RTCPeerConnection(c));
    const pc = factory({ iceServers: this.opts.iceServers ?? DEFAULT_ICE });
    this.pc = pc;

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (stream) for (const h of this.trackHandlers) h(stream);
    };
    pc.onicecandidate = (ev) => {
      const c = ev.candidate ? ev.candidate.toJSON() : null;
      for (const h of this.iceHandlers) h(c);
    };
    pc.oniceconnectionstatechange = () => {
      for (const h of this.stateHandlers) h(pc.iceConnectionState);
    };

    pc.addTransceiver("video", { direction: "recvonly" });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer;
  }

  async acceptAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) throw new Error("peer not started");
    await this.pc.setRemoteDescription(sdp);
  }

  async addRemoteIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) throw new Error("peer not started");
    await this.pc.addIceCandidate(candidate);
  }

  onTrack(fn: (stream: MediaStream) => void): void {
    this.trackHandlers.push(fn);
  }

  onIceCandidate(fn: (candidate: RTCIceCandidateInit | null) => void): void {
    this.iceHandlers.push(fn);
  }

  onIceState(fn: (state: RTCIceConnectionState) => void): void {
    this.stateHandlers.push(fn);
  }

  close(): void {
    this.pc?.close();
    this.pc = null;
  }
}
```

- [ ] **Step 4: Run tests, verify pass. Coverage ≥ 70%. Commit.**

```bash
cd viewer && npm test -- --coverage
git add viewer/src/webrtc-client.ts viewer/tests/webrtc-client.test.ts
git commit -m "feat(viewer): RTCPeerConnection wrapper with mock-based tests"
```

---

## Task 3: Viewer — Wire WebRTC into UI

**Files:**
- Modify: `viewer/index.html`, `viewer/src/ui.ts`

- [ ] **Step 1: Add `<video>` element**

In `viewer/index.html`, inside `<main id="app">` after the `#status` div, add:

```html
<video id="remote-video" autoplay playsinline muted style="width: 100%; max-width: 1280px; display: none; margin-top: 1rem; background: #000;"></video>
<button id="disconnect" style="display: none; margin-top: 0.5rem;">Trennen</button>
```

CSS additions in the `<style>` block:

```css
#remote-video.active { display: block; }
#disconnect.active { display: inline-block; }
```

- [ ] **Step 2: Wire WebRTC + signaling in `ui.ts`**

Replace the body of `viewer/src/ui.ts` so the connect flow now:
1. On click, validates code and creates `SignalingClient` + `ViewerPeer`
2. On signaling `onRelay`, dispatches on `payload.kind`:
   - `sdp` answer → `peer.acceptAnswer(payload.sdp)`
   - `ice` → `peer.addRemoteIceCandidate(payload.candidate)`
3. On `peer-confirmed` (resolved by SignalingClient), calls `peer.start()` → sends offer via `signaling.sendRelay({ kind: "sdp", sdp: offer })`
4. On `peer.onIceCandidate`, forwards via `signaling.sendRelay({ kind: "ice", candidate })`
5. On `peer.onTrack`, assigns `stream` to `<video>` and reveals it
6. On `disconnect` button, calls `peer.close()` + `signaling.close()` + hides video

Full file (replacing existing `ui.ts`):

```ts
import { SignalingClient } from "./signaling-client.js";
import { ViewerPeer } from "./webrtc-client.js";
import type { RelayPayload } from "./protocol.js";

function setStatus(text: string, kind: "ok" | "err" | "info"): void {
  const el = document.getElementById("status")!;
  el.textContent = text;
  el.className = kind;
}

function setVideoStream(stream: MediaStream | null): void {
  const video = document.getElementById("remote-video") as HTMLVideoElement;
  const disconnect = document.getElementById("disconnect")!;
  if (stream) {
    video.srcObject = stream;
    video.classList.add("active");
    disconnect.classList.add("active");
  } else {
    video.srcObject = null;
    video.classList.remove("active");
    disconnect.classList.remove("active");
  }
}

export function bindUI(backendWsUrl: string): void {
  const codeInput = document.getElementById("code") as HTMLInputElement;
  const connectBtn = document.getElementById("connect") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;

  let signaling: SignalingClient | null = null;
  let peer: ViewerPeer | null = null;

  codeInput.addEventListener("input", () => {
    const digits = codeInput.value.replace(/\D/g, "").slice(0, 9);
    const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)].filter(
      (s) => s.length > 0,
    );
    codeInput.value = parts.join("-");
  });

  function teardown(reason: string, kind: "ok" | "err" | "info" = "info"): void {
    peer?.close();
    signaling?.close();
    peer = null;
    signaling = null;
    setVideoStream(null);
    setStatus(reason, kind);
    connectBtn.disabled = false;
  }

  disconnectBtn.addEventListener("click", () => teardown("Getrennt.", "info"));

  connectBtn.addEventListener("click", () => {
    const code = codeInput.value.trim();
    if (!/^\d{3}-\d{3}-\d{3}$/.test(code)) {
      setStatus("Bitte 9-stelligen Code eingeben.", "err");
      return;
    }
    setStatus("Warte auf Bestätigung durch den Sharer…", "info");
    connectBtn.disabled = true;

    signaling = new SignalingClient(backendWsUrl);
    peer = new ViewerPeer();

    peer.onTrack(setVideoStream);
    peer.onIceCandidate((candidate) => {
      if (candidate) signaling?.sendRelay({ kind: "ice", candidate });
    });
    peer.onIceState((state) => {
      if (state === "failed" || state === "disconnected") {
        teardown("Verbindung verloren.", "err");
      }
    });

    signaling.onRelay((payload) => {
      const p = payload as RelayPayload;
      if (p.kind === "sdp") {
        peer?.acceptAnswer(p.sdp as RTCSessionDescriptionInit).catch((e: unknown) =>
          teardown(`SDP-Fehler: ${e instanceof Error ? e.message : String(e)}`, "err"),
        );
      } else if (p.kind === "ice") {
        peer?.addRemoteIceCandidate(p.candidate as RTCIceCandidateInit).catch(() => {
          /* benign: candidate may arrive before remote description */
        });
      }
    });

    signaling.onDisconnect((reason) => teardown(`Verbindung beendet: ${reason}`, "err"));

    signaling
      .join(code)
      .then(async () => {
        if (!peer || !signaling) return;
        const offer = await peer.start();
        signaling.sendRelay({ kind: "sdp", sdp: offer });
        setStatus("Verbunden — empfange Stream…", "ok");
      })
      .catch((e: unknown) =>
        teardown(`Fehler: ${e instanceof Error ? e.message : String(e)}`, "err"),
      );
  });
}
```

- [ ] **Step 3: Verify build + lint + existing tests.**

```bash
cd viewer && npm run build && npm test
```

- [ ] **Step 4: Commit.**

```bash
git add viewer/src/ui.ts viewer/index.html
git commit -m "feat(viewer): wire WebRTC into connect flow and render remote stream"
```

---

## Task 4: Sharer — `scap` Screen Capture

**Files:**
- Modify: `sharer/src-tauri/Cargo.toml`
- Create: `sharer/src-tauri/src/capture.rs`

- [ ] **Step 1: Add `scap` dep**

```
cargo search scap --limit 1
```

Pin exact: e.g. `scap = "=0.x.y"`. Verify it supports Linux/Windows/macOS.

- [ ] **Step 2: Implement `capture.rs`**

```rust
use scap::capturer::{Capturer, Options, Resolution};
use scap::frame::Frame;
use scap::Target;

pub struct ScreenCapturer {
    capturer: Capturer,
}

pub fn list_displays() -> Vec<DisplayInfo> {
    scap::get_all_targets()
        .into_iter()
        .filter_map(|t| match t {
            Target::Display(d) => Some(DisplayInfo {
                id: d.id,
                title: d.title.clone(),
                width: d.width,
                height: d.height,
            }),
            _ => None,
        })
        .collect()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DisplayInfo {
    pub id: u32,
    pub title: String,
    pub width: u32,
    pub height: u32,
}

impl ScreenCapturer {
    pub fn start(display_id: u32) -> Result<Self, String> {
        let targets = scap::get_all_targets();
        let target = targets
            .into_iter()
            .find(|t| matches!(t, Target::Display(d) if d.id == display_id))
            .ok_or_else(|| format!("display {display_id} not found"))?;

        let options = Options {
            fps: 30,
            target: Some(target),
            show_cursor: true,
            show_highlight: false,
            output_type: scap::frame::FrameType::BGRAFrame,
            output_resolution: Resolution::_1080p,
            ..Default::default()
        };

        let mut capturer = Capturer::build(options).map_err(|e| e.to_string())?;
        capturer.start_capture();
        Ok(Self { capturer })
    }

    pub fn next_frame(&mut self) -> Result<Frame, String> {
        self.capturer.get_next_frame().map_err(|e| e.to_string())
    }

    pub fn stop(&mut self) {
        self.capturer.stop_capture();
    }
}
```

Note: `scap` API may differ from the snippet above; the implementer must reconcile against the actual installed version (`cargo doc --open --package scap` or the crate's README). Implementer must adapt without using `unwrap()` in non-test paths.

- [ ] **Step 3: `cargo check` succeeds. Document on host without webkit2gtk: code reaches scap compilation step. Commit.**

```bash
cd sharer/src-tauri && cargo check 2>&1 | tail -20
```

```bash
git add sharer/src-tauri/Cargo.toml sharer/src-tauri/Cargo.lock sharer/src-tauri/src/capture.rs
git commit -m "feat(sharer): screen capture wrapper via scap"
```

---

## Task 5: Sharer — VP8 Encoder

**Files:**
- Modify: `sharer/src-tauri/Cargo.toml`
- Create: `sharer/src-tauri/src/encoder.rs`

- [ ] **Step 1: Add `vpx-encode` (or equivalent) dep**

Investigate available VP8 encoder crates:
```
cargo search vpx --limit 5
```

Pick a maintained one (`vpx-encode`, `libvpx-sys`, or use `gst-plugin-rs` if simpler). Pin exact.

- [ ] **Step 2: Implement `encoder.rs`**

Wraps the encoder with a simple interface:
```rust
pub struct Vp8Encoder { /* … */ }

impl Vp8Encoder {
    pub fn new(width: u32, height: u32, bitrate_kbps: u32) -> Result<Self, String> { … }
    pub fn encode(&mut self, frame_bgra: &[u8], timestamp_us: u64) -> Result<Vec<EncodedPacket>, String> { … }
}

pub struct EncodedPacket {
    pub data: Vec<u8>,
    pub is_keyframe: bool,
    pub pts_us: u64,
}
```

Convert BGRA → I420 (YUV) before encoding (libvpx requires YUV). Use `yuv` crate or hand-roll the conversion.

- [ ] **Step 3: Compile-check + commit.**

```bash
cd sharer/src-tauri && cargo check
```

```bash
git commit -m "feat(sharer): VP8 encoder wrapper"
```

---

## Task 6: Sharer — WebRTC PeerConnection

**Files:**
- Modify: `sharer/src-tauri/Cargo.toml`
- Create: `sharer/src-tauri/src/webrtc.rs`

- [ ] **Step 1: Add `webrtc` crate**

```
cargo search webrtc --limit 3
```

Likely `webrtc = "=X.Y.Z"` (the `webrtc-rs` crate). Pin exact.

- [ ] **Step 2: Implement `webrtc.rs`**

Single `SharerPeer` struct:

```rust
use webrtc::api::APIBuilder;
use webrtc::api::media_engine::MediaEngine;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::Error;
use std::sync::Arc;

pub struct SharerPeer {
    pc: Arc<webrtc::peer_connection::RTCPeerConnection>,
    pub track: Arc<TrackLocalStaticSample>,
}

impl SharerPeer {
    pub async fn new(ice_servers: Vec<String>) -> Result<Self, Error> {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs()?;
        let api = APIBuilder::new().with_media_engine(media_engine).build();

        let config = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: ice_servers,
                ..Default::default()
            }],
            ..Default::default()
        };
        let pc = Arc::new(api.new_peer_connection(config).await?);

        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: "video/VP8".to_string(),
                ..Default::default()
            },
            "video".to_string(),
            "screenshare".to_string(),
        ));
        pc.add_track(track.clone()).await?;

        Ok(Self { pc, track })
    }

    pub async fn set_remote_offer(&self, sdp: String) -> Result<RTCSessionDescription, Error> {
        let offer = RTCSessionDescription::offer(sdp)?;
        self.pc.set_remote_description(offer).await?;
        let answer = self.pc.create_answer(None).await?;
        self.pc.set_local_description(answer.clone()).await?;
        Ok(answer)
    }

    pub async fn add_ice_candidate(&self, candidate: webrtc::ice_transport::ice_candidate::RTCIceCandidateInit) -> Result<(), Error> {
        self.pc.add_ice_candidate(candidate).await
    }

    pub fn on_ice_candidate<F>(&self, mut handler: F)
    where F: FnMut(webrtc::ice_transport::ice_candidate::RTCIceCandidate) + Send + Sync + 'static
    {
        self.pc.on_ice_candidate(Box::new(move |maybe| {
            let handler = &mut handler;
            Box::pin(async move {
                if let Some(c) = maybe { handler(c); }
            })
        }));
    }
}
```

(Implementer adjusts to current `webrtc-rs` API — check `https://docs.rs/webrtc` for current version.)

- [ ] **Step 3: Commit.**

---

## Task 7: Sharer — Glue Code + Tauri Commands

**Files:**
- Modify: `sharer/src-tauri/src/lib.rs`, `sharer/src/main.ts`, `sharer/index.html`

- [ ] **Step 1: Add Tauri commands**

- `list_monitors()` → returns `Vec<DisplayInfo>`
- `start_streaming(monitor_id: u32)` → starts capture loop, creates SharerPeer, wires SDP/ICE flow through existing signaling

Streaming loop runs in `tauri::async_runtime::spawn`:
```
loop {
  let frame = capturer.next_frame()?;
  let packets = encoder.encode(&frame.data, timestamp)?;
  for p in packets {
    track.write_sample(&Sample { data: p.data.into(), duration: Duration::from_millis(33), .. }).await?;
  }
}
```

Wire SDP/ICE through signaling::Outgoing::Relay payloads — emit incoming offer to webview via existing relay event, but in practice the webrtc handshake runs entirely in Rust without touching the webview (the webview only displays UI state).

- [ ] **Step 2: Webview — Monitor select UI**

After clicking "Verbinden zulassen" in the confirm dialog (existing), webview calls `invoke("list_monitors")`, renders radio buttons, user picks one and clicks "Streamen", which calls `invoke("start_streaming", { monitorId })`.

- [ ] **Step 3: Compile + commit.**

---

## Task 8: Node.js Mock-Sharer for E2E Tests

**Files:**
- Create: `scripts/mock-sharer.mjs`, `package.json` at root (for the script's deps)

- [ ] **Step 1: Install `wrtc` (Node WebRTC bindings) or use `@roamhq/wrtc` (modern fork) plus `ws`**

```
npm install --save-exact @roamhq/wrtc@latest ws@latest
```

(Adjust to current names. There's also `node-datachannel` as an alternative.)

- [ ] **Step 2: Write mock-sharer**

`scripts/mock-sharer.mjs` connects to backend as sharer, prints the code, waits for `peer-joined`, sends `confirm:accepted`, then negotiates SDP — sending a stub VP8 stream from a static file. This lets Playwright drive the viewer end-to-end without needing the Tauri sharer.

- [ ] **Step 3: Smoke-test the mock against backend.**

- [ ] **Step 4: Commit.**

---

## Task 9: Playwright E2E Tests

**Files:**
- Create: `viewer/playwright.config.ts`, `viewer/tests/e2e/connect.spec.ts`
- Modify: `viewer/package.json` (add @playwright/test)

- [ ] **Step 1: Install Playwright**

```
cd viewer && npm install --save-exact @playwright/test@latest && npx playwright install chromium
```

- [ ] **Step 2: Write e2e test**

Spawn backend (`docker compose up backend -d`), spawn mock-sharer (`node scripts/mock-sharer.mjs &`), capture its emitted code, launch viewer page, type the code, click connect, verify `<video>` element receives a stream (`video.videoWidth > 0` after some seconds).

- [ ] **Step 3: Run + commit.**

---

## Phase 2 Done When

- All 9 tasks committed and approved
- Backend tests unchanged-and-still-pass
- Viewer unit tests pass; `webrtc-client.ts` coverage ≥ 70%
- Sharer `cargo check` reaches our crate (compile of scap + vp8 + webrtc OK)
- Playwright e2e: viewer + mock-sharer end-to-end works (status "Verbunden — empfange Stream…", video element shows actual frames)
- Manual test on host with webkit2gtk: deferred

## Out of Scope (still)

- System audio
- Adaptive bitrate beyond what webrtc-rs does by default
- Latency optimization beyond reasonable defaults
- macOS testing
