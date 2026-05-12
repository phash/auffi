mod capture;
mod encoder;
mod files;
mod free_tier_timer;
mod hotkey;
pub mod input;
mod protocol;
mod signaling;
mod turn_config;
mod webrtc_peer;

/// Append a diagnostic line to `/tmp/auffi-debug.log` with explicit
/// flush. Stdio buffering eats println!/eprintln! when the tauri-cli pipes
/// our streams, so for ad-hoc live diagnostics this writes to a known path
/// that can be `tail -F`'d. Errors are silently dropped — diagnostics must
/// never crash the app.
///
/// Debug-only: in release builds the function compiles to a no-op so the
/// world-writable `/tmp` path is not exposed (TOCTOU symlink risk on Linux).
/// Production code paths should prefer `log::info!`/`log::warn!`.
#[cfg(debug_assertions)]
#[allow(dead_code)]
pub(crate) fn dbg_log(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/auffi-debug.log")
    {
        let _ = writeln!(f, "{}", msg);
        let _ = f.flush();
    }
}

#[cfg(not(debug_assertions))]
#[allow(dead_code)]
pub(crate) fn dbg_log(_msg: &str) {}

use std::{path::PathBuf, sync::Arc, sync::Mutex, time::Duration};

use tauri::{Emitter, Manager, State};
use tokio::sync::mpsc;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use capture::DisplayInfo;
use files::FileMessage;
use input::{InputController, InputEvent};

struct SignalingState(Mutex<Option<signaling::Signaling>>);

struct WebRtcState(tokio::sync::Mutex<Option<webrtc_peer::SharerPeer>>);

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
    // (gh #64)
    if state
        .0
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
    {
        return Err("signaling already running — call disconnect_streaming first".to_string());
    }
    if rtc_state.0.lock().await.is_some() {
        return Err("webrtc peer still alive — call disconnect_streaming first".to_string());
    }
    if input_state.0.lock().await.is_some() {
        return Err("input controller still alive — call disconnect_streaming first".to_string());
    }
    if file_state.0.lock().await.is_some() {
        return Err("file transfer still alive — call disconnect_streaming first".to_string());
    }

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

/// Show the border overlay window on the monitor being streamed, emit
/// `border-info` with the connected peer's IP prefix.
///
/// Temporarily unused — the transparent overlay window renders opaque-black on
/// some compositors and traps user input. Re-enable once the compositor /
/// pass-through behaviour is verified on the target distros.
#[allow(dead_code)]
fn show_border_window(app: &tauri::AppHandle, monitor: &DisplayInfo, ip_prefix: &str) {
    let Some(border) = app.get_webview_window("border") else {
        log::warn!("border window not found");
        return;
    };

    let pos = tauri::PhysicalPosition::new(monitor.x, monitor.y);
    let size = tauri::PhysicalSize::new(monitor.width, monitor.height);

    if let Err(e) = border.set_position(pos) {
        log::warn!("border window set_position failed: {e}");
    }
    if let Err(e) = border.set_size(size) {
        log::warn!("border window set_size failed: {e}");
    }

    let payload = serde_json::json!({ "ipPrefix": ip_prefix });
    if let Err(e) = app.emit_to("border", "border-info", payload) {
        log::warn!("border-info emit failed: {e}");
    }

    if let Err(e) = border.show() {
        log::warn!("border window show failed: {e}");
    }
}

/// Hide the border overlay window, ignoring errors (window may already be hidden).
fn hide_border_window(app: &tauri::AppHandle) {
    if let Some(border) = app.get_webview_window("border") {
        if let Err(e) = border.hide() {
            log::warn!("border window hide failed: {e}");
        }
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
    ip_state: State<'_, PeerIpState>,
    file_state: State<'_, FileTransferState>,
    timer_state: State<'_, FreeTierTimerState>,
) -> Result<(), String> {
    dbg_log(&format!(
        "[start_streaming] enter monitor_id={} session_code=***",
        monitor_id
    ));
    let ws_url = std::env::var("AUFFI_BACKEND_WS").unwrap_or_else(|_| {
        std::option_env!("AUFFI_DEFAULT_BACKEND_WS")
            .unwrap_or("wss://auffi.app/signal")
            .to_string()
    });
    let backend_http_url = turn_config::ws_url_to_http(&ws_url);
    dbg_log(&format!("[start_streaming] backend_http_url={}", backend_http_url));
    let ice_servers = turn_config::fetch_ice_servers(&backend_http_url, &session_code).await;
    dbg_log(&format!("[start_streaming] ice_servers count={}", ice_servers.len()));

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
                    let _ = tx.send(protocol::Outgoing::Relay { payload }).await;
                });
            }
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
    let mut capturer = capture::ScreenCapturer::start(monitor_id).map_err(|e| {
        dbg_log(&format!("[start_streaming] ScreenCapturer::start FAILED: {e}"));
        e.to_string()
    })?;
    dbg_log(&format!(
        "[start_streaming] capturer ready {}x{}",
        capturer.width(),
        capturer.height()
    ));
    let width = capturer.width();
    let height = capturer.height();

    let (input_tx, mut input_rx) = mpsc::channel::<InputEvent>(256);
    let (files_msg_tx, mut files_msg_rx) = mpsc::channel::<FileMessage>(256);
    peer.on_data_channels(input_tx, files_msg_tx);

    let controller = InputController::new(width, height).map_err(|e| e.to_string())?;
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
    let app_for_files = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = files_msg_rx.recv().await {
            match msg {
                FileMessage::Event(ev) => {
                    let mut guard = file_mgr_arc.lock().await;
                    if let Some(mgr) = guard.as_mut() {
                        let _ = mgr.handle_offer(ev, &app_for_files);
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

    // Position and show the border overlay on the chosen monitor.
    let monitors = capture::list_displays();
    let monitor = monitors
        .iter()
        .find(|m| m.id == monitor_id)
        .cloned()
        .unwrap_or(DisplayInfo {
            id: monitor_id,
            title: String::new(),
            x: 0,
            y: 0,
            width,
            height,
        });
    let ip_prefix = ip_state
        .0
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();
    // TEMP-DISABLED: the transparent overlay window currently renders opaque
    // black on this compositor and traps the user's desktop. Re-enable once
    // the transparency / pass-through behaviour is verified end-to-end.
    let _ = (&monitor, &ip_prefix);
    // show_border_window(&app, &monitor, &ip_prefix);

    let mut enc = encoder::Vp8Encoder::new(width, height, 2000)?;

    tauri::async_runtime::spawn(async move {
        streaming_loop(&mut capturer, &mut enc, track).await;
    });

    Ok(())
}

/// Tear down the active WebRTC session and hide the border overlay.
///
/// Invocable both from the main window (future use) and from the border
/// overlay's "Trennen" button.
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
) -> Result<(), String> {
    // Tell the viewer we're ending the session, BEFORE we tear down the peer.
    // Otherwise the viewer only sees an ICE disconnect (which looks like a
    // network problem) and shows a "Verbindung verloren" error instead of
    // a friendly "Stream beendet" message.
    let bye_tx = {
        let guard = sig_state
            .0
            .lock()
            .map_err(|e| format!("signaling state lock poisoned: {e}"))?;
        guard.as_ref().map(|s| s.tx.clone())
    };
    if let Some(tx) = bye_tx {
        let payload = serde_json::json!({ "kind": "bye" });
        let _ = tx.send(protocol::Outgoing::Relay { payload }).await;
        // Give the message a brief moment to flush before we tear down the
        // signaling-adjacent state.
        tokio::time::sleep(Duration::from_millis(80)).await;
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
    // against a subsequent session (gh #63).
    if let Ok(mut guard) = timer_state.0.lock() {
        if let Some(handles) = guard.take() {
            handles.cancel();
        }
    }

    // Clear the cached peer IP so the next session starts clean.
    if let Ok(mut guard) = ip_state.0.lock() {
        *guard = None;
    }

    hide_border_window(&app);

    // Notify the main window so it can reset its UI state.
    let _ = app.emit("streaming-stopped", serde_json::json!({}));

    Ok(())
}

async fn streaming_loop(
    capturer: &mut capture::ScreenCapturer,
    enc: &mut encoder::Vp8Encoder,
    track: std::sync::Arc<TrackLocalStaticSample>,
) {
    dbg_log("[streaming_loop] entered");
    let mut write_failures = 0u64;
    let mut frame_count = 0u64;
    let mut sample_count = 0u64;
    let mut last_log_at = std::time::Instant::now();
    loop {
        let frame = match capturer.next_frame() {
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
        let packets = match enc.encode(&frame.data, frame.pts_us) {
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
                    if write_failures <= 3 || write_failures % 10 == 0 {
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
    let answer_sdp = {
        let guard = rtc_state.0.lock().await;
        let peer = guard
            .as_ref()
            .ok_or_else(|| "WebRTC peer not initialized; call start_streaming first".to_string())?;
        peer.set_remote_offer(sdp)
            .await
            .map_err(|e| e.to_string())?
    };

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

    let payload = serde_json::json!({
        "kind": "sdp",
        "sdp": { "type": "answer", "sdp": answer_sdp }
    });
    tx.send(protocol::Outgoing::Relay { payload })
        .await
        .map_err(|e| e.to_string())?;

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
    let init = webrtc::ice_transport::ice_candidate::RTCIceCandidateInit {
        candidate,
        sdp_mid,
        sdp_mline_index,
        username_fragment,
    };

    let guard = rtc_state.0.lock().await;
    let peer = guard
        .as_ref()
        .ok_or_else(|| "WebRTC peer not initialized".to_string())?;
    peer.add_ice_candidate(init)
        .await
        .map_err(|e| e.to_string())?;

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
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .manage(SignalingState(Mutex::new(None)))
        .manage(WebRtcState(tokio::sync::Mutex::new(None)))
        .manage(InputControllerState(Arc::new(tokio::sync::Mutex::new(
            None,
        ))))
        .manage(PeerIpState(Mutex::new(None)))
        .manage(FileTransferState(Arc::new(tokio::sync::Mutex::new(None))))
        .manage(FreeTierTimerState(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            start_signaling,
            confirm_peer,
            list_monitors,
            capture_backend_uses_portal,
            start_streaming,
            receive_offer,
            receive_ice_candidate,
            disconnect_streaming,
            accept_file,
            reject_file,
            pick_and_send_file,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri");
}
