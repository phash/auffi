mod capture;
mod encoder;
mod protocol;
mod signaling;
mod webrtc_peer;

use std::sync::Mutex;
use tauri::State;

struct SignalingState(Mutex<Option<signaling::Signaling>>);

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
    if accepted {
        tx.send(protocol::Outgoing::Relay {
            payload: serde_json::json!({ "hello": "from sharer" }),
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(SignalingState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![start_signaling, confirm_peer])
        .run(tauri::generate_context!())
        .expect("error running tauri");
}
