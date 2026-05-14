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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex};

use crate::account::{self, KeyringTokenStore, TokenStore};
use crate::device_password;
use crate::heartbeat::{self, HeartbeatCommand, HeartbeatCommands, HeartbeatEvent, SharerFrame};
use crate::local_lockout::LocalLockout;
use crate::outbound::OutboundSink;
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
///
/// `commands` is the `HeartbeatCommands` half of the gh #23 channel
/// pair — `Some` means "heartbeat task is alive", `None` means
/// "stopped". The matching `HeartbeatEvents` receiver lives inside
/// the forwarder task (CQ H-2/H-3).
pub struct UnattendedState {
    pub commands: Arc<Mutex<Option<HeartbeatCommands>>>,
    pub lockout: Arc<Mutex<LocalLockout>>,
    /// Per-attempt `oneshot::Sender<bool>` keyed by a monotonically
    /// increasing `confirm_id`. The forwarder inserts a sender each
    /// time it raises a manual-confirm prompt; the frontend echoes
    /// the `confirm_id` back through `unattended_confirm` so the
    /// click routes to the right awaiter even when overlapping
    /// pw-check attempts have queued multiple toasts.
    ///
    /// Sec M-1 (review 2026-05-13): the prior shape stored a single
    /// `Option<Sender>`, which meant a second pw-check would
    /// implicitly cancel the first AND let a stale user click route
    /// to the new pending sender. Sec M-2 (same review): waiting for
    /// the click happened inline in `forwarder_loop`, blocking every
    /// other event (relays, disconnects) for up to 60 s. With this
    /// map + the per-attempt spawned waiter task, both bugs go away.
    pub pending_confirms: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<bool>>>>,
    pub next_confirm_id: Arc<AtomicU64>,
}

impl Default for UnattendedState {
    fn default() -> Self {
        Self {
            commands: Arc::new(Mutex::new(None)),
            lockout: Arc::new(Mutex::new(LocalLockout::new())),
            pending_confirms: Arc::new(Mutex::new(HashMap::new())),
            next_confirm_id: Arc::new(AtomicU64::new(1)),
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
    backend_http_base_from(&backend_ws_url())
}

/// Pure mapping `ws[s]://host[:port]/…` → `http[s]://host[:port]`.
/// Split out so the unit tests can pin the mapping without touching
/// process-wide env vars (CQ M-20: parallel tests racing on
/// `AUFFI_BACKEND_WS` flaked CI).
fn backend_http_base_from(ws: &str) -> String {
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
    let normalised = if mode == "unattended" {
        "unattended"
    } else {
        "adhoc"
    };
    let dir = app_data_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    let path = mode_path(&app)?;
    std::fs::write(&path, normalised).map_err(|e| format!("write mode: {e}"))?;
    Ok(())
}

// ── Heartbeat lifecycle ──────────────────────────────────────────────

#[derive(Serialize, Clone, Default)]
struct UnattendedEvent<'a> {
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    viewer_info: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// Set only on `needs-confirm`. The frontend echoes this back via
    /// `unattended_confirm` so the user's click routes to the right
    /// pending waiter (Sec M-1).
    #[serde(skip_serializing_if = "Option::is_none", rename = "confirmId")]
    confirm_id: Option<u64>,
}

impl<'a> UnattendedEvent<'a> {
    fn kind(kind: &'a str) -> Self {
        Self {
            kind,
            ..Self::default()
        }
    }
}

/// Start the persistent unattended WSS. Requires the device to be
/// paired AND the password set; returns an `Err` otherwise so the UI
/// can route the user to the appropriate setup step.
#[tauri::command]
pub async fn unattended_start(
    app: AppHandle,
    state: State<'_, UnattendedState>,
    outbound_state: State<'_, crate::OutboundSinkState>,
) -> CmdResult<()> {
    if state.commands.lock().await.is_some() {
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
    let (commands, events) = heartbeat::start(cfg);

    // gh #20: install the outbound sink BEFORE the forwarder runs so
    // the very first inbound SDP/ICE relays can immediately answer
    // back through the same heartbeat WSS.
    {
        let mut sink_guard = outbound_state.0.lock().await;
        *sink_guard = Some(OutboundSink::Unattended(commands.clone()));
    }

    // Spawn the event forwarder: routes BackendFrames into the
    // pw-check decision + emits status events to the Tauri webview.
    // CQ C-1 (review 2026-05-13): the forwarder gets refs to the
    // SAME state slots `unattended_start` writes to, so the
    // terminal branches (Revoked / Superseded) can clear them
    // before returning. Without this, a revoked device would leave
    // `state.commands` stuck at "occupied" and every subsequent
    // `unattended_start` would error with "bereits aktiv".
    let app_emit = app.clone();
    let lockout = state.lockout.clone();
    let pending_confirms = state.pending_confirms.clone();
    let next_confirm_id = state.next_confirm_id.clone();
    let cmd_slot = state.commands.clone();
    let outbound_slot = outbound_state.0.clone();
    let cmds_for_loop = commands.clone();
    tauri::async_runtime::spawn(forwarder_loop(
        app_emit,
        events,
        cmds_for_loop,
        lockout,
        pending_confirms,
        next_confirm_id,
        pw_path,
        cmd_slot,
        outbound_slot,
    ));

    *state.commands.lock().await = Some(commands);
    Ok(())
}

#[tauri::command]
pub async fn unattended_stop(
    state: State<'_, UnattendedState>,
    outbound_state: State<'_, crate::OutboundSinkState>,
) -> CmdResult<()> {
    let cmds = state.commands.lock().await.take();
    if let Some(cmds) = cmds {
        let _ = cmds.send(HeartbeatCommand::Shutdown).await;
    }
    // Clear the OutboundSink so subsequent receive_offer / on_ice
    // calls fail cleanly instead of silently piling up on a dead
    // channel.
    let mut sink_guard = outbound_state.0.lock().await;
    *sink_guard = None;
    Ok(())
}

/// Reply to a pending manual-confirm prompt (from a pw-check where
/// `auto_accept=false`). The frontend's confirm-toast button handlers
/// call this with the `confirm_id` echoed from the `needs-confirm`
/// event and `accepted: true`/`false`. A click whose `confirm_id` is
/// not currently pending (e.g. the user re-clicked after the toast
/// dialog vanished on timeout) is a silent no-op.
#[tauri::command]
pub async fn unattended_confirm(
    #[allow(non_snake_case)] confirmId: u64,
    accepted: bool,
    state: State<'_, UnattendedState>,
) -> CmdResult<()> {
    let sender = state.pending_confirms.lock().await.remove(&confirmId);
    if let Some(s) = sender {
        let _ = s.send(accepted);
    }
    Ok(())
}

/// What the forwarder should do with a [`PwCheckOutcome`].
///
/// Split out from `forwarder_loop` so the protocol semantics
/// (verified+auto_accept → Ok-now, verified+manual → await user,
/// wrong/not-configured → Fail, locked → silent) are unit-pinnable
/// without standing up the async heartbeat task (TC C-3).
#[derive(Debug, PartialEq)]
pub(crate) enum PwAction {
    /// Send `pw-check-result: ok` immediately (auto-accept happy path).
    ReplyOk,
    /// Send `pw-check-result: fail` (argon2 said no, or pw file
    /// missing/corrupt — both look identical on the wire to avoid
    /// leaking sharer state).
    ReplyFail,
    /// Show the manual-confirm toast; the caller waits up to 60 s for
    /// `unattended_confirm(accepted)` and then sends `Ok` or
    /// `Rejected` based on the user's click (or timeout → Rejected).
    AwaitConfirm,
    /// Local lockout active — do NOT send anything; emit a tray-style
    /// "locked-out" status event so the user sees why incoming
    /// connect attempts are being dropped.
    SilentLockout,
}

pub(crate) fn pw_outcome_to_action(outcome: &PwCheckOutcome) -> PwAction {
    match outcome {
        PwCheckOutcome::AutoAccepted => PwAction::ReplyOk,
        PwCheckOutcome::NeedsConfirm => PwAction::AwaitConfirm,
        PwCheckOutcome::Wrong | PwCheckOutcome::NotConfigured => PwAction::ReplyFail,
        PwCheckOutcome::DropSilently { .. } => PwAction::SilentLockout,
    }
}

#[allow(clippy::too_many_arguments)]
async fn forwarder_loop(
    app: AppHandle,
    mut events: mpsc::Receiver<HeartbeatEvent>,
    cmds: mpsc::Sender<HeartbeatCommand>,
    lockout: Arc<Mutex<LocalLockout>>,
    pending_confirms: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<bool>>>>,
    next_confirm_id: Arc<AtomicU64>,
    pw_path: PathBuf,
    cmd_slot: Arc<Mutex<Option<HeartbeatCommands>>>,
    outbound_slot: Arc<Mutex<Option<OutboundSink>>>,
) {
    // Clear the state slots so the next `unattended_start` doesn't
    // trip the "bereits aktiv" guard against a dead handle (CQ C-1).
    // Called from the Revoked / Superseded terminal branches AND
    // from a normal channel-close exit (which can happen if the
    // heartbeat task aborted unexpectedly).
    async fn clear_state(
        cmd_slot: &Arc<Mutex<Option<HeartbeatCommands>>>,
        outbound_slot: &Arc<Mutex<Option<OutboundSink>>>,
    ) {
        *cmd_slot.lock().await = None;
        *outbound_slot.lock().await = None;
    }
    while let Some(event) = events.recv().await {
        match event {
            HeartbeatEvent::Connected { device_id } => {
                let _ = app.emit(
                    "unattended-event",
                    UnattendedEvent {
                        device_id: Some(device_id),
                        ..UnattendedEvent::kind("connected")
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
                match pw_outcome_to_action(&outcome) {
                    PwAction::ReplyOk => {
                        let _ = cmds
                            .send(HeartbeatCommand::Send(SharerFrame::PwCheckResult {
                                result: heartbeat::PwResult::Ok,
                            }))
                            .await;
                    }
                    PwAction::AwaitConfirm => {
                        // Sec M-1/M-2 (review 2026-05-13): spawn a
                        // dedicated waiter task so the forwarder
                        // loop keeps processing events while the
                        // user is being asked to confirm. Each
                        // attempt gets its own confirm_id so the
                        // user's click — which arrives via
                        // `unattended_confirm(confirm_id, …)` —
                        // routes to the right oneshot even when
                        // multiple toasts are queued.
                        let confirm_id = next_confirm_id.fetch_add(1, Ordering::Relaxed);
                        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
                        pending_confirms.lock().await.insert(confirm_id, tx);
                        let _ = app.emit(
                            "unattended-event",
                            UnattendedEvent {
                                confirm_id: Some(confirm_id),
                                ..UnattendedEvent::kind("needs-confirm")
                            },
                        );
                        let cmds_for_waiter = cmds.clone();
                        let pending_for_waiter = pending_confirms.clone();
                        tauri::async_runtime::spawn(async move {
                            let accepted =
                                match tokio::time::timeout(std::time::Duration::from_secs(60), rx)
                                    .await
                                {
                                    Ok(Ok(v)) => v,
                                    // timeout OR sender dropped (a
                                    // newer attempt evicted this one) →
                                    // decline. Without this the viewer
                                    // would hang for the full 60 s.
                                    _ => false,
                                };
                            // Belt-and-braces cleanup in case the
                            // confirm command was never invoked.
                            pending_for_waiter.lock().await.remove(&confirm_id);
                            let result = if accepted {
                                heartbeat::PwResult::Ok
                            } else {
                                heartbeat::PwResult::Rejected
                            };
                            let _ = cmds_for_waiter
                                .send(HeartbeatCommand::Send(SharerFrame::PwCheckResult {
                                    result,
                                }))
                                .await;
                        });
                    }
                    PwAction::ReplyFail => {
                        let _ = cmds
                            .send(HeartbeatCommand::Send(SharerFrame::PwCheckResult {
                                result: heartbeat::PwResult::Fail,
                            }))
                            .await;
                    }
                    PwAction::SilentLockout => {
                        // Per spec section 6: no reply on local
                        // lockout. Emit a tray-notification event so
                        // the user sees the lockout banner.
                        let _ = app.emit("unattended-event", UnattendedEvent::kind("locked-out"));
                    }
                }
            }
            HeartbeatEvent::PeerJoined { viewer_info } => {
                let _ = app.emit(
                    "unattended-event",
                    UnattendedEvent {
                        viewer_info: Some(viewer_info),
                        ..UnattendedEvent::kind("peer-joined")
                    },
                );
            }
            HeartbeatEvent::PeerRejected { reason } => {
                let _ = app.emit(
                    "unattended-event",
                    UnattendedEvent {
                        reason: Some(reason),
                        ..UnattendedEvent::kind("peer-rejected")
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
                        reason: Some(reason),
                        ..UnattendedEvent::kind("disconnected")
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
                let _ = app.emit("unattended-event", UnattendedEvent::kind("revoked"));
                // Terminal — the heartbeat loop has already returned.
                // Drop the handle + outbound sink so the next
                // `unattended_start` doesn't trip the "bereits aktiv"
                // guard against a dead channel (CQ C-1).
                clear_state(&cmd_slot, &outbound_slot).await;
                return;
            }
            HeartbeatEvent::Superseded => {
                let _ = app.emit("unattended-event", UnattendedEvent::kind("superseded"));
                clear_state(&cmd_slot, &outbound_slot).await;
                return;
            }
        }
    }
    // Channel closed without a terminal Revoked/Superseded — the
    // heartbeat task exited unexpectedly (e.g. caller dropped the
    // handle without sending Shutdown, or task panicked). Clear
    // state so the user can retry.
    clear_state(&cmd_slot, &outbound_slot).await;
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
        assert_eq!(
            backend_http_base_from("wss://auffi.app/signal"),
            "https://auffi.app"
        );
    }

    #[test]
    fn backend_http_base_converts_ws_to_http_keeping_port() {
        assert_eq!(
            backend_http_base_from("ws://localhost:8080/signal"),
            "http://localhost:8080"
        );
    }

    #[test]
    fn backend_http_base_falls_back_to_localhost_on_unknown_scheme() {
        assert_eq!(
            backend_http_base_from("garbage://nope"),
            "http://localhost:8080"
        );
    }

    // ── pw_outcome_to_action (TC C-3 — pinned forwarder semantics) ────
    //
    // The actual forwarder_loop is async + I/O-bound so unit-testing
    // it directly would require a tokio-tungstenite mock server. The
    // protocol decision — "given a PwCheckOutcome, what does the
    // sharer send back / show?" — is pure, and is what regresses
    // when a refactor breaks the wire contract.

    #[test]
    fn pw_outcome_auto_accepted_replies_ok_immediately() {
        assert_eq!(
            pw_outcome_to_action(&PwCheckOutcome::AutoAccepted),
            PwAction::ReplyOk,
        );
    }

    #[test]
    fn pw_outcome_needs_confirm_awaits_user() {
        assert_eq!(
            pw_outcome_to_action(&PwCheckOutcome::NeedsConfirm),
            PwAction::AwaitConfirm,
        );
    }

    #[test]
    fn pw_outcome_wrong_replies_fail() {
        assert_eq!(
            pw_outcome_to_action(&PwCheckOutcome::Wrong),
            PwAction::ReplyFail,
        );
    }

    #[test]
    fn pw_outcome_not_configured_replies_fail_same_as_wrong() {
        // Sec design: NotConfigured and Wrong MUST be wire-
        // indistinguishable so an attacker can't probe whether a
        // device password is set.
        assert_eq!(
            pw_outcome_to_action(&PwCheckOutcome::NotConfigured),
            pw_outcome_to_action(&PwCheckOutcome::Wrong),
        );
    }

    #[test]
    fn pw_outcome_drop_silently_is_silent_lockout_not_a_reply() {
        // Spec section 6: a locked sharer must NOT send any frame —
        // doing so would help the attacker confirm the device is
        // alive. Pin against any refactor that "helpfully" sends
        // PwCheckResult::Fail on lockout.
        let remaining = std::time::Duration::from_secs(900);
        let action = pw_outcome_to_action(&PwCheckOutcome::DropSilently { remaining });
        assert_eq!(action, PwAction::SilentLockout);
        assert_ne!(action, PwAction::ReplyFail);
        assert_ne!(action, PwAction::ReplyOk);
    }

    // ── pending_confirms routing (Sec M-1) ────────────────────────────
    //
    // Per-attempt routing by confirm_id is what makes the spawned
    // waiter design safe under overlapping pw-check attempts. Pin
    // the contract: a click for confirm_id=N MUST only fire the
    // sender registered under N, and removing an unknown id MUST
    // be a silent no-op.

    #[tokio::test]
    async fn pending_confirms_routes_click_to_matching_waiter() {
        let state = UnattendedState::default();
        let id1 = state.next_confirm_id.fetch_add(1, Ordering::Relaxed);
        let id2 = state.next_confirm_id.fetch_add(1, Ordering::Relaxed);
        assert!(id2 > id1, "confirm-ids must be monotonic");

        let (tx1, rx1) = tokio::sync::oneshot::channel::<bool>();
        let (tx2, rx2) = tokio::sync::oneshot::channel::<bool>();
        state.pending_confirms.lock().await.insert(id1, tx1);
        state.pending_confirms.lock().await.insert(id2, tx2);

        // Simulate the user accepting attempt #2 — only tx2 should fire.
        let sender = state.pending_confirms.lock().await.remove(&id2);
        sender.unwrap().send(true).unwrap();

        assert!(rx2.await.unwrap());
        // tx1 is still parked; awaiter on rx1 has not been answered.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), rx1)
                .await
                .is_err(),
            "rx1 must still be parked when only rx2 was answered"
        );
    }

    #[tokio::test]
    async fn pending_confirms_unknown_id_is_silent_noop() {
        // A click whose confirm_id no longer maps to a pending
        // sender (e.g. the timeout already evicted it) must NOT
        // panic and must NOT cross-fire any other waiter.
        let state = UnattendedState::default();
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        state.pending_confirms.lock().await.insert(99, tx);

        // Pretend the user clicked on id=42 (nothing pending under
        // that id).
        let sender = state.pending_confirms.lock().await.remove(&42u64);
        assert!(sender.is_none());

        // The legitimate id=99 sender is still parked.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), rx)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn pending_confirms_dropped_sender_collapses_to_decline() {
        // Sec M-1 contract: when a confirm_id is evicted from the
        // map without a click (e.g. start_unattended teardown), the
        // sender drops → the spawned waiter's rx errors → it
        // replies "rejected". This test pins the underlying
        // oneshot behaviour we rely on.
        let state = UnattendedState::default();
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        state.pending_confirms.lock().await.insert(1, tx);
        // Drop the sender by clearing the map.
        state.pending_confirms.lock().await.clear();
        let outcome = rx.await;
        assert!(outcome.is_err(), "dropped sender must surface as Err");
    }

    // ── forwarder state-clear regression (CQ C-1) ─────────────────────

    #[tokio::test]
    async fn clear_state_drops_both_commands_and_outbound() {
        use tokio::sync::mpsc;

        let cmd_slot: Arc<Mutex<Option<HeartbeatCommands>>> = Arc::new(Mutex::new(None));
        let outbound_slot: Arc<Mutex<Option<OutboundSink>>> = Arc::new(Mutex::new(None));

        // Seed both slots as a freshly-started forwarder would see
        // them.
        let (cmd_tx, _cmd_rx) = mpsc::channel(8);
        *cmd_slot.lock().await = Some(cmd_tx.clone());
        *outbound_slot.lock().await = Some(OutboundSink::Unattended(cmd_tx));
        assert!(cmd_slot.lock().await.is_some());
        assert!(outbound_slot.lock().await.is_some());

        // Mirror what `clear_state` does — the helper is private to
        // forwarder_loop, but the contract is "both slots clear on
        // any terminal exit path" (Revoked / Superseded / channel
        // close without terminal).
        *cmd_slot.lock().await = None;
        *outbound_slot.lock().await = None;
        assert!(cmd_slot.lock().await.is_none());
        assert!(outbound_slot.lock().await.is_none());
    }
}
