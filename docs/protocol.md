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
{ "type": "error", "code": "invalid-code" | "code-expired" | "rate-limit" | "bad-message", "message": "human readable" }
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
