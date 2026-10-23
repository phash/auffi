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
- `accepted: true` only takes effect while a viewer is attached **and** its
  socket is still open; an accept that races the viewer's Abbrechen leaves the
  session unconfirmed (the pending close delivers the synthesized `bye`).
- `accepted: false` on an unconfirmed session sends the viewer `peer-rejected`
  `"declined"`, closes **both** sockets and drops the code — a declined code is
  gone, the sharer starts over with `register` on a new socket.
- `accepted: false` against an already **confirmed** session is ignored (a
  stray decline must not tear down a running stream). A viewer swapped in after
  a drop is unconfirmed again, so a decline aimed at it works normally.

### `relay` (any peer → any peer)
Used for WebRTC signaling messages relayed by the backend. The payload body is
forwarded opaquely, but **not** without inspection: the backend checks that
`payload` is an object whose `kind` is in its `RELAY_KINDS` allow-list
(`sdp`, `ice`, `hello`, `bye`) and answers anything else with `bad-message`
`"invalid relay payload"` (socket stays open). A relay sent **before** the
session is confirmed (ad-hoc: sharer's `confirm`; unattended: `pw-check-result`
`ok`) is dropped silently — no error, no forward.
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
viewer IP never leaves the VPS). Both paths fill it: the unattended mirror (sent to the sharer after
`pw-check-result: ok`) carries the redacted `ipPrefix` and the `country` resolved at join time
(backends ≤ 0.7.1 always sent `country: null` there).

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
`message` is free text, with two exceptions the viewer keys on
(`viewer/src/connect-messages.ts`): `invalid-code` carries either
`"session full"` (another viewer holds the session, ad-hoc or unattended) or
`"no such session"`. Keep those strings stable.

Some errors are followed by a server-side close of the socket (default close
code, no reason the clients rely on); the rest leave it open:

| `code` / `message`                                             | Socket closed? |
|----------------------------------------------------------------|----------------|
| `rate-limit` `message rate exceeded` (per-socket frame cap, below) | yes |
| `rate-limit` `too many registrations` (5 `register`/min/IP)    | yes            |
| `rate-limit` `too many attempts` (`join` budget per IP, 5/min) | yes            |
| `bad-message` `invalid code format` (on `join`)                | yes            |
| `invalid-code` `session full` / `no such session`              | yes            |
| `bad-message` `invalid JSON` / `expected a JSON object` / `invalid relay payload` / `unexpected message` | no |
| `bad-message` on `pw-attempt` (`no pw-check expected`, `password missing`, `password too long`) | no |
| `bad-message` `wait for unattended-hello before sending` (bearer path) | no (but the sharer treats any `error` as fatal) |

**Per-socket frame cap.** Every `/signal` socket — ad-hoc and bearer — may send
at most **50 frames per 10 s** (`DEFAULT_PER_PEER_LIMIT`); the next frame gets
`rate-limit` `message rate exceeded` and the socket is closed. Per-IP limits
(`join`, `register`, bearer auth, socket count) key IPv6 clients by their /64
(`backend/src/rate-limit.ts::rateLimitKey`).

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
confirmed by the sharer again.

**Reconnect grace past the TTL.** The 10-minute TTL caps the code for *new*
joins only. When a **confirmed** viewer drops, the session stays joinable for
**30 s** (`RECONNECT_GRACE_MS`, `backend/src/codes.ts`) even if the code has
long expired; a viewer re-joining inside that window holds the session for
another **60 s** (`RECONNECT_CONFIRM_WINDOW_MS`) while the sharer re-confirms.
Backends ≤ 0.7.1 refused that re-join once the code was older than 10 minutes.

**Session dropped → sharer socket closed.** Whenever an unconfirmed session
is dropped for expiry (code TTL over, reconnect grace over), the backend
closes the sharer's WS with **4410** `code expired` (after the
`peer-rejected` / synthesized `bye` above, if a viewer was attached). The
socket cannot register again, so it is closed rather than left as a dead
registration. Sharers ≤ 0.7.1 have no special case for 4410: they treat it
like any lost signaling link ("Verbindung zum Server getrennt" + „Neu
verbinden", which fetches a fresh code; a live P2P stream keeps running).

#### WebSocket close codes on the ad-hoc path

| Code | Reason (free text) | Meaning                                                   |
|------|--------------------|-----------------------------------------------------------|
| 1011 | `internal error`   | A server-side fault while handling this socket's frame (e.g. a failing DB); also used on the bearer path. Ordinary disconnect for every client. |
| 4400 | `no register or join` | The socket sent neither `register` nor `join` within **15 s** of opening (`SIGNAL_ROLE_DEADLINE_MS`). Clients send their first frame right after open, so only idle sockets hit this. |
| 4410 | `code expired`     | → sharer: its session was dropped (TTL / reconnect grace over). Get a new code. |
| 4429 | `too many connections` | The client address (IPv6: its /64) already holds **20** open ad-hoc sockets (`SIGNAL_MAX_SOCKETS_PER_IP`); closed right after the upgrade. Bearer-authenticated sockets are not counted. |

If the viewer vanished **before** confirmation,
the backend synthesizes a `bye` to the sharer so its confirm dialog does not
point at a gone peer; a confirmed viewer's drop deliberately sends nothing, so
a Wi-Fi blip keeps the sharer's ICE grace / reconnect window alive. The
sharer's `keep_signaling` teardown intent (`docs/footguns.md` § Sharer
Teardown) relies on this back-edge.

## Transport Liveness

The backend pings every open `/signal` socket every **30 s** and terminates
one that has not answered with a pong for **90 s** (`backend/src/signaling.ts`,
`DEFAULT_KEEPALIVE`). A terminated socket runs the ordinary `close` teardown,
so a viewer whose network died silently (lid close, Wi-Fi → LTE, NAT expiry)
frees its `session.viewer` slot and a rejoin of the same code succeeds — the
sharer confirms the returning helper afresh. Clients need no application-level
code for this: browsers, `ws` and tungstenite answer protocol pings
automatically. The sharer pings the backend on the same 30 s / 90 s schedule
in the other direction (`sharer/src-tauri/src/signaling.rs`).

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

**Ordering rule.** Until `unattended-hello` has been sent, the backend answers
*any* frame from the sharer with `{ "type": "error", "code": "bad-message" }`
(the verify is still running and a wrong token must not observe protocol
behaviour). The sharer treats `error` as a fatal disconnect, so it MUST NOT
send before hello: `heartbeat.rs` holds frames queued during the handshake
(a `pw-check-result` from a confirm waiter, a `bye`, ICE candidates,
`turn-credentials-request`) and flushes them in order right after hello.

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
upper bound; anything longer is pure relay abuse). An empty password, and a
second `pw-attempt` while the previous one is still in flight (session state
`pw-in-flight`), get `bad-message` too (`password missing` /
`no pw-check expected`); the socket stays open and the attempt is not
forwarded. After a `wrong-password` the session is back in `awaiting-pw` and
the next attempt is accepted.

### `pw-check` (→ sharer)
Backend forwards the attempt to the sharer, which argon2-verifies it **locally**
(the backend never sees the device password hash). The backend **does** see the
plaintext attempt in transit — TLS ends at the reverse proxy and the frame is
re-serialised to the sharer — but neither stores nor logs it. `autoAccept` mirrors
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
- `ok` → backend resets the lockout counter, marks the session confirmed, sends `peer-confirmed` to the viewer **and mirrors `peer-joined` to the sharer** (with the viewer's `ipPrefix` + `country` captured at join time), so the sharer's WebRTC path matches the ad-hoc one; SDP/ICE relay proceeds as in the ad-hoc flow.
- `fail` → argon2 rejected; backend increments the per-device lockout counter and sends `wrong-password` (or `locked` + close once the 5th fail trips the lockout).
- `rejected` → verify succeeded but the user clicked *ablehnen*; backend sends `rejected-by-user`, closes the viewer socket and drops the session.
- Any **other** `result` value is counted as `fail` (it increments the lockout counter) — there is no error frame for it.

**Sharer-side gate.** Sharers ≥ 0.7.2 accept a forwarded `peer-joined` only
within **30 s** after they themselves sent `pw-check-result` `ok`
(`unattended_cmd.rs::PEER_JOINED_WINDOW`, one per `ok`); any other
`peer-joined` on the bearer socket is logged and dropped, so a backend fault
cannot start a stream the device never authorised.

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
> pre-join fetch. Neither this in-band request nor the device-id path of the
> REST endpoint is subject to the per-code credential budget (see
> § `POST /turn-credentials`).

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
> and the 30-day retention in `purge.ts` operate on.
>
> There is no relay time limit (removed in v0.7.2). Sharers ≤ 0.7.1 still
> show a stale banner at 8 min; the cutoff itself was enforced by the viewer.

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

The sender MUST NOT stream a single chunk before `file-accept` arrives — the
receiver refuses data that precedes the helper's/user's consent. The sharer
waits up to 60 s for the answer; on timeout it withdraws the offer with
`file-error` `"offer-timeout"` and the receiver drops the pending offer (a
late accept then has nothing to start). A `file-reject` or `file-error` for an
id that is already streaming stops the sender's chunk loop.

`message` values the sharer sends as a receiver: `too-many-active`,
`file-too-large`, `duplicate-id` (the offer's id — or its 32-bit FNV routing
hash, see below — matches a transfer that is still live), `cannot open file: …`,
`incomplete-transfer`. Receivers treat unknown values as a generic failure.

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

The WSS frames above are the bulk of the cross-component surface, but these
REST routes are called from more than one codebase and are therefore part of
this contract too. Account / device management (`/api/auth/*`, `/api/me`,
`/api/admin/*`) is dashboard-only and documented in the handler modules
(`backend/src/<area>/handlers.ts`, mirrored by `dashboard/src/api.ts`).

`/api/devices/*` is mostly dashboard-only too, with two sharer callers
(`sharer/src-tauri/src/account.rs`): `POST /api/devices/redeem`
(`{code, alias}` → `200 {deviceId, token}`, no auth, 5/min/IP; errors
`400 bad-code|bad-alias`, `410 code-invalid|code-used`, `503 id-collision`;
new devices start with `auto_accept = 1`) and the self-revoke
`DELETE /api/devices/:id` with `Authorization: Bearer <token>` +
`X-Auffi-Device-Id` (`204`; `403 forbidden` if the token's device is not
`:id`, `401 bad-token` if it does not verify; the live WSS is evicted with
4401). Without `X-Auffi-Device-Id` the bearer is "malformed" and the route
falls back to the session-cookie gate.

### `POST /turn-credentials` (viewer, ad-hoc sharer → backend)

Handler: `backend/src/turn-credentials.ts`. Callers:
`viewer/src/turn-config.ts`, `sharer/src-tauri/src/turn_config.rs`. Only
registered when `TURN_SHARED_SECRET` is set (otherwise 404).

Request: `Origin` header in the backend's allow-list (the sharer sets it
explicitly) + JSON body `{ "code": "284-915-073" }`.

```json
{ "urls": ["turn:turn.auffi.app:3478", "turns:turn.auffi.app:5349"], "username": "1715000000:uuid", "credential": "base64==", "ttl": 3600 }
```

| Status | Body | When |
|--------|------|------|
| 200 | credentials above | live ad-hoc session with budget left, or a live unattended session / connected unattended device for that id |
| 403 | `{"error":"origin not allowed"}` | `Origin` missing or not allow-listed |
| 403 | `{"error":"no active session"}` | code unknown / malformed and no unattended match |
| 429 | `{"error":"turn credential budget exhausted"}` | the ad-hoc code spent its budget: **4** credentials up front plus **2** per viewer join (`TURN_CREDENTIALS_UP_FRONT` / `_PER_JOIN`, `backend/src/codes.ts`) |
| 429 | `@fastify/rate-limit` default body | more than 10 requests/min/IP |

Errors use `{ "error": "<text>" }` without a `message` field (unlike `/api/*`).
Both clients treat **any** non-2xx as "no ICE servers" and build their peer
without STUN/TURN — host / mDNS candidates only, no third-party STUN fallback
(DSGVO). A 429 therefore silently costs NAT traversal, which is why the budget
must stay generous enough for one fetch per side per (re)join plus retries.

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
