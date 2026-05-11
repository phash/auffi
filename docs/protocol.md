# Screenshare Signaling Protocol

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
Used for arbitrary peer-to-peer messages relayed by the backend.
In later phases this carries SDP offers/answers and ICE candidates.
In Phase 1 it carries "hello" test payloads.
```json
{ "type": "relay", "payload": { "...": "..." } }
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
