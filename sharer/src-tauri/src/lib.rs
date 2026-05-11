mod capture;
mod encoder;
mod protocol;
mod signaling;
mod webrtc_peer;

use std::{sync::Mutex, time::Duration};

use tauri::State;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use capture::DisplayInfo;

struct SignalingState(Mutex<Option<signaling::Signaling>>);

struct WebRtcState(tokio::sync::Mutex<Option<webrtc_peer::SharerPeer>>);

#[tauri::command]
async fn start_signaling(
    app: tauri::AppHandle,
    state: State<'_, SignalingState>,
) -> Result<(), String> {
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
async fn confirm_peer(accepted: bool, state: State<'_, SignalingState>) -> Result<(), String> {
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

#[tauri::command]
async fn start_streaming(
    monitor_id: u32,
    sig_state: State<'_, SignalingState>,
    rtc_state: State<'_, WebRtcState>,
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

    let track = peer.track.clone();
    {
        let mut guard = rtc_state.0.lock().await;
        *guard = Some(peer);
    }

    let mut capturer = capture::ScreenCapturer::start(monitor_id).map_err(|e| e.to_string())?;
    let width = capturer.width();
    let height = capturer.height();
    let mut enc = encoder::Vp8Encoder::new(width, height, 2000)?;

    tauri::async_runtime::spawn(async move {
        streaming_loop(&mut capturer, &mut enc, track).await;
    });

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
        .manage(SignalingState(Mutex::new(None)))
        .manage(WebRtcState(tokio::sync::Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            start_signaling,
            confirm_peer,
            list_monitors,
            start_streaming,
            receive_offer,
            receive_ice_candidate,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri");
}
