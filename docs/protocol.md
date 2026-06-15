# Auffi Signaling Protocol

Transport: WebSocket Secure (WSS) to `/signal` on the backend.
All messages are JSON. Each message has a `type` field.

## Roles

A client identifies as either `sharer` or `viewer` in its first message.

## Sharer-Initiated Messages

### `register`
Sent immediately after connect. Backend responds with `code-assigned`.
```json
{ "type": "register", "role": "sharer" }
```

### `confirm`
After viewer joins, sharer shows a confirmation dialog. On "Yes":
```json
{ "type": "confirm", "accepted": true }
```
On "No":
```json
{ "type": "confirm", "accepted": false }
```

### `relay` (any peer → any peer)
Used for WebRTC signaling messages relayed by the backend without inspection.
The `payload` field is a discriminated union on `kind`:

**SDP offer / answer:**
```json
{ "type": "relay", "payload": { "kind": "sdp", "sdp": { "type": "offer", "sdp": "v=0..." } } }
{ "type": "relay", "payload": { "kind": "sdp", "sdp": { "type": "answer", "sdp": "v=0..." } } }
```

**ICE candidate:**
```json
{ "type": "relay", "payload": { "kind": "ice", "candidate": { "candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0 } } }
```

**Hello (smoke-test / keepalive):**
```json
{ "type": "relay", "payload": { "kind": "hello", "ts": 1715000000000 } }
```

## Viewer-Initiated Messages

### `join`
Viewer sends this with the code it has typed in.
```json
{ "type": "join", "role": "viewer", "code": "284-915-073" }
```

## Server-Sent Messages

### `code-assigned` (→ sharer)
```json
{ "type": "code-assigned", "code": "284-915-073", "expiresInSec": 600 }
```

### `peer-joined` (→ sharer)
Viewer has connected. Sharer must show confirmation dialog and reply with `confirm`.
```json
{ "type": "peer-joined", "viewerInfo": { "ipPrefix": "84.xxx", "country": "DE" } }
```
`viewerInfo.country` is the viewer's ISO-3166-1-alpha-2 country code (e.g. `"DE"`) or `null` when the
lookup returns no result. Resolved server-side via a local MMDB lookup (no third-party call; the full
viewer IP never leaves the VPS). Set **only** on the ad-hoc path; the unattended mirror always carries
`null` because the device-password flow bypasses the confirm dialog.

### `peer-confirmed` (→ viewer)
After sharer accepted.
```json
{ "type": "peer-confirmed" }
```

### `peer-rejected` (→ viewer)
After sharer declined or session ended.
```json
{ "type": "peer-rejected", "reason": "declined" | "expired" | "sharer-gone" }
```

### `relay` (→ peer)
Forwarded `relay` message from the other peer.
```json
{ "type": "relay", "payload": { "...": "..." } }
```

### `error` (→ any)
```json
{ "type": "error", "code": "invalid-code" | "rate-limit" | "bad-message", "message": "human readable" }
```

## State Machine (Backend)

```
[no session]
   ↓ sharer connects + register
[code-assigned, waiting]   ── 10 min TTL → [expired]
   ↓ viewer connects + join (code matches)
[matched, awaiting-confirm]
   ↓ sharer sends confirm:accepted
[active]   ←→ relay messages flow
   ↓ either side disconnects
[ended]
```

---

## Unattended-Access Extensions (gh #16 / #17 / #25)

The messages above cover the **ad-hoc** flow (sharer mints a code, confirms each
viewer manually). A second flow exists for **unattended** devices: an account
pairs a device once, the sharer keeps a persistent WSS open, and a viewer
connects with the device's code + a device password instead of a per-session
human confirmation. The authoritative wire types live in
[`backend/src/protocol.ts`](../backend/src/protocol.ts) and the sharer side in
[`sharer/src-tauri/src/heartbeat.rs`](../sharer/src-tauri/src/heartbeat.rs)
(`BackendFrame` / `SharerFrame`).

### Sharer connect (Bearer, not `register`)

An unattended sharer authenticates the `/signal` WebSocket upgrade with
`Authorization: Bearer <device-token>` + `X-Auffi-Device-Id: <id>` headers
(rate-limited per IP, Sec H-1) instead of sending a `register` frame. On
success the backend replies:

```json
{ "type": "unattended-hello", "deviceId": "284-915-073" }
```

The sharer then idles, waiting for `pw-check` frames.

### `needs-password` (→ viewer)
A `join` whose code resolves to a live unattended device. Instead of pairing
immediately, the backend prompts the viewer for the device password.
```json
{ "type": "needs-password" }
```

### `pw-attempt` (viewer → server)
```json
{ "type": "pw-attempt", "password": "the-device-password" }
```

### `pw-check` (→ sharer)
Backend forwards the attempt to the sharer, which argon2-verifies it **locally**
(the backend never sees the device password hash). `autoAccept` mirrors
`devices.auto_accept` and is sent on every check so a dashboard toggle takes
effect without a sharer reconnect.
```json
{ "type": "pw-check", "attempt": "the-device-password", "autoAccept": false }
```

### `pw-check-result` (sharer → server)
Result of the local verify (and the optional manual-confirm dialog when
`autoAccept` is false):
```json
{ "type": "pw-check-result", "result": "ok" | "fail" | "rejected" }
```
- `ok` → backend pairs the peers and sends `peer-confirmed` to the viewer; SDP/ICE relay proceeds as in the ad-hoc flow.
- `fail` → argon2 rejected; backend increments the per-device lockout counter and sends `wrong-password`.
- `rejected` → verify succeeded but the user clicked *ablehnen*; backend sends `rejected-by-user`.

> A late `pw-check-result` (sharer took a slow manual-confirm path after the
> viewer already gave up) is **silently dropped**, not error-reported — a
> `bad-message` error here would make the sharer's heartbeat treat it as a
> fatal disconnect (TC C-2).

### `wrong-password` (→ viewer)
```json
{ "type": "wrong-password", "attemptsLeft": 3 }
```

### `locked` (→ viewer)
Per-device attempts exhausted (5 fails → 15-min lockout, spec §6). Also sent if
a viewer joins a device that is already in its lockout window.
```json
{ "type": "locked", "retryAfterSec": 840 }
```

### `rejected-by-user` (→ viewer)
```json
{ "type": "rejected-by-user" }
```

> **Manual-confirm routing (sharer-internal).** When `autoAccept` is false the
> sharer Rust core raises a `needs-confirm` Tauri event to its own webview
> carrying a monotonic `confirmId`; the webview must echo that id back through
> the `unattended_confirm` command. This `confirmId` is a sharer-process
> detail (`pending_confirms: HashMap<u64, Sender>`), **not** a backend wire
> field — it never crosses the WSS. See `sharer/src-tauri/src/unattended_cmd.rs`.

### Connection telemetry (sharer → server)
The sharer reports connection lifecycle for the `connection_log` and relay-byte
accounting (feeds the free-tier relay cap).
```json
{ "type": "connection-started", "connectionType": "p2p" | "relay" }
{ "type": "connection-ended", "bytesRelayed": 1048576 }
```
> Currently emitted only by the **ad-hoc** signaling path. The unattended
> heartbeat path defines these wire shapes but does not yet emit them
> (gh #109).

---

## DataChannel Sub-Protocols

Once the WebRTC peer connection is active, two named DataChannels are opened
by the viewer (caller role):

| Channel | Direction | Ordered | Reliability |
|---------|-----------|---------|-------------|
| `input` | Viewer → Sharer | No | Unreliable for mouse-move; reliable for buttons/keys |
| `files` | Bidirectional | Yes | Reliable ordered |

All messages are UTF-8 JSON unless stated otherwise.

---

### Channel `input` — Remote Input Events

Each message is a JSON object with a `kind` discriminator.

**Mouse move** — normalized coordinates in the range `[0, 1]`:
```json
{ "kind": "mouse-move", "x": 0.5, "y": 0.5 }
```

**Mouse button:**
```json
{ "kind": "mouse-button", "button": "left", "pressed": true }
{ "kind": "mouse-button", "button": "right", "pressed": false }
{ "kind": "mouse-button", "button": "middle", "pressed": true }
```

**Scroll** — delta in pixels (matches the browser `WheelEvent` convention):
```json
{ "kind": "scroll", "dx": 0, "dy": 120 }
```

**Key** — W3C `KeyboardEvent.code` values:
```json
{ "kind": "key", "code": "KeyA", "pressed": true, "modifiers": { "shift": false, "ctrl": false, "alt": false, "meta": false } }
```

---

### Channel `files` — File Transfer

Control messages are UTF-8 JSON. Binary chunk frames are raw `ArrayBuffer`
(see below).

**Sender offers a file:**
```json
{ "kind": "file-offer", "id": "uuid", "name": "report.pdf", "size": 12345, "mime": "application/pdf" }
```

**Receiver accepts:**
```json
{ "kind": "file-accept", "id": "uuid" }
```

**Receiver rejects:**
```json
{ "kind": "file-reject", "id": "uuid" }
```

**Transfer complete (sender signals end-of-stream):**
```json
{ "kind": "file-done", "id": "uuid" }
```

**Error (either side):**
```json
{ "kind": "file-error", "id": "uuid", "message": "disk full" }
```

**Chunk (binary frame — NOT JSON):**

After `file-accept`, the sender streams chunks as raw `ArrayBuffer` messages.
Each frame has an 8-byte little-endian header followed by up to 16 KB of chunk
data:

```
Offset  Size  Type         Description
──────  ────  ──────────── ──────────────────────────────────────────────────
0       4     uint32-LE    File ID hash — lower 32 bits of a FNV-1a hash of
                           the UUID string, used to identify which file this
                           chunk belongs to.
4       4     uint32-LE    Sequence number — zero-based, increments per chunk.
8       ≤16384 bytes       Raw chunk data.
```

The receiver reconstructs the file by concatenating chunk payloads in sequence
order. After the last chunk the sender sends a `file-done` JSON message to
signal completion.
