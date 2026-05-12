# Postmortem — Monitor-Switch + Viewer-Swap Chain, 2026-05-12

## Context

Iterative bug-fix session that began as a feature request ("switch monitor mid-stream") and immediately surfaced a chain of subtler bugs hidden by the previous always-working happy-path. Each fix made the next layer's bug visible. Took 7 commits across ~90 minutes to bottom out.

This document captures the chain so future-me doesn't repeat the same triage.

## The architectural insight

The sharer holds five distinct resource lifetimes:

1. **Signaling WS** to the backend (carries `code-assigned`, `peer-joined`, `relay`, `confirm`)
2. **WebRTC peer connection** (`SharerPeer` — DTLS / ICE / RTP transport)
3. **Streaming pipeline** (`ScreenCapturer` → `Vp8Encoder` → `TrackLocalStaticSample`)
4. **InputController** (maps remote pointer coords to OS events)
5. **FileTransferManager** (data-channel side-stream)

These are independent. "End the session" wants all five gone. "New viewer joined the same code" wants 2-5 gone but 1 kept alive — the WS task that *just delivered* the `peer-joined` is the same one the next `confirm_peer` / `receive_offer` will go through.

The original `disconnect_streaming` collapsed everything as one transaction. That worked while it had a single caller. The moment we added a second caller with different intent the design started lying about itself.

**Takeaway:** if a teardown function is called from more than one site, audit which lifetimes each caller actually wants to end. "Disconnect" is not a primitive — it's a policy.

## The seven layers

| # | Symptom | Commit | Root cause | Fix |
|---|---------|--------|------------|-----|
| 1 | Process panic on first WS connect | `7c635e8` | rustls 0.23 refuses to auto-pick a CryptoProvider when both `ring` (via webrtc-rs) and `aws-lc-rs` (via rustls-platform-verifier) are in the dep graph | `rustls::crypto::ring::default_provider().install_default()` in `run()` before any TLS use |
| 2 | "signaling already running" on bootstrap | `1056df9` | `disconnect_streaming` didn't clear `SignalingState`, so the `#64` guard tripped on every restart (including JS webview F5) | Drop `SignalingState` in `disconnect_streaming` |
| 3 | `peer-joined` event never observed in UI | `29a080e` | `ViewerInfo._country` (Rust field, renamed for dead-code lint) didn't match `country` (JSON key) — serde silently dropped the field for the `Option<T>` case, but the rename was still misleading | `#[serde(rename = "country", default)]` |
| 4 | Feature: monitor switch during active session | `0ce2dd5` | n/a — new feature | New `switch_monitor` Tauri command; streaming_loop refactored to take owned capturer + encoder + mpsc receiver; portal restore_token reuse gated behind `AUFFI_ENABLE_RESTORE_TOKEN` so the picker always prompts (deferred re-enabling for unattended mode — gh #20-#27, tracked in gh #85, #86) |
| 5 | "Verbindung fehlgeschlagen" on the helper side after second viewer joined the same code | `91f8bca` | When the old viewer disconnected, backend silently `detachViewer`'d but never told the sharer. A new viewer's `peer-joined` then fired while the previous WebRTC peer + streaming_loop were still alive; the trusted-peer JS auto-accept invoked `start_streaming` which stacked a second portal-dialog request on top of the live source. Plasma refused to surface the second dialog while the first source was active. | JS `peer-joined` handler tears down the prior session before processing the new one; Rust `start_streaming` gained a defensive `rtc_state.is_none()` guard |
| 6 | "Verbindung verloren" on the helper side (round 1) | `c190c3c` | The fix from #5 invoked `disconnect_streaming`, which per #2 also dropped `SignalingState`. The very WS task that had just delivered the `peer-joined` was now gone, so the subsequent `confirm_peer` failed with "signaling not started" and the helper's ICE timed out | Added `keep_signaling: Option<bool>` param; `peer-joined` cleanup passes `true`. Bootstrap path keeps the default `false` |
| 7 | "Verbindung verloren" on the helper side (round 2) | `f894be3` | After `disconnect_streaming` dropped the WebRTC peer, the previous `streaming_loop` kept pulling frames from the previous GStreamer/portal pipeline for the ~1 s it took `write_failures` to climb past 30. During that overlap two concurrent portal pipelines were active and Plasma's compositor refused to route the *new* session's media even though the new loop's sample counts grew — sharer log showed flowing frames but the viewer reported lost connection | The mpsc switch-channel is now also the canonical shutdown signal: when `disconnect_streaming` clears `SwitchState` the `Sender` drops, the `Receiver`'s next `try_recv` returns `TryRecvError::Disconnected`, the loop exits, the capturer drops, the GStreamer pipeline tears down. One portal pipeline live at a time |

## Recurring patterns

**Compositor as silent rate-limiter.** Plasma will not surface a second `org.freedesktop.portal.ScreenCast` dialog while the first source is live, and it will silently misroute media when two pipelines overlap. The portal API doesn't expose this — it just looks like "the dialog never appeared" or "frames aren't reaching the peer." Always assume at most one active portal pipeline.

**Tauri events vs invoke return.** `emit("streaming-stopped")` from Rust resolves on the JS side asynchronously, *not* in the await chain of `invoke("disconnect_streaming")`. Don't rely on event-driven state reset arriving before the next JS statement runs — clear local state explicitly.

**Serde rename is load-bearing.** Renaming a Rust field for lint-suppression without a matching `#[serde(rename)]` doesn't always panic — `Option<T>` quietly defaults to `None` — but it does silently break the contract you thought you had. Either keep the field name aligned with the JSON or always rename.

**"`disconnect`" needs a noun.** `disconnect_streaming` was used for three distinct intents: end-the-session-completely, reset-state-before-restart-signaling, swap-viewers-on-same-code. Each wanted a different subset of state torn down. The `keep_signaling` flag papered over this — the cleaner refactor would be three named functions or a structured `TeardownScope` enum.

## What to do next time

Before adding a second caller to a teardown function, list what each caller wants left alive. If the lists differ at all, take the API split *first* and the new caller *after*. The 90-minute debug loop traded API hygiene for incremental delivery — the result was a working product, but at the cost of four extra round-trips.

## Commits, in order

```
7c635e8  fix(sharer): install rustls ring CryptoProvider at startup
1056df9  fix(sharer): clear SignalingState in disconnect_streaming
29a080e  fix(sharer): deserialize ViewerInfo.country (was silently dropping PeerJoined)
0ce2dd5  feat(sharer): switch monitor mid-stream + always-prompt picker policy
91f8bca  fix(sharer): tear down prior session before accepting a new peer-joined
c190c3c  fix(sharer): disconnect_streaming preserves signaling on viewer-swap
f894be3  fix(sharer): streaming_loop exits when disconnect drops switch channel
```
