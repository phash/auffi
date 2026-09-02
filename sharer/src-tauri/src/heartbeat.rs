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
//! 4429 — the backend's per-IP bearer cap tripped — is transient but
//! special: the loop reconnects at the backoff CEILING (no ladder reset)
//! so a fleet behind one NAT spreads out instead of re-tripping the cap.
//! Anything else (transient network drop, server restart, viewer
//! peer gone) just triggers a reconnect.
//!
//! Outbound frames queued before `unattended-hello` arrives are held and
//! flushed in order right after it: the backend answers any earlier frame
//! with a fatal `error bad-message` (docs/protocol.md § Sharer connect).
//!
//! The module exposes a command/event channel pair so the Tauri app
//! can: (a) receive incoming `pw-check` frames and route them to
//! `device_password::verify` + the manual-confirm UI, (b) send the
//! `pw-check-result`, SDP/ICE relay frames, and TURN-credential
//! requests back through the same socket.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

/// WS close-codes we treat as "do not reconnect" — anything else is a
/// transient disconnect.
pub const WS_CLOSE_REVOKED: u16 = 4401;
pub const WS_CLOSE_SUPERSEDED: u16 = 4408;
/// Backend's per-IP bearer-auth cap tripped (docs/protocol.md § WebSocket
/// close codes). Transient — see [`is_rate_limited_close`].
pub const WS_CLOSE_RATE_LIMITED: u16 = 4429;

/// Reason string the backend attaches to a rate-limited close. Backends up
/// to 0.7.0 sent it with code 4401, so it is the only way to tell a capped
/// upgrade from a real revocation against those.
const RATE_LIMIT_CLOSE_REASON: &str = "rate limit";

/// Decide whether a close code means the heartbeat should stop
/// retrying. Pure for trivial unit-pinning.
pub fn should_terminate(close_code: Option<u16>) -> bool {
    matches!(
        close_code,
        Some(WS_CLOSE_REVOKED) | Some(WS_CLOSE_SUPERSEDED)
    )
}

/// Whether a close frame means "the backend's bearer cap is exhausted for
/// this IP right now". Checked BEFORE [`should_terminate`]: a 4401 whose
/// reason is "rate limit" came from a pre-0.7.1 backend and must not be
/// mistaken for a revocation — nothing was revoked, and an unattended
/// machine that stops retrying stays offline until somebody re-pairs it.
pub fn is_rate_limited_close(close_code: Option<u16>, reason: &str) -> bool {
    match close_code {
        Some(WS_CLOSE_RATE_LIMITED) => true,
        Some(WS_CLOSE_REVOKED) => reason == RATE_LIMIT_CLOSE_REASON,
        _ => false,
    }
}

/// Smallest attempt index whose [`next_backoff`] already sits at `max`.
/// Used to park the ladder at the ceiling after a rate-limited close.
/// Capped at the same 30 doublings `next_backoff` clamps to, so a
/// degenerate zero `initial` cannot loop.
pub fn attempts_to_reach_max(initial: Duration, max: Duration) -> u32 {
    (0..=30u32)
        .find(|n| next_backoff(*n, initial, max) >= max)
        .unwrap_or(30)
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
/// returned duration is in `[base/2, base + base/2)` (i.e. 0.5x .. 1.5x).
/// Splitting jitter into its own function so the deterministic backoff
/// sequence stays unit-testable.
pub fn with_jitter(base: Duration) -> Duration {
    if base.is_zero() {
        return base;
    }
    let half = base / 2;
    // The jitter draw spans the FULL base width so `base - half + r`
    // covers the documented ±50 % window. u128→u64 via try_from so a
    // pathological `base` (years long) can't silently truncate; any
    // realistic Duration is ≪ u64::MAX nanos (~584 years), but the
    // explicit fallback matches the convention in `next_backoff`.
    let extra_nanos = u64::try_from(base.as_nanos()).unwrap_or(u64::MAX);
    // Cheap "pretty random" source — getrandom for one u64.
    let mut buf = [0u8; 8];
    if let Err(e) = getrandom::fill(&mut buf) {
        // Entropy source unavailable. Falling back to deterministic
        // `base` keeps the heartbeat alive, but reconnect-jitter is
        // gone for this attempt — log so a host with a broken
        // /dev/urandom doesn't fail silently.
        log::warn!("[heartbeat] jitter: getrandom failed — no jitter on this attempt: {e}");
        return base;
    }
    let r = u64::from_le_bytes(buf);
    let jitter_nanos = r % extra_nanos.max(1);
    base - half + Duration::from_nanos(jitter_nanos)
}

#[derive(Clone)]
pub struct HeartbeatConfig {
    /// `wss://host/signal` (or `ws://…` in dev). Trailing slash is OK.
    pub backend_ws_url: String,
    /// 9-digit `NNN-NNN-NNN` device-id from `account::read_device_id`.
    pub device_id: String,
    /// Bearer token from `account::KeyringTokenStore::read`. Never
    /// printed — see the hand-written `Debug` below.
    pub token: String,
    /// `Origin` header — the backend's `verifyClient` requires one
    /// from `ALLOWED_ORIGINS`. Default derived from `backend_ws_url`.
    pub origin: String,
    pub ping_interval: Duration,
    pub pong_timeout: Duration,
    pub backoff_initial: Duration,
    pub backoff_max: Duration,
}

/// Hand-written so a `{:?}` of the config on some future error path
/// cannot put the long-lived device token into `auffi-debug.log`
/// (no-secrets-in-logs rule).
impl std::fmt::Debug for HeartbeatConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HeartbeatConfig")
            .field("backend_ws_url", &self.backend_ws_url)
            .field("device_id", &self.device_id)
            .field(
                "token",
                &format_args!("<redacted, {} bytes>", self.token.len()),
            )
            .field("origin", &self.origin)
            .field("ping_interval", &self.ping_interval)
            .field("pong_timeout", &self.pong_timeout)
            .field("backoff_initial", &self.backoff_initial)
            .field("backoff_max", &self.backoff_max)
            .finish()
    }
}

impl HeartbeatConfig {
    /// Tuned for the production spec: 30 s ping, 90 s pong-timeout,
    /// 1 s..60 s backoff window.
    pub fn production(backend_ws_url: String, device_id: String, token: String) -> Self {
        let origin = crate::backend_urls::origin_from_ws(&backend_ws_url);
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
    ///
    /// `attempt_id` is the backend-minted correlation id echoed in
    /// [`SharerFrame::PwCheckResult`] (F053). Optional so a backend
    /// predating it still parses — the sharer then answers without one.
    #[serde(rename = "pw-check", rename_all = "camelCase")]
    PwCheck {
        attempt: String,
        auto_accept: bool,
        #[serde(default)]
        attempt_id: Option<u64>,
    },
    /// `{"type":"peer-joined","viewerInfo":{...}}` — the viewer info is
    /// for the ad-hoc confirm dialog; the unattended flow confirmed before
    /// this frame (pw-check), so it is not carried further here.
    #[serde(rename = "peer-joined")]
    PeerJoined,
    #[serde(rename = "relay")]
    Relay { payload: serde_json::Value },
    /// Reply to `SharerFrame::TurnCredentialsRequest`. `credentials`
    /// is `null` when the backend has no TURN configured — the sharer
    /// then builds its peer STUN-less, exactly like a failed HTTP
    /// fetch on the ad-hoc path.
    #[serde(rename = "turn-credentials")]
    TurnCredentials {
        credentials: Option<crate::turn_config::TurnCredentials>,
    },
    /// Backend may emit `error` for protocol violations — we surface
    /// them as Disconnected so the UI gets a clear message.
    #[serde(rename = "error")]
    BackendError { code: String, message: String },
}

/// Outgoing wire-shape, mirrors backend `IncomingMessage` types.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SharerFrame {
    /// `attempt_id` echoes the `pw-check` this answers so the backend
    /// can drop a result that belongs to an attempt it no longer holds
    /// (F053). `None` only when the backend sent no id.
    #[serde(rename = "pw-check-result", rename_all = "camelCase")]
    PwCheckResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        attempt_id: Option<u64>,
        result: PwResult,
    },
    #[serde(rename = "relay")]
    Relay { payload: serde_json::Value },
    /// Ask the backend for ephemeral TURN credentials before building
    /// the WebRTC peer for an unattended session (the ad-hoc path
    /// fetches the same credentials via POST /turn-credentials; the
    /// unattended sharer has no session code, but its WSS is already
    /// bearer-authenticated). Answered with
    /// `BackendFrame::TurnCredentials`.
    #[serde(rename = "turn-credentials-request")]
    TurnCredentialsRequest,
    /// Unattended telemetry (gh #109). Sent once ICE settles and the media
    /// path is known; the backend opens a `connection_log` row for the
    /// device. The ad-hoc path sends nothing — that table is keyed by
    /// device and an ad-hoc session has none.
    #[serde(rename = "connection-started", rename_all = "camelCase")]
    ConnectionStarted { connection_type: ConnectionKind },
    /// Closes the row opened by [`SharerFrame::ConnectionStarted`] with the
    /// bytes this session pushed through the track.
    #[serde(rename = "connection-ended", rename_all = "camelCase")]
    ConnectionEnded { bytes_relayed: u64 },
}

/// Negotiated media path, as the backend's `connectionType` field spells it.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind {
    P2p,
    Relay,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PwResult {
    Ok,
    Fail,
    Rejected,
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
    /// auto-replying Ok or showing a manual-confirm toast. `attempt_id`
    /// must be echoed in the reply.
    PwCheck {
        attempt: String,
        auto_accept: bool,
        attempt_id: Option<u64>,
    },
    /// After `PwCheckResult::Ok`, the backend pairs viewer+sharer
    /// and forwards this. The sharer should now start the WebRTC
    /// offer (same as the ad-hoc `peer-joined`). Viewer loss is
    /// signalled via a (possibly backend-synthesized) relay `bye`,
    /// never via a sharer-directed peer-rejected.
    PeerJoined,
    /// SDP / ICE / hello / bye relay from the viewer.
    Relay { payload: serde_json::Value },
    /// Backend's answer to `SharerFrame::TurnCredentialsRequest`.
    /// `None` = backend has no TURN configured; proceed STUN-less.
    TurnCredentials {
        credentials: Option<crate::turn_config::TurnCredentials>,
    },
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
    // CQ M-25 (review 2026-05-13): `cmd_rx` used to be wrapped in
    // `Arc<Mutex<…>>` so it could be re-locked from both the outer
    // backoff-sleep branch and the inner connect-and-run loop. Those
    // two branches are strictly sequential (connect_and_run always
    // returns before the backoff branch runs), so we can just keep
    // the Receiver owned by run_loop and hand a `&mut` to the inner
    // function. No mutex, no Arc, no `lock().await` on the hot path.
    tauri::async_runtime::spawn(run_loop(config, cmd_rx, evt_tx));
    (cmd_tx, evt_rx)
}

async fn run_loop(
    config: HeartbeatConfig,
    mut cmd_rx: mpsc::Receiver<HeartbeatCommand>,
    evt_tx: mpsc::Sender<HeartbeatEvent>,
) {
    let mut attempt: u32 = 0;
    loop {
        match connect_and_run(&config, &mut cmd_rx, &evt_tx).await {
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
            ConnectOutcome::Disconnected {
                reason,
                hello_seen,
                rate_limited,
            } => {
                if rate_limited {
                    // The cap is per IP and shared by every device behind
                    // the same NAT; a fast retry re-trips it for all of
                    // them. Park at the ceiling (±50 % jitter spreads the
                    // fleet) and never restart the ladder here — a session
                    // that reached hello and then got capped on the way
                    // back would otherwise come back at 1 s.
                    attempt = attempt.max(attempts_to_reach_max(
                        config.backoff_initial,
                        config.backoff_max,
                    ));
                    log::warn!("[heartbeat] backend rate-limited the bearer upgrade — retrying at max backoff");
                } else if hello_seen {
                    // A session that reached unattended-hello was a real
                    // connection — restart the backoff ladder from the
                    // bottom instead of ratcheting toward the 60 s ceiling
                    // over the process lifetime (product goal 2: reconnect
                    // latency after a blip must not depend on blip history).
                    attempt = 0;
                }
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
        // shutdown command. We don't want a Shutdown to wait 60 s —
        // but a queued Send must NOT shortcut the sleep: the frame is
        // undeliverable while disconnected (dropped, with a log note),
        // and cancelling the remaining backoff would turn queued frames
        // into a reconnect burst exactly when the server is unreachable.
        let deadline = tokio::time::Instant::now() + sleep;
        let stopped = loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => break false,
                cmd = cmd_rx.recv() => match cmd {
                    Some(HeartbeatCommand::Send(_)) => {
                        log::debug!(
                            "[heartbeat] dropping outbound frame — disconnected, backoff in progress"
                        );
                    }
                    Some(HeartbeatCommand::Shutdown) | None => break true,
                },
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
    /// Transient — reconnect after backoff. `hello_seen` is true when
    /// the session reached `unattended-hello` before dropping, so the
    /// caller can reset the backoff ladder after a real connection.
    /// `rate_limited` marks a close the backend's per-IP bearer cap
    /// caused (4429, or a legacy 4401 + "rate limit"); the caller then
    /// parks the ladder at the ceiling instead.
    Disconnected {
        reason: String,
        hello_seen: bool,
        rate_limited: bool,
    },
}

async fn connect_and_run(
    config: &HeartbeatConfig,
    cmd_rx: &mut mpsc::Receiver<HeartbeatCommand>,
    evt_tx: &mpsc::Sender<HeartbeatEvent>,
) -> ConnectOutcome {
    let mut request = match config.backend_ws_url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => {
            return ConnectOutcome::Disconnected {
                reason: format!("invalid ws url: {e}"),
                hello_seen: false,
                rate_limited: false,
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

    // Merged trust anchors (OS store + bundled) rather than the crate's
    // native-roots default — see src/tls_roots.rs for the Windows failure
    // that made the app unusable on machines with a lazily-populated store.
    let (ws, _) = match tokio_tungstenite::connect_async_tls_with_config(
        request,
        None,
        false,
        Some(crate::tls_roots::connector()),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            return ConnectOutcome::Disconnected {
                reason: format!("connect: {e}"),
                hello_seen: false,
                rate_limited: false,
            };
        }
    };
    let mut hello_seen = false;
    // Frames the app hands us while the backend's argon2 verify is still
    // running. Bounded so a proxy that keeps a never-verified socket open
    // cannot grow it; whatever is left when this function returns is
    // undeliverable and dropped, like Sends during the backoff sleep.
    let mut pre_hello: Vec<SharerFrame> = Vec::new();
    let (mut write, mut read) = ws.split();
    let mut ping_timer = tokio::time::interval(config.ping_interval);
    ping_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // First tick fires immediately; skip it so we don't burn a ping
    // on a freshly-opened socket.
    ping_timer.tick().await;
    let mut last_pong = tokio::time::Instant::now();

    loop {
        tokio::select! {
            biased;
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(HeartbeatCommand::Send(frame)) => {
                        if !hello_seen {
                            if pre_hello.len() >= PRE_HELLO_BUFFER_MAX {
                                log::warn!(
                                    "[heartbeat] pre-hello buffer full — dropping the oldest outbound frame"
                                );
                                pre_hello.remove(0);
                            }
                            pre_hello.push(frame);
                            continue;
                        }
                        if let Err(reason) = write_frame(&mut write, &frame).await {
                            return ConnectOutcome::Disconnected {
                                reason,
                                hello_seen,
                                rate_limited: false,
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
                            hello_seen,
                            rate_limited: false,
                        };
                    }
                    None => {
                        return ConnectOutcome::Disconnected {
                            reason: "socket EOF".to_string(),
                            hello_seen,
                            rate_limited: false,
                        };
                    }
                };
                match msg {
                    Message::Text(txt) => {
                        // CQ M-26 (review 2026-05-13): log parse errors
                        // explicitly so a wire-protocol mismatch
                        // doesn't manifest as a silent stall. The
                        // `serde_json::from_str` path returns the
                        // SAME Err for "unknown variant" and
                        // "malformed JSON"; we log both at warn level
                        // — a new backend message type ought to land
                        // in BackendFrame, not arrive unannounced.
                        let frame = match serde_json::from_str::<BackendFrame>(&txt) {
                            Ok(f) => f,
                            Err(e) => {
                                log::warn!("[heartbeat] {}", describe_parse_failure(&txt, &e));
                                continue;
                            }
                        };
                        match frame {
                            BackendFrame::UnattendedHello { device_id } => {
                                    hello_seen = true;
                                    for frame in pre_hello.drain(..) {
                                        if let Err(reason) = write_frame(&mut write, &frame).await {
                                            return ConnectOutcome::Disconnected {
                                                reason,
                                                hello_seen,
                                                rate_limited: false,
                                            };
                                        }
                                    }
                                    let _ = evt_tx
                                        .send(HeartbeatEvent::Connected { device_id })
                                        .await;
                                }
                                BackendFrame::PwCheck {
                                    attempt,
                                    auto_accept,
                                    attempt_id,
                                } => {
                                    let _ = evt_tx
                                        .send(HeartbeatEvent::PwCheck {
                                            attempt,
                                            auto_accept,
                                            attempt_id,
                                        })
                                        .await;
                                }
                                BackendFrame::PeerJoined => {
                                    let _ = evt_tx.send(HeartbeatEvent::PeerJoined).await;
                                }
                                BackendFrame::Relay { payload } => {
                                    let _ = evt_tx
                                        .send(HeartbeatEvent::Relay { payload })
                                        .await;
                                }
                                BackendFrame::TurnCredentials { credentials } => {
                                    let _ = evt_tx
                                        .send(HeartbeatEvent::TurnCredentials { credentials })
                                        .await;
                                }
                                BackendFrame::BackendError { code, message } => {
                                    return ConnectOutcome::Disconnected {
                                        reason: format!("backend error {code}: {message}"),
                                        hello_seen,
                                        rate_limited: false,
                                    };
                                }
                            }
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
                        let reason = frame.as_ref().map(|f| f.reason.as_str()).unwrap_or("");
                        if is_rate_limited_close(code, reason) {
                            return ConnectOutcome::Disconnected {
                                reason: close_reason(frame.as_ref()),
                                hello_seen,
                                rate_limited: true,
                            };
                        }
                        if should_terminate(code) {
                            return match code {
                                Some(WS_CLOSE_REVOKED) => ConnectOutcome::Revoked,
                                Some(WS_CLOSE_SUPERSEDED) => ConnectOutcome::Superseded,
                                _ => ConnectOutcome::Disconnected {
                                    reason: "terminal close".to_string(),
                                    hello_seen,
                                    rate_limited: false,
                                },
                            };
                        }
                        return ConnectOutcome::Disconnected {
                            reason: close_reason(frame.as_ref()),
                            hello_seen,
                            rate_limited: false,
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
                        hello_seen,
                        rate_limited: false,
                    };
                }
                if write.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return ConnectOutcome::Disconnected {
                        reason: "write half closed during ping".to_string(),
                        hello_seen,
                        rate_limited: false,
                    };
                }
            }
        }
    }
}

/// Cap on frames held back before `unattended-hello`. A healthy verify
/// takes ~250 ms; nothing legitimate queues dozens of frames in that
/// window, so the bound only matters for a socket that never gets hello.
const PRE_HELLO_BUFFER_MAX: usize = 32;

async fn write_frame<S>(write: &mut S, frame: &SharerFrame) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
{
    let json = serde_json::to_string(frame).map_err(|e| format!("serialise outgoing: {e}"))?;
    write
        .send(Message::Text(json.into()))
        .await
        .map_err(|_| "write half closed".to_string())
}

fn close_reason(frame: Option<&CloseFrame>) -> String {
    match frame {
        Some(f) => format!("close code={} reason={:?}", u16::from(f.code), f.reason),
        None => "close without frame".to_string(),
    }
}

/// Describe an unparseable backend frame for the warn-log WITHOUT echoing
/// the body: `pw-check` frames carry the viewer-typed device password in
/// plaintext, so a raw preview would leak real password attempts into the
/// log the moment the wire shape drifts. Only the serde error and the
/// frame length are safe to include.
fn describe_parse_failure(txt: &str, err: &serde_json::Error) -> String {
    format!(
        "unknown/malformed backend frame ({} bytes): {err}",
        txt.len()
    )
}

#[cfg(test)]
mod tests {

    // gh #109: the backend reads `connectionType` / `bytesRelayed` in
    // camelCase off the wire; the struct fields are snake_case, so the
    // rename has to hold or the frames are silently ignored.
    #[test]
    fn connection_started_matches_the_backend_wire_shape() {
        let v = serde_json::to_value(SharerFrame::ConnectionStarted {
            connection_type: ConnectionKind::Relay,
        })
        .expect("serialize");
        assert_eq!(v["type"], "connection-started");
        assert_eq!(v["connectionType"], "relay");
    }

    #[test]
    fn connection_ended_matches_the_backend_wire_shape() {
        let v = serde_json::to_value(SharerFrame::ConnectionEnded {
            bytes_relayed: 4096,
        })
        .expect("serialize");
        assert_eq!(v["type"], "connection-ended");
        assert_eq!(v["bytesRelayed"], 4096);
    }
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
            Some(WS_CLOSE_RATE_LIMITED),
            Some(4500),
        ] {
            assert!(!should_terminate(code), "expected {code:?} to be retryable");
        }
    }

    #[test]
    fn rate_limited_close_is_recognised_by_code_or_legacy_reason() {
        assert!(is_rate_limited_close(
            Some(WS_CLOSE_RATE_LIMITED),
            "rate limit"
        ));
        assert!(is_rate_limited_close(Some(WS_CLOSE_RATE_LIMITED), ""));
        // Backends ≤ 0.7.0 sent the cap as 4401 + "rate limit".
        assert!(is_rate_limited_close(Some(WS_CLOSE_REVOKED), "rate limit"));
        // A real revocation keeps its terminal meaning.
        assert!(!is_rate_limited_close(
            Some(WS_CLOSE_REVOKED),
            "invalid device token"
        ));
        assert!(!is_rate_limited_close(
            Some(WS_CLOSE_REVOKED),
            "device revoked"
        ));
        assert!(!is_rate_limited_close(
            Some(WS_CLOSE_SUPERSEDED),
            "rate limit"
        ));
        assert!(!is_rate_limited_close(Some(1000), "rate limit"));
        assert!(!is_rate_limited_close(None, "rate limit"));
    }

    #[test]
    fn attempts_to_reach_max_matches_the_backoff_ladder() {
        let s = Duration::from_secs;
        assert_eq!(attempts_to_reach_max(s(1), s(60)), 6);
        assert_eq!(next_backoff(6, s(1), s(60)), s(60));
        assert_eq!(next_backoff(5, s(1), s(60)), s(32));
        let ms = Duration::from_millis;
        assert_eq!(attempts_to_reach_max(ms(20), ms(80)), 2);
        assert_eq!(attempts_to_reach_max(s(60), s(60)), 0);
        assert_eq!(attempts_to_reach_max(s(90), s(60)), 0);
        // Degenerate zero initial never climbs; the clamp keeps it finite.
        assert_eq!(attempts_to_reach_max(s(0), s(60)), 30);
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

    #[test]
    fn with_jitter_spreads_above_and_below_base() {
        // The documented window is ±50 % — both halves must actually
        // occur. With a uniform draw over the full window, 200 samples
        // all landing on one side has probability 2^-200, so a failure
        // here means the window is lopsided, not bad luck.
        let base = Duration::from_millis(1000);
        let mut above = false;
        let mut below = false;
        for _ in 0..200 {
            let j = with_jitter(base);
            if j > base {
                above = true;
            }
            if j < base {
                below = true;
            }
        }
        assert!(
            above,
            "with_jitter never exceeded base — jitter window is not ±50 %"
        );
        assert!(
            below,
            "with_jitter never went below base — jitter window is not ±50 %"
        );
    }

    // ── Parse-failure logging ───────────────────────────────────────

    #[test]
    fn parse_failure_log_never_contains_the_frame_body() {
        // A pw-check frame carries the viewer-typed device password in
        // plaintext. If the wire shape drifts (field rename, added
        // required field) the parse fails — the warn-log for that must
        // not echo the body (no-secrets-in-logs rule).
        let raw = r#"{"type":"pw-check","attempt":"hunter2-secret","accept":true}"#;
        let err = serde_json::from_str::<BackendFrame>(raw).expect_err("drifted frame must fail");
        let line = describe_parse_failure(raw, &err);
        assert!(
            !line.contains("hunter2-secret"),
            "log line must not leak the password attempt: {line}"
        );
        assert!(
            line.contains(&format!("{} bytes", raw.len())),
            "frame length is the only body-derived datum allowed: {line}"
        );
    }

    // ── run_loop backoff behaviour ──────────────────────────────────

    /// Regression: a queued `Send` arriving during the reconnect backoff
    /// must not cancel the remaining sleep — otherwise queued frames
    /// (pw-check-result from a confirm waiter, ICE relays) turn the
    /// backoff into a burst of immediate reconnects exactly when the
    /// server is unreachable.
    #[tokio::test]
    async fn send_during_backoff_does_not_cancel_the_sleep() {
        // Bind-then-drop yields a loopback port that refuses connections
        // instantly, so every reconnect attempt fails fast.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        drop(listener);

        let config = HeartbeatConfig {
            backend_ws_url: format!("ws://{addr}/signal"),
            device_id: "111-111-111".to_string(),
            token: "test-token".to_string(),
            origin: format!("http://{addr}"),
            ping_interval: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(90),
            // Large enough that the whole test fits inside ONE backoff
            // window (jittered minimum is backoff_initial / 2 = 15 s).
            backoff_initial: Duration::from_secs(30),
            backoff_max: Duration::from_secs(30),
        };
        let (cmd_tx, cmd_rx) = mpsc::channel::<HeartbeatCommand>(16);
        let (evt_tx, mut evt_rx) = mpsc::channel::<HeartbeatEvent>(64);
        tokio::spawn(run_loop(config, cmd_rx, evt_tx));

        // Drain until the first Reconnecting — the loop is now inside
        // its backoff sleep.
        loop {
            let ev = tokio::time::timeout(Duration::from_secs(10), evt_rx.recv())
                .await
                .expect("heartbeat event within 10 s")
                .expect("event channel open");
            if matches!(ev, HeartbeatEvent::Reconnecting { .. }) {
                break;
            }
        }

        for _ in 0..3 {
            cmd_tx
                .send(HeartbeatCommand::Send(SharerFrame::PwCheckResult {
                    attempt_id: None,
                    result: PwResult::Fail,
                }))
                .await
                .expect("send during backoff");
        }
        // If a Send shortcut the sleep, the loop would reconnect (and
        // fail) immediately — producing Disconnected/Reconnecting events
        // well within this window.
        let burst = tokio::time::timeout(Duration::from_millis(300), evt_rx.recv()).await;
        assert!(
            burst.is_err(),
            "no reconnect events may fire mid-backoff after a Send, got {:?}",
            burst.expect("timeout already checked")
        );

        // Shutdown must still exit the backoff wait promptly.
        cmd_tx
            .send(HeartbeatCommand::Shutdown)
            .await
            .expect("shutdown");
        let closed = tokio::time::timeout(Duration::from_secs(5), evt_rx.recv())
            .await
            .expect("loop must exit promptly on Shutdown");
        assert!(
            closed.is_none(),
            "run_loop returning closes the event channel"
        );
    }

    /// Regression: the reconnect attempt counter must reset once a
    /// session reaches unattended-hello — otherwise every disconnect
    /// over the process lifetime permanently ratchets the backoff
    /// toward the 60 s ceiling (product goal 2: reconnect latency).
    #[tokio::test]
    async fn backoff_attempt_resets_after_connected_session() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");

        tokio::spawn(async move {
            // Session 1: accept, then close before hello — a failed attempt.
            let (sock, _) = listener.accept().await.expect("accept 1");
            let mut ws = tokio_tungstenite::accept_async(sock).await.expect("ws 1");
            let _ = ws.close(None).await;
            // Session 2: successful — send unattended-hello, then close.
            let (sock, _) = listener.accept().await.expect("accept 2");
            let mut ws = tokio_tungstenite::accept_async(sock).await.expect("ws 2");
            ws.send(Message::Text(
                r#"{"type":"unattended-hello","deviceId":"111-111-111"}"#
                    .to_string()
                    .into(),
            ))
            .await
            .expect("send hello");
            let _ = ws.close(None).await;
            // Keep accepting so the reconnect loop has somewhere to go
            // while the assertion below runs; runtime teardown kills us.
            loop {
                let Ok((sock, _)) = listener.accept().await else {
                    break;
                };
                let _ws = tokio_tungstenite::accept_async(sock).await;
            }
        });

        let config = HeartbeatConfig {
            backend_ws_url: format!("ws://{addr}/signal"),
            device_id: "111-111-111".to_string(),
            token: "test-token".to_string(),
            origin: format!("http://{addr}"),
            ping_interval: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(90),
            backoff_initial: Duration::from_millis(20),
            backoff_max: Duration::from_millis(80),
        };
        let (_cmd_tx, cmd_rx) = mpsc::channel::<HeartbeatCommand>(16);
        let (evt_tx, mut evt_rx) = mpsc::channel::<HeartbeatEvent>(64);
        tokio::spawn(run_loop(config, cmd_rx, evt_tx));

        let mut connected_seen = false;
        let attempt_after_connected = loop {
            let ev = tokio::time::timeout(Duration::from_secs(10), evt_rx.recv())
                .await
                .expect("heartbeat event within 10 s")
                .expect("event channel open");
            match ev {
                HeartbeatEvent::Connected { .. } => connected_seen = true,
                HeartbeatEvent::Reconnecting { attempt, .. } if connected_seen => break attempt,
                _ => {}
            }
        };
        assert_eq!(
            attempt_after_connected, 1,
            "attempt counter must reset after a session that reached hello"
        );
    }

    // ── Debug must not print the credential (F064) ──────────────────

    #[test]
    fn config_debug_redacts_the_bearer_token() {
        let cfg = HeartbeatConfig::production(
            "wss://auffi.app/signal".to_string(),
            "111-111-111".to_string(),
            "s3cret-token".to_string(),
        );
        let dbg = format!("{cfg:?}");
        assert!(!dbg.contains("s3cret-token"), "token leaked: {dbg}");
        assert!(dbg.contains("111-111-111"), "non-secret fields stay: {dbg}");
    }

    /// The backend's per-IP bearer cap (10/min, shared by every device
    /// behind one NAT) used to close with 4401 — the "token revoked" code —
    /// so the 11th device reconnecting after a deploy stopped retrying for
    /// good and sat offline until somebody re-paired it. Both the new 4429
    /// and the legacy 4401 + "rate limit" must reconnect, and at the
    /// backoff ceiling so the fleet spreads out instead of re-tripping.
    async fn rate_limited_close_reconnects_at_max_backoff(code: u16) {
        use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");

        tokio::spawn(async move {
            loop {
                let Ok((sock, _)) = listener.accept().await else {
                    break;
                };
                let Ok(mut ws) = tokio_tungstenite::accept_async(sock).await else {
                    continue;
                };
                let _ = ws
                    .close(Some(CloseFrame {
                        code: CloseCode::from(code),
                        reason: "rate limit".into(),
                    }))
                    .await;
            }
        });

        let backoff_initial = Duration::from_millis(20);
        let backoff_max = Duration::from_millis(80);
        let config = HeartbeatConfig {
            backend_ws_url: format!("ws://{addr}/signal"),
            device_id: "111-111-111".to_string(),
            token: "test-token".to_string(),
            origin: format!("http://{addr}"),
            ping_interval: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(90),
            backoff_initial,
            backoff_max,
        };
        let (_cmd_tx, cmd_rx) = mpsc::channel::<HeartbeatCommand>(16);
        let (evt_tx, mut evt_rx) = mpsc::channel::<HeartbeatEvent>(64);
        tokio::spawn(run_loop(config, cmd_rx, evt_tx));

        let first = tokio::time::timeout(Duration::from_secs(10), evt_rx.recv())
            .await
            .expect("heartbeat event within 10 s")
            .expect("event channel open");
        assert!(
            matches!(first, HeartbeatEvent::Disconnected { .. }),
            "a rate-limited close is transient, got {first:?}"
        );
        let second = tokio::time::timeout(Duration::from_secs(10), evt_rx.recv())
            .await
            .expect("heartbeat event within 10 s")
            .expect("event channel open");
        match second {
            HeartbeatEvent::Reconnecting { after, attempt } => {
                // Jittered ceiling: [max/2, 1.5·max). A fresh ladder would
                // yield [initial/2, 1.5·initial) = [10 ms, 30 ms).
                assert!(
                    after >= backoff_max / 2,
                    "must park at the backoff ceiling, got {after:?}"
                );
                assert_eq!(
                    attempt,
                    attempts_to_reach_max(backoff_initial, backoff_max) + 1,
                    "ladder jumps straight to the ceiling attempt"
                );
            }
            other => panic!("expected Reconnecting, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn close_4429_reconnects_at_max_backoff() {
        rate_limited_close_reconnects_at_max_backoff(WS_CLOSE_RATE_LIMITED).await;
    }

    #[tokio::test]
    async fn legacy_4401_rate_limit_reason_is_not_treated_as_revoked() {
        rate_limited_close_reconnects_at_max_backoff(WS_CLOSE_REVOKED).await;
    }

    /// The backend answers ANY frame on the bearer path with a fatal
    /// `error bad-message` until its argon2 verify has promoted the socket
    /// and `unattended-hello` went out. The biased select drains queued
    /// Sends the instant the WS opens, so a confirm-waiter's
    /// pw-check-result, a bye from disconnect_streaming or a late ICE
    /// candidate queued during the handshake was written pre-hello, killed
    /// the connection ("backend error bad-message: wait for unattended-hello
    /// before sending" shown verbatim), advanced the backoff ladder and
    /// lost the frame. Outbound frames must wait for hello and flush after.
    #[tokio::test]
    async fn outbound_frames_wait_for_unattended_hello() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (verdict_tx, verdict_rx) = tokio::sync::oneshot::channel::<Result<String, String>>();

        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.expect("accept");
            let mut ws = tokio_tungstenite::accept_async(sock).await.expect("ws");
            // Mirror prod: anything before hello is a fatal protocol error.
            if let Ok(Some(Ok(Message::Text(early)))) =
                tokio::time::timeout(Duration::from_millis(200), ws.next()).await
            {
                let _ = ws
                    .send(Message::Text(
                        r#"{"type":"error","code":"bad-message","message":"wait for unattended-hello before sending"}"#
                            .to_string()
                            .into(),
                    ))
                    .await;
                let _ = verdict_tx.send(Err(format!("frame before hello: {early}")));
                return;
            }
            ws.send(Message::Text(
                r#"{"type":"unattended-hello","deviceId":"111-111-111"}"#
                    .to_string()
                    .into(),
            ))
            .await
            .expect("send hello");
            let verdict = match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
                Ok(Some(Ok(Message::Text(txt)))) => Ok(txt.to_string()),
                other => Err(format!("no text frame after hello: {other:?}")),
            };
            let _ = verdict_tx.send(verdict);
            // Keep the socket open so the client sees no disconnect.
            while let Some(Ok(_)) = ws.next().await {}
        });

        let config = HeartbeatConfig {
            backend_ws_url: format!("ws://{addr}/signal"),
            device_id: "111-111-111".to_string(),
            token: "test-token".to_string(),
            origin: format!("http://{addr}"),
            ping_interval: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(90),
            backoff_initial: Duration::from_millis(20),
            backoff_max: Duration::from_millis(80),
        };
        let (cmd_tx, cmd_rx) = mpsc::channel::<HeartbeatCommand>(16);
        let (evt_tx, mut evt_rx) = mpsc::channel::<HeartbeatEvent>(64);
        // Queued BEFORE the loop even starts connecting — the shape of a
        // confirm-waiter answering while the socket is mid-handshake.
        cmd_tx
            .send(HeartbeatCommand::Send(SharerFrame::PwCheckResult {
                result: PwResult::Ok,
                attempt_id: None,
            }))
            .await
            .expect("queue send");
        tokio::spawn(run_loop(config, cmd_rx, evt_tx));

        let verdict = tokio::time::timeout(Duration::from_secs(5), verdict_rx)
            .await
            .expect("server verdict within 5 s")
            .expect("verdict channel");
        let delivered = verdict.expect("frame must be held until hello, then delivered");
        assert_eq!(delivered, r#"{"type":"pw-check-result","result":"ok"}"#);

        let first = tokio::time::timeout(Duration::from_secs(5), evt_rx.recv())
            .await
            .expect("heartbeat event within 5 s")
            .expect("event channel open");
        assert!(
            matches!(first, HeartbeatEvent::Connected { .. }),
            "expected Connected, got {first:?}"
        );
        let quiet = tokio::time::timeout(Duration::from_millis(300), evt_rx.recv()).await;
        assert!(
            quiet.is_err(),
            "no Disconnected/Reconnecting may follow a held-then-flushed frame, got {:?}",
            quiet.expect("timeout already checked")
        );
    }

    // ── Wire-shape round-trips ───────────────────────────────────────

    #[test]
    fn outgoing_pw_check_result_matches_backend_wire_shape() {
        let frame = SharerFrame::PwCheckResult {
            attempt_id: None,
            result: PwResult::Ok,
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert_eq!(json, r#"{"type":"pw-check-result","result":"ok"}"#);
    }

    // F053: without an attempt id on the wire the backend attributes a
    // stale confirm waiter's answer to whichever viewer is pw-in-flight
    // NOW — a rejected-by-user nobody clicked, or a confirm before the
    // sharer's own verdict. The echo is what lets the backend drop it.
    #[test]
    fn outgoing_pw_check_result_echoes_the_attempt_id_in_camel_case() {
        let frame = SharerFrame::PwCheckResult {
            attempt_id: Some(7),
            result: PwResult::Ok,
        };
        let v = serde_json::to_value(&frame).unwrap();
        assert_eq!(v["type"], "pw-check-result");
        assert_eq!(v["attemptId"], 7, "backend reads camelCase attemptId");
        assert_eq!(v["result"], "ok");
        assert!(v.get("attempt_id").is_none(), "snake_case must not leak");
    }

    #[test]
    fn incoming_pw_check_parses_the_attempt_id() {
        let raw = r#"{"type":"pw-check","attempt":"hunter2","autoAccept":false,"attemptId":3}"#;
        let parsed: BackendFrame = serde_json::from_str(raw).unwrap();
        match parsed {
            BackendFrame::PwCheck { attempt_id, .. } => assert_eq!(attempt_id, Some(3)),
            other => panic!("expected PwCheck, got {other:?}"),
        }
    }

    #[test]
    fn outgoing_turn_credentials_request_matches_backend_wire_shape() {
        let json = serde_json::to_string(&SharerFrame::TurnCredentialsRequest).unwrap();
        assert_eq!(json, r#"{"type":"turn-credentials-request"}"#);
    }

    #[test]
    fn incoming_turn_credentials_parses_full_payload() {
        let raw = r#"{"type":"turn-credentials","credentials":{"urls":["turn:t.auffi.app:3478"],"username":"1715000000:uuid","credential":"base64==","ttl":3600}}"#;
        let parsed: BackendFrame = serde_json::from_str(raw).unwrap();
        match parsed {
            BackendFrame::TurnCredentials {
                credentials: Some(c),
            } => {
                assert_eq!(c.urls, vec!["turn:t.auffi.app:3478"]);
                assert_eq!(c.username, "1715000000:uuid");
                assert_eq!(c.credential, "base64==");
                assert_eq!(c.ttl, 3600);
            }
            other => panic!("expected TurnCredentials(Some), got {other:?}"),
        }
    }

    #[test]
    fn incoming_turn_credentials_null_means_no_turn_configured() {
        let raw = r#"{"type":"turn-credentials","credentials":null}"#;
        let parsed: BackendFrame = serde_json::from_str(raw).unwrap();
        match parsed {
            BackendFrame::TurnCredentials { credentials: None } => {}
            other => panic!("expected TurnCredentials(None), got {other:?}"),
        }
    }

    #[test]
    fn incoming_pw_check_parses_with_auto_accept() {
        let raw = r#"{"type":"pw-check","attempt":"hunter2","autoAccept":true}"#;
        let parsed: BackendFrame = serde_json::from_str(raw).unwrap();
        match parsed {
            BackendFrame::PwCheck {
                attempt,
                auto_accept,
                attempt_id,
            } => {
                assert_eq!(attempt, "hunter2");
                assert!(auto_accept);
                assert_eq!(attempt_id, None, "a backend without ids must still parse");
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
    fn incoming_peer_joined_parses_with_the_viewer_info_the_backend_sends() {
        // backend/src/signaling.ts mirrors the ad-hoc frame incl. viewerInfo;
        // the unattended sharer only needs the type.
        let raw = r#"{"type":"peer-joined","viewerInfo":{"ipPrefix":"84.xxx","country":null}}"#;
        let parsed: BackendFrame = serde_json::from_str(raw).unwrap();
        assert!(matches!(parsed, BackendFrame::PeerJoined), "got {parsed:?}");
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
}
