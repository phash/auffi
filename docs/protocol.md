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

**Hello (opaque smoke-test probe — NOT a keepalive):**
```json
{ "type": "relay", "payload": { "kind": "hello", "ts": 1715000000000 } }
```
`hello` is allow-listed by the backend's `RELAY_KINDS` and relayed like any
other payload, but no production client emits it and both receivers ignore
it — backend tests use it as the neutral relay payload. Nothing on the
signaling WebSocket keeps a connection alive at the application layer; liveness
comes from the WS close / ICE state, not from this frame.

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

The ad-hoc sharer answers a received bye by dropping only its WebRTC session
and **keeping its WS registration**: a pending confirm dialog is dismissed, the
code stays redeemable until its TTL, and the next `join` on it produces a
fresh `peer-joined` (and a fresh confirmation). This is what lets the viewer's
30 s "doch nochmal verbinden" after its own Beenden succeed
(`sharer/src/viewer-bye-policy.ts`).

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

#### WebSocket close codes on the bearer path

The backend closes a bearer-authenticated `/signal` socket with one of three
application codes; the sharer's heartbeat (`heartbeat.rs`) keys its reconnect
policy on them, so they are part of the wire contract
(`backend/src/unattended.ts::WS_CLOSE`).

| Code | Reason (free text)                                              | Meaning                                  | Sharer behaviour                                         |
|------|-----------------------------------------------------------------|------------------------------------------|----------------------------------------------------------|
| 4401 | `invalid bearer auth` / `invalid device token` / `device revoked` / `verification error` / `unattended mode not configured` | Auth failed or token revoked      | **Terminal** — stop retrying, show „Token widerrufen — bitte erneut pairen" |
| 4408 | `superseded by newer connection`                                | Another instance owns this device-id     | **Terminal** — stop retrying                             |
| 4429 | `rate limit`                                                    | Per-IP bearer cap tripped (Sec H-1)      | Transient — reconnect at the backoff **ceiling** (60 s ±50 %), never reset the ladder |

Backends up to 0.7.0 sent the rate-limit close as `4401` + reason `rate
limit`; sharers ≥ 0.7.1 still recognise that pair as transient. Any other
close code (1000, 1001, 1006, …) is an ordinary disconnect and reconnects
with the normal backoff.

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
`attemptId` is a backend-minted correlation id, unique per attempt on this
device; the sharer echoes it in `pw-check-result`.
```json
{ "type": "pw-check", "attempt": "the-device-password", "autoAccept": false, "attemptId": 7 }
```

### `pw-check-result` (sharer → server)
Result of the local verify (and the optional manual-confirm dialog when
`autoAccept` is false):
```json
{ "type": "pw-check-result", "attemptId": 7, "result": "ok" | "fail" | "rejected" }
```
- `ok` → backend pairs the peers and sends `peer-confirmed` to the viewer; SDP/ICE relay proceeds as in the ad-hoc flow.
- `fail` → argon2 rejected; backend increments the per-device lockout counter and sends `wrong-password`.
- `rejected` → verify succeeded but the user clicked *ablehnen*; backend sends `rejected-by-user`.

> A late `pw-check-result` (sharer took a slow manual-confirm path after the
> viewer already gave up) is **silently dropped**, not error-reported — a
> `bad-message` error here would make the sharer's heartbeat treat it as a
> fatal disconnect (TC C-2).
>
> The same silent drop applies to a result whose `attemptId` is not the one
> currently in flight for that device (F053): without the id, a sharer
> waiter that outlived its viewer (60 s timeout, or an orphaned confirm
> dialog displaced by the next prompt) was attributed to whichever viewer
> came next. A result **without** `attemptId` is honoured as before —
> transitional clause for sharers older than v0.7.1; remove once those are
> gone. On the sharer, a new `pw-check` or a pre-confirm relay `bye` evicts
> every open confirm prompt, and an evicted prompt sends **nothing** (only a
> click or the 60 s timeout produces a frame).

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

**Key** — W3C `KeyboardEvent.code` values, plus the layout-resolved
`KeyboardEvent.key` when it is a single printable character:
```json
{ "kind": "key", "code": "KeyY", "key": "z", "pressed": true, "modifiers": { "shift": false, "ctrl": false, "alt": false, "meta": false } }
{ "kind": "key", "code": "Enter", "pressed": true, "modifiers": { "shift": false, "ctrl": false, "alt": false, "meta": false } }
```
`code` names a US-layout position (a QWERTZ helper's Z key is `KeyY`), so the
sharer types `key` when present and falls back to its `code` table for named
keys (`Enter`, arrows, F-keys, modifiers) and for viewers that omit the field.
Dead keys (`key: "Dead"`) are sent code-only and dropped by the sharer; the
composed character arrives with the following key event. The sharer ignores
`modifiers`: modifier state reaches it as the separate `ShiftLeft` /
`ControlLeft` / … key events, and `key` already carries the resolved
character. Held-key tracking on
both sides is by `code`, so a release is matched to its press even when Shift
was let go in between and `key` changed case.

---

### Channel `files` — File Transfer

Control messages are UTF-8 JSON sent as **text** DataChannel messages. Binary
chunk frames are raw `ArrayBuffer` sent as **binary** messages (see below).
Receivers MUST tell the two apart by the DataChannel message type (string vs
binary), never by inspecting the payload — a chunk frame starts with a hash
whose first byte can be `{`.

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

---

## REST Endpoints Shared Across Components

The WSS frames above are the bulk of the cross-component surface, but three
REST routes are called from more than one codebase and are therefore part of
this contract too. Account / device management (`/api/auth/*`, `/api/me`,
`/api/devices/*`, `/api/admin/*`) is dashboard-only and documented in the
handler modules.

### `POST /api/feedback` (dashboard, viewer, sharer → backend)

Callers: `dashboard/src/components/feedback-fab.ts`, `viewer/public/feedback-fab.js`,
`sharer/src-tauri/src/unattended_cmd.rs::unattended_submit_feedback`.
Handler: `backend/src/feedback/handlers.ts`.

```json
{ "source": "dashboard" | "viewer" | "sharer",
  "category": "bug" | "feature" | "praise" | "other",
  "rating": 1..5,
  "body": "<1..4000 chars, trimmed server-side>" }
```

Authentication is decided by `source` and must match the credential offered —
a logged-in dashboard user cannot post as `sharer`, nor a sharer as `dashboard`:

| `source`               | Credential                                                                 |
|------------------------|----------------------------------------------------------------------------|
| `dashboard`, `viewer`  | `__Host-auffi_session` cookie (same session as the dashboard).             |
| `sharer`               | `Authorization: Bearer <device-token>` + `X-Auffi-Device-Id: <id>` — the same pair the `/signal` upgrade uses. The feedback row is attached to the device's owner account. Unlike the WSS connect this does **not** stamp `devices.last_seen_at`; feedback is not a presence signal. |

Responses: `202 {"ok":true}` · `400` with `error` one of `bad-source`,
`bad-category`, `bad-rating`, `bad-body` · `401 no-auth` (missing/invalid
credential, or credential does not match `source`) · `429 rate-limited` on the
Bearer path only (per-IP cap in front of the argon2 verify,
`FEEDBACK_BEARER_RATE_LIMIT_MAX`, default 5/min). The route itself is capped
at 20/min/IP. Anonymous posts are rejected.

### `GET /api/downloads` (viewer download pages → backend)

Handler: `backend/src/downloads/handlers.ts`. Public, no auth.

```json
{ "counts": { "Auffi_0.7.0_amd64.deb": 123, "...": 0 } }
```

One key per allow-listed asset (`KNOWN_ASSETS`), zero for assets never
downloaded. Consumed by `viewer/public/download/counts.js`.

### `GET | HEAD /api/downloads/file/:asset[?tag=vX.Y.Z]` (viewer download pages → backend → GitHub)

Stream-through proxy for release artefacts; the pages link it directly so the
visible download URL stays on `auffi.app` and the counter is server-side.

- `:asset` must be in `KNOWN_ASSETS` — anything else is `404 unknown-asset`
  **before** any upstream call. Bump the list with every release.
- `?tag=` is optional; absent means GitHub's `latest`. Present, it must match
  `^v\d+\.\d+\.\d+$` or the answer is `400 invalid-tag`.
- `HEAD` short-circuits: `200` with the same `Content-Type` /
  `Content-Disposition` a successful `GET` would carry, **no** upstream fetch,
  **no** counter bump (link-preview crawlers, uptime checks).
- `GET`: upstream is fetched with a 15 s headers deadline. A non-2xx, a
  missing body, or a network-level failure (DNS, reset, TLS, timeout) is
  `502 upstream-unavailable` and does not bump the counter. On success the
  body streams through as `application/octet-stream` +
  `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`
  regardless of upstream headers, and the per-asset counter increments once.
- Rate limit 30/min/IP.

See `docs/footguns.md` § Download-Proxy Patterns for the reasoning behind
each of these.
