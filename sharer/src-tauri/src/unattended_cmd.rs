//! Tauri command bindings for unattended-mode setup + lifecycle.
//!
//! These are thin wrappers over `account.rs`, `device_password.rs`,
//! and `heartbeat.rs`. The mode-toggle UI (gh #20) calls them through
//! `@tauri-apps/api/core invoke`. The actual business logic lives in
//! the underlying modules; this file's job is to: (a) resolve the
//! app-config dir from `tauri::AppHandle`, (b) translate Result types
//! into the String-error shape Tauri expects, (c) hold the
//! heartbeat handle + lockout state across calls.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex};

use crate::account::{self, KeyringTokenStore, TokenStore};
use crate::device_password;
use crate::heartbeat::{self, HeartbeatCommand, HeartbeatEvent, HeartbeatHandle, SharerFrame};
use crate::local_lockout::LocalLockout;
use crate::pw_check::{handle_pw_check, PwCheckOutcome};

/// Filename used inside the app-config directory for the persisted
/// mode (ad-hoc / unattended). Stored as plain UTF-8 — non-sensitive.
const MODE_FILE: &str = "mode.txt";

/// Wrapping every command result in a String simplifies the JS-side
/// error handling — `try { await invoke(...) } catch (msg)` works
/// uniformly without any special-cased typed errors.
type CmdResult<T> = Result<T, String>;

/// Holds the heartbeat handle + lockout state across invocations.
/// `Mutex` so multiple Tauri command handlers can claim the handle
/// without holding it across an await. Wrapped in `Arc` so the
/// event-forwarder background task can hold a reference too.
pub struct UnattendedState {
    pub handle: Arc<Mutex<Option<HeartbeatHandle>>>,
    pub lockout: Arc<Mutex<LocalLockout>>,
    /// `Option<oneshot::Sender<bool>>` set when the sharer is showing
    /// a manual-confirm prompt to the user and waiting for their
    /// click. The frontend's `unattended_confirm` command fires
    /// `true` on accept, `false` on decline. None outside of the
    /// confirm window.
    pub pending_confirm: Arc<Mutex<Option<tokio::sync::oneshot::Sender<bool>>>>,
}

impl Default for UnattendedState {
    fn default() -> Self {
        Self {
            handle: Arc::new(Mutex::new(None)),
            lockout: Arc::new(Mutex::new(LocalLockout::new())),
            pending_confirm: Arc::new(Mutex::new(None)),
        }
    }
}

fn app_data_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))
}

fn device_password_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app_data_dir(app)?.join("device_password.phc"))
}

fn mode_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app_data_dir(app)?.join(MODE_FILE))
}

fn backend_ws_url() -> String {
    std::env::var("AUFFI_BACKEND_WS").unwrap_or_else(|_| {
        std::option_env!("AUFFI_DEFAULT_BACKEND_WS")
            .unwrap_or("wss://auffi.app/signal")
            .to_string()
    })
}

fn backend_http_base() -> String {
    let ws = backend_ws_url();
    if let Some(rest) = ws.strip_prefix("wss://") {
        return format!("https://{}", rest.split('/').next().unwrap_or(rest));
    }
    if let Some(rest) = ws.strip_prefix("ws://") {
        return format!("http://{}", rest.split('/').next().unwrap_or(rest));
    }
    "http://localhost:8080".to_string()
}

// ── Pair / unpair / status ───────────────────────────────────────────

/// Trade a one-time pairing code (minted by the dashboard) for a
/// permanent device-id + token. `alias` is the human label shown in
/// the dashboard's device list — caller passes the OS hostname as a
/// sensible default; the user can override before submitting.
#[tauri::command]
pub async fn unattended_pair(app: AppHandle, code: String, alias: String) -> CmdResult<String> {
    let dir = app_data_dir(&app)?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let store = KeyringTokenStore::default_for_auffi();
    account::pair(&http, &store, &backend_http_base(), &code, &alias, &dir)
        .await
        .map_err(|e| e.to_string())
}

/// Best-effort revoke + local-wipe of the device token. Idempotent.
#[tauri::command]
pub async fn unattended_unpair(app: AppHandle) -> CmdResult<()> {
    let dir = app_data_dir(&app)?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let store = KeyringTokenStore::default_for_auffi();
    account::unpair(&http, &store, &backend_http_base(), &dir)
        .await
        .map_err(|e| e.to_string())
}

/// Returns the device-id if paired, `None` otherwise. The token never
/// leaves the keyring.
#[tauri::command]
pub fn unattended_is_paired(app: AppHandle) -> CmdResult<Option<String>> {
    let dir = app_data_dir(&app)?;
    account::read_device_id(&dir).map_err(|e| e.to_string())
}

// ── Device password ──────────────────────────────────────────────────

#[tauri::command]
pub fn unattended_set_password(app: AppHandle, password: String) -> CmdResult<()> {
    let path = device_password_path(&app)?;
    device_password::set(&password, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unattended_is_password_set(app: AppHandle) -> CmdResult<bool> {
    Ok(device_password::is_set(&device_password_path(&app)?))
}

// ── Mode persistence ─────────────────────────────────────────────────

#[tauri::command]
pub fn unattended_get_mode(app: AppHandle) -> CmdResult<String> {
    let path = mode_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            let trimmed = s.trim();
            if trimmed == "unattended" {
                Ok("unattended".to_string())
            } else {
                Ok("adhoc".to_string())
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("adhoc".to_string()),
        Err(e) => Err(format!("mode file IO: {e}")),
    }
}

#[tauri::command]
pub fn unattended_set_mode(app: AppHandle, mode: String) -> CmdResult<()> {
    let normalised = if mode == "unattended" { "unattended" } else { "adhoc" };
    let dir = app_data_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    let path = mode_path(&app)?;
    std::fs::write(&path, normalised).map_err(|e| format!("write mode: {e}"))?;
    Ok(())
}

// ── Heartbeat lifecycle ──────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct UnattendedEvent<'a> {
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    viewer_info: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// Start the persistent unattended WSS. Requires the device to be
/// paired AND the password set; returns an `Err` otherwise so the UI
/// can route the user to the appropriate setup step.
#[tauri::command]
pub async fn unattended_start(
    app: AppHandle,
    state: State<'_, UnattendedState>,
) -> CmdResult<()> {
    if state.handle.lock().await.is_some() {
        return Err("unattended bereits aktiv".to_string());
    }
    let dir = app_data_dir(&app)?;
    let device_id = account::read_device_id(&dir)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Gerät nicht gepaart".to_string())?;
    let store = KeyringTokenStore::default_for_auffi();
    let token = store
        .read()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Token fehlt im Keyring".to_string())?;
    let pw_path = device_password_path(&app)?;
    if !device_password::is_set(&pw_path) {
        return Err("Geräte-Passwort nicht gesetzt".to_string());
    }

    let cfg = heartbeat::HeartbeatConfig::production(backend_ws_url(), device_id, token);
    let HeartbeatHandle { commands, events } = heartbeat::start(cfg);

    // Spawn the event forwarder: routes BackendFrames into the
    // pw-check decision + emits status events to the Tauri webview.
    let app_emit = app.clone();
    let lockout = state.lockout.clone();
    let pending_confirm = state.pending_confirm.clone();
    let cmds_for_loop = commands.clone();
    tauri::async_runtime::spawn(forwarder_loop(
        app_emit,
        events,
        cmds_for_loop,
        lockout,
        pending_confirm,
        pw_path,
    ));

    *state.handle.lock().await = Some(HeartbeatHandle { commands, events: dummy_receiver() });
    Ok(())
}

#[tauri::command]
pub async fn unattended_stop(state: State<'_, UnattendedState>) -> CmdResult<()> {
    let h = state.handle.lock().await.take();
    if let Some(handle) = h {
        let _ = handle.commands.send(HeartbeatCommand::Shutdown).await;
    }
    Ok(())
}

/// Reply to a pending manual-confirm prompt (from a pw-check where
/// `auto_accept=false`). The frontend's confirm-toast button handlers
/// call this with `true` on accept and `false` on decline.
#[tauri::command]
pub async fn unattended_confirm(
    accepted: bool,
    state: State<'_, UnattendedState>,
) -> CmdResult<()> {
    let sender = state.pending_confirm.lock().await.take();
    if let Some(s) = sender {
        let _ = s.send(accepted);
    }
    Ok(())
}

/// Returns a receiver that's already closed — used as a placeholder
/// in `UnattendedState.handle` because the real receiver has been
/// moved into the forwarder task. The handle's `commands` Sender is
/// what callers actually use.
fn dummy_receiver() -> mpsc::Receiver<HeartbeatEvent> {
    let (_, rx) = mpsc::channel(1);
    rx
}

async fn forwarder_loop(
    app: AppHandle,
    mut events: mpsc::Receiver<HeartbeatEvent>,
    cmds: mpsc::Sender<HeartbeatCommand>,
    lockout: Arc<Mutex<LocalLockout>>,
    pending_confirm: Arc<Mutex<Option<tokio::sync::oneshot::Sender<bool>>>>,
    pw_path: PathBuf,
) {
    while let Some(event) = events.recv().await {
        match event {
            HeartbeatEvent::Connected { device_id } => {
                let _ = app.emit(
                    "unattended-event",
                    UnattendedEvent {
                        kind: "connected",
                        device_id: Some(device_id),
                        viewer_info: None,
                        reason: None,
                    },
                );
            }
            HeartbeatEvent::PwCheck {
                attempt,
                auto_accept,
            } => {
                let outcome = {
                    let mut lk = lockout.lock().await;
                    handle_pw_check(&attempt, auto_accept, &pw_path, &mut lk, Instant::now())
                };
                match outcome {
                    PwCheckOutcome::AutoAccepted => {
                        let _ = cmds
                            .send(HeartbeatCommand::Send(SharerFrame::PwCheckResult {
                                result: heartbeat::PwResult::Ok,
                            }))
                            .await;
                    }
                    PwCheckOutcome::NeedsConfirm => {
                        // Park a oneshot, emit to frontend, await the
                        // user's click. Decline on timeout (60 s per
                        // spec) so the viewer doesn't hang.
                        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
                        *pending_confirm.lock().await = Some(tx);
                        let _ = app.emit(
                            "unattended-event",
                            UnattendedEvent {
                                kind: "needs-confirm",
                                device_id: None,
                                viewer_info: None,
                                reason: None,
                            },
                        );
                        let accepted = match tokio::time::timeout(
                            std::time::Duration::from_secs(60),
                            rx,
                        )
                        .await
                        {
                            Ok(Ok(v)) => v,
                            _ => false, // timeout or sender dropped → decline
                        };
                        // Clear pending_confirm in case the timeout
                        // path beat the user's click.
                        let _ = pending_confirm.lock().await.take();
                        let result = if accepted {
                            heartbeat::PwResult::Ok
                        } else {
                            heartbeat::PwResult::Rejected
                        };
                        let _ = cmds
                            .send(HeartbeatCommand::Send(SharerFrame::PwCheckResult { result }))
                            .await;
                    }
                    PwCheckOutcome::Wrong | PwCheckOutcome::NotConfigured => {
                        let _ = cmds
                            .send(HeartbeatCommand::Send(SharerFrame::PwCheckResult {
                                result: heartbeat::PwResult::Fail,
                            }))
                            .await;
                    }
                    PwCheckOutcome::DropSilently { .. } => {
                        // Per spec section 6: no reply on local
                        // lockout. Emit a tray-notification event so
                        // the user sees the lockout banner.
                        let _ = app.emit(
                            "unattended-event",
                            UnattendedEvent {
                                kind: "locked-out",
                                device_id: None,
                                viewer_info: None,
                                reason: None,
                            },
                        );
                    }
                }
            }
            HeartbeatEvent::PeerJoined { viewer_info } => {
                let _ = app.emit(
                    "unattended-event",
                    UnattendedEvent {
                        kind: "peer-joined",
                        device_id: None,
                        viewer_info: Some(viewer_info),
                        reason: None,
                    },
                );
            }
            HeartbeatEvent::PeerRejected { reason } => {
                let _ = app.emit(
                    "unattended-event",
                    UnattendedEvent {
                        kind: "peer-rejected",
                        device_id: None,
                        viewer_info: None,
                        reason: Some(reason),
                    },
                );
            }
            HeartbeatEvent::Relay { payload } => {
                let _ = app.emit(
                    "unattended-event",
                    serde_json::json!({"kind":"relay","payload":payload}),
                );
            }
            HeartbeatEvent::Disconnected { reason } => {
                let _ = app.emit(
                    "unattended-event",
                    UnattendedEvent {
                        kind: "disconnected",
                        device_id: None,
                        viewer_info: None,
                        reason: Some(reason),
                    },
                );
            }
            HeartbeatEvent::Reconnecting { after, attempt } => {
                let _ = app.emit(
                    "unattended-event",
                    serde_json::json!({
                        "kind": "reconnecting",
                        "after_ms": after.as_millis() as u64,
                        "attempt": attempt,
                    }),
                );
            }
            HeartbeatEvent::Revoked => {
                let _ = app.emit(
                    "unattended-event",
                    UnattendedEvent {
                        kind: "revoked",
                        device_id: None,
                        viewer_info: None,
                        reason: None,
                    },
                );
                // Terminal — the heartbeat loop has already returned.
                return;
            }
            HeartbeatEvent::Superseded => {
                let _ = app.emit(
                    "unattended-event",
                    UnattendedEvent {
                        kind: "superseded",
                        device_id: None,
                        viewer_info: None,
                        reason: None,
                    },
                );
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure helpers we can test without a Tauri app instance. The
    // command bodies themselves require app.path() which only exists
    // inside a running Tauri context; those get exercised by manual
    // smoke-tests once the UI lands.

    #[test]
    fn backend_http_base_converts_wss_to_https() {
        std::env::set_var("AUFFI_BACKEND_WS", "wss://auffi.app/signal");
        assert_eq!(backend_http_base(), "https://auffi.app");
    }

    #[test]
    fn backend_http_base_converts_ws_to_http_keeping_port() {
        std::env::set_var("AUFFI_BACKEND_WS", "ws://localhost:8080/signal");
        assert_eq!(backend_http_base(), "http://localhost:8080");
        std::env::remove_var("AUFFI_BACKEND_WS");
    }
}
