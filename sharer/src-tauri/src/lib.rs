mod account;
mod backend_urls;
mod bitrate_controller;
mod capture;
mod device_password;
mod encoder;
mod files;
mod free_tier_timer;
mod heartbeat;
mod hotkey;
mod input;
mod ip_redact;
mod local_lockout;
mod nat_traversal;
mod outbound;
mod protocol;
mod pw_check;
mod rtp_clock;
mod signaling;
mod tls_roots;
mod turn_config;
mod unattended_cmd;
mod update_check;
mod webrtc_peer;

use std::sync::atomic::{AtomicBool, Ordering};

/// Runtime gate for `dbg_log`.
///
/// Defaults ON in dev builds (unchanged developer ergonomics) and OFF in
/// release builds. A release build only ever touches the world-writable temp
/// file once the user explicitly opts in — via the `--debug` launch flag or the
/// Einstellungen toggle. Keeping it off by default preserves the "no diagnostic
/// file unless requested" property: the temp dir is shared, so an always-on log
/// would be a TOCTOU symlink target on Linux.
static DEBUG_LOGGING: AtomicBool = AtomicBool::new(cfg!(debug_assertions));

/// Enable or disable diagnostic logging at runtime.
pub(crate) fn set_debug_logging_enabled(enabled: bool) {
    DEBUG_LOGGING.store(enabled, Ordering::Relaxed);
}

/// Whether diagnostic logging is currently enabled.
pub(crate) fn debug_logging_enabled() -> bool {
    DEBUG_LOGGING.load(Ordering::Relaxed)
}

/// True if `--debug` appears anywhere in the process arguments.
pub(crate) fn debug_flag_present(mut args: impl Iterator<Item = String>) -> bool {
    args.any(|a| a == "--debug")
}

/// Resolve the destination path for `dbg_log()` writes.
///
/// Uses the OS-specific temp dir so the helper works on both Linux/macOS
/// (`/tmp/auffi-debug.log`) and Windows (`%TEMP%\auffi-debug.log`).
/// Hard-coding `/tmp/` would silently no-op on Windows because the path
/// is not valid there.
fn dbg_log_path() -> std::path::PathBuf {
    std::env::temp_dir().join("auffi-debug.log")
}

/// Append a timestamped diagnostic line to the dbg-log file (`auffi-debug.log`
/// in the OS temp directory) with an explicit flush. Stdio buffering eats
/// println!/eprintln! when the tauri-cli pipes our streams, and release builds
/// have no console at all, so diagnostics go to a known tailable path.
///
/// No-op unless logging is enabled (see [`DEBUG_LOGGING`]). Errors are silently
/// dropped — diagnostics must never crash the app.
pub(crate) fn dbg_log(msg: &str) {
    if !debug_logging_enabled() {
        return;
    }
    use std::io::Write;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    harden_log_open(&mut opts);
    if let Ok(mut f) = opts.open(dbg_log_path()) {
        let _ = writeln!(f, "[{ts}] {msg}");
        let _ = f.flush();
    }
}

/// The Unix temp dir (/tmp) is world-writable, so refuse to follow a symlink
/// planted at the log path and keep the file owner-only — diagnostic lines
/// can carry connection metadata (URLs, redacted ICE) that other local users
/// must not read or redirect. Windows %TEMP% is already per-user. Every open
/// of the log file goes through here: `mode` only applies at creation, so
/// whichever path creates the file decides its permissions for good.
fn harden_log_open(opts: &mut std::fs::OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(not(unix))]
    {
        let _ = opts;
    }
}

/// Make sure a regular, owner-only log file exists at `path` so "Log öffnen"
/// never dead-ends on a machine where logging has not produced output yet.
fn ensure_log_file(path: &std::path::Path) -> Result<(), String> {
    // O_EXCL fails with EEXIST on a symlink even with O_NOFOLLOW, which
    // would look like the normal already-exists case and hand the symlink's
    // target to the opener — so a link at the path is refused outright.
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("log path is a symlink — refusing to open it".to_string());
    }
    let mut opts = std::fs::OpenOptions::new();
    // create_new is atomic (no exists()-then-create TOCTOU). AlreadyExists is
    // the normal case once logging has run.
    opts.write(true).create_new(true);
    harden_log_open(&mut opts);
    match opts.open(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(format!("create log file: {e}")),
    }
}

/// `log`-facade backend forwarding every enabled record into the same
/// `dbg_log()` sink.
///
/// Without an installed logger the facade drops ALL records — heartbeat
/// wire-parse warnings, TURN-fetch failures, input-apply errors and hotkey
/// failures were silent no-ops, defeating the diagnosability those call
/// sites were added for. Filtering runs through the same runtime gate as
/// `dbg_log`, so the cost while logging is disabled is one atomic load.
struct DbgLogForwarder;

impl log::Log for DbgLogForwarder {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        debug_logging_enabled() && metadata.level() <= log::Level::Debug
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        dbg_log(&format!(
            "[{}] {}: {}",
            record.level(),
            record.target(),
            record.args()
        ));
    }

    fn flush(&self) {}
}

static LOG_FORWARDER: DbgLogForwarder = DbgLogForwarder;

/// Flip diagnostic logging at runtime. Persistence lives on the JS side (the
/// settings store) — this command only mutates the in-process gate, so the
/// store has a single writer and there is no cross-process race on the file.
#[tauri::command]
fn set_debug_logging(enabled: bool) {
    set_debug_logging_enabled(enabled);
    dbg_log(&format!("[debug-logging] runtime gate set to {enabled}"));
}

/// Current state of the diagnostic-logging gate (reflects the `--debug` flag
/// applied at startup). The settings UI seeds its toggle from this.
#[tauri::command]
fn get_debug_logging() -> bool {
    debug_logging_enabled()
}

/// Open `auffi-debug.log` in the OS default handler. Creates the (empty) file
/// first so the button never dead-ends on a machine where logging has not yet
/// produced output.
#[tauri::command]
fn open_debug_log(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = dbg_log_path();
    ensure_log_file(&path)?;
    let path_str = path.to_str().ok_or("log path is not valid UTF-8")?;
    app.opener()
        .open_path(path_str, None::<&str>)
        .map_err(|e| format!("open log file: {e}"))
}

use std::{path::PathBuf, sync::Arc, sync::Mutex, time::Duration};

use tauri::{Emitter, State};
use tokio::sync::mpsc;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocalWriter;

use capture::DisplayInfo;
use files::FileMessage;
use input::{InputCommand, InputController};

struct SignalingState(Mutex<Option<signaling::Signaling>>);

/// Wrapped in `Arc` so the file-task spawn can hold a reference to send
/// auto-reject responses through the files DataChannel without borrowing
/// `tauri::State` across an await.
struct WebRtcState(Arc<tokio::sync::Mutex<Option<webrtc_peer::SharerPeer>>>);

/// Shared mutable access to the active `InputController`.
///
/// Wrapped in `Arc` so the input-applier task and future hotkey handlers can
/// both hold a reference without borrowing Tauri state across await points.
struct InputControllerState(Arc<tokio::sync::Mutex<Option<InputController>>>);

/// Shared access to the active `FileTransferManager`.
struct FileTransferState(Arc<tokio::sync::Mutex<Option<files::FileTransferManager>>>);

/// Holds the abort handles of the currently-running free-tier relay timer
/// so `disconnect_streaming` can cancel them. Without this the warning /
/// cutoff sleeps from a prior session would fire against a new one. (gh #63)
struct FreeTierTimerState(Arc<Mutex<Option<free_tier_timer::TimerHandles>>>);

/// Command channel into the live streaming loop. The `switch_monitor`
/// command builds a fresh capturer + encoder and ships them through the
/// sender; the loop swaps them in between frames so the active WebRTC
/// track is preserved (no SDP renegotiation, no viewer reconnect).
struct SwitchState(Mutex<Option<mpsc::Sender<SwitchMsg>>>);

/// Mode-agnostic outbound relay channel. Set by `start_signaling`
/// (AdHoc variant) or `unattended_start` (Unattended variant);
/// cleared by `disconnect_streaming` and `unattended_stop`. Every
/// outbound relay (on_ice_candidate, receive_offer's answer, the
/// bye on teardown) reads through this so the same webrtc_peer
/// wiring works in both modes. See `outbound.rs`.
struct OutboundSinkState(Arc<tokio::sync::Mutex<Option<outbound::OutboundSink>>>);

/// Per-session telemetry counters (gh #109).
///
/// `bytes` accumulates what was handed to the WebRTC track. It is reported as
/// `bytesRelayed` ONLY when the path is a TURN relay — `connection_log`
/// documents that column as "0 for p2p", and filling it with total track
/// bytes made every direct session look like multi-GB relay traffic.
///
/// `generation` rises on every `start_streaming`. Callbacks capture the value
/// they were installed with, so a late ICE callback from a torn-down session
/// cannot open a log row for the session that replaced it.
#[derive(Default)]
struct SessionMetrics {
    bytes: std::sync::atomic::AtomicU64,
    is_relay: std::sync::atomic::AtomicBool,
    /// Set when something learns a decoder needs a fresh reference frame —
    /// a peer connecting, or the viewer asking via RTCP PLI. The streaming
    /// loop consumes it and tells the encoder. VP8 shows nothing until a
    /// keyframe arrives, and on a static screen the encoder's own scene
    /// detection will not produce one.
    keyframe_requested: std::sync::atomic::AtomicBool,
    /// Same, but from the viewer's repeated PLI — rate-limited by the encoder
    /// so answering packet loss cannot amplify it.
    keyframe_requested_throttled: std::sync::atomic::AtomicBool,
    /// Target bitrate in kbps, decided by the congestion controller from the
    /// viewer's RTCP and applied by the streaming loop. An atomic rather than
    /// a channel because only the newest value matters — a backlog of stale
    /// rates would be worse than dropping them.
    target_bitrate_kbps: std::sync::atomic::AtomicU32,
    generation: std::sync::atomic::AtomicU64,
}

struct SessionBytesState(Arc<SessionMetrics>);

/// Two-phase swap protocol so the OLD capture pipeline tears down before
/// the NEW portal dialog is opened. On Plasma, two concurrent
/// `org.freedesktop.portal.ScreenCast` pipelines confuse the compositor
/// and the new session's media may be misrouted; see
/// `docs/postmortem-2026-05-12-monitor-switch.md`.
///
/// `switch_monitor` first sends `Stop` and awaits ack — at that point
/// the loop has dropped the old capturer. Only THEN does switch_monitor
/// build the new one (which on Wayland opens the portal dialog). Once
/// built it sends `Replace`. While in the stopped state the loop blocks
/// on the next message instead of looping at frame rate.
enum SwitchMsg {
    Stop {
        ack: tokio::sync::oneshot::Sender<()>,
    },
    Replace {
        capturer: capture::ScreenCapturer,
        encoder: encoder::Vp8Encoder,
        /// Top-left of the new monitor in the OS virtual-desktop coordinate
        /// space; needed so the rebuilt InputController routes absolute
        /// pointer events to the just-selected display instead of the
        /// primary monitor.
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    },
}

#[tauri::command]
async fn start_signaling(
    app: tauri::AppHandle,
    state: State<'_, SignalingState>,
    rtc_state: State<'_, WebRtcState>,
    input_state: State<'_, InputControllerState>,
    file_state: State<'_, FileTransferState>,
    outbound_state: State<'_, OutboundSinkState>,
) -> Result<(), String> {
    // Refuse to start a fresh signaling session while the previous one's
    // resources are still allocated. Overwriting `SignalingState` while the
    // WebRTC peer / input controller / file-transfer manager from a prior
    // session are still live would leak running tasks and silently keep an
    // attacker-controlled remote-input session alive after the UI thinks
    // it has been replaced. The UI must call `disconnect_streaming` first.
    // (gh #64) Policy lives in `check_streaming_preconditions` so each
    // guard is independently unit-pinnable.
    // Poison-recovery (`into_inner`) matches the rest of this file — an
    // Err-on-poison here previously diverged from the recovery below and
    // could fail AFTER the WS task was spawned, leaking it unregistered.
    let signaling_active = state.0.lock().unwrap_or_else(|p| p.into_inner()).is_some();
    let rtc_alive = rtc_state.0.lock().await.is_some();
    let input_alive = input_state.0.lock().await.is_some();
    let file_alive = file_state.0.lock().await.is_some();
    check_streaming_preconditions(signaling_active, rtc_alive, input_alive, file_alive)
        .map_err(|e| e.to_string())?;

    // Reject cleartext ws:///http:// backend URLs (unless AUFFI_ALLOW_INSECURE=1)
    // just like the unattended path — the 9-digit session code must not travel
    // over an unencrypted WS.
    let url = crate::unattended_cmd::backend_ws_url_secure()?;

    let sig = signaling::run(app, url).await;
    // gh #20: set the mode-agnostic OutboundSink so receive_offer +
    // on_ice_candidate + the bye on teardown all route through this
    // ad-hoc channel.
    {
        let mut guard = outbound_state.0.lock().await;
        *guard = Some(outbound::OutboundSink::AdHoc(sig.tx.clone()));
    }
    // Poison-recover: the WS task is already spawned and the OutboundSink
    // set — failing here would leave that task running with no handle
    // stored anywhere.
    {
        let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        *guard = Some(sig);
    }
    Ok(())
}

#[tauri::command]
async fn confirm_peer(
    accepted: bool,
    state: State<'_, SignalingState>,
    outbound_state: State<'_, OutboundSinkState>,
) -> Result<(), String> {
    let tx = {
        let guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        guard.as_ref().map(|s| s.tx.clone())
    };
    let Some(tx) = tx else {
        return Err("signaling not started".to_string());
    };
    tx.send(protocol::Outgoing::Confirm { accepted })
        .await
        .map_err(|e| e.to_string())?;

    if !accepted {
        // Clear the signaling state so start_signaling can be called again
        // cleanly from a fresh state after a rejection. The OutboundSink
        // holds the other sender clone into the WS task's command channel —
        // clear it too so every sender drops and the task closes the socket
        // and exits (instead of lingering on a session the backend already
        // removed). Compare-and-clear: only the AdHoc variant belongs to
        // this flow — an Unattended sink is the heartbeat's.
        {
            let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
            *guard = None;
        }
        let mut sink_guard = outbound_state.0.lock().await;
        if sink_guard.as_ref().is_some_and(|s| s.is_adhoc()) {
            *sink_guard = None;
        }
    }

    Ok(())
}

#[tauri::command]
fn list_monitors() -> Result<Vec<DisplayInfo>, String> {
    Ok(capture::list_displays())
}

/// Returns true on Wayland sessions where the compositor portal handles
/// monitor picking — in that case the webview skips its own monitor-select
/// step and goes straight to start_streaming. Always false on Windows
/// (xcap exposes monitors directly, the webview handles the picker itself).
#[tauri::command]
fn capture_backend_uses_portal() -> bool {
    #[cfg(target_os = "linux")]
    {
        let xdg = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
        let uses_portal = matches!(capture::select_backend(), capture::Backend::Portal);
        dbg_log(&format!(
            "[capture_backend_uses_portal] XDG_SESSION_TYPE={xdg:?} -> uses_portal={uses_portal}"
        ));
        uses_portal
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Close `peer` when `result` is an error, then hand the result back.
///
/// webrtc-rs has no Drop-based teardown (see `disconnect_streaming`), so an
/// early return between `SharerPeer::new` and the hand-off to `WebRtcState`
/// leaks the ICE agent, its bound UDP sockets and the SCTP tasks — for the
/// whole process lifetime, on every failed start. Nothing else owns the peer
/// at that point, so the close has to happen here.
async fn close_peer_on_err<T, E>(
    peer: &webrtc_peer::SharerPeer,
    result: Result<T, E>,
) -> Result<T, E> {
    if result.is_err() {
        dbg_log("[start_streaming] failed after peer construction — closing peer");
        if let Err(e) = peer.close().await {
            dbg_log(&format!("[start_streaming] peer close during unwind: {e}"));
        }
    }
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_streaming(
    app: tauri::AppHandle,
    monitor_id: u32,
    session_code: String,
    rtc_state: State<'_, WebRtcState>,
    input_state: State<'_, InputControllerState>,
    file_state: State<'_, FileTransferState>,
    timer_state: State<'_, FreeTierTimerState>,
    switch_state: State<'_, SwitchState>,
    outbound_state: State<'_, OutboundSinkState>,
    unattended_state: State<'_, unattended_cmd::UnattendedState>,
    bytes_state: State<'_, SessionBytesState>,
) -> Result<(), String> {
    dbg_log(&format!(
        "[start_streaming] enter monitor_id={} session_code=*** os={} arch={} v{}",
        monitor_id,
        std::env::consts::OS,
        std::env::consts::ARCH,
        env!("CARGO_PKG_VERSION")
    ));

    // Defensive guard: refuse to stack a second WebRTC peer on top of a
    // live one. The JS-side peer-joined handler is supposed to call
    // disconnect_streaming first, but a missing call would otherwise
    // silently leak a streaming_loop and queue up a second portal dialog
    // that the compositor may refuse to display.
    if rtc_state.0.lock().await.is_some() {
        return Err("ein Stream läuft bereits — disconnect_streaming zuerst aufrufen".to_string());
    }
    // TURN credentials, mode-dependent: the unattended path has no
    // session code and asks over its bearer-authenticated heartbeat
    // WSS; the ad-hoc path POSTs the session code to the backend.
    // Both degrade to an empty (STUN-less) list on failure.
    let unattended_cmds = {
        let guard = outbound_state.0.lock().await;
        match guard.as_ref() {
            Some(outbound::OutboundSink::Unattended(cmds)) => Some(cmds.clone()),
            _ => None,
        }
    };
    let ice_servers = match unattended_cmds {
        Some(cmds) => {
            dbg_log("[start_streaming] fetching TURN via heartbeat WSS");
            unattended_cmd::request_turn_via_heartbeat(&cmds, &unattended_state.pending_turn).await
        }
        None => {
            let ws_url = crate::unattended_cmd::backend_ws_url_secure()?;
            let backend_http_url = backend_urls::http_base_from_ws(&ws_url);
            let origin = backend_urls::origin_from_ws(&ws_url);
            dbg_log(&format!(
                "[start_streaming] backend_http_url={}",
                backend_http_url
            ));
            turn_config::fetch_ice_servers(&backend_http_url, &origin, &session_code).await
        }
    };
    dbg_log(&format!(
        "[start_streaming] ice_servers count={}",
        ice_servers.len()
    ));

    let peer = webrtc_peer::SharerPeer::new(ice_servers)
        .await
        .map_err(|e| {
            dbg_log(&format!("[start_streaming] peer::new failed: {e}"));
            e.to_string()
        })?;

    let outbound_arc_for_ice = Arc::clone(&outbound_state.0);
    peer.on_ice_candidate(move |candidate| {
        if let Some(c) = candidate {
            if let Ok(init) = c.to_json() {
                dbg_log(&format!(
                    "[local-ice] candidate='{}' mid={:?} mline={:?}",
                    ip_redact::redact_ips_in_text(&init.candidate),
                    init.sdp_mid,
                    init.sdp_mline_index
                ));
                let payload = serde_json::json!({
                    "kind": "ice",
                    "candidate": {
                        "candidate": init.candidate,
                        "sdpMid": init.sdp_mid,
                        "sdpMLineIndex": init.sdp_mline_index,
                        "usernameFragment": init.username_fragment,
                    }
                });
                let outbound = Arc::clone(&outbound_arc_for_ice);
                tauri::async_runtime::spawn(async move {
                    let sink = outbound.lock().await.clone();
                    match sink {
                        Some(s) => {
                            if let Err(e) = s.send_relay(payload).await {
                                dbg_log(&format!("[local-ice] send err: {e}"));
                            }
                        }
                        None => dbg_log("[local-ice] no outbound sink — dropping candidate"),
                    }
                });
            }
        } else {
            dbg_log("[local-ice] end-of-candidates");
        }
    });

    let app_for_conn_type = app.clone();
    // A viewer that lost the reference frame asks for a new one via RTCP PLI.
    // Without this the request is never read and the viewer stays black.
    {
        use webrtc_peer::SenderFeedback;
        let metrics_for_rtcp = Arc::clone(&bytes_state.0);
        // The controller is owned by the callback: RTCP for one session is
        // delivered on one task, so a Mutex here is uncontended, and tying its
        // lifetime to the listener means a new session starts from the default
        // rate rather than inheriting the last one's congestion state.
        let congestion = std::sync::Mutex::new(bitrate_controller::BitrateController::new(
            bitrate_controller::START_BITRATE_KBPS,
        ));
        peer.spawn_rtcp_listener(move |feedback| match feedback {
            SenderFeedback::KeyframeRequest => {
                // Throttled: a viewer on a lossy link repeats the request, and
                // an unthrottled answer feeds the congestion that caused it.
                metrics_for_rtcp
                    .keyframe_requested_throttled
                    .store(true, std::sync::atomic::Ordering::Relaxed);
            }
            SenderFeedback::Loss { fraction_lost } => {
                let changed = congestion
                    .lock()
                    .map(|mut c| c.on_receiver_report(fraction_lost))
                    .unwrap_or(None);
                if let Some(kbps) = changed {
                    dbg_log(&format!(
                        "[congestion] loss {:.1}% -> {kbps} kbps",
                        f64::from(fraction_lost) / 256.0 * 100.0
                    ));
                    metrics_for_rtcp
                        .target_bitrate_kbps
                        .store(kbps, std::sync::atomic::Ordering::Relaxed);
                }
            }
            SenderFeedback::Remb { bitrate_bps } => {
                let changed = congestion
                    .lock()
                    .map(|mut c| c.on_remb(bitrate_bps))
                    .unwrap_or(None);
                if let Some(kbps) = changed {
                    dbg_log(&format!("[congestion] remb -> {kbps} kbps"));
                    metrics_for_rtcp
                        .target_bitrate_kbps
                        .store(kbps, std::sync::atomic::Ordering::Relaxed);
                }
            }
        });
    }

    // Surface every ICE state to the webview, which owns "stop the stream"
    // and knows whether the signaling channel must survive (it must — the
    // sharer stays available for the next viewer).
    {
        let app_for_ice = app.clone();
        peer.on_ice_state(move |state| {
            let value = format!("{state}").to_lowercase();
            dbg_log(&format!("[ice-state] {value}"));
            if let Err(e) = app_for_ice.emit("ice-state", value) {
                log::warn!("ice-state emit failed: {e}");
            }
        });
    }

    let outbound_for_conn_type = Arc::clone(&outbound_state.0);
    let metrics_for_cb = Arc::clone(&bytes_state.0);
    // Fresh session: zero the counters and claim a generation. Callbacks
    // installed below capture it, so one that fires after this session is
    // gone can tell and stay quiet.
    {
        use std::sync::atomic::Ordering;
        bytes_state.0.bytes.store(0, Ordering::Relaxed);
        bytes_state.0.is_relay.store(false, Ordering::Relaxed);
        // SessionMetrics is `manage`d once for the whole app — that is what
        // `generation` exists to paper over — so a per-session value left
        // behind here is inherited by the next session. Without this reset a
        // session that backed off to the floor on a bad link would start the
        // NEXT one, on a different viewer's possibly fine link, pinned at that
        // floor until its first receiver report arrives. Zero means "this
        // session's controller has not spoken yet; leave the encoder alone".
        bytes_state
            .0
            .target_bitrate_kbps
            .store(0, Ordering::Relaxed);
    }
    let my_generation = bytes_state
        .0
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        + 1;
    let timer_state_for_cb = Arc::clone(&timer_state.0);
    peer.on_connection_type(move |conn_type| {
        use webrtc_peer::ConnectionType;
        let value = match conn_type {
            ConnectionType::P2p => "p2p",
            ConnectionType::Relay => "relay",
        };
        dbg_log(&format!("[ice-connected] type={value}"));
        if let Err(e) = app_for_conn_type.emit("connection-type", value) {
            log::warn!("connection-type emit failed: {e}");
        }

        // gh #109: open the connection_log row now that the media path is
        // known. Unattended only — send_telemetry is a no-op on the ad-hoc
        // sink, since that table is keyed by device.
        {
            use std::sync::atomic::Ordering;
            let sink_arc = Arc::clone(&outbound_for_conn_type);
            let metrics = Arc::clone(&metrics_for_cb);
            let kind = match conn_type {
                ConnectionType::P2p => heartbeat::ConnectionKind::P2p,
                ConnectionType::Relay => heartbeat::ConnectionKind::Relay,
            };
            // Only a relayed path accrues billable bytes; the teardown reads
            // this to decide whether to report the track total or 0.
            metrics.is_relay.store(
                matches!(conn_type, ConnectionType::Relay),
                Ordering::Relaxed,
            );
            // A viewer just attached. Its decoder has nothing to reference
            // until a keyframe arrives, and the encoder cannot know that on
            // its own — the first keyframe was emitted before this connection
            // existed and went nowhere.
            metrics.keyframe_requested.store(true, Ordering::Relaxed);
            tauri::async_runtime::spawn(async move {
                // A late callback from a torn-down session must not open a row
                // against whatever session replaced it.
                if metrics.generation.load(Ordering::Relaxed) != my_generation {
                    dbg_log("[ice-connected] stale callback — telemetry start skipped");
                    return;
                }
                let sink = sink_arc.lock().await.clone();
                if let Some(sink) = sink {
                    if let Err(e) = sink
                        .send_telemetry(heartbeat::SharerFrame::ConnectionStarted {
                            connection_type: kind,
                        })
                        .await
                    {
                        dbg_log(&format!("[ice-connected] telemetry start: {e}"));
                    }
                }
            });
        }

        match conn_type {
            ConnectionType::Relay => {
                let app_warn = app_for_conn_type.clone();
                let app_cut = app_for_conn_type.clone();
                let handles = free_tier_timer::start(
                    free_tier_timer::TimerConfig::default(),
                    move || {
                        if let Err(e) = app_warn.emit("free-tier-warning", serde_json::json!({})) {
                            log::warn!("free-tier-warning emit failed: {e}");
                        }
                    },
                    move || {
                        if let Err(e) = app_cut.emit("free-tier-cutoff", serde_json::json!({})) {
                            log::warn!("free-tier-cutoff emit failed: {e}");
                        }
                    },
                );
                // Park the abort handles in shared state so disconnect_streaming
                // can cancel them. Drops any pre-existing handles first (defensive
                // — should never happen since disconnect always clears).
                let mut guard = timer_state_for_cb.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(prev) = guard.take() {
                    prev.cancel();
                }
                *guard = Some(handles);
            }
            ConnectionType::P2p => {
                // A Relay→P2p flip (ICE restart, late direct pair after an
                // initial relay nomination) must cancel the parked warning/
                // cutoff timers — otherwise they fire against a session that
                // no longer uses the relay and cut a legitimate P2P stream.
                let mut guard = timer_state_for_cb.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(handles) = guard.take() {
                    dbg_log("[ice-connected] relay->p2p flip — cancelling free-tier timers");
                    handles.cancel();
                }
            }
        }
    });

    dbg_log("[start_streaming] before ScreenCapturer::start");
    let capturer = close_peer_on_err(
        &peer,
        capture::ScreenCapturer::start(monitor_id)
            .await
            .map_err(|e| {
                dbg_log(&format!(
                    "[start_streaming] ScreenCapturer::start FAILED: {e}"
                ));
                e.to_string()
            }),
    )
    .await?;
    dbg_log(&format!(
        "[start_streaming] capturer ready {}x{}",
        capturer.width(),
        capturer.height()
    ));
    let width = capturer.width();
    let height = capturer.height();

    // Create the encoder BEFORE any session state is mutated: it is the last
    // fallible step, and a failure after the input/file/rtc slots were
    // populated used to leave them stuck (the gh#64 guards then blocked
    // every retry until a webview reload).
    let enc = close_peer_on_err(
        &peer,
        encoder::Vp8Encoder::new(width, height, bitrate_controller::START_BITRATE_KBPS).map_err(
            |e| {
                dbg_log(&format!(
                    "[start_streaming] Vp8Encoder::new FAILED ({width}x{height}): {e}"
                ));
                e
            },
        ),
    )
    .await?;
    dbg_log("[start_streaming] encoder ready");

    // Resolve the chosen monitor's top-left in virtual-desktop coordinates so
    // the InputController can offset absolute pointer events onto the right
    // display. Falls back to (0,0) when the lookup can't find the id —
    // e.g. on Wayland where list_displays returns a single placeholder —
    // which matches the historical primary-only behaviour.
    let monitor_origin: (i32, i32) = capture::list_displays()
        .into_iter()
        .find(|m| m.id == monitor_id)
        .map(|m| (m.x, m.y))
        .unwrap_or((0, 0));

    let (input_tx, mut input_rx) = mpsc::channel::<InputCommand>(256);
    let (files_msg_tx, mut files_msg_rx) = mpsc::channel::<FileMessage>(256);
    peer.on_data_channels(input_tx, files_msg_tx);

    let controller = close_peer_on_err(
        &peer,
        InputController::new(monitor_origin.0, monitor_origin.1, width, height)
            .map_err(|e| e.to_string()),
    )
    .await?;
    {
        let mut guard = input_state.0.lock().await;
        *guard = Some(controller);
    }

    let controller_arc = Arc::clone(&input_state.0);
    tauri::async_runtime::spawn(async move {
        while let Some(cmd) = input_rx.recv().await {
            let mut guard = controller_arc.lock().await;
            if let Some(ctrl) = guard.as_mut() {
                if let Err(e) = ctrl.handle(cmd) {
                    log::warn!("input apply: {e}");
                }
            }
        }
    });

    // Initialize the file transfer manager.
    {
        let mut guard = file_state.0.lock().await;
        *guard = Some(files::FileTransferManager::new(files::output_dir()));
    }

    // Spawn the file-task that drives incoming file messages.
    let file_mgr_arc = Arc::clone(&file_state.0);
    let rtc_arc_for_files = Arc::clone(&rtc_state.0);
    let app_for_files = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = files_msg_rx.recv().await {
            match msg {
                FileMessage::Event(ev) => {
                    // handle_offer returns auto-reject FileError events
                    // (too-many-active, file-too-large) that MUST be sent
                    // back to the viewer over the files DataChannel —
                    // otherwise the viewer's FileTransferManager keeps
                    // the offer pending indefinitely.
                    let auto_responses = {
                        let mut guard = file_mgr_arc.lock().await;
                        guard
                            .as_mut()
                            .map(|mgr| mgr.handle_offer(ev, &app_for_files))
                            .unwrap_or_default()
                    };
                    if !auto_responses.is_empty() {
                        let guard = rtc_arc_for_files.lock().await;
                        if let Some(peer) = guard.as_ref() {
                            for resp in &auto_responses {
                                if let Err(e) = peer.send_file_event(resp).await {
                                    log::warn!("auto-reject send_file_event failed: {e}");
                                }
                            }
                        }
                    }
                }
                FileMessage::Chunk(data) => {
                    let mut guard = file_mgr_arc.lock().await;
                    if let Some(mgr) = guard.as_mut() {
                        if let Err(e) = mgr.handle_chunk(&data) {
                            log::warn!("file chunk error: {e}");
                        }
                    }
                }
            }
        }
    });

    // Best-effort: the pause hotkey is a convenience. If another app already
    // owns Ctrl+Alt+P / Ctrl+Alt+Pause system-wide, registration fails — that
    // must NOT abort the whole stream (a `?` here was a latent cause of
    // "Streamen konnte nicht gestartet werden").
    if let Err(e) = hotkey::register_pause_hotkey(&app, Arc::clone(&input_state.0)) {
        log::warn!("pause hotkey registration failed (continuing without it): {e}");
        dbg_log(&format!(
            "[start_streaming] pause hotkey registration failed (non-fatal): {e}"
        ));
    }

    let track = peer.track.clone();
    {
        let mut guard = rtc_state.0.lock().await;
        *guard = Some(peer);
    }

    // Install the switch-monitor command channel. The runtime command
    // builds a fresh capturer + encoder and pushes them through this
    // channel; streaming_loop swaps them in between frames.
    let (switch_tx, switch_rx) = mpsc::channel::<SwitchMsg>(1);
    {
        // Poison-recover so a panicked sibling thread doesn't strand the
        // sender — without it, the streaming_loop would never receive a
        // swap and switch_monitor would always reply "no active stream".
        let mut g = switch_state.0.lock().unwrap_or_else(|p| p.into_inner());
        *g = Some(switch_tx);
    }
    let controller_arc_for_loop = Arc::clone(&input_state.0);
    let app_for_loop = app.clone();
    let on_failed: FailureSink =
        Arc::new(move |reason: &str| emit_streaming_failed(&app_for_loop, reason));
    // Fresh session, fresh count — otherwise connection-ended would report
    // the previous session's bytes on top of this one's.
    let metrics_for_loop = Arc::clone(&bytes_state.0);

    tauri::async_runtime::spawn(async move {
        streaming_loop(
            Some(capturer),
            Some(enc),
            track,
            switch_rx,
            controller_arc_for_loop,
            metrics_for_loop,
            on_failed,
        )
        .await;
    });

    dbg_log("[start_streaming] success — streaming loop spawned");
    Ok(())
}

/// Swap the active capture source mid-stream.
///
/// The WebRTC track and peer connection are preserved — only the
/// upstream capturer + encoder are replaced, plus the InputController so
/// remote pointer coords map to the new resolution. On Wayland the portal
/// dialog prompts for the new source (no restore token is ever kept).
///
/// `monitor_id` is the X11 / Windows monitor index. Ignored on Wayland
/// (the portal owns selection there) — the UI should pass 0 in that
/// case.
/// Phase 1 of the two-phase monitor swap: enqueue `Stop` and BLOCK until
/// the streaming_loop has acknowledged it has dropped the old capturer.
///
/// Extracted so the ordering invariant is testable in isolation: callers
/// MUST `.await?` this before opening a fresh portal pipeline. The
/// regression we are pinning here is recreating the
/// `docs/postmortem-2026-05-12-monitor-switch.md` chain — where a refactor
/// allowed the new ScreenCast pipeline to start while the old one was
/// still emitting frames, and Plasma misrouted the resulting media.
///
/// Tolerates the loop dropping the ack sender (loop exited before
/// acknowledging) — at worst, the subsequent `Replace` send will return
/// the closed-channel error and the caller surfaces it.
async fn send_stop_and_wait_ack(tx: &mpsc::Sender<SwitchMsg>) -> Result<(), String> {
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
    tx.send(SwitchMsg::Stop { ack: ack_tx })
        .await
        .map_err(|e| format!("switch channel closed: {e}"))?;
    let _ = ack_rx.await;
    Ok(())
}

#[tauri::command]
async fn switch_monitor(
    monitor_id: u32,
    switch_state: State<'_, SwitchState>,
) -> Result<(), String> {
    dbg_log(&format!(
        "[switch_monitor] requested monitor_id={monitor_id}"
    ));
    let tx = {
        let guard = switch_state.0.lock().unwrap_or_else(|p| p.into_inner());
        guard.clone()
    };
    let Some(tx) = tx else {
        return Err("kein aktiver Stream — start_streaming zuerst aufrufen".to_string());
    };

    // Phase 1: stop the live capturer FIRST. Without this step, building
    // the new ScreenCapturer below opens a second portal pipeline while
    // the old one is still alive — Plasma routes the new session's media
    // unpredictably when two ScreenCast sources overlap.
    send_stop_and_wait_ack(&tx).await?;

    // Phase 2: now that the old pipeline is gone, open the portal dialog
    // / pick the next monitor and build the fresh capturer + encoder.
    let new_capturer = capture::ScreenCapturer::start(monitor_id)
        .await
        .map_err(|e| {
            dbg_log(&format!("[switch_monitor] capturer start failed: {e}"));
            e.to_string()
        })?;
    let w = new_capturer.width();
    let h = new_capturer.height();
    let new_enc = encoder::Vp8Encoder::new(w, h, bitrate_controller::START_BITRATE_KBPS)
        .map_err(|e| e.to_string())?;
    let (new_x, new_y) = capture::list_displays()
        .into_iter()
        .find(|m| m.id == monitor_id)
        .map(|m| (m.x, m.y))
        .unwrap_or((0, 0));
    dbg_log(&format!(
        "[switch_monitor] new capturer ready {w}x{h} @ ({new_x},{new_y}), queueing swap"
    ));

    tx.send(SwitchMsg::Replace {
        capturer: new_capturer,
        encoder: new_enc,
        x: new_x,
        y: new_y,
        width: w,
        height: h,
    })
    .await
    .map_err(|e| format!("switch channel closed: {e}"))?;
    Ok(())
}

/// Decide whether `disconnect_streaming` should emit the `{"kind":"bye"}`
/// relay before tearing the peer down.
///
/// The bye is a courtesy: the viewer's relay handler shows
/// "Der Sharer hat den Stream beendet." instead of the generic ICE-fail
/// "Verbindung verloren" message. **But** when `keep_signaling = true`
/// (the viewer-swap path) the backend has already moved `session.viewer`
/// to the brand-new viewer (and `session.confirmed` stays true across
/// `detachViewer` — see `backend/src/codes.ts`). The bye would therefore
/// reach the new viewer instead of the prior one and tear THEIR session
/// down before any offer is exchanged.
///
/// Pure helper so the policy is easy to unit-test; production passes the
/// `keep_signaling` flag through verbatim.
fn should_send_bye(keep_signaling: bool) -> bool {
    !keep_signaling
}

/// Reentrancy guards for `start_signaling`. Each of the four sub-resources
/// is checked independently — if ANY is still live, we refuse to start.
///
/// This is gh #64: a previous version of `start_signaling` would replace
/// `SignalingState` while the WebRTC peer / input controller /
/// file-transfer manager from the prior session were still allocated.
/// The result was a leaked input loop that kept applying mouse/keyboard
/// events from the previous (potentially attacker-confirmed) peer, after
/// the UI thought the session was gone. Anyone "simplifying" this to a
/// single signaling-only check is recreating that bug.
///
/// Error strings are stable (`&'static str`) so they can be asserted on
/// without comparing dynamic format output.
fn check_streaming_preconditions(
    signaling_active: bool,
    rtc_alive: bool,
    input_alive: bool,
    file_alive: bool,
) -> Result<(), &'static str> {
    if signaling_active {
        return Err("signaling already running — call disconnect_streaming first");
    }
    if rtc_alive {
        return Err("webrtc peer still alive — call disconnect_streaming first");
    }
    if input_alive {
        return Err("input controller still alive — call disconnect_streaming first");
    }
    if file_alive {
        return Err("file transfer still alive — call disconnect_streaming first");
    }
    Ok(())
}

/// Tear down the active WebRTC session (peer, input controller, file
/// transfer, free-tier timers, streaming loop).
///
/// `keep_signaling` controls whether the underlying WS task to the
/// backend is preserved. Defaults to `false` (full teardown — used on
/// bootstrap F5 + on the user-clicked Beenden flow where we want the
/// next start_signaling to register a fresh code). Pass `true` when a
/// new viewer just joined the same code and we only want to swap the
/// streaming state without losing the WS registration that the new
/// viewer's `join` arrived on.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn disconnect_streaming(
    app: tauri::AppHandle,
    sig_state: State<'_, SignalingState>,
    rtc_state: State<'_, WebRtcState>,
    input_state: State<'_, InputControllerState>,
    file_state: State<'_, FileTransferState>,
    timer_state: State<'_, FreeTierTimerState>,
    switch_state: State<'_, SwitchState>,
    outbound_state: State<'_, OutboundSinkState>,
    bytes_state: State<'_, SessionBytesState>,
    keep_signaling: Option<bool>,
) -> Result<(), String> {
    let keep_signaling = keep_signaling.unwrap_or(false);
    // Tell the viewer we're ending the session, BEFORE we tear down the peer.
    // Otherwise the viewer only sees an ICE disconnect (which looks like a
    // network problem) and shows a "Verbindung verloren" error instead of
    // a friendly "Stream beendet" message.
    //
    // CRITICAL: skip the bye when keep_signaling is true. See
    // `should_send_bye` below for the full rationale.
    let bye_sink = if should_send_bye(keep_signaling) {
        outbound_state.0.lock().await.clone()
    } else {
        None
    };
    if let Some(sink) = bye_sink {
        let payload = serde_json::json!({ "kind": "bye" });
        let _ = sink.send_relay(payload).await;
        // Give the message a brief moment to flush before we tear down the
        // signaling-adjacent state.
        tokio::time::sleep(Duration::from_millis(80)).await;
    }

    // Drop the signaling handle so start_signaling can run again. Without
    // this the #64 guard ("signaling already running") trips on every
    // subsequent restart because the slot is still populated even after
    // we sent `bye`. Dropping the handle AND the OutboundSink below drops
    // every sender into the WS task's command channel — the task observes
    // the close, sends a WS Close (releasing the ad-hoc code server-side)
    // and exits. Skip this when `keep_signaling` is true:
    // a new viewer just joined the same code and we want to preserve the
    // WS task that delivered the join — replacing the streaming state only.
    if !keep_signaling {
        {
            let mut guard = sig_state.0.lock().unwrap_or_else(|p| p.into_inner());
            *guard = None;
        }
        // Clear the OutboundSink only on the full-teardown path AND
        // only when it is the AdHoc variant. The viewer-swap path
        // (keep_signaling=true) keeps the same WSS and the same sink —
        // the new viewer's offer must answer through the channel still
        // in flight. An Unattended sink is never cleared from here:
        // it belongs to the heartbeat lifecycle, and blindly nulling
        // it on a viewer bye made every later unattended session fail
        // with "kein aktiver Signaling-Kanal" until a manual restart.
        // Scoped block above drops the std::sync::MutexGuard before
        // the await on the tokio::sync::Mutex (the guard isn't `Send`).
        let mut sink_guard = outbound_state.0.lock().await;
        if sink_guard.as_ref().is_some_and(|s| s.is_adhoc()) {
            *sink_guard = None;
        }
    }

    // gh #109: close the connection_log row before tearing the peer down.
    // Read-and-reset so a later teardown in the same process cannot report
    // the same bytes twice. No-op on the ad-hoc sink.
    {
        use std::sync::atomic::Ordering;
        // connection_log.bytes_relayed means RELAYED bytes — the schema
        // documents "0 for p2p". Reporting the track total regardless of path
        // made every direct session look like multi-GB relay traffic in the
        // admin stats. Read-and-reset so a second teardown cannot re-report.
        let written = bytes_state.0.bytes.swap(0, Ordering::Relaxed);
        let sent = reportable_relay_bytes(
            written,
            bytes_state.0.is_relay.swap(false, Ordering::Relaxed),
        );
        let sink = outbound_state.0.lock().await.clone();
        if let Some(sink) = sink {
            if let Err(e) = sink
                .send_telemetry(heartbeat::SharerFrame::ConnectionEnded {
                    bytes_relayed: sent,
                })
                .await
            {
                dbg_log(&format!("[disconnect_streaming] telemetry end: {e}"));
            }
        }
    }

    // Close the peer explicitly, then drop it. webrtc-rs has NO Drop-based
    // teardown: without close() the ICE/DTLS/SCTP tasks, their bound UDP
    // sockets, and the DataChannel callbacks (whose held senders keep the
    // input-applier and file tasks alive) leak on every session teardown.
    {
        let mut guard = rtc_state.0.lock().await;
        if let Some(peer) = guard.take() {
            if let Err(e) = peer.close().await {
                dbg_log(&format!("[disconnect_streaming] peer close: {e}"));
            }
        }
    }

    // Drop the input controller — and the global pause chords with it, which
    // are only meaningful while a controller exists.
    {
        let mut guard = input_state.0.lock().await;
        *guard = None;
    }
    hotkey::unregister_pause_hotkey(&app);

    // Drop the file transfer manager.
    {
        let mut guard = file_state.0.lock().await;
        *guard = None;
    }

    // Cancel any pending free-tier warning / cutoff timer so it cannot fire
    // against a subsequent session (gh #63). Poison-recover so a panicked
    // peer-callback thread can't strand a live timer here.
    {
        let mut guard = timer_state.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(handles) = guard.take() {
            handles.cancel();
        }
    }

    // Drop the switch-monitor channel sender so the streaming_loop sees
    // the channel close (which is its canonical shutdown signal). A
    // stale sender from a prior session would make the next switch_monitor
    // talk to a long-dead loop.
    {
        let mut guard = switch_state.0.lock().unwrap_or_else(|p| p.into_inner());
        *guard = None;
    }

    // Notify the main window so it can reset its UI state. `keepSignaling`
    // lets the UI tell a full teardown (code released — clear it) apart from a
    // viewer-swap (same WS + code kept alive for the next viewer).
    let _ = app.emit(
        "streaming-stopped",
        serde_json::json!({ "keepSignaling": keep_signaling }),
    );

    Ok(())
}

/// Bytes to report as `bytesRelayed` for a finished session.
///
/// `connection_log.bytes_relayed` documents itself as "0 for p2p": the column
/// exists to size TURN traffic. Reporting the track total regardless of path
/// made every direct session show up as multi-GB relay traffic in the admin
/// stats, which is the opposite of what the figure is for.
fn reportable_relay_bytes(written: u64, was_relay: bool) -> u64 {
    if was_relay {
        written
    } else {
        0
    }
}

/// Emitted on every abnormal (self-initiated) exit of `streaming_loop` so the
/// webview can run its disconnect + UI-reset flow instead of showing
/// "Streaming läuft." over a dead loop. Deliberate teardown via the switch
/// channel close does NOT emit — `disconnect_streaming` already emits
/// `streaming-stopped` on that path.
fn emit_streaming_failed(app: &tauri::AppHandle, reason: &str) {
    let _ = app.emit("streaming-failed", serde_json::json!({ "reason": reason }));
}

/// Drop the live `InputController` on process exit so its `Drop` releases
/// whatever the viewer still holds. Tauri ends the process from inside the
/// event loop without dropping managed state, so a helper mid-drag when the
/// user clicks the tray's "Beenden" (or closes the ad-hoc window) would
/// otherwise leave the OS with the button down — the very action taken to
/// end the session recreating gh #97. Returns whether a controller was live.
fn release_input_on_exit(state: &Arc<tokio::sync::Mutex<Option<InputController>>>) -> bool {
    // Main-thread call, no runtime context here; the applier only holds the
    // lock across one synchronous `handle`, so this cannot stall for long.
    state.blocking_lock().take().is_some()
}

/// Consecutive `encoder.encode` failures the loop tolerates before it ends
/// the stream with `streaming-failed` (reason `encode`). Roughly one second
/// at 30 fps, the same threshold the track-write arm uses. A persistent
/// failure here is a frame/encoder geometry mismatch (a source that started
/// delivering differently sized buffers); silently `continue`-ing left the
/// helper with a frozen picture and the sharer saying "Streaming läuft."
const MAX_CONSECUTIVE_ENCODE_FAILURES: u64 = 30;

fn encode_failures_exceeded(consecutive: u64) -> bool {
    consecutive > MAX_CONSECUTIVE_ENCODE_FAILURES
}

/// Where `streaming_loop` reports its abnormal exits. Production wraps
/// `emit_streaming_failed`; tests record the reasons.
type FailureSink = Arc<dyn Fn(&str) + Send + Sync>;

/// One captured frame after encoding, handed from the capture/encode thread
/// to the RTP writer.
struct EncodedFrame {
    pts_us: u64,
    packets: Vec<encoder::EncodedPacket>,
}

/// Packet-level counters the RTP writer shares with the capture/encode
/// thread's periodic "alive" line.
#[derive(Default)]
struct WriterStats {
    packets: std::sync::atomic::AtomicU64,
    write_failures: std::sync::atomic::AtomicU64,
}

/// Drives capture → encode → RTP for one session.
///
/// Waiting for a frame (`next_frame`, up to 500 ms) and the BGRA→I420 +
/// libvpx pass are synchronous and cost tens of milliseconds per frame. They
/// used to run inline in this async fn on Tauri's shared runtime, parking one
/// worker for the duration — on a single-CPU host (a small Windows Server VM
/// reached over RDP has exactly one worker) that froze ICE, DTLS/SCTP, the
/// input applier, signaling keepalives and the heartbeat for every blocked
/// interval, and on an idle screen the 500 ms poll never even yielded. The
/// blocking half therefore runs on its own thread (`capture_encode_loop`)
/// and hands encoded frames over a channel; only the `write_rtp` calls stay
/// async here.
///
/// Teardown is unchanged: the switch channel closing (disconnect_streaming)
/// ends the capture/encode thread, which drops its frame sender, which ends
/// this writer. An abnormal exit on either side reports once through
/// `on_failed` and closes its end of the channel so the other side follows.
async fn streaming_loop(
    capturer: Option<capture::ScreenCapturer>,
    enc: Option<encoder::Vp8Encoder>,
    track: std::sync::Arc<TrackLocalStaticRTP>,
    switch_rx: mpsc::Receiver<SwitchMsg>,
    controller_arc: Arc<tokio::sync::Mutex<Option<InputController>>>,
    metrics: Arc<SessionMetrics>,
    on_failed: FailureSink,
) {
    dbg_log("[streaming_loop] entered");
    let payloader = match track.codec().payloader_for_codec() {
        Ok(p) => p,
        Err(e) => {
            dbg_log(&format!(
                "[streaming_loop] no payloader for track codec: {e}"
            ));
            on_failed("internal");
            return;
        }
    };
    // One packetizer for the session: the track (and its SSRC) survives a
    // monitor switch, so the RTP clock and sequence numbers must too.
    let mut packetizer = rtp_clock::FramePacketizer::new(payloader);
    let stats = Arc::new(WriterStats::default());
    let (frame_tx, mut frame_rx) = mpsc::channel::<EncodedFrame>(4);
    let encoder_side = {
        let on_failed = Arc::clone(&on_failed);
        let stats = Arc::clone(&stats);
        let metrics = Arc::clone(&metrics);
        tokio::task::spawn_blocking(move || {
            capture_encode_loop(
                capturer,
                enc,
                switch_rx,
                controller_arc,
                metrics,
                frame_tx,
                stats,
                on_failed,
            )
        })
    };

    let mut write_failures = 0u64;
    let mut frame_count = 0u64;
    while let Some(frame) = frame_rx.recv().await {
        frame_count += 1;
        for pkt in frame.packets {
            let encoded_len = pkt.data.len() as u64;
            let rtp_packets = match packetizer.packetize(frame.pts_us, pkt.data) {
                Ok(p) => p,
                Err(e) => {
                    dbg_log(&format!("[streaming_loop] packetize failed: {e}"));
                    on_failed("internal");
                    return;
                }
            };
            if frame_count == 1 {
                if let Some(first) = rtp_packets.first() {
                    dbg_log(&format!(
                        "[streaming_loop] first frame -> {} rtp packets, ts={}",
                        rtp_packets.len(),
                        first.header.timestamp
                    ));
                }
            }
            let mut frame_written = false;
            for p in &rtp_packets {
                match track.write_rtp(p).await {
                    Ok(_) => {
                        stats
                            .packets
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        frame_written = true;
                        // Only CONSECUTIVE failures should kill the loop — a
                        // cumulative counter meant 30 transient blips spread
                        // over a long session ended it too.
                        write_failures = 0;
                        stats
                            .write_failures
                            .store(0, std::sync::atomic::Ordering::Relaxed);
                    }
                    Err(e) => {
                        write_failures += 1;
                        stats
                            .write_failures
                            .store(write_failures, std::sync::atomic::Ordering::Relaxed);
                        if write_failures <= 3 || write_failures.is_multiple_of(10) {
                            dbg_log(&format!(
                                "[streaming_loop] write_rtp err #{write_failures}: {e}"
                            ));
                        }
                        if write_failures > 30 {
                            dbg_log("[streaming_loop] write_rtp failing repeatedly; exiting");
                            on_failed("track-write");
                            return;
                        }
                    }
                }
            }
            if frame_written {
                metrics
                    .bytes
                    .fetch_add(encoded_len, std::sync::atomic::Ordering::Relaxed);
            }
        }
    }
    // The capture/encode thread closed the channel: either deliberate
    // teardown (nothing to report) or a failure it already reported. A panic
    // over there would otherwise end the stream without a word.
    if let Err(e) = encoder_side.await {
        if e.is_panic() {
            dbg_log("[streaming_loop] capture/encode thread panicked");
            on_failed("internal");
        }
    }
    dbg_log("[streaming_loop] writer exiting");
}

/// The blocking half of [`streaming_loop`]: owns capturer + encoder, serves
/// the switch-channel protocol, and pushes encoded frames to the writer.
/// Runs on a `spawn_blocking` thread, hence the `blocking_*` calls.
#[allow(clippy::too_many_arguments)]
fn capture_encode_loop(
    mut capturer: Option<capture::ScreenCapturer>,
    mut enc: Option<encoder::Vp8Encoder>,
    mut switch_rx: mpsc::Receiver<SwitchMsg>,
    controller_arc: Arc<tokio::sync::Mutex<Option<InputController>>>,
    metrics: Arc<SessionMetrics>,
    frame_tx: mpsc::Sender<EncodedFrame>,
    stats: Arc<WriterStats>,
    on_failed: FailureSink,
) {
    let mut encode_failures = 0u64;
    let mut frame_count = 0u64;
    let mut last_log_at = std::time::Instant::now();
    // Per-interval accumulators for the throughput diagnostic (effective fps +
    // average encode time) — the key signal for capture/encode lag.
    let mut frames_since_log = 0u64;
    let mut encode_us_since_log = 0u64;

    fn handle_switch_msg(
        msg: SwitchMsg,
        capturer: &mut Option<capture::ScreenCapturer>,
        enc: &mut Option<encoder::Vp8Encoder>,
        controller_arc: &Arc<tokio::sync::Mutex<Option<InputController>>>,
    ) {
        match msg {
            SwitchMsg::Stop { ack } => {
                dbg_log("[streaming_loop] stop request — dropping capturer");
                // Take by ownership so Drop runs (and on Wayland the
                // GStreamer/portal pipeline tears down) BEFORE we ack.
                *capturer = None;
                *enc = None;
                // GStreamer's `pipeline.set_state(Null)` in Drop is
                // asynchronous — by the time we reach this line the
                // pipewiresrc connection is *initiating* its teardown but
                // not necessarily complete. Plasma's portal limits to a
                // single active capture per app and refuses the next
                // `create_session()` while the old PipeWire connection
                // still appears active. Give it a beat to release.
                #[cfg(target_os = "linux")]
                std::thread::sleep(Duration::from_millis(500));
                let _ = ack.send(());
            }
            SwitchMsg::Replace {
                capturer: c,
                encoder: e,
                x,
                y,
                width,
                height,
            } => {
                dbg_log(&format!(
                    "[streaming_loop] replace -> {}x{} @ ({},{})",
                    width, height, x, y
                ));
                *capturer = Some(c);
                *enc = Some(e);
                match InputController::new(x, y, width, height) {
                    Ok(ic) => *controller_arc.blocking_lock() = Some(ic),
                    Err(e) => log::warn!("[streaming_loop] InputController re-init failed: {e}"),
                }
            }
        }
    }

    loop {
        // Idle state (between Stop and Replace): block on the channel so we
        // don't busy-loop. Channel close is shutdown.
        if capturer.is_none() {
            match switch_rx.blocking_recv() {
                Some(msg) => {
                    handle_switch_msg(msg, &mut capturer, &mut enc, &controller_arc);
                    encode_failures = 0;
                    continue;
                }
                None => {
                    dbg_log("[streaming_loop] switch channel closed while idle; exiting");
                    return;
                }
            }
        }

        // Active state: non-blocking poll for switch / shutdown between frames.
        match switch_rx.try_recv() {
            Ok(msg) => {
                handle_switch_msg(msg, &mut capturer, &mut enc, &controller_arc);
                // A fresh capturer + encoder must not inherit the old pair's
                // failure streak.
                encode_failures = 0;
                continue;
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {}
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                dbg_log("[streaming_loop] switch channel closed (disconnect_streaming); exiting");
                return;
            }
        }

        // `capturer.is_none()` was checked above and the only path that nulls
        // it again is `Stop`, which `continue`s back to the idle branch — so
        // both are present here today. Degrade to a clean exit rather than a
        // panic if a future change ever breaks that invariant.
        let (cap, encoder) = match (capturer.as_mut(), enc.as_mut()) {
            (Some(c), Some(e)) => (c, e),
            _ => {
                dbg_log("[streaming_loop] capturer/encoder unexpectedly absent in active branch; exiting");
                on_failed("internal");
                return;
            }
        };

        let frame = match cap.next_frame() {
            Ok(capture::NextFrame::Frame(f)) => f,
            Ok(capture::NextFrame::Timeout) => {
                // No frame in the poll window — the source may be stalled
                // with its channel still open (portal revoked, WGC silent
                // stop). Loop around so the switch_rx shutdown check above
                // runs; a `recv()` here used to park the loop forever, past
                // disconnect_streaming.
                continue;
            }
            Err(e) => {
                dbg_log(&format!(
                    "[streaming_loop] next_frame Err after {frame_count} frames: {e}"
                ));
                on_failed("capture");
                return;
            }
        };
        frame_count += 1;
        if frame_count == 1 {
            dbg_log(&format!(
                "[streaming_loop] FIRST FRAME received: {} bytes, pts={}",
                frame.data.len(),
                frame.pts_us
            ));
        }
        let enc_start = std::time::Instant::now();
        if metrics
            .keyframe_requested
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            dbg_log("[streaming_loop] peer connected — forcing a keyframe");
            encoder.request_keyframe();
        }
        if metrics
            .keyframe_requested_throttled
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            encoder.request_keyframe_throttled();
        }
        // Apply whatever the congestion controller last decided. set_bitrate
        // is a no-op when the value is unchanged, so this costs nothing on a
        // steady link.
        let target = metrics
            .target_bitrate_kbps
            .load(std::sync::atomic::Ordering::Relaxed);
        if target != 0 {
            if let Err(e) = encoder.set_bitrate_kbps(target) {
                log::warn!("[streaming_loop] bitrate retarget failed: {e}");
            }
        }
        let packets = match encoder.encode(&frame.data, frame.pts_us) {
            Ok(p) => {
                encode_failures = 0;
                p
            }
            Err(e) => {
                encode_failures += 1;
                if encode_failures <= 3 || encode_failures.is_multiple_of(10) {
                    dbg_log(&format!(
                        "[streaming_loop] vp8 encode error #{encode_failures} (frame {} bytes): {e}",
                        frame.data.len()
                    ));
                }
                if encode_failures_exceeded(encode_failures) {
                    dbg_log("[streaming_loop] encode failing repeatedly; exiting");
                    on_failed("encode");
                    return;
                }
                continue;
            }
        };
        if packets.iter().any(|p| p.is_keyframe) {
            // The signal that tells a black-screen report apart from a
            // network problem: without a keyframe the viewer decodes nothing,
            // and on a static screen the encoder emits none by itself.
            dbg_log(&format!(
                "[streaming_loop] keyframe emitted at frame {frame_count}"
            ));
        }
        frames_since_log += 1;
        encode_us_since_log += enc_start.elapsed().as_micros() as u64;
        if frame_count == 1 {
            dbg_log(&format!(
                "[streaming_loop] first encode -> {} packets",
                packets.len()
            ));
        }
        if !packets.is_empty()
            && frame_tx
                .blocking_send(EncodedFrame {
                    pts_us: frame.pts_us,
                    packets,
                })
                .is_err()
        {
            // The writer reported its own failure (or was dropped); nothing
            // left to feed.
            dbg_log("[streaming_loop] rtp writer gone; exiting");
            return;
        }
        // Periodic heartbeat so we know the loop is alive even when frames
        // flow silently.
        if last_log_at.elapsed() >= std::time::Duration::from_secs(2) {
            let secs = last_log_at.elapsed().as_secs_f64();
            let fps = frames_since_log as f64 / secs;
            let avg_encode_ms = if frames_since_log > 0 {
                (encode_us_since_log as f64 / frames_since_log as f64) / 1000.0
            } else {
                0.0
            };
            dbg_log(&format!(
                "[streaming_loop] alive: frames={frame_count} packets={} write_failures={} encode_failures={encode_failures} fps={fps:.1} avg_encode_ms={avg_encode_ms:.1}",
                stats.packets.load(std::sync::atomic::Ordering::Relaxed),
                stats
                    .write_failures
                    .load(std::sync::atomic::Ordering::Relaxed),
            ));
            frames_since_log = 0;
            encode_us_since_log = 0;
            last_log_at = std::time::Instant::now();
        }
    }
}

/// Called by the webview when a relay with kind="sdp" (offer) is received.
#[tauri::command]
async fn receive_offer(
    sdp: String,
    rtc_state: State<'_, WebRtcState>,
    outbound_state: State<'_, OutboundSinkState>,
) -> Result<(), String> {
    dbg_log(&format!("[receive_offer] enter sdp_len={}", sdp.len()));
    let answer_sdp = {
        let guard = rtc_state.0.lock().await;
        let peer = guard.as_ref().ok_or_else(|| {
            dbg_log("[receive_offer] FAILED: no peer in rtc_state");
            "WebRTC peer not initialized; call start_streaming first".to_string()
        })?;
        peer.set_remote_offer(sdp).await.map_err(|e| {
            dbg_log(&format!("[receive_offer] set_remote_offer err: {e}"));
            e.to_string()
        })?
    };
    dbg_log(&format!(
        "[receive_offer] answer_sdp_len={}",
        answer_sdp.len()
    ));

    let sink = {
        let guard = outbound_state.0.lock().await;
        guard.clone().ok_or_else(|| {
            dbg_log("[receive_offer] FAILED: no outbound sink configured");
            "kein aktiver Signaling-Kanal".to_string()
        })?
    };

    let payload = serde_json::json!({
        "kind": "sdp",
        "sdp": { "type": "answer", "sdp": answer_sdp }
    });
    sink.send_relay(payload).await.map_err(|e| {
        dbg_log(&format!("[receive_offer] send err: {e}"));
        e
    })?;
    dbg_log("[receive_offer] answer sent");

    Ok(())
}

/// Called by the webview when a relay with kind="ice" is received.
#[tauri::command]
async fn receive_ice_candidate(
    candidate: String,
    sdp_mid: Option<String>,
    sdp_mline_index: Option<u16>,
    username_fragment: Option<String>,
    rtc_state: State<'_, WebRtcState>,
) -> Result<(), String> {
    dbg_log(&format!(
        "[remote-ice] candidate='{}' mid={:?} mline={:?}",
        ip_redact::redact_ips_in_text(&candidate),
        sdp_mid,
        sdp_mline_index
    ));
    let init = webrtc::ice_transport::ice_candidate::RTCIceCandidateInit {
        candidate,
        sdp_mid,
        sdp_mline_index,
        username_fragment,
    };

    let guard = rtc_state.0.lock().await;
    let peer = guard.as_ref().ok_or_else(|| {
        dbg_log("[remote-ice] FAILED: no peer in rtc_state");
        "WebRTC peer not initialized".to_string()
    })?;
    peer.add_ice_candidate(init).await.map_err(|e| {
        dbg_log(&format!("[remote-ice] add_ice_candidate err: {e}"));
        e.to_string()
    })?;
    Ok(())
}

/// Called by the webview when the user accepts an incoming file offer.
///
/// Sends a `file-accept` JSON event back to the viewer over the files
/// DataChannel so it starts streaming chunks.
#[tauri::command]
async fn accept_file(
    id: String,
    rtc_state: State<'_, WebRtcState>,
    file_state: State<'_, FileTransferState>,
) -> Result<(), String> {
    let event = {
        let mut guard = file_state.0.lock().await;
        guard
            .as_mut()
            .map(|mgr| mgr.accept(&id))
            .ok_or_else(|| "file transfer not active".to_string())?
    };
    let guard = rtc_state.0.lock().await;
    let peer = guard
        .as_ref()
        .ok_or_else(|| "WebRTC peer not initialized".to_string())?;
    peer.send_file_event(&event).await
}

/// Called by the webview when the user rejects an incoming file offer.
#[tauri::command]
async fn reject_file(
    id: String,
    rtc_state: State<'_, WebRtcState>,
    file_state: State<'_, FileTransferState>,
) -> Result<(), String> {
    let event = {
        let mut guard = file_state.0.lock().await;
        guard
            .as_mut()
            .map(|mgr| mgr.reject(&id))
            .ok_or_else(|| "file transfer not active".to_string())?
    };
    let guard = rtc_state.0.lock().await;
    let peer = guard
        .as_ref()
        .ok_or_else(|| "WebRTC peer not initialized".to_string())?;
    peer.send_file_event(&event).await
}

/// Opens a native file-picker dialog and sends the chosen file to the viewer.
#[tauri::command]
async fn pick_and_send_file(
    app: tauri::AppHandle,
    rtc_state: State<'_, WebRtcState>,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    // Callback API bridged through a oneshot instead of blocking_pick_file:
    // the blocking variant parks a tokio worker thread for the entire
    // (user-paced, unbounded) dialog lifetime.
    let (picked_tx, picked_rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |p| {
        let _ = picked_tx.send(p);
    });
    let path: PathBuf = match picked_rx.await {
        Ok(Some(p)) => p.into_path().map_err(|e| e.to_string())?,
        // Dialog cancelled, or the dialog plugin dropped the callback
        // without firing (app teardown) — either way nothing to send.
        Ok(None) | Err(_) => return Err("no file selected".to_string()),
    };

    let guard = rtc_state.0.lock().await;
    let peer = guard
        .as_ref()
        .ok_or_else(|| "WebRTC peer not initialized; start streaming first".to_string())?;

    files::send_file(path, peer).await
}

// ── Autostart (gh #27) ──────────────────────────────────────────────────────
// The `@tauri-apps/plugin-autostart` JS bindings are not bundled in the
// sharer webview, so the settings UI toggles autostart through these
// commands instead. Error strings are user-facing (German); details go to
// dbg_log.

#[tauri::command]
fn enable_autostart(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().enable().map_err(|e| {
        dbg_log(&format!("[autostart] enable failed: {e}"));
        "Autostart konnte nicht aktiviert werden.".to_string()
    })
}

#[tauri::command]
fn disable_autostart(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().disable().map_err(|e| {
        dbg_log(&format!("[autostart] disable failed: {e}"));
        "Autostart konnte nicht deaktiviert werden.".to_string()
    })
}

#[tauri::command]
fn is_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| {
        dbg_log(&format!("[autostart] is_enabled failed: {e}"));
        "Autostart-Status konnte nicht gelesen werden.".to_string()
    })
}

pub fn run() {
    // rustls 0.23+ refuses to pick a default CryptoProvider when both
    // 'ring' and 'aws-lc-rs' are present in the dep graph (we have both,
    // pulled in transitively by webrtc-rs and rustls-platform-verifier).
    // Install ring explicitly before any TLS use (signaling WSS,
    // /turn-credentials reqwest) so the first connection doesn't panic.
    // Failure here means a process-default was already installed —
    // harmless, swallow it.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // `--debug` turns on diagnostic logging for the whole session (transient —
    // not persisted). The settings toggle persists separately and is synced by
    // the webview on startup. With it, a release build (which has no console)
    // can still produce a tailable %TEMP%\auffi-debug.log.
    if debug_flag_present(std::env::args()) {
        set_debug_logging_enabled(true);
        dbg_log("[startup] --debug flag present — diagnostic logging enabled");
    }

    // Route the `log` facade into dbg_log. Err means a logger was already
    // installed (only possible in embedded/test contexts) — keep it.
    if log::set_logger(&LOG_FORWARDER).is_ok() {
        log::set_max_level(log::LevelFilter::Debug);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        // Unattended-mode autostart: registered but defaults to off — the
        // settings UI flips it via the `enable_autostart` /
        // `disable_autostart` / `is_autostart_enabled` commands above
        // (gh #27; the plugin's JS bindings are not bundled in the
        // webview). On macOS we use LaunchAgent (per-user, no privileged
        // install required); Linux ships a .desktop file under
        // `~/.config/autostart`; Windows uses
        // `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. No
        // extra args — the sharer's normal entry point handles
        // unattended-mode bootstrap on its own.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(SignalingState(Mutex::new(None)))
        .manage(WebRtcState(Arc::new(tokio::sync::Mutex::new(None))))
        .manage(InputControllerState(Arc::new(tokio::sync::Mutex::new(
            None,
        ))))
        .manage(FileTransferState(Arc::new(tokio::sync::Mutex::new(None))))
        .manage(FreeTierTimerState(Arc::new(Mutex::new(None))))
        .manage(SwitchState(Mutex::new(None)))
        .manage(OutboundSinkState(Arc::new(tokio::sync::Mutex::new(None))))
        .manage(SessionBytesState(Arc::new(SessionMetrics::default())))
        .manage(unattended_cmd::UnattendedState::default())
        .invoke_handler(tauri::generate_handler![
            start_signaling,
            confirm_peer,
            list_monitors,
            capture_backend_uses_portal,
            start_streaming,
            receive_offer,
            receive_ice_candidate,
            disconnect_streaming,
            switch_monitor,
            accept_file,
            reject_file,
            pick_and_send_file,
            enable_autostart,
            disable_autostart,
            is_autostart_enabled,
            unattended_cmd::unattended_pair,
            unattended_cmd::unattended_unpair,
            unattended_cmd::unattended_is_paired,
            unattended_cmd::unattended_set_password,
            unattended_cmd::unattended_is_password_set,
            unattended_cmd::unattended_get_mode,
            unattended_cmd::unattended_set_mode,
            unattended_cmd::unattended_start,
            unattended_cmd::unattended_stop,
            unattended_cmd::unattended_is_active,
            unattended_cmd::unattended_confirm,
            unattended_cmd::unattended_submit_feedback,
            update_check::check_for_update,
            set_debug_logging,
            get_debug_logging,
            open_debug_log,
        ])
        // gh #26: tray icon + minimise-to-tray. Built in setup() so
        // the AppHandle is available. The window-close handler reads
        // the persisted mode (gh #20) and prevents close in
        // unattended mode — the sharer keeps running in the tray and
        // the heartbeat WSS stays alive. In ad-hoc mode the default
        // quit-on-close behaviour is preserved so the existing UX
        // for the help-a-friend use case doesn't change.
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
            use tauri::Manager;

            let show_item =
                MenuItem::with_id(app, "tray-show", "Auffi öffnen", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray-quit", "Beenden", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // Load the 32x32 PNG explicitly — the default window icon
            // comes through as raw 16-bit-per-channel RGBA (the source
            // PNGs are 16-bit) which the tray-icon crate rejects with
            // "expected 4096 got 8192". Decoding with `image` gives us
            // normalised 8-bit RGBA.
            let icon_png: &[u8] = include_bytes!("../icons/32x32.png");
            let decoded = image::load_from_memory_with_format(icon_png, image::ImageFormat::Png)
                .map_err(|e| format!("tray icon decode: {e}"))?
                .to_rgba8();
            let (w, h) = decoded.dimensions();
            let icon = tauri::image::Image::new_owned(decoded.into_raw(), w, h);

            let _tray = TrayIconBuilder::with_id("auffi-tray")
                .icon(icon)
                .tooltip("Auffi")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray-show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "tray-quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Unattended mode must come up without a click — that is what
            // autostart + minimise-to-tray promise.
            unattended_cmd::resume_on_launch(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::{Manager, WindowEvent};
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Read the persisted mode synchronously — it's a tiny
                // text file under app_data_dir. Anything other than
                // "unattended" falls through to the default close
                // (quit) behaviour.
                let unattended = window
                    .app_handle()
                    .path()
                    .app_data_dir()
                    .ok()
                    .and_then(|dir| std::fs::read_to_string(dir.join("mode.txt")).ok())
                    .map(|s| s.trim() == "unattended")
                    .unwrap_or(false);
                if unattended {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error building tauri")
        .run(|app, event| {
            use tauri::Manager;
            if let tauri::RunEvent::Exit = event {
                if release_input_on_exit(&app.state::<InputControllerState>().0) {
                    dbg_log("[exit] released held input before quitting");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::reportable_relay_bytes;
    use std::sync::{Arc, Mutex};

    // gh #109 follow-up: bytes_relayed is a TURN-traffic figure. Filling it
    // with the track total on a direct path made every p2p session read as
    // multi-GB relay traffic in the admin stats.
    #[test]
    fn relay_bytes_are_reported_only_for_a_relayed_path() {
        assert_eq!(reportable_relay_bytes(41_231_872, true), 41_231_872);
        assert_eq!(reportable_relay_bytes(41_231_872, false), 0);
        assert_eq!(reportable_relay_bytes(0, true), 0);
    }

    // Serialises the tests that flip the process-global DEBUG_LOGGING atomic so
    // cargo's parallel runner cannot interleave their enabled/disabled windows.
    static LOG_GATE_LOCK: Mutex<()> = Mutex::new(());

    fn unique_marker(tag: &str) -> String {
        format!(
            "dbg-log-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    #[test]
    fn dbg_log_path_lives_inside_os_temp_dir_and_is_named_auffi_debug_log() {
        let path = super::dbg_log_path();
        assert!(
            path.is_absolute(),
            "dbg_log path must be absolute: {path:?}"
        );
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("auffi-debug.log"),
            "dbg_log filename must be auffi-debug.log: {path:?}"
        );
        assert!(
            path.starts_with(std::env::temp_dir()),
            "dbg_log path must be inside std::env::temp_dir(): got {path:?}, temp_dir is {:?}",
            std::env::temp_dir()
        );
    }

    // "Log öffnen" created the file with the default umask (0644) and no
    // NOFOLLOW while dbg_log deliberately opens it 0600 + O_NOFOLLOW. Release
    // builds ship with logging off, so the realistic order is: click the
    // button (world-readable file), then enable logging — mode(0o600) only
    // applies at creation, so every connection-metadata line afterwards was
    // readable by other local users. A pre-planted symlink at the path made
    // create_new report AlreadyExists and the opener launched its target.
    #[cfg(unix)]
    #[test]
    fn ensure_log_file_creates_the_file_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("auffi-debug.log");
        super::ensure_log_file(&path).expect("create");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "log file must be owner-only, got {mode:o}");
        super::ensure_log_file(&path).expect("an existing regular file is fine");
    }

    #[cfg(unix)]
    #[test]
    fn ensure_log_file_refuses_a_symlink_at_the_log_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("victim");
        std::fs::write(&target, b"secret").expect("target");
        let path = dir.path().join("auffi-debug.log");
        std::os::unix::fs::symlink(&target, &path).expect("symlink");
        assert!(
            super::ensure_log_file(&path).is_err(),
            "must not open through a symlink"
        );
    }

    #[test]
    fn dbg_log_writes_when_enabled() {
        let _guard = LOG_GATE_LOCK.lock().unwrap();
        let prev = super::debug_logging_enabled();
        super::set_debug_logging_enabled(true);
        let marker = unique_marker("enabled");
        super::dbg_log(&marker);
        super::set_debug_logging_enabled(prev);

        let path = super::dbg_log_path();
        let contents =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
        assert!(
            contents.contains(&marker),
            "expected dbg_log to append marker {marker:?} to {path:?} when enabled"
        );
    }

    #[test]
    fn dbg_log_silent_when_disabled() {
        let _guard = LOG_GATE_LOCK.lock().unwrap();
        let prev = super::debug_logging_enabled();
        super::set_debug_logging_enabled(false);
        let marker = unique_marker("disabled");
        super::dbg_log(&marker);
        super::set_debug_logging_enabled(prev);

        // The file may already exist from prior runs — assert only that the
        // disabled write did not land.
        let path = super::dbg_log_path();
        let contents = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            !contents.contains(&marker),
            "dbg_log must not write {marker:?} while logging is disabled"
        );
    }

    // ── log-facade forwarder (2026-08 review) ───────────────────────────
    // Without an installed backend every log::warn!/info!/debug! in the
    // crate was a silent no-op. The forwarder must (a) write enabled
    // records into the dbg_log sink, (b) respect the runtime gate, and
    // (c) filter out trace-level noise.

    #[test]
    fn log_forwarder_writes_warn_records_when_gate_enabled() {
        let _guard = LOG_GATE_LOCK.lock().unwrap();
        let prev = super::debug_logging_enabled();
        super::set_debug_logging_enabled(true);
        let marker = unique_marker("logfwd-on");
        log::Log::log(
            &super::LOG_FORWARDER,
            &log::Record::builder()
                .level(log::Level::Warn)
                .target("auffi_test")
                .args(format_args!("{marker}"))
                .build(),
        );
        super::set_debug_logging_enabled(prev);

        let contents = std::fs::read_to_string(super::dbg_log_path()).unwrap_or_default();
        assert!(
            contents.contains(&marker),
            "forwarder must append warn records to the dbg_log file"
        );
        assert!(
            contents.contains(&format!("[WARN] auffi_test: {marker}")),
            "forwarder line must carry level and target"
        );
    }

    #[test]
    fn log_forwarder_silent_when_gate_disabled() {
        let _guard = LOG_GATE_LOCK.lock().unwrap();
        let prev = super::debug_logging_enabled();
        super::set_debug_logging_enabled(false);
        let marker = unique_marker("logfwd-off");
        log::Log::log(
            &super::LOG_FORWARDER,
            &log::Record::builder()
                .level(log::Level::Warn)
                .target("auffi_test")
                .args(format_args!("{marker}"))
                .build(),
        );
        super::set_debug_logging_enabled(prev);

        let contents = std::fs::read_to_string(super::dbg_log_path()).unwrap_or_default();
        assert!(
            !contents.contains(&marker),
            "forwarder must not write while the runtime gate is off"
        );
    }

    #[test]
    fn log_forwarder_filters_trace_but_accepts_debug() {
        let _guard = LOG_GATE_LOCK.lock().unwrap();
        let prev = super::debug_logging_enabled();
        super::set_debug_logging_enabled(true);
        let trace_enabled = log::Log::enabled(
            &super::LOG_FORWARDER,
            &log::Metadata::builder().level(log::Level::Trace).build(),
        );
        let debug_enabled = log::Log::enabled(
            &super::LOG_FORWARDER,
            &log::Metadata::builder().level(log::Level::Debug).build(),
        );
        super::set_debug_logging_enabled(prev);
        assert!(!trace_enabled, "trace must stay filtered");
        assert!(debug_enabled, "debug and above must pass the filter");
    }

    #[test]
    fn debug_flag_present_detects_the_flag() {
        assert!(super::debug_flag_present(
            ["auffi.exe".to_string(), "--debug".to_string()].into_iter()
        ));
        assert!(!super::debug_flag_present(
            ["auffi.exe".to_string()].into_iter()
        ));
        assert!(!super::debug_flag_present(
            ["auffi.exe".to_string(), "--other".to_string()].into_iter()
        ));
    }

    /// Pinned regression for the `bye`-to-new-viewer Critical that
    /// surfaced in the 2026-05-12 viewer-swap addendum (postmortem-05-12).
    /// Anyone tempted to "simplify" `should_send_bye` to always-true is
    /// recreating that bug; this test must fail when they do.
    #[test]
    fn should_send_bye_only_when_not_keeping_signaling() {
        assert!(super::should_send_bye(false));
        assert!(!super::should_send_bye(true));
    }

    /// Pinned regression for the monitor-switch ordering chain in
    /// `docs/postmortem-2026-05-12-monitor-switch.md`. The two-phase swap
    /// MUST observe the loop's ack before any caller-side "build new
    /// pipeline" work begins. We assert two things in one harness:
    /// (1) `Stop` lands on the channel, and (2) `send_stop_and_wait_ack`
    /// does not return until the loop has actually dropped the ack
    /// sender (i.e. the loop saw Stop). Anyone refactoring the helper to
    /// skip the await — or to send Replace inline before Stop — must
    /// fail this test.
    #[tokio::test]
    async fn send_stop_and_wait_ack_blocks_until_loop_acks() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use tokio::sync::mpsc;

        let (tx, mut rx) = mpsc::channel::<super::SwitchMsg>(1);
        let loop_observed_stop = Arc::new(AtomicBool::new(false));
        let loop_observed_stop_clone = loop_observed_stop.clone();

        let loop_task = tokio::spawn(async move {
            match rx.recv().await {
                Some(super::SwitchMsg::Stop { ack }) => {
                    // Simulate the streaming_loop doing its drop-the-old-
                    // capturer work, then acking.
                    tokio::time::sleep(std::time::Duration::from_millis(15)).await;
                    loop_observed_stop_clone.store(true, Ordering::SeqCst);
                    let _ = ack.send(());
                }
                Some(super::SwitchMsg::Replace { .. }) => {
                    panic!("expected first message to be Stop, got Replace")
                }
                None => panic!("channel closed before Stop arrived"),
            }
        });

        super::send_stop_and_wait_ack(&tx)
            .await
            .expect("ack must succeed when loop responds");

        assert!(
            loop_observed_stop.load(Ordering::SeqCst),
            "send_stop_and_wait_ack returned before the loop processed Stop"
        );

        loop_task.await.expect("loop task panicked");
    }

    /// If the loop has already exited and dropped the ack sender, the
    /// caller must NOT hang. (The follow-up Replace send will report the
    /// closed-channel error and the user sees a clean failure.)
    #[tokio::test]
    async fn send_stop_and_wait_ack_does_not_hang_when_loop_drops_ack() {
        use tokio::sync::mpsc;

        let (tx, mut rx) = mpsc::channel::<super::SwitchMsg>(1);
        let loop_task = tokio::spawn(async move {
            // Receive Stop and drop the ack sender without firing it.
            match rx.recv().await {
                Some(super::SwitchMsg::Stop { ack }) => drop(ack),
                Some(super::SwitchMsg::Replace { .. }) => panic!("expected Stop, got Replace"),
                None => panic!("channel closed before Stop arrived"),
            }
        });

        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            super::send_stop_and_wait_ack(&tx),
        )
        .await
        .expect("must not hang when ack sender is dropped")
        .expect("function must return Ok even if ack was not fired");

        loop_task.await.expect("loop task panicked");
    }

    /// Closed channel surfaces as a typed error, not a panic.
    #[tokio::test]
    async fn send_stop_and_wait_ack_errors_when_channel_closed() {
        use tokio::sync::mpsc;
        let (tx, rx) = mpsc::channel::<super::SwitchMsg>(1);
        drop(rx);
        let err = super::send_stop_and_wait_ack(&tx)
            .await
            .expect_err("closed channel must produce Err");
        assert!(
            err.contains("switch channel closed"),
            "error should mention switch channel closed, got: {err}"
        );
    }

    /// Pinned regression for gh #64. Each precondition for
    /// `start_signaling` must fail independently with a stable error
    /// message — anyone collapsing these checks into a single one is
    /// recreating the leaked-input-controller bug. Order of evaluation
    /// is also stable (signaling → rtc → input → file): later
    /// preconditions surface only when all earlier ones are clean.
    #[test]
    fn check_streaming_preconditions_all_clean_returns_ok() {
        assert!(super::check_streaming_preconditions(false, false, false, false).is_ok());
    }

    #[test]
    fn check_streaming_preconditions_signaling_alive_blocks() {
        let err = super::check_streaming_preconditions(true, false, false, false)
            .expect_err("signaling-alive must error");
        assert_eq!(
            err,
            "signaling already running — call disconnect_streaming first"
        );
    }

    #[test]
    fn check_streaming_preconditions_rtc_alive_blocks() {
        let err = super::check_streaming_preconditions(false, true, false, false)
            .expect_err("rtc-alive must error");
        assert_eq!(
            err,
            "webrtc peer still alive — call disconnect_streaming first"
        );
    }

    #[test]
    fn check_streaming_preconditions_input_alive_blocks() {
        let err = super::check_streaming_preconditions(false, false, true, false)
            .expect_err("input-alive must error");
        assert_eq!(
            err,
            "input controller still alive — call disconnect_streaming first"
        );
    }

    #[test]
    fn check_streaming_preconditions_file_alive_blocks() {
        let err = super::check_streaming_preconditions(false, false, false, true)
            .expect_err("file-alive must error");
        assert_eq!(
            err,
            "file transfer still alive — call disconnect_streaming first"
        );
    }

    /// Pinned regression for `docs/postmortem-2026-05-13-connectivity.md`
    /// layer #1: `ScreenCapturer::start` MUST stay `async` so the portal
    /// handshake runs on the caller's long-lived tokio runtime. If
    /// someone refactors it back to a synchronous fn that internally
    /// spawns a per-call runtime, `ashpd`'s cached `zbus::Connection`
    /// (a process-wide `OnceLock`) ends up bound to a dying runtime and
    /// the second `create_session()` hangs forever.
    ///
    /// The pin is a type-level assertion: `ScreenCapturer::start` is
    /// coerced into a function pointer whose return type is constrained
    /// to implement `Future`. A sync fn returning `Result<…, String>`
    /// directly would fail this coercion.
    #[test]
    fn screen_capturer_start_remains_async() {
        fn assert_returns_future<Fut>(_: fn(u32) -> Fut)
        where
            Fut: std::future::Future<Output = Result<super::capture::ScreenCapturer, String>>,
        {
        }
        assert_returns_future(super::capture::ScreenCapturer::start);
    }

    /// Drives `streaming_loop` with a channel-fed capturer, a real encoder
    /// and an unbound RTP track (no peer needed); failures are recorded
    /// instead of emitted to a webview.
    mod streaming_loop_harness {
        use super::super::*;
        use std::sync::Mutex as StdMutex;
        use std::time::{Duration, Instant};
        use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;

        struct Harness {
            failures: Arc<StdMutex<Vec<String>>>,
            switch_tx: mpsc::Sender<SwitchMsg>,
            frame_tx: std::sync::mpsc::SyncSender<capture::BgraFrame>,
            task: tokio::task::JoinHandle<()>,
        }

        fn spawn_loop(frame_w: u32, frame_h: u32) -> Harness {
            let (frame_tx, cap) = capture::ScreenCapturer::from_channel(frame_w, frame_h);
            let enc = encoder::Vp8Encoder::new(frame_w, frame_h, 300).expect("encoder");
            let track = Arc::new(TrackLocalStaticRTP::new(
                RTCRtpCodecCapability {
                    mime_type: "video/VP8".to_string(),
                    ..Default::default()
                },
                "video".to_string(),
                "auffi".to_string(),
            ));
            let (switch_tx, switch_rx) = mpsc::channel::<SwitchMsg>(1);
            let failures = Arc::new(StdMutex::new(Vec::new()));
            let sink: FailureSink = {
                let failures = Arc::clone(&failures);
                Arc::new(move |reason: &str| {
                    failures
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .push(reason.to_string())
                })
            };
            let task = tokio::spawn(streaming_loop(
                Some(cap),
                Some(enc),
                track,
                switch_rx,
                Arc::new(tokio::sync::Mutex::new(None)),
                Arc::new(SessionMetrics::default()),
                sink,
            ));
            Harness {
                failures,
                switch_tx,
                frame_tx,
                task,
            }
        }

        // next_frame blocks up to 500 ms and encode is synchronous; both ran
        // inline on the runtime, so on a one-worker runtime (single-CPU host)
        // every other task — ICE, input applier, heartbeat — stalled with it,
        // and an idle capture source never even yielded. Observed from a
        // separate OS thread because a parked runtime cannot run the probe.
        #[test]
        fn waiting_for_a_frame_does_not_block_the_runtime() {
            let (done_tx, done_rx) = std::sync::mpsc::channel::<Duration>();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("runtime");
                rt.block_on(async move {
                    let h = spawn_loop(4, 4);
                    let started = Instant::now();
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let _ = done_tx.send(started.elapsed());
                    drop(h.switch_tx);
                    drop(h.frame_tx);
                    let _ = tokio::time::timeout(Duration::from_secs(3), h.task).await;
                    assert!(
                        h.failures.lock().unwrap().is_empty(),
                        "deliberate teardown reports nothing"
                    );
                });
            });
            let waited = done_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("the streaming loop parked the runtime — a 50 ms timer never fired");
            assert!(
                waited < Duration::from_millis(1000),
                "a 50 ms timer took {waited:?}"
            );
        }

        #[tokio::test]
        async fn persistent_encode_failures_end_the_stream_with_reason_encode() {
            let h = spawn_loop(4, 4);
            let producer = {
                let tx = h.frame_tx.clone();
                tokio::task::spawn_blocking(move || {
                    for i in 0..60u64 {
                        // Far too short for 4x4 BGRA — every encode fails.
                        let undersized = capture::BgraFrame {
                            data: vec![0u8; 8],
                            pts_us: i * 33_000,
                        };
                        if tx.send(undersized).is_err() {
                            break;
                        }
                    }
                })
            };
            tokio::time::timeout(Duration::from_secs(5), h.task)
                .await
                .expect("loop must give up instead of spinning")
                .expect("no panic");
            assert_eq!(*h.failures.lock().unwrap(), vec!["encode".to_string()]);
            drop(h.switch_tx);
            drop(h.frame_tx);
            let _ = producer.await;
        }
    }

    #[test]
    fn release_input_on_exit_reports_no_controller() {
        let state = Arc::new(tokio::sync::Mutex::new(None));
        assert!(!super::release_input_on_exit(&state));
    }

    /// Needs a display: builds a real controller, holds a button and a key,
    /// and checks the exit hook takes (and thereby releases) it.
    #[test]
    #[ignore]
    fn release_input_on_exit_takes_the_live_controller_with_real_enigo() {
        use super::input::{Button, InputController, InputEvent};
        let mut ctrl = InputController::new(0, 0, 1920, 1080).expect("need display");
        ctrl.apply(InputEvent::MouseButton {
            button: Button::Left,
            pressed: true,
        })
        .expect("press");
        let state = Arc::new(tokio::sync::Mutex::new(Some(ctrl)));
        assert!(super::release_input_on_exit(&state));
        assert!(
            state.blocking_lock().is_none(),
            "controller must be gone after exit"
        );
    }

    // A persistent frame/encoder size mismatch (Wayland renegotiation, any
    // producer handing over a wrongly sized buffer) used to make every encode
    // fail while the loop kept spinning at frame rate: frozen picture for the
    // helper, "Streaming läuft." on the sharer, and no event that would let
    // the webview restart. The encode arm has to give up like the write arm.
    #[test]
    fn encode_failures_exceeded_only_after_thirty_consecutive() {
        assert!(!super::encode_failures_exceeded(0));
        assert!(!super::encode_failures_exceeded(30));
        assert!(super::encode_failures_exceeded(31));
    }

    #[test]
    fn check_streaming_preconditions_short_circuits_in_order() {
        // signaling beats rtc beats input beats file. If we ever changed
        // the evaluation order, several existing UI error toasts would
        // start firing for a different "reason" than before. Pin it.
        let err =
            super::check_streaming_preconditions(true, true, true, true).expect_err("must error");
        assert!(err.starts_with("signaling already running"));
        let err =
            super::check_streaming_preconditions(false, true, true, true).expect_err("must error");
        assert!(err.starts_with("webrtc peer still alive"));
        let err =
            super::check_streaming_preconditions(false, false, true, true).expect_err("must error");
        assert!(err.starts_with("input controller still alive"));
    }
}
