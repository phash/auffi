use crate::protocol::{Incoming, Outgoing};
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub struct Signaling {
    pub tx: mpsc::Sender<Outgoing>,
}

/// Derive the WebSocket Origin header value from the backend URL. The
/// production backend's `verifyClient` rejects connections whose Origin is
/// not in `ALLOWED_ORIGINS`; native clients have no Origin by default, so we
/// supply the matching origin explicitly. `wss://host/path` → `https://host`,
/// `ws://host/path` → `http://host`. Override with `AUFFI_SHARER_ORIGIN`.
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

pub async fn run(app: AppHandle, url: String) -> Signaling {
    let (tx, mut rx) = mpsc::channel::<Outgoing>(16);
    let tx_for_handle = tx.clone();

    tauri::async_runtime::spawn(async move {
        let origin = derive_origin(&url);
        let request = match url.as_str().into_client_request() {
            Ok(mut r) => {
                match origin.parse() {
                    Ok(v) => {
                        r.headers_mut().insert("Origin", v);
                    }
                    Err(e) => {
                        let _ = app.emit(
                            "disconnected",
                            serde_json::json!({ "reason": format!("invalid origin {origin:?}: {e}") }),
                        );
                        return;
                    }
                }
                r
            }
            Err(e) => {
                let _ = app.emit(
                    "disconnected",
                    serde_json::json!({ "reason": format!("invalid signaling url: {e}") }),
                );
                return;
            }
        };
        let (ws, _) = match connect_async(request).await {
            Ok(v) => v,
            Err(e) => {
                let _ = app.emit(
                    "disconnected",
                    serde_json::json!({ "reason": format!("connect failed: {e}") }),
                );
                return;
            }
        };
        let (mut write, mut read) = ws.split();

        let register = Outgoing::Register { role: "sharer" };
        match serde_json::to_string(&register) {
            Ok(txt) => {
                if write.send(Message::Text(txt.into())).await.is_err() {
                    let _ = app.emit(
                        "disconnected",
                        serde_json::json!({ "reason": "send failed on register" }),
                    );
                    return;
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "disconnected",
                    serde_json::json!({ "reason": format!("serialize error: {e}") }),
                );
                return;
            }
        }

        loop {
            tokio::select! {
                Some(out) = rx.recv() => {
                    match serde_json::to_string(&out) {
                        Ok(txt) => {
                            if write.send(Message::Text(txt.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = app.emit(
                                "disconnected",
                                serde_json::json!({ "reason": format!("serialize error: {e}") }),
                            );
                            break;
                        }
                    }
                }
                Some(Ok(msg)) = read.next() => {
                    let txt = match msg {
                        Message::Text(t) => t.to_string(),
                        Message::Close(_) => break,
                        _ => continue,
                    };
                    let parsed = match serde_json::from_str::<Incoming>(&txt) {
                        Ok(p) => p,
                        Err(_) => continue,
                    };
                    match parsed {
                        Incoming::CodeAssigned { code, .. } => {
                            let _ = app.emit(
                                "code-assigned",
                                serde_json::json!({ "code": code }),
                            );
                        }
                        Incoming::PeerJoined { viewer_info } => {
                            let _ = app.emit(
                                "peer-joined",
                                serde_json::json!({ "ipPrefix": viewer_info.ip_prefix }),
                            );
                        }
                        Incoming::PeerConfirmed => {}
                        Incoming::PeerRejected { reason } => {
                            let _ = app.emit(
                                "disconnected",
                                serde_json::json!({ "reason": reason }),
                            );
                        }
                        Incoming::Relay { payload } => {
                            let _ = app.emit(
                                "relay",
                                serde_json::json!({ "payload": payload }),
                            );
                        }
                        Incoming::Error { code, message } => {
                            let _ = app.emit(
                                "disconnected",
                                serde_json::json!({ "reason": format!("{code}: {message}") }),
                            );
                        }
                    }
                }
                else => break,
            }
        }
    });

    Signaling { tx: tx_for_handle }
}
