//! Persistent WSS connection for unattended mode.
//!
//! Maintains a long-lived bearer-authenticated connection to the
//! backend's `/signal` endpoint (spec section 5.3). Sends a WebSocket
//! ping every 30 s; if no pong arrives within 90 s the connection is
//! considered dead and the loop reconnects with exponential backoff
//! (1 → 2 → 4 → 8 → 16 → 32 → 60 s ceiling, with ±50 % jitter).
//!
//! Terminal close codes stop the loop:
//!   * 4401 — token revoked (DELETE /api/devices/:id) or invalid
//!   * 4408 — superseded by a newer connection for the same device-id
//!
//! Anything else (transient network drop, server restart, viewer
//! peer gone) just triggers a reconnect.
//!
//! The module exposes a command/event channel pair so the Tauri app
//! can: (a) receive incoming `pw-check` frames and route them to
//! `device_password::verify` + the manual-confirm UI, (b) send the
//! `pw-check-result`, SDP/ICE relay frames, and connection-log
//! reports back through the same socket.

// Wired into the Tauri builder by gh #20 (mode toggle); until then the
// pub surface is dead-code-allowed.
#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

/// WS close-codes we treat as "do not reconnect" — anything else is a
/// transient disconnect.
pub const WS_CLOSE_REVOKED: u16 = 4401;
pub const WS_CLOSE_SUPERSEDED: u16 = 4408;

/// Decide whether a close code means the heartbeat should stop
/// retrying. Pure for trivial unit-pinning.
pub fn should_terminate(close_code: Option<u16>) -> bool {
    matches!(
        close_code,
        Some(WS_CLOSE_REVOKED) | Some(WS_CLOSE_SUPERSEDED)
    )
}

/// Compute the backoff sleep for attempt `n` (zero-indexed). Doubles
/// each step from `initial`, caps at `max`. Pure for unit-pinning;
/// jitter is added separately by [`with_jitter`] so deterministic
/// tests can pin the base sequence.
pub fn next_backoff(attempt: u32, initial: Duration, max: Duration) -> Duration {
    if initial.is_zero() {
        return Duration::from_secs(0);
    }
    // Cap the doubling at 30 iterations to avoid u64 overflow on the
    // initial * 2^30 multiply — well past `max` for any realistic
    // input anyway.
    let shift = attempt.min(30);
    let nanos = initial.as_nanos().saturating_mul(1u128 << shift);
    let dur = Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX));
    if dur > max {
        max
    } else {
        dur
    }
}

/// Wrap a base backoff in ±50 % jitter using thread-local RNG. The
/// returned duration is in `[base/2, base + base/2]` (i.e. 0.5x .. 1.5x).
/// Splitting jitter into its own function so the deterministic backoff
/// sequence stays unit-testable.
pub fn with_jitter(base: Duration) -> Duration {
    if base.is_zero() {
        return base;
    }
    let half = base / 2;
    let extra_nanos = half.as_nanos() as u64;
    // Cheap "pretty random" source — getrandom for one u64.
    let mut buf = [0u8; 8];
    if getrandom::fill(&mut buf).is_err() {
        return base; // fall back if entropy source unavailable
    }
    let r = u64::from_le_bytes(buf);
    let jitter_nanos = r % extra_nanos.max(1);
    base - half + Duration::from_nanos(jitter_nanos)
}

#[derive(Debug, Clone)]
pub struct HeartbeatConfig {
    /// `wss://host/signal` (or `ws://…` in dev). Trailing slash is OK.
    pub backend_ws_url: String,
    /// 9-digit `NNN-NNN-NNN` device-id from `account::read_device_id`.
    pub device_id: String,
    /// Bearer token from `account::KeyringTokenStore::read`.
    pub token: String,
    /// `Origin` header — the backend's `verifyClient` requires one
    /// from `ALLOWED_ORIGINS`. Default derived from `backend_ws_url`.
    pub origin: String,
    pub ping_interval: Duration,
    pub pong_timeout: Duration,
    pub backoff_initial: Duration,
    pub backoff_max: Duration,
}

impl HeartbeatConfig {
    /// Tuned for the production spec: 30 s ping, 90 s pong-timeout,
    /// 1 s..60 s backoff window.
    pub fn production(backend_ws_url: String, device_id: String, token: String) -> Self {
        let origin = derive_origin(&backend_ws_url);
        Self {
            backend_ws_url,
            device_id,
            token,
            origin,
            ping_interval: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(90),
            backoff_initial: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
        }
    }
}

/// Mirror of the backend's `OutgoingMessage` types from
/// `backend/src/protocol.ts`, restricted to the unattended subset.
/// Internally-tagged on `"type"` so serde matches each variant on
/// the wire `{ "type": "unattended-hello", … }` shape.
#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum BackendFrame {
    /// `{"type":"unattended-hello","deviceId":"..."}` — TS sends
    /// camelCase fields, hence per-variant rename_all.
    #[serde(rename = "unattended-hello", rename_all = "camelCase")]
    UnattendedHello { device_id: String },
    /// gh #25: `auto_accept` from the device row, threaded through
    /// on every pw-check so a dashboard toggle takes effect without
    /// sharer reconnect. False → caller shows a confirm toast after
    /// argon2-verify succeeds.
    #[serde(rename = "pw-check", rename_all = "camelCase")]
    PwCheck { attempt: String, auto_accept: bool },
    /// `{"type":"peer-joined","viewerInfo":{...}}`
    #[serde(rename = "peer-joined", rename_all = "camelCase")]
    PeerJoined { viewer_info: serde_json::Value },
    #[serde(rename = "peer-rejected")]
    PeerRejected { reason: String },
    #[serde(rename = "relay")]
    Relay { payload: serde_json::Value },
    /// Backend may emit `error` for protocol violations — we surface
    /// them as Disconnected so the UI gets a clear message.
    #[serde(rename = "error")]
    BackendError { code: String, message: String },
}

/// Outgoing wire-shape, mirrors backend `IncomingMessage` types.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SharerFrame {
    #[serde(rename = "pw-check-result")]
    PwCheckResult { result: PwResult },
    #[serde(rename = "connection-started")]
    ConnectionStarted {
        #[serde(rename = "connectionType")]
        connection_type: ConnectionType,
    },
    #[serde(rename = "connection-ended")]
    ConnectionEnded {
        #[serde(rename = "bytesRelayed")]
        bytes_relayed: u64,
    },
    #[serde(rename = "relay")]
    Relay { payload: serde_json::Value },
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PwResult {
    Ok,
    Fail,
    Rejected,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionType {
    P2p,
    Relay,
}

/// What the heartbeat loop emits to the Tauri-side app. Consumed via
/// the receiver returned from [`start`].
#[derive(Debug, Clone)]
pub enum HeartbeatEvent {
    /// Bearer auth succeeded; the WSS is live and ready to receive
    /// pw-check frames. `device_id` is echoed from the backend.
    Connected { device_id: String },
    /// Viewer is attempting an unattended connect — verify locally,
    /// reply via `SharerFrame::PwCheckResult`. `auto_accept` mirrors
    /// `devices.auto_accept`; the caller uses it to choose between
    /// auto-replying Ok or showing a manual-confirm toast.
    PwCheck { attempt: String, auto_accept: bool },
    /// After `PwCheckResult::Ok`, the backend pairs viewer+sharer
    /// and forwards this. The sharer should now start the WebRTC
    /// offer (same as the ad-hoc `peer-joined`).
    PeerJoined { viewer_info: serde_json::Value },
    /// Viewer-side hangup / rejection.
    PeerRejected { reason: String },
    /// SDP / ICE / hello / bye relay from the viewer.
    Relay { payload: serde_json::Value },
    /// Lost the connection — heartbeat will retry. `reason` is for
    /// `dbg_log`, NOT user-facing.
    Disconnected { reason: String },
    /// Scheduled reconnect attempt `n` after `after` of backoff.
    Reconnecting { after: Duration, attempt: u32 },
    /// Backend closed us with 4401: token revoked or invalid.
    /// Terminal — the loop has stopped. Caller should remove the
    /// stored token and prompt the user to re-pair.
    Revoked,
    /// Backend closed us with 4408: another instance has taken over
    /// this device-id. Terminal.
    Superseded,
}

/// Commands the caller sends INTO the heartbeat task to forward over
/// the live WSS.
#[derive(Debug, Clone)]
pub enum HeartbeatCommand {
    Send(SharerFrame),
    /// Cleanly stop the loop and close the WSS.
    Shutdown,
}

/// Command sender returned by [`start`]. Holding one of these is the
/// "the heartbeat task is alive" signal — drop it AND let the task
/// observe a closed channel to stop, OR send `Shutdown` for a clean
/// close. Cheap to clone.
pub type HeartbeatCommands = mpsc::Sender<HeartbeatCommand>;

/// Event receiver returned by [`start`]. The caller drains it on a
/// background task (typically the forwarder in `unattended_cmd.rs`).
/// Single-consumer by construction.
pub type HeartbeatEvents = mpsc::Receiver<HeartbeatEvent>;

/// Spawn the heartbeat onto the caller's tokio runtime (the same
/// long-lived `tauri::async_runtime` we use for portal handshake,
/// per postmortem-2026-05-13).
///
/// CQ H-2/H-3 (review 2026-05-13): returns a `(Commands, Events)`
/// pair instead of a single `HeartbeatHandle` struct. The prior
/// struct shape forced callers to store a half-empty placeholder in
/// state (the events Receiver had to be moved into the forwarder,
/// leaving a `dummy_receiver()` behind in the slot). With the pair
/// split, app state holds only the `Commands` half and the
/// `Events` flows straight into the consumer.
pub fn start(config: HeartbeatConfig) -> (HeartbeatCommands, HeartbeatEvents) {
    let (cmd_tx, cmd_rx) = mpsc::channel::<HeartbeatCommand>(16);
    let (evt_tx, evt_rx) = mpsc::channel::<HeartbeatEvent>(64);
    let cmd_rx = Arc::new(Mutex::new(cmd_rx));
    tauri::async_runtime::spawn(run_loop(config, cmd_rx, evt_tx));
    (cmd_tx, evt_rx)
}

fn derive_origin(ws_url: &str) -> String {
    if let Ok(custom) = std::env::var("AUFFI_SHARER_ORIGIN") {
        return custom;
    }
    if let Some(rest) = ws_url.strip_prefix("wss://") {
        let host = rest.split('/').next().unwrap_or(rest);
        return format!("https://{host}");
    }
    if let Some(rest) = ws_url.strip_prefix("ws://") {
        let host = rest.split('/').next().unwrap_or(rest);
        return format!("http://{host}");
    }
    "http://localhost".to_string()
}

async fn run_loop(
    config: HeartbeatConfig,
    cmd_rx: Arc<Mutex<mpsc::Receiver<HeartbeatCommand>>>,
    evt_tx: mpsc::Sender<HeartbeatEvent>,
) {
    let mut attempt: u32 = 0;
    loop {
        match connect_and_run(&config, &cmd_rx, &evt_tx).await {
            ConnectOutcome::Revoked => {
                let _ = evt_tx.send(HeartbeatEvent::Revoked).await;
                return;
            }
            ConnectOutcome::Superseded => {
                let _ = evt_tx.send(HeartbeatEvent::Superseded).await;
                return;
            }
            ConnectOutcome::Shutdown => {
                return;
            }
            ConnectOutcome::Disconnected { reason } => {
                let _ = evt_tx.send(HeartbeatEvent::Disconnected { reason }).await;
            }
        }

        let base = next_backoff(attempt, config.backoff_initial, config.backoff_max);
        let sleep = with_jitter(base);
        let _ = evt_tx
            .send(HeartbeatEvent::Reconnecting {
                after: sleep,
                attempt: attempt + 1,
            })
            .await;

        // Wait either for the backoff to elapse OR for an explicit
        // shutdown command. We don't want a Shutdown to wait 60 s.
        let stopped = {
            let mut rx = cmd_rx.lock().await;
            tokio::select! {
                _ = tokio::time::sleep(sleep) => false,
                cmd = rx.recv() => matches!(cmd, Some(HeartbeatCommand::Shutdown) | None),
            }
        };
        if stopped {
            return;
        }
        attempt = attempt.saturating_add(1);
    }
}

enum ConnectOutcome {
    /// Authoritative "do not reconnect": 4401 token revoked.
    Revoked,
    /// Authoritative "do not reconnect": 4408 superseded by newer.
    Superseded,
    /// Caller asked us to stop.
    Shutdown,
    /// Transient — reconnect after backoff.
    Disconnected { reason: String },
}

async fn connect_and_run(
    config: &HeartbeatConfig,
    cmd_rx: &Arc<Mutex<mpsc::Receiver<HeartbeatCommand>>>,
    evt_tx: &mpsc::Sender<HeartbeatEvent>,
) -> ConnectOutcome {
    let mut request = match config.backend_ws_url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => {
            return ConnectOutcome::Disconnected {
                reason: format!("invalid ws url: {e}"),
            };
        }
    };
    let headers = request.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&config.origin) {
        headers.insert("Origin", v);
    }
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", config.token)) {
        headers.insert("Authorization", v);
    }
    if let Ok(v) = HeaderValue::from_str(&config.device_id) {
        headers.insert("X-Auffi-Device-Id", v);
    }

    let (ws, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(v) => v,
        Err(e) => {
            return ConnectOutcome::Disconnected {
                reason: format!("connect: {e}"),
            };
        }
    };
    let (mut write, mut read) = ws.split();
    let mut ping_timer = tokio::time::interval(config.ping_interval);
    ping_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // First tick fires immediately; skip it so we don't burn a ping
    // on a freshly-opened socket.
    ping_timer.tick().await;
    let mut last_pong = tokio::time::Instant::now();

    loop {
        let mut rx = cmd_rx.lock().await;
        tokio::select! {
            biased;
            cmd = rx.recv() => {
                match cmd {
                    Some(HeartbeatCommand::Send(frame)) => {
                        let json = match serde_json::to_string(&frame) {
                            Ok(s) => s,
                            Err(e) => {
                                return ConnectOutcome::Disconnected {
                                    reason: format!("serialise outgoing: {e}"),
                                };
                            }
                        };
                        if write.send(Message::Text(json.into())).await.is_err() {
                            return ConnectOutcome::Disconnected {
                                reason: "write half closed".to_string(),
                            };
                        }
                    }
                    Some(HeartbeatCommand::Shutdown) | None => {
                        let _ = write.send(Message::Close(None)).await;
                        return ConnectOutcome::Shutdown;
                    }
                }
            }
            msg = read.next() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => {
                        return ConnectOutcome::Disconnected {
                            reason: format!("read: {e}"),
                        };
                    }
                    None => {
                        return ConnectOutcome::Disconnected {
                            reason: "socket EOF".to_string(),
                        };
                    }
                };
                match msg {
                    Message::Text(txt) => {
                        if let Ok(frame) = serde_json::from_str::<BackendFrame>(&txt) {
                            match frame {
                                BackendFrame::UnattendedHello { device_id } => {
                                    let _ = evt_tx
                                        .send(HeartbeatEvent::Connected { device_id })
                                        .await;
                                }
                                BackendFrame::PwCheck {
                                    attempt,
                                    auto_accept,
                                } => {
                                    let _ = evt_tx
                                        .send(HeartbeatEvent::PwCheck {
                                            attempt,
                                            auto_accept,
                                        })
                                        .await;
                                }
                                BackendFrame::PeerJoined { viewer_info } => {
                                    let _ = evt_tx
                                        .send(HeartbeatEvent::PeerJoined { viewer_info })
                                        .await;
                                }
                                BackendFrame::PeerRejected { reason } => {
                                    let _ = evt_tx
                                        .send(HeartbeatEvent::PeerRejected { reason })
                                        .await;
                                }
                                BackendFrame::Relay { payload } => {
                                    let _ = evt_tx
                                        .send(HeartbeatEvent::Relay { payload })
                                        .await;
                                }
                                BackendFrame::BackendError { code, message } => {
                                    return ConnectOutcome::Disconnected {
                                        reason: format!("backend error {code}: {message}"),
                                    };
                                }
                            }
                        }
                        // Unknown frame: ignore. New backend message
                        // types should not crash an old sharer build.
                    }
                    Message::Pong(_) => {
                        last_pong = tokio::time::Instant::now();
                    }
                    Message::Ping(payload) => {
                        // Tungstenite normally auto-pongs, but only
                        // when the read half is polled — which it is
                        // here. Reply explicitly anyway to stay
                        // resilient against runtime-version drift.
                        let _ = write.send(Message::Pong(payload)).await;
                    }
                    Message::Close(frame) => {
                        let code = frame.as_ref().map(|f| u16::from(f.code));
                        if should_terminate(code) {
                            return match code {
                                Some(WS_CLOSE_REVOKED) => ConnectOutcome::Revoked,
                                Some(WS_CLOSE_SUPERSEDED) => ConnectOutcome::Superseded,
                                _ => ConnectOutcome::Disconnected {
                                    reason: "terminal close".to_string(),
                                },
                            };
                        }
                        return ConnectOutcome::Disconnected {
                            reason: close_reason(frame.as_ref()),
                        };
                    }
                    Message::Binary(_) | Message::Frame(_) => {
                        // Ignore — backend never sends binary on
                        // /signal.
                    }
                }
            }
            _ = ping_timer.tick() => {
                if last_pong.elapsed() > config.pong_timeout {
                    return ConnectOutcome::Disconnected {
                        reason: format!(
                            "no pong for {:.0}s",
                            last_pong.elapsed().as_secs_f64()
                        ),
                    };
                }
                if write.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return ConnectOutcome::Disconnected {
                        reason: "write half closed during ping".to_string(),
                    };
                }
            }
        }
    }
}

fn close_reason(frame: Option<&CloseFrame>) -> String {
    match frame {
        Some(f) => format!("close code={} reason={:?}", u16::from(f.code), f.reason),
        None => "close without frame".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Pure helpers ────────────────────────────────────────────────

    #[test]
    fn should_terminate_recognises_4401_and_4408() {
        assert!(should_terminate(Some(WS_CLOSE_REVOKED)));
        assert!(should_terminate(Some(WS_CLOSE_SUPERSEDED)));
    }

    #[test]
    fn should_terminate_keeps_transient_codes_retryable() {
        for code in [
            None,
            Some(1000),
            Some(1001),
            Some(1006),
            Some(4000),
            Some(4500),
        ] {
            assert!(!should_terminate(code), "expected {code:?} to be retryable");
        }
    }

    #[test]
    fn next_backoff_doubles_until_max() {
        let initial = Duration::from_secs(1);
        let max = Duration::from_secs(60);
        assert_eq!(next_backoff(0, initial, max), Duration::from_secs(1));
        assert_eq!(next_backoff(1, initial, max), Duration::from_secs(2));
        assert_eq!(next_backoff(2, initial, max), Duration::from_secs(4));
        assert_eq!(next_backoff(3, initial, max), Duration::from_secs(8));
        assert_eq!(next_backoff(4, initial, max), Duration::from_secs(16));
        assert_eq!(next_backoff(5, initial, max), Duration::from_secs(32));
        assert_eq!(next_backoff(6, initial, max), max);
        assert_eq!(next_backoff(7, initial, max), max);
        assert_eq!(next_backoff(99, initial, max), max);
    }

    #[test]
    fn next_backoff_handles_zero_initial() {
        assert_eq!(
            next_backoff(5, Duration::from_secs(0), Duration::from_secs(60)),
            Duration::from_secs(0)
        );
    }

    #[test]
    fn next_backoff_does_not_overflow_on_huge_attempt() {
        // shift > 30 is clamped; result still bounded by max.
        let max = Duration::from_secs(60);
        assert_eq!(next_backoff(u32::MAX, Duration::from_secs(1), max), max);
    }

    #[test]
    fn with_jitter_stays_inside_half_to_one_and_a_half_window() {
        let base = Duration::from_millis(1000);
        for _ in 0..50 {
            let j = with_jitter(base);
            assert!(j >= Duration::from_millis(500), "j={j:?} below 0.5x");
            assert!(j <= Duration::from_millis(1500), "j={j:?} above 1.5x");
        }
    }

    #[test]
    fn with_jitter_zero_base_returns_zero() {
        assert_eq!(with_jitter(Duration::from_secs(0)), Duration::from_secs(0));
    }

    // ── Wire-shape round-trips ───────────────────────────────────────

    #[test]
    fn outgoing_pw_check_result_matches_backend_wire_shape() {
        let frame = SharerFrame::PwCheckResult {
            result: PwResult::Ok,
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert_eq!(json, r#"{"type":"pw-check-result","result":"ok"}"#);
    }

    #[test]
    fn outgoing_connection_started_uses_camelcase_field() {
        let frame = SharerFrame::ConnectionStarted {
            connection_type: ConnectionType::P2p,
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert_eq!(
            json,
            r#"{"type":"connection-started","connectionType":"p2p"}"#
        );
    }

    #[test]
    fn outgoing_connection_ended_carries_bytes_relayed() {
        let frame = SharerFrame::ConnectionEnded {
            bytes_relayed: 4096,
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert_eq!(json, r#"{"type":"connection-ended","bytesRelayed":4096}"#);
    }

    #[test]
    fn incoming_pw_check_parses_with_auto_accept() {
        let raw = r#"{"type":"pw-check","attempt":"hunter2","autoAccept":true}"#;
        let parsed: BackendFrame = serde_json::from_str(raw).unwrap();
        match parsed {
            BackendFrame::PwCheck {
                attempt,
                auto_accept,
            } => {
                assert_eq!(attempt, "hunter2");
                assert!(auto_accept);
            }
            other => panic!("expected PwCheck, got {other:?}"),
        }
    }

    #[test]
    fn incoming_pw_check_with_auto_accept_false() {
        // gh #25: when the dashboard turns auto-accept off, every
        // pw-check arrives with `autoAccept: false` and the sharer
        // should show the manual-confirm toast.
        let raw = r#"{"type":"pw-check","attempt":"hunter2","autoAccept":false}"#;
        let parsed: BackendFrame = serde_json::from_str(raw).unwrap();
        match parsed {
            BackendFrame::PwCheck { auto_accept, .. } => assert!(!auto_accept),
            other => panic!("expected PwCheck, got {other:?}"),
        }
    }

    #[test]
    fn incoming_unattended_hello_parses() {
        let raw = r#"{"type":"unattended-hello","deviceId":"123-456-789"}"#;
        let parsed: BackendFrame = serde_json::from_str(raw).unwrap();
        match parsed {
            BackendFrame::UnattendedHello { device_id } => {
                assert_eq!(device_id, "123-456-789");
            }
            other => panic!("expected UnattendedHello, got {other:?}"),
        }
    }

    #[test]
    fn incoming_peer_joined_parses_camelcase_viewer_info() {
        // backend/src/signaling.ts sends viewerInfo (camelCase). If
        // that drifts to snake_case, this fails before we ship.
        let raw = r#"{"type":"peer-joined","viewerInfo":{"ipPrefix":"84.xxx","country":null}}"#;
        let parsed: BackendFrame = serde_json::from_str(raw).unwrap();
        match parsed {
            BackendFrame::PeerJoined { viewer_info } => {
                assert_eq!(viewer_info["ipPrefix"], "84.xxx");
            }
            other => panic!("expected PeerJoined, got {other:?}"),
        }
    }

    #[test]
    fn incoming_relay_parses() {
        let raw =
            r#"{"type":"relay","payload":{"kind":"sdp","sdp":{"type":"offer","sdp":"v=0\n"}}}"#;
        let parsed: BackendFrame = serde_json::from_str(raw).unwrap();
        match parsed {
            BackendFrame::Relay { payload } => {
                assert_eq!(payload["kind"], "sdp");
            }
            other => panic!("expected Relay, got {other:?}"),
        }
    }

    #[test]
    fn derive_origin_strips_path_keeps_host() {
        std::env::remove_var("AUFFI_SHARER_ORIGIN");
        assert_eq!(derive_origin("wss://auffi.app/signal"), "https://auffi.app");
        assert_eq!(
            derive_origin("ws://localhost:8080/signal"),
            "http://localhost:8080"
        );
    }
}
