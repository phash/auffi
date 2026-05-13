mod account;
mod capture;
mod device_password;
mod encoder;
mod files;
mod free_tier_timer;
mod heartbeat;
mod hotkey;
pub mod input;
mod ip_redact;
mod local_lockout;
mod nat_traversal;
mod protocol;
mod pw_check;
mod signaling;
mod turn_config;
mod unattended_cmd;
mod webrtc_peer;

/// Resolve the destination path for `dbg_log()` writes.
///
/// Uses the OS-specific temp dir so the helper works on both Linux/macOS
/// (`/tmp/auffi-debug.log`) and Windows (`%TEMP%\auffi-debug.log`).
/// Hard-coding `/tmp/` would silently no-op on Windows because the path
/// is not valid there.
#[cfg(debug_assertions)]
fn dbg_log_path() -> std::path::PathBuf {
    std::env::temp_dir().join("auffi-debug.log")
}

/// Append a diagnostic line to the dbg-log file (`auffi-debug.log` in the
/// OS temp directory) with an explicit flush. Stdio buffering eats
/// println!/eprintln! when the tauri-cli pipes our streams, so for ad-hoc
/// live diagnostics this writes to a known path that can be tailed.
/// Errors are silently dropped — diagnostics must never crash the app.
///
/// Debug-only: in release builds the function compiles to a no-op so the
/// world-writable temp dir is not exposed (TOCTOU symlink risk on Linux).
/// Production code paths should prefer `log::info!`/`log::warn!`.
#[cfg(debug_assertions)]
#[allow(dead_code)]
pub(crate) fn dbg_log(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dbg_log_path())
    {
        let _ = writeln!(f, "{}", msg);
        let _ = f.flush();
    }
}

#[cfg(not(debug_assertions))]
#[allow(dead_code)]
pub(crate) fn dbg_log(_msg: &str) {}

use std::{path::PathBuf, sync::Arc, sync::Mutex, time::Duration};

use tauri::{Emitter, State};
use tokio::sync::mpsc;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use capture::DisplayInfo;
use files::FileMessage;
use input::{InputController, InputEvent};

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

/// IP prefix of the currently connected viewer, set when a peer-joined event
/// arrives so it can be forwarded to the border overlay window.
struct PeerIpState(Mutex<Option<String>>);

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
#[allow(clippy::too_many_arguments)]
async fn start_signaling(
    app: tauri::AppHandle,
    state: State<'_, SignalingState>,
    ip_state: State<'_, PeerIpState>,
    rtc_state: State<'_, WebRtcState>,
    input_state: State<'_, InputControllerState>,
    file_state: State<'_, FileTransferState>,
) -> Result<(), String> {
    // Refuse to start a fresh signaling session while the previous one's
    // resources are still allocated. Overwriting `SignalingState` while the
    // WebRTC peer / input controller / file-transfer manager from a prior
    // session are still live would leak running tasks and silently keep an
    // attacker-controlled remote-input session alive after the UI thinks
    // it has been replaced. The UI must call `disconnect_streaming` first.
    // (gh #64) Policy lives in `check_streaming_preconditions` so each
    // guard is independently unit-pinnable.
    let signaling_active = state.0.lock().map(|g| g.is_some()).unwrap_or(false);
    let rtc_alive = rtc_state.0.lock().await.is_some();
    let input_alive = input_state.0.lock().await.is_some();
    let file_alive = file_state.0.lock().await.is_some();
    check_streaming_preconditions(signaling_active, rtc_alive, input_alive, file_alive)
        .map_err(|e| e.to_string())?;

    // Clear any stale peer IP from a previous session.
    if let Ok(mut guard) = ip_state.0.lock() {
        *guard = None;
    }

    let url = std::env::var("AUFFI_BACKEND_WS").unwrap_or_else(|_| {
        std::option_env!("AUFFI_DEFAULT_BACKEND_WS")
            .unwrap_or("wss://auffi.app/signal")
            .to_string()
    });

    let sig = signaling::run(app, url).await;
    match state.0.lock() {
        Ok(mut guard) => {
            *guard = Some(sig);
            Ok(())
        }
        Err(e) => Err(format!("state lock poisoned: {e}")),
    }
}

#[tauri::command]
async fn confirm_peer(
    accepted: bool,
    ip_prefix: Option<String>,
    state: State<'_, SignalingState>,
    ip_state: State<'_, PeerIpState>,
) -> Result<(), String> {
    if let Some(ip) = ip_prefix {
        if let Ok(mut guard) = ip_state.0.lock() {
            *guard = Some(ip);
        }
    }

    let tx = {
        let guard = state
            .0
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
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
        // cleanly from a fresh state after a rejection.
        if let Ok(mut guard) = state.0.lock() {
            *guard = None;
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_streaming(
    app: tauri::AppHandle,
    monitor_id: u32,
    session_code: String,
    sig_state: State<'_, SignalingState>,
    rtc_state: State<'_, WebRtcState>,
    input_state: State<'_, InputControllerState>,
    file_state: State<'_, FileTransferState>,
    timer_state: State<'_, FreeTierTimerState>,
    switch_state: State<'_, SwitchState>,
) -> Result<(), String> {
    dbg_log(&format!(
        "[start_streaming] enter monitor_id={} session_code=***",
        monitor_id
    ));

    // Defensive guard: refuse to stack a second WebRTC peer on top of a
    // live one. The JS-side peer-joined handler is supposed to call
    // disconnect_streaming first, but a missing call would otherwise
    // silently leak a streaming_loop and queue up a second portal dialog
    // that the compositor may refuse to display.
    if rtc_state.0.lock().await.is_some() {
        return Err("ein Stream läuft bereits — disconnect_streaming zuerst aufrufen".to_string());
    }
    let ws_url = std::env::var("AUFFI_BACKEND_WS").unwrap_or_else(|_| {
        std::option_env!("AUFFI_DEFAULT_BACKEND_WS")
            .unwrap_or("wss://auffi.app/signal")
            .to_string()
    });
    let backend_http_url = turn_config::ws_url_to_http(&ws_url);
    dbg_log(&format!(
        "[start_streaming] backend_http_url={}",
        backend_http_url
    ));
    let ice_servers = turn_config::fetch_ice_servers(&backend_http_url, &session_code).await;
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

    let tx = {
        let guard = sig_state
            .0
            .lock()
            .map_err(|e| format!("signaling state lock poisoned: {e}"))?;
        guard
            .as_ref()
            .map(|s| s.tx.clone())
            .ok_or_else(|| "signaling not started".to_string())?
    };

    let tx_ice = tx.clone();
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
                let tx = tx_ice.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = tx.send(protocol::Outgoing::Relay { payload }).await {
                        dbg_log(&format!("[local-ice] send err: {e}"));
                    }
                });
            }
        } else {
            dbg_log("[local-ice] end-of-candidates");
        }
    });

    let app_for_conn_type = app.clone();
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

        if conn_type == ConnectionType::Relay {
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
            if let Ok(mut guard) = timer_state_for_cb.lock() {
                if let Some(prev) = guard.take() {
                    prev.cancel();
                }
                *guard = Some(handles);
            }
        }
    });

    dbg_log("[start_streaming] before ScreenCapturer::start");
    let capturer = capture::ScreenCapturer::start(monitor_id)
        .await
        .map_err(|e| {
            dbg_log(&format!(
                "[start_streaming] ScreenCapturer::start FAILED: {e}"
            ));
            e.to_string()
        })?;
    dbg_log(&format!(
        "[start_streaming] capturer ready {}x{}",
        capturer.width(),
        capturer.height()
    ));
    let width = capturer.width();
    let height = capturer.height();

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

    let (input_tx, mut input_rx) = mpsc::channel::<InputEvent>(256);
    let (files_msg_tx, mut files_msg_rx) = mpsc::channel::<FileMessage>(256);
    peer.on_data_channels(input_tx, files_msg_tx);

    let controller = InputController::new(monitor_origin.0, monitor_origin.1, width, height)
        .map_err(|e| e.to_string())?;
    {
        let mut guard = input_state.0.lock().await;
        *guard = Some(controller);
    }

    let controller_arc = Arc::clone(&input_state.0);
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = input_rx.recv().await {
            let mut guard = controller_arc.lock().await;
            if let Some(ctrl) = guard.as_mut() {
                if let Err(e) = ctrl.apply(ev) {
                    log::warn!("input apply: {e}");
                }
            }
        }
    });

    // Initialize the file transfer manager.
    {
        let mut guard = file_state.0.lock().await;
        *guard = Some(files::FileTransferManager::new());
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

    hotkey::register_pause_hotkey(&app, Arc::clone(&input_state.0))?;

    let track = peer.track.clone();
    {
        let mut guard = rtc_state.0.lock().await;
        *guard = Some(peer);
    }

    let enc = encoder::Vp8Encoder::new(width, height, 2000)?;

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

    tauri::async_runtime::spawn(async move {
        streaming_loop(
            Some(capturer),
            Some(enc),
            track,
            switch_rx,
            controller_arc_for_loop,
        )
        .await;
    });

    Ok(())
}

/// Swap the active capture source mid-stream.
///
/// The WebRTC track and peer connection are preserved — only the
/// upstream capturer + encoder are replaced, plus the InputController so
/// remote pointer coords map to the new resolution. On Wayland the
/// cached portal restore_token is dropped first so the portal dialog
/// re-prompts the user for a fresh source.
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

    // Wayland: drop the cached restore_token so the portal re-prompts.
    // X11 / Windows: no-op.
    #[cfg(target_os = "linux")]
    if matches!(capture::select_backend(), capture::Backend::Portal) {
        capture::delete_restore_token();
    }

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
    let new_enc = encoder::Vp8Encoder::new(w, h, 2000).map_err(|e| e.to_string())?;
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

/// Tear down the active WebRTC session and hide the border overlay.
///
/// Invocable both from the main window (future use) and from the border
/// overlay's "Trennen" button.
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
    ip_state: State<'_, PeerIpState>,
    file_state: State<'_, FileTransferState>,
    timer_state: State<'_, FreeTierTimerState>,
    switch_state: State<'_, SwitchState>,
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
    let bye_tx = if should_send_bye(keep_signaling) {
        let guard = sig_state.0.lock().unwrap_or_else(|p| p.into_inner());
        guard.as_ref().map(|s| s.tx.clone())
    } else {
        None
    };
    if let Some(tx) = bye_tx {
        let payload = serde_json::json!({ "kind": "bye" });
        let _ = tx.send(protocol::Outgoing::Relay { payload }).await;
        // Give the message a brief moment to flush before we tear down the
        // signaling-adjacent state.
        tokio::time::sleep(Duration::from_millis(80)).await;
    }

    // Drop the signaling handle so start_signaling can run again. Without
    // this the #64 guard ("signaling already running") trips on every
    // subsequent restart because the slot is still populated even after
    // we sent `bye`. Dropping the handle ends the WS task, which in turn
    // emits the "code-assigned" listener teardown — the next start_signaling
    // gets a fresh code-channel. Skip this when `keep_signaling` is true:
    // a new viewer just joined the same code and we want to preserve the
    // WS task that delivered the join — replacing the streaming state only.
    if !keep_signaling {
        let mut guard = sig_state.0.lock().unwrap_or_else(|p| p.into_inner());
        *guard = None;
    }

    // Drop the peer — this closes all ICE/DTLS transports.
    {
        let mut guard = rtc_state.0.lock().await;
        *guard = None;
    }

    // Drop the input controller.
    {
        let mut guard = input_state.0.lock().await;
        *guard = None;
    }

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

    // Clear the cached peer IP so the next session starts clean.
    {
        let mut guard = ip_state.0.lock().unwrap_or_else(|p| p.into_inner());
        *guard = None;
    }

    // Drop the switch-monitor channel sender so the streaming_loop sees
    // the channel close (which is its canonical shutdown signal). A
    // stale sender from a prior session would make the next switch_monitor
    // talk to a long-dead loop.
    {
        let mut guard = switch_state.0.lock().unwrap_or_else(|p| p.into_inner());
        *guard = None;
    }

    // Notify the main window so it can reset its UI state.
    let _ = app.emit("streaming-stopped", serde_json::json!({}));

    Ok(())
}

async fn streaming_loop(
    mut capturer: Option<capture::ScreenCapturer>,
    mut enc: Option<encoder::Vp8Encoder>,
    track: std::sync::Arc<TrackLocalStaticSample>,
    mut switch_rx: mpsc::Receiver<SwitchMsg>,
    controller_arc: Arc<tokio::sync::Mutex<Option<InputController>>>,
) {
    dbg_log("[streaming_loop] entered");
    let mut write_failures = 0u64;
    let mut frame_count = 0u64;
    let mut sample_count = 0u64;
    let mut last_log_at = std::time::Instant::now();

    async fn handle_switch_msg(
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
                tokio::time::sleep(Duration::from_millis(500)).await;
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
                    Ok(ic) => {
                        let mut g = controller_arc.lock().await;
                        *g = Some(ic);
                    }
                    Err(e) => log::warn!("[streaming_loop] InputController re-init failed: {e}"),
                }
            }
        }
    }

    loop {
        // Idle state (between Stop and Replace): block on the channel so we
        // don't busy-loop. Channel close is shutdown.
        if capturer.is_none() {
            match switch_rx.recv().await {
                Some(msg) => {
                    handle_switch_msg(msg, &mut capturer, &mut enc, &controller_arc).await;
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
                handle_switch_msg(msg, &mut capturer, &mut enc, &controller_arc).await;
                continue;
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {}
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                dbg_log("[streaming_loop] switch channel closed (disconnect_streaming); exiting");
                return;
            }
        }

        // Safety: `capturer.is_none()` was checked above and the only path
        // that nulls it again is `Stop` which `continue`s back to the idle
        // branch.
        let cap = capturer
            .as_mut()
            .expect("capturer present in active branch");
        let encoder = enc.as_mut().expect("encoder present in active branch");

        let frame = match cap.next_frame() {
            Ok(f) => f,
            Err(e) => {
                dbg_log(&format!(
                    "[streaming_loop] next_frame Err after {frame_count} frames / {sample_count} samples: {e}"
                ));
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
        let packets = match encoder.encode(&frame.data, frame.pts_us) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[streaming_loop] vp8 encode error: {e}");
                continue;
            }
        };
        if frame_count == 1 {
            dbg_log(&format!(
                "[streaming_loop] first encode -> {} packets",
                packets.len()
            ));
        }
        for pkt in packets {
            let sample = webrtc::media::Sample {
                data: pkt.data.into(),
                duration: Duration::from_millis(33),
                ..Default::default()
            };
            match track.write_sample(&sample).await {
                Ok(_) => sample_count += 1,
                Err(e) => {
                    write_failures += 1;
                    if write_failures <= 3 || write_failures.is_multiple_of(10) {
                        dbg_log(&format!(
                            "[streaming_loop] write_sample err #{write_failures}: {e}"
                        ));
                    }
                    if write_failures > 30 {
                        dbg_log("[streaming_loop] write_sample failing repeatedly; exiting");
                        return;
                    }
                }
            }
        }
        // Periodic heartbeat once per second so we know the loop is alive
        // even when frames flow silently.
        if last_log_at.elapsed() >= std::time::Duration::from_secs(2) {
            dbg_log(&format!(
                "[streaming_loop] alive: frames={frame_count} samples={sample_count} write_failures={write_failures}"
            ));
            last_log_at = std::time::Instant::now();
        }
    }
}

/// Called by the webview when a relay with kind="sdp" (offer) is received.
#[tauri::command]
async fn receive_offer(
    sdp: String,
    sig_state: State<'_, SignalingState>,
    rtc_state: State<'_, WebRtcState>,
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

    let tx = {
        let guard = sig_state
            .0
            .lock()
            .map_err(|e| format!("signaling state lock poisoned: {e}"))?;
        guard.as_ref().map(|s| s.tx.clone()).ok_or_else(|| {
            dbg_log("[receive_offer] FAILED: signaling not started");
            "signaling not started".to_string()
        })?
    };

    let payload = serde_json::json!({
        "kind": "sdp",
        "sdp": { "type": "answer", "sdp": answer_sdp }
    });
    tx.send(protocol::Outgoing::Relay { payload })
        .await
        .map_err(|e| {
            dbg_log(&format!("[receive_offer] tx.send err: {e}"));
            e.to_string()
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

    let path: Option<PathBuf> = app
        .dialog()
        .file()
        .blocking_pick_file()
        .map(|p| p.into_path().map_err(|e| e.to_string()))
        .transpose()?;

    let path = path.ok_or_else(|| "no file selected".to_string())?;

    let guard = rtc_state.0.lock().await;
    let peer = guard
        .as_ref()
        .ok_or_else(|| "WebRTC peer not initialized; start streaming first".to_string())?;

    files::send_file(path, peer).await
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

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        // Unattended-mode autostart: registered but defaults to off — the
        // settings UI (gh #20) flips it via the plugin's JS bindings
        // (`enable()` / `disable()` / `isEnabled()` from
        // `@tauri-apps/plugin-autostart`). On macOS we use LaunchAgent
        // (per-user, no privileged install required); Linux ships a
        // .desktop file under `~/.config/autostart`; Windows uses
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
        .manage(PeerIpState(Mutex::new(None)))
        .manage(FileTransferState(Arc::new(tokio::sync::Mutex::new(None))))
        .manage(FreeTierTimerState(Arc::new(Mutex::new(None))))
        .manage(SwitchState(Mutex::new(None)))
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
            unattended_cmd::unattended_pair,
            unattended_cmd::unattended_unpair,
            unattended_cmd::unattended_is_paired,
            unattended_cmd::unattended_set_password,
            unattended_cmd::unattended_is_password_set,
            unattended_cmd::unattended_get_mode,
            unattended_cmd::unattended_set_mode,
            unattended_cmd::unattended_start,
            unattended_cmd::unattended_stop,
            unattended_cmd::unattended_confirm,
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

            let icon = app
                .default_window_icon()
                .ok_or_else(|| "tauri: no default window icon configured for tray".to_string())?
                .clone();

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
        .run(tauri::generate_context!())
        .expect("error running tauri");
}

#[cfg(test)]
mod tests {
    #[cfg(debug_assertions)]
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

    #[cfg(debug_assertions)]
    #[test]
    fn dbg_log_appends_message_to_dbg_log_path() {
        let marker = format!(
            "dbg-log-test-marker-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        super::dbg_log(&marker);

        let path = super::dbg_log_path();
        let contents =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
        assert!(
            contents.contains(&marker),
            "expected dbg_log to append marker {marker:?} to {path:?}"
        );
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
