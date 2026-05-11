mod capture;
mod encoder;
mod hotkey;
pub mod input;
mod protocol;
mod signaling;
mod webrtc_peer;

use std::{sync::Arc, sync::Mutex, time::Duration};

use tauri::{Emitter, Manager, State};
use tokio::sync::mpsc;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use capture::DisplayInfo;
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

#[tauri::command]
async fn start_signaling(
    app: tauri::AppHandle,
    state: State<'_, SignalingState>,
    ip_state: State<'_, PeerIpState>,
) -> Result<(), String> {
    // Clear any stale peer IP from a previous session.
    if let Ok(mut guard) = ip_state.0.lock() {
        *guard = None;
    }

    let url = std::env::var("SCREENSHARE_BACKEND_WS")
        .unwrap_or_else(|_| "ws://localhost:8080/signal".to_string());

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
    Ok(())
}

#[tauri::command]
fn list_monitors() -> Result<Vec<DisplayInfo>, String> {
    Ok(capture::list_displays())
}

/// Show the border overlay window on the monitor being streamed, emit
/// `border-info` with the connected peer's IP prefix.
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
async fn start_streaming(
    app: tauri::AppHandle,
    monitor_id: u32,
    sig_state: State<'_, SignalingState>,
    rtc_state: State<'_, WebRtcState>,
    input_state: State<'_, InputControllerState>,
    ip_state: State<'_, PeerIpState>,
) -> Result<(), String> {
    let ice_servers = vec!["stun:stun.l.google.com:19302".to_string()];

    let peer = webrtc_peer::SharerPeer::new(ice_servers)
        .await
        .map_err(|e| e.to_string())?;

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

    let mut capturer = capture::ScreenCapturer::start(monitor_id).map_err(|e| e.to_string())?;
    let width = capturer.width();
    let height = capturer.height();

    let (input_tx, mut input_rx) = mpsc::channel::<InputEvent>(256);
    peer.on_input_channel(input_tx);

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
    show_border_window(&app, &monitor, &ip_prefix);

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
async fn disconnect_streaming(
    app: tauri::AppHandle,
    rtc_state: State<'_, WebRtcState>,
    input_state: State<'_, InputControllerState>,
) -> Result<(), String> {
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
    while let Ok(frame) = capturer.next_frame() {
        let Ok(packets) = enc.encode(&frame.data, frame.pts_us) else {
            continue;
        };

        for pkt in packets {
            let sample = webrtc::media::Sample {
                data: pkt.data.into(),
                duration: Duration::from_millis(33),
                ..Default::default()
            };
            if track.write_sample(&sample).await.is_err() {
                return;
            }
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(SignalingState(Mutex::new(None)))
        .manage(WebRtcState(tokio::sync::Mutex::new(None)))
        .manage(InputControllerState(Arc::new(tokio::sync::Mutex::new(
            None,
        ))))
        .manage(PeerIpState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            start_signaling,
            confirm_peer,
            list_monitors,
            start_streaming,
            receive_offer,
            receive_ice_candidate,
            disconnect_streaming,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri");
}
