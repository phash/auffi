# Auffi Signaling Protocol

Transport: WebSocket Secure (WSS) to `/signal` on the backend.
All messages are JSON. Each message has a `type` field.

## Roles

An ad-hoc client identifies as either `sharer` or `viewer` in its first
message (`register` / `join`). An **unattended** sharer never sends a first
message: it is identified during the WebSocket upgrade by
`Authorization: Bearer <device-token>` + `X-Auffi-Device-Id` headers and is
greeted with `unattended-hello` (see § Unattended-Access Extensions).

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
{ "type": "relay", "payload": { "kind": "ice", "candidate": { "candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0, "usernameFragment": "abcd" } } }
```
`sdpMid` / `sdpMLineIndex` / `usernameFragment` are optional-nullable, matching
the browser's `RTCIceCandidateInit`. Note the wire key is `sdpMLineIndex`
(capital L); the sharer webview re-maps it to the Tauri invoke key
`sdpMlineIndex` (see `sharer/src/signaling-buffer.ts`).

**Hello (smoke-test / keepalive):**
```json
{ "type": "relay", "payload": { "kind": "hello", "ts": 1715000000000 } }
```

**Bye (courteous teardown):**
```json
{ "type": "relay", "payload": { "kind": "bye" } }
```
The sending peer ended the stream on purpose; the receiver shows the friendly
"beendet" copy instead of waiting for the ICE timeout. The backend also
**synthesizes** this frame toward the sharer (a viewer's own bye is gated by
the pre-confirm relay guard, and a tab-close sends nothing at all) in these
cases:

- **Ad-hoc, pre-confirm viewer loss** — the viewer's WS drops before the
  sharer confirmed; the sharer's confirm dialog would otherwise point at a
  gone viewer.
- **Ad-hoc, code expiry** — a code expires while an unconfirmed viewer is
  attached (the viewer additionally gets `peer-rejected` reason `"expired"`).
- **Unattended, pre-confirm viewer loss** — the viewer's WS drops while the
  session is in `awaiting-pw` / `pw-in-flight`.
- **Unattended, pw-entry timeout** — the server-side sweep reaps a session
  stuck before `confirmed` for longer than 2 minutes (see below).

Confirmed sessions never get a synthesized bye on viewer WS loss — a Wi-Fi
blip must keep the ICE grace / reconnect window alive instead of tearing the
stream down.

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
viewer IP never leaves the VPS). Set **only** on the ad-hoc path; the unattended mirror (sent to the
sharer after `pw-check-result: ok`) carries the redacted `ipPrefix` captured at join time and always
`country: null` — no GeoIP lookup runs on that path, access is gated by the device password (plus the
manual confirm when `autoAccept` is off) instead of the ad-hoc IP-hint dialog.

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
- `declined` — the sharer clicked Ablehnen.
- `expired` — the code's 10-minute TTL lapsed while this (unconfirmed) viewer
  was attached; the backend closes the viewer WS after sending it.
- `sharer-gone` — the sharer's WS dropped while a viewer was attached (sent on
  both the ad-hoc and unattended paths).

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
   ↓ viewer connects + join (code matches)        ▲
[matched, awaiting-confirm]                       │ viewer disconnects
   ↓ sharer sends confirm:accepted                │ (same code, confirmed
[active]   ←→ relay messages flow  ───────────────┘  reset → re-confirm)
   ↓ sharer disconnects
[ended]
```

Only the **sharer** ends a session (`removeBySharer`; the viewer gets
`peer-rejected` / `sharer-gone`). A viewer disconnect runs `detachViewer`: the
viewer slot is cleared, `confirmed` is reset and the code stays joinable until
its TTL. This is what lets the same helper reconnect within the 30-s grace (or
a replacement helper attach) — and why every returning viewer has to be
confirmed by the sharer again. If the viewer vanished **before** confirmation,
the backend synthesizes a `bye` to the sharer so its confirm dialog does not
point at a gone peer; a confirmed viewer's drop deliberately sends nothing, so
a Wi-Fi blip keeps the sharer's ICE grace / reconnect window alive. The
sharer's `keep_signaling` teardown intent (`docs/footguns.md` § Sharer
Teardown) relies on this back-edge.

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
The backend rejects passwords longer than 256 characters with a
`bad-message` error before forwarding (Sec H-4 — matches the account-password
upper bound; anything longer is pure relay abuse).

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

### Pre-confirm session timeout (server-side)

A viewer may sit in `awaiting-pw` / `pw-in-flight` for at most **2 minutes**
(`PW_ENTRY_TIMEOUT_MS`). While the session exists every other viewer sees
"session full", so a wedged or hostile client could otherwise occupy the
device silently for as long as it keeps its WS open — this deadline is the
unattended counterpart of the ad-hoc 10-minute code TTL. On reap the backend
closes the viewer WS and sends the sharer the synthesized
`{"kind":"bye"}` relay. Confirmed sessions are exempt (they live until a peer
disconnects).

### `turn-credentials-request` (sharer → server)

The unattended sharer has no session code for `POST /turn-credentials`; its
WSS is already bearer-authenticated, so it asks for the ephemeral TURN
credentials in-band — sent before building the WebRTC peer for a session.
```json
{ "type": "turn-credentials-request" }
```

### `turn-credentials` (→ sharer)

Reply to `turn-credentials-request`. Carries the same HMAC-ephemeral
credentials the REST endpoint mints, or `null` when the deployment has no
TURN configured — the sharer then builds its peer STUN-less (identical
degradation to a failed REST fetch).
```json
{ "type": "turn-credentials", "credentials": { "urls": ["turn:host:3478"], "username": "1715000000:uuid", "credential": "base64==", "ttl": 3600 } }
{ "type": "turn-credentials", "credentials": null }
```

> Viewer side: unattended viewers use the normal `POST /turn-credentials`
> REST endpoint with the device-id as `code` — the gate accepts any code
> whose device currently holds a live bearer-authenticated WSS
> (`UnattendedRegistry`), which is already true during the viewer's
> pre-join fetch.

### `connection-started` (sharer → server)

Sent once ICE settles and the sharer knows whether media flows directly or
through TURN. The server opens a `connection_log` row for the device, keyed by
the viewer IP prefix captured at join time.

```json
{ "type": "connection-started", "connectionType": "p2p" | "relay" }
```

### `connection-ended` (sharer → server)

Closes the row opened above with the bytes this session pushed through the
video track. The server sets `ended_at` and `bytes_relayed`.

```json
{ "type": "connection-ended", "bytesRelayed": 4096 }
```

> **Unattended only (gh #109).** `connection_log.device_id` is `NOT NULL` and
> references `devices(id)`, so an ad-hoc session has nothing to attribute a row
> to — the sharer's ad-hoc path deliberately sends neither frame
> (`OutboundSink::send_telemetry` is a silent no-op there).
>
> **The server owns the row's end, not the frame.** `connection-ended` can
> only be sent from the sharer's teardown, which runs at least one round-trip
> after the viewer's socket closed — so on the ordinary ending (helper closes
> the tab) it reaches a session that is already gone, and a crashed sharer
> never sends one at all. The row is therefore finalised whenever the session
> leaves the store, whatever the cause: viewer close, sharer close, stale
> reap. A session that never reported a byte count logs `0` rather than a
> guess. `connection-ended` arriving in time simply supplies a better number.
>
> Both frames are **advisory**: the server ignores them outside a `confirmed`
> session, ignores an unknown `connectionType`, ignores `connection-ended`
> without a preceding `connection-started`, and never answers with an `error`
> — the sharer's heartbeat treats `error` as a fatal disconnect, so losing
> telemetry must not cost the session. A device row deleted mid-session makes
> the insert fail the foreign key; that is caught and logged, not propagated.
>
> `bytesRelayed` counts **relayed** bytes only. The column is sized at TURN
> traffic (`0 for p2p` in the schema), so the sharer reports its track total
> only when ICE settled on a relay path and `0` otherwise.
>
> These rows are what `GET /api/devices/:id/log`, the admin connection stats
> and the 30-day retention in `purge.ts` operate on. The free-tier relay
> cutoff is **not** driven by them — it runs client-side in
> `sharer/src-tauri/src/free_tier_timer.rs` and arms on a relay connection
> regardless of mode.

> **Manual-confirm routing (sharer-internal).** When `autoAccept` is false the
> sharer Rust core raises a `needs-confirm` Tauri event to its own webview
> carrying a monotonic `confirmId`; the webview must echo that id back through
> the `unattended_confirm` command. This `confirmId` is a sharer-process
> detail (`pending_confirms: HashMap<u64, Sender>`), **not** a backend wire
> field — it never crosses the WSS. See `sharer/src-tauri/src/unattended_cmd.rs`.

---

## DataChannel Sub-Protocols

Once the WebRTC peer connection is active, two named DataChannels are opened
by the viewer (caller role):

| Channel | Direction | Ordered | Reliability |
|---------|-----------|---------|-------------|
| `input` | Viewer → Sharer | Yes | Reliable |
| `files` | Bidirectional | Yes | Reliable ordered |

The `input` channel is deliberately ordered + reliable: a lost key-up or
button-up mid-session leaves a stuck key on the sharer. Input stays
low-bandwidth because the viewer coalesces pointer moves to one message per
animation frame (~60 Hz); buttons, keys and wheel events are sent
immediately.

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

**Scroll** — delta in pixels, where one wheel notch is 120 px:
```json
{ "kind": "scroll", "dx": 0, "dy": 120 }
```
The viewer accumulates raw `WheelEvent` deltas (normalizing
`DOM_DELTA_LINE`/`DOM_DELTA_PAGE`) and emits only **whole multiples of
120 px** per axis, keeping the sub-notch remainder locally. The sharer
converts with `trunc(delta / 120)` scroll lines and clamps each event to
**±100 lines** (DoS guard against `Infinity`/`NaN`/huge deltas — the
DataChannel bypasses the backend's rate limits); the viewer discards the
excess of a clamped burst instead of replaying it later.

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
