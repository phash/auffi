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

## Addendum — second-pass review (commit `ae8d8d6`)

After the chain settled, an independent review of the resulting state surfaced one more critical bug plus four important issues, all caused by the same too-fast-to-think incremental delivery the first chain warned against. Each one is a clean instance of "I shipped before I traced what the existing primitives actually do."

| Severity | Issue | Fix |
|---|---|---|
| Critical | `disconnect_streaming({keep_signaling:true})` was still sending the `{"kind":"bye"}` relay as its first step. By the time that runs in the viewer-swap path, the backend has already moved `session.viewer` to the **new** viewer (`backend/src/codes.ts:detachViewer` does not reset `session.confirmed`), so the bye reaches the brand-new viewer and tears their session down before any offer is exchanged. | Skip the bye emission entirely when `keep_signaling = true`. |
| Important | `switch_monitor` constructed the **new** `ScreenCapturer` (which opens a fresh portal/GStreamer pipeline) **before** the old one was dropped. The old capturer only dropped on the streaming_loop's next iteration — so for the seconds the portal dialog was open, two concurrent pipelines ran. Same Plasma-misroute symptom the original chain was fighting. | Two-phase Stop/Replace protocol via the existing mpsc channel plus a oneshot ack: switch_monitor sends `Stop`, awaits the loop's ack (loop drops capturer and acks here), only THEN opens the new portal and sends `Replace`. The streaming_loop's capturer/encoder become `Option<>`; in the stopped state the loop blocks on the next message instead of looping at frame rate. |
| Important | JS `peer-joined` cleanup did `await disconnect_streaming(...)` **before** resetting `streamingReady`/`pendingOffer`/`pendingIce`. While the await was in flight, the kept-alive WS could already deliver a relay/sdp from the new viewer; the relay handler dispatched on `streamingReady` (still true) and called `receive_offer` against a just-cleared rtc_state, losing the offer silently. | Clear the flags **before** the await. |
| Important | Several lock-acquisition sites on cleanup paths used `if let Ok(mut g) = ...lock()` which silently no-ops on a poisoned mutex. Most-cited: `start_streaming`'s switch_tx install — a poisoned lock would strand the sender, and every subsequent `switch_monitor` would reply "no active stream" against a live session. | Use `lock().unwrap_or_else(\|p\| p.into_inner())` on cleanup paths so a poisoned-but-readable state still flows. |
| Nit | `AUFFI_ENABLE_RESTORE_TOKEN` was checked with `var_os(...)?` — short-circuits on missing but treats any value (including empty string) as enabled. Setting the env var to `""` to disable would have re-enabled it. | Only `"1"` and `"true"` enable. |

Cosmetic: `stopConfirmYesBtn`'s status text promised the user could "den Code erneut weitergeben" after Beenden. With the existing full-teardown semantics that's false (the WS closes, backend drops the session). Status text updated to point at the "Neuer Code" button instead. Keeping the policy ambiguity (Beenden = end-everything vs Beenden = end-current-helper-keep-code-alive) as an explicit decision the user can make later — the agent's review surfaced the trade-off, not the answer.

The takeaway from the addendum reinforces the original lesson: when a function is wired into a second caller with different intent, do the API split first. The `bye` emission, the order of capturer creation, the order of state resets, the lock-acquisition style — all assumed a single-intent contract.
