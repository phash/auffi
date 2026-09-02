//! Tauri command bindings for unattended-mode setup + lifecycle.
//!
//! These are thin wrappers over `account.rs`, `device_password.rs`,
//! and `heartbeat.rs`. The mode-toggle UI (gh #20) calls them through
//! `@tauri-apps/api/core invoke`. The actual business logic lives in
//! the underlying modules; this file's job is to: (a) resolve the
//! app-config dir from `tauri::AppHandle`, (b) translate Result types
//! into the String-error shape Tauri expects, (c) hold the
//! heartbeat handle + lockout state across calls.

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
use crate::pw_check::{self, PwCheckOutcome};
use crate::turn_config::{self, TurnCredentials};

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
    /// Single-slot waiter for the TURN-credentials round-trip over the
    /// heartbeat WSS (`SharerFrame::TurnCredentialsRequest` →
    /// `BackendFrame::TurnCredentials`). `start_streaming` installs a
    /// oneshot here before sending the request; the forwarder fulfils
    /// it when the reply arrives. One slot suffices: at most one
    /// `start_streaming` is in flight (rtc_state guard).
    pub pending_turn: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Option<TurnCredentials>>>>>,
}

impl Default for UnattendedState {
    fn default() -> Self {
        Self {
            commands: Arc::new(Mutex::new(None)),
            lockout: Arc::new(Mutex::new(LocalLockout::new())),
            pending_confirms: Arc::new(Mutex::new(HashMap::new())),
            next_confirm_id: Arc::new(AtomicU64::new(1)),
            pending_turn: Arc::new(Mutex::new(None)),
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

/// Validate that a backend URL uses a TLS scheme (`wss://` or `https://`).
///
/// Returns `Ok(())` when the URL is secure, or `Ok(())` when the insecure
/// escape hatch `AUFFI_ALLOW_INSECURE=1` is set (development only). Returns
/// `Err(String)` when the URL is `ws://`/`http://` **and** the flag is absent.
///
/// Pure (takes a `&str` and an explicit `allow_insecure` flag) so it is
/// unit-testable without touching process-wide env vars (CQ M-20: parallel
/// tests racing on env vars flaked CI).
pub(crate) fn validate_backend_url(url: &str, allow_insecure: bool) -> Result<(), String> {
    let is_insecure = url.starts_with("ws://") || url.starts_with("http://");
    if is_insecure && !allow_insecure {
        return Err(format!(
            "Unsicheres Backend-URL abgelehnt: {url:?}. \
             Setze AUFFI_ALLOW_INSECURE=1 für lokale Entwicklungsumgebungen."
        ));
    }
    Ok(())
}

fn backend_ws_url() -> String {
    std::env::var("AUFFI_BACKEND_WS").unwrap_or_else(|_| {
        std::option_env!("AUFFI_DEFAULT_BACKEND_WS")
            .unwrap_or("wss://auffi.app/signal")
            .to_string()
    })
}

/// Like [`backend_ws_url`] but validates the resolved URL against
/// [`validate_backend_url`]. Returns an error string when the URL is
/// cleartext and the dev escape hatch is not set. All callers that send
/// a Bearer token MUST use this variant.
pub(crate) fn backend_ws_url_secure() -> Result<String, String> {
    let url = backend_ws_url();
    let allow_insecure = std::env::var("AUFFI_ALLOW_INSECURE")
        .map(|v| v == "1")
        .unwrap_or(false);
    validate_backend_url(&url, allow_insecure)?;
    Ok(url)
}

fn backend_http_base() -> Result<String, String> {
    Ok(crate::backend_urls::http_base_from_ws(
        &backend_ws_url_secure()?,
    ))
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
    account::pair(&http, &store, &backend_http_base()?, &code, &alias, &dir)
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
    account::unpair(&http, &store, &backend_http_base()?, &dir)
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

/// Async so the argon2id hash (m=64 MiB, t=3 — several hundred ms)
/// runs on a blocking worker instead of freezing the main thread /
/// webview while the user saves the device password.
#[tauri::command]
pub async fn unattended_set_password(app: AppHandle, password: String) -> CmdResult<()> {
    let path = device_password_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        device_password::set(&password, &path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("hash task failed: {e}"))?
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

/// Payload of the `unattended-event` Tauri event.
///
/// camelCase across the board: the webview's `interface UnattendedEvent`
/// declares `deviceId`, and reading `ev.deviceId` off a snake_case payload
/// silently yielded `undefined` — the status line showed a bare "Verbunden"
/// and never told the user which device-id the helper has to type.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
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
    start_heartbeat(&app, state.inner(), outbound_state.inner()).await
}

/// The one place the heartbeat is brought up — shared by the Aktivieren
/// button (`unattended_start`) and the launch-time resume
/// (`resume_on_launch`), so both apply the same pairing/password gate and
/// the same double-start guard.
pub(crate) async fn start_heartbeat(
    app: &AppHandle,
    state: &UnattendedState,
    outbound_state: &crate::OutboundSinkState,
) -> CmdResult<()> {
    // Hold the commands lock across the WHOLE start body (tokio Mutex,
    // so holding it over the awaits below is legal). Releasing it after
    // the guard check used to let two concurrent invokes (double-click
    // on Aktivieren) both pass and spawn two heartbeats — the backend
    // then 4408s the older one, whose forwarder wiped the newer
    // session's slots.
    let mut cmd_guard = state.commands.lock().await;
    if cmd_guard.is_some() {
        return Err("unattended bereits aktiv".to_string());
    }
    let dir = app_data_dir(app)?;
    let device_id = account::read_device_id(&dir)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Gerät nicht gepaart".to_string())?;
    let store = KeyringTokenStore::default_for_auffi();
    let token = store
        .read()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Token fehlt im Keyring".to_string())?;
    let pw_path = device_password_path(app)?;
    if !device_password::is_set(&pw_path) {
        return Err("Geräte-Passwort nicht gesetzt".to_string());
    }

    let cfg = heartbeat::HeartbeatConfig::production(backend_ws_url_secure()?, device_id, token);
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
    tauri::async_runtime::spawn(forwarder_loop(ForwarderCtx {
        app: app.clone(),
        events,
        cmds: commands.clone(),
        lockout: state.lockout.clone(),
        pending_confirms: state.pending_confirms.clone(),
        next_confirm_id: state.next_confirm_id.clone(),
        pending_turn: state.pending_turn.clone(),
        pw_path,
        cmd_slot: state.commands.clone(),
        outbound_slot: outbound_state.0.clone(),
    }));

    *cmd_guard = Some(commands);
    Ok(())
}

/// Whether a launch brings the heartbeat up by itself. `mode` is the raw
/// content of the persisted mode file (`None` when there is none).
pub(crate) fn resumes_on_launch(mode: Option<&str>) -> bool {
    mode.is_some_and(|m| m.trim() == "unattended")
}

/// Keyring/backend hiccups at login get this many tries, this far apart.
/// At session start the secret service is often still unlocking; ten
/// tries over half a minute cover that without spinning forever.
const RESUME_ATTEMPTS: u32 = 10;
const RESUME_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(3);

/// Bring the heartbeat up at launch when unattended mode is selected.
///
/// Without this the app came up "Inaktiv" after every reboot and waited for
/// someone to click Aktivieren — the one thing unattended access exists to
/// not need; autostart delivered a sharer nobody could reach. Missing
/// pairing or password is definitive (the webview shows the setup step for
/// it); every other failure is retried a few times because the keyring may
/// not be unlocked yet this early in the session.
pub(crate) fn resume_on_launch(app: AppHandle) {
    let mode = mode_path(&app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok());
    if !resumes_on_launch(mode.as_deref()) {
        return;
    }
    let paired = app_data_dir(&app)
        .ok()
        .and_then(|dir| account::read_device_id(&dir).ok().flatten())
        .is_some();
    let pw_set = device_password_path(&app)
        .map(|p| device_password::is_set(&p))
        .unwrap_or(false);
    if !paired || !pw_set {
        crate::dbg_log(&format!(
            "[unattended] not resumed on launch: paired={paired} password_set={pw_set}"
        ));
        return;
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<UnattendedState>();
        let outbound = app.state::<crate::OutboundSinkState>();
        for attempt in 1..=RESUME_ATTEMPTS {
            match start_heartbeat(&app, state.inner(), outbound.inner()).await {
                Ok(()) => {
                    crate::dbg_log(&format!("[unattended] resumed on launch (attempt {attempt})"));
                    return;
                }
                Err(e) => {
                    crate::dbg_log(&format!(
                        "[unattended] resume attempt {attempt}/{RESUME_ATTEMPTS} failed: {e}"
                    ));
                    tokio::time::sleep(RESUME_RETRY_DELAY).await;
                }
            }
        }
    });
}

#[tauri::command]
pub async fn unattended_stop(
    state: State<'_, UnattendedState>,
    outbound_state: State<'_, crate::OutboundSinkState>,
) -> CmdResult<()> {
    let cmds = state.commands.lock().await.take();
    if let Some(cmds) = cmds {
        let _ = cmds.send(HeartbeatCommand::Shutdown).await;
        // Compare-and-clear the OutboundSink: only drop the entry THIS
        // heartbeat installed. A blind `= None` here used to clobber a
        // live ad-hoc session's sink when the modes overlapped.
        let mut sink_guard = outbound_state.0.lock().await;
        if sink_guard
            .as_ref()
            .is_some_and(|s| s.is_unattended_channel(&cmds))
        {
            *sink_guard = None;
        }
    }
    Ok(())
}

/// Rust-side truth for "is the heartbeat running". The webview's local
/// `active` flag resets on a reload (F5 / hot-reload) while the
/// heartbeat keeps running — `refresh()` resyncs from this instead.
#[tauri::command]
pub async fn unattended_is_active(state: State<'_, UnattendedState>) -> CmdResult<bool> {
    Ok(state.commands.lock().await.is_some())
}

/// TURN-credential fetch for the unattended path: request/reply over
/// the heartbeat WSS instead of `POST /turn-credentials` (the
/// unattended sharer has no session code, but its WSS is already
/// bearer-authenticated). Degrades to an empty server list on
/// timeout / channel failure / backend-without-TURN — the same
/// graceful STUN-less fallback as the ad-hoc HTTP fetch.
pub(crate) async fn request_turn_via_heartbeat(
    cmds: &HeartbeatCommands,
    pending_turn: &Mutex<Option<tokio::sync::oneshot::Sender<Option<TurnCredentials>>>>,
) -> Vec<webrtc::ice_transport::ice_server::RTCIceServer> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    *pending_turn.lock().await = Some(tx);
    if cmds
        .send(HeartbeatCommand::Send(SharerFrame::TurnCredentialsRequest))
        .await
        .is_err()
    {
        *pending_turn.lock().await = None;
        return Vec::new();
    }
    let creds = match tokio::time::timeout(std::time::Duration::from_secs(3), rx).await {
        Ok(Ok(c)) => c,
        // Timeout, or the forwarder replaced/dropped the waiter. Clear
        // the slot so a late reply cannot leak into the next request.
        _ => {
            *pending_turn.lock().await = None;
            None
        }
    };
    turn_config::to_ice_servers(creds)
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

/// Submit feedback from the sharer to the backend (gh #39).
///
/// Authenticates via the same device-Bearer-token the heartbeat WSS
/// uses; backend's `POST /api/feedback` accepts both
/// `source=dashboard` (session cookie) and `source=sharer` (Bearer).
/// Only enabled in unattended mode — the webview hides the FAB
/// otherwise because there is no paired account to attach the
/// feedback to.
#[tauri::command]
pub async fn unattended_submit_feedback(
    app: AppHandle,
    category: String,
    rating: u32,
    body: String,
) -> CmdResult<()> {
    // Validate locally before burning a network round-trip. Same
    // shape the backend re-validates server-side; we only fail-fast
    // here to give the UI a snappier error.
    if !matches!(category.as_str(), "bug" | "feature" | "praise" | "other") {
        return Err("invalid category".to_string());
    }
    if !(1..=5).contains(&rating) {
        return Err("rating must be 1..5".to_string());
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("body must not be empty".to_string());
    }
    if trimmed.len() > 4000 {
        return Err("body too long (max 4000 chars)".to_string());
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

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let payload = serde_json::json!({
        "source": "sharer",
        "category": category,
        "rating": rating,
        "body": trimmed,
    });
    let url = format!("{}/api/feedback", backend_http_base()?);
    let res = http
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("X-Auffi-Device-Id", &device_id)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Senden fehlgeschlagen: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let body_preview = res
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect::<String>();
        return Err(format!("Backend {}: {}", status.as_u16(), body_preview));
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

/// Everything one forwarder run needs. Bundled so the spawn site stays
/// readable and clippy's argument-count lint has nothing to say.
struct ForwarderCtx {
    app: AppHandle,
    events: mpsc::Receiver<HeartbeatEvent>,
    /// THIS session's heartbeat sender — doubles as the generation
    /// token for the compare-and-clear teardown below.
    cmds: mpsc::Sender<HeartbeatCommand>,
    lockout: Arc<Mutex<LocalLockout>>,
    pending_confirms: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<bool>>>>,
    next_confirm_id: Arc<AtomicU64>,
    pending_turn: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Option<TurnCredentials>>>>>,
    pw_path: PathBuf,
    cmd_slot: Arc<Mutex<Option<HeartbeatCommands>>>,
    outbound_slot: Arc<Mutex<Option<OutboundSink>>>,
}

/// Compare-and-clear the shared session slots on forwarder exit
/// (CQ C-1: Revoked / Superseded / unexpected channel close must free
/// them so the next `unattended_start` doesn't trip "bereits aktiv").
///
/// `mine` is the exiting session's heartbeat sender: a STALE forwarder
/// outliving a quick stop→start toggle must not erase the slots the
/// NEWER session just populated (`same_channel` is the generation
/// check), and an `AdHoc` sink installed by the ad-hoc flow is never
/// touched from here.
pub(crate) async fn clear_session_state(
    cmd_slot: &Mutex<Option<HeartbeatCommands>>,
    outbound_slot: &Mutex<Option<OutboundSink>>,
    mine: &HeartbeatCommands,
) {
    {
        let mut guard = cmd_slot.lock().await;
        if guard.as_ref().is_some_and(|c| c.same_channel(mine)) {
            *guard = None;
        }
    }
    let mut guard = outbound_slot.lock().await;
    if guard
        .as_ref()
        .is_some_and(|s| s.is_unattended_channel(mine))
    {
        *guard = None;
    }
}

async fn forwarder_loop(ctx: ForwarderCtx) {
    let ForwarderCtx {
        app,
        mut events,
        cmds,
        lockout,
        pending_confirms,
        next_confirm_id,
        pending_turn,
        pw_path,
        cmd_slot,
        outbound_slot,
    } = ctx;
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
                // Lockout gate under the mutex (cheap); the argon2id
                // verify (m=64 MiB, t=3 — hundreds of ms) then runs on
                // a blocking worker WITHOUT the lockout mutex held so
                // it neither stalls this loop's tokio worker nor
                // serialises unrelated pw-checks; the mutex is
                // re-acquired only for the fail/success bookkeeping.
                let locked = {
                    let mut lk = lockout.lock().await;
                    pw_check::check_locked(&mut lk, Instant::now())
                };
                let outcome = match locked {
                    Some(out) => out,
                    None => {
                        let path = pw_path.clone();
                        let verify_res = tauri::async_runtime::spawn_blocking(move || {
                            device_password::verify(&attempt, &path)
                        })
                        .await
                        .unwrap_or_else(|e| {
                            Err(device_password::DevicePasswordError::Hash(format!(
                                "verify task join failed: {e}"
                            )))
                        });
                        let mut lk = lockout.lock().await;
                        pw_check::outcome_from_verify(
                            verify_res,
                            auto_accept,
                            &mut lk,
                            Instant::now(),
                        )
                    }
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
                        // In unattended mode the resting state is
                        // hidden-to-tray — a confirm prompt nobody can
                        // see auto-declines after 60 s. Surface the
                        // window so the dialog gates access for real.
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                        let _ = app.emit(
                            "unattended-event",
                            UnattendedEvent {
                                confirm_id: Some(confirm_id),
                                ..UnattendedEvent::kind("needs-confirm")
                            },
                        );
                        let cmds_for_waiter = cmds.clone();
                        let pending_for_waiter = pending_confirms.clone();
                        let app_for_waiter = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let (accepted, answered_by_user) =
                                match tokio::time::timeout(std::time::Duration::from_secs(60), rx)
                                    .await
                                {
                                    Ok(Ok(v)) => (v, true),
                                    // timeout OR sender dropped (a
                                    // newer attempt evicted this one) →
                                    // decline. Without this the viewer
                                    // would hang for the full 60 s.
                                    _ => (false, false),
                                };
                            // Belt-and-braces cleanup in case the
                            // confirm command was never invoked.
                            pending_for_waiter.lock().await.remove(&confirm_id);
                            if !answered_by_user {
                                // The webview dialog would otherwise stand
                                // open while any answer routes to a dead
                                // confirm_id — tell it to dismiss.
                                let _ = app_for_waiter.emit(
                                    "unattended-event",
                                    UnattendedEvent {
                                        confirm_id: Some(confirm_id),
                                        ..UnattendedEvent::kind("confirm-expired")
                                    },
                                );
                            }
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
            HeartbeatEvent::TurnCredentials { credentials } => {
                // Route to the start_streaming call awaiting the
                // round-trip. An unsolicited reply (waiter timed out
                // and took its sender back) is dropped silently.
                if let Some(waiter) = pending_turn.lock().await.take() {
                    let _ = waiter.send(credentials);
                }
            }
            HeartbeatEvent::Revoked => {
                let _ = app.emit("unattended-event", UnattendedEvent::kind("revoked"));
                // Terminal — the heartbeat loop has already returned.
                // Drop the handle + outbound sink so the next
                // `unattended_start` doesn't trip the "bereits aktiv"
                // guard against a dead channel (CQ C-1).
                clear_session_state(&cmd_slot, &outbound_slot, &cmds).await;
                return;
            }
            HeartbeatEvent::Superseded => {
                let _ = app.emit("unattended-event", UnattendedEvent::kind("superseded"));
                clear_session_state(&cmd_slot, &outbound_slot, &cmds).await;
                return;
            }
        }
    }
    // Channel closed without a terminal Revoked/Superseded — the
    // heartbeat task exited unexpectedly (e.g. caller dropped the
    // handle without sending Shutdown, or task panicked). Clear
    // state so the user can retry.
    clear_session_state(&cmd_slot, &outbound_slot, &cmds).await;
}

#[cfg(test)]
mod tests {

    // Autostart used to deliver a sharer that sat "Inaktiv" until someone
    // clicked Aktivieren. Only the persisted "unattended" choice resumes;
    // anything else — ad-hoc, no file, garbage — must leave the heartbeat
    // down so an ad-hoc user never gets a bearer WSS opened behind their back.
    #[test]
    fn launch_resumes_only_when_unattended_mode_is_persisted() {
        assert!(super::resumes_on_launch(Some("unattended")));
        assert!(super::resumes_on_launch(Some("unattended\n")));
        assert!(super::resumes_on_launch(Some("  unattended  ")));
        assert!(!super::resumes_on_launch(Some("adhoc")));
        assert!(!super::resumes_on_launch(Some("Unattended")));
        assert!(!super::resumes_on_launch(Some("")));
        assert!(!super::resumes_on_launch(None));
    }

    // The webview declares `deviceId` and reads `ev.deviceId`, but the struct
    // serialized snake_case with only confirm_id renamed — so the status line
    // showed a bare "Verbunden" and the user never saw which device-id the
    // helper has to type.
    #[test]
    fn event_fields_serialize_in_the_camel_case_the_webview_reads() {
        let ev = UnattendedEvent {
            device_id: Some("284-915-073".to_string()),
            viewer_info: Some(serde_json::json!({ "ipPrefix": "84.xxx" })),
            confirm_id: Some(7),
            ..UnattendedEvent::kind("connected")
        };
        let v = serde_json::to_value(&ev).expect("serialize");
        assert_eq!(v["kind"], "connected");
        assert_eq!(v["deviceId"], "284-915-073", "webview reads ev.deviceId");
        assert!(v.get("device_id").is_none(), "snake_case must not leak");
        assert!(
            v.get("viewerInfo").is_some(),
            "viewer_info must be camelCase too"
        );
        assert!(v.get("viewer_info").is_none());
        assert_eq!(v["confirmId"], 7);
    }

    #[test]
    fn absent_fields_stay_absent() {
        let v = serde_json::to_value(UnattendedEvent::kind("revoked")).expect("serialize");
        assert_eq!(v["kind"], "revoked");
        assert!(v.get("deviceId").is_none());
        assert!(v.get("reason").is_none());
    }
    use super::*;

    // Pure helpers we can test without a Tauri app instance. The
    // command bodies themselves require app.path() which only exists
    // inside a running Tauri context; those get exercised by manual
    // smoke-tests once the UI lands.

    // The ws→http scheme mapping and its tests live in `backend_urls.rs`.

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

    // ── forwarder state-clear regression (CQ C-1 + ownership) ─────────

    #[tokio::test]
    async fn clear_session_state_drops_own_slots() {
        let cmd_slot: Arc<Mutex<Option<HeartbeatCommands>>> = Arc::new(Mutex::new(None));
        let outbound_slot: Arc<Mutex<Option<OutboundSink>>> = Arc::new(Mutex::new(None));

        let (cmd_tx, _cmd_rx) = mpsc::channel(8);
        *cmd_slot.lock().await = Some(cmd_tx.clone());
        *outbound_slot.lock().await = Some(OutboundSink::Unattended(cmd_tx.clone()));

        clear_session_state(&cmd_slot, &outbound_slot, &cmd_tx).await;
        assert!(cmd_slot.lock().await.is_none());
        assert!(outbound_slot.lock().await.is_none());
    }

    #[tokio::test]
    async fn clear_session_state_is_a_noop_for_a_stale_forwarder() {
        // Quick stop→start toggle: the OLD forwarder exits after the
        // NEW session already repopulated the slots. Its clear must
        // not erase the new session's HeartbeatCommands/OutboundSink.
        let cmd_slot: Arc<Mutex<Option<HeartbeatCommands>>> = Arc::new(Mutex::new(None));
        let outbound_slot: Arc<Mutex<Option<OutboundSink>>> = Arc::new(Mutex::new(None));

        let (old_tx, _old_rx) = mpsc::channel(8);
        let (new_tx, _new_rx) = mpsc::channel(8);
        *cmd_slot.lock().await = Some(new_tx.clone());
        *outbound_slot.lock().await = Some(OutboundSink::Unattended(new_tx.clone()));

        clear_session_state(&cmd_slot, &outbound_slot, &old_tx).await;
        assert!(
            cmd_slot.lock().await.is_some(),
            "stale forwarder must not clear the new session's commands"
        );
        assert!(
            outbound_slot.lock().await.is_some(),
            "stale forwarder must not clear the new session's sink"
        );
    }

    #[tokio::test]
    async fn clear_session_state_never_touches_an_adhoc_sink() {
        let cmd_slot: Arc<Mutex<Option<HeartbeatCommands>>> = Arc::new(Mutex::new(None));
        let outbound_slot: Arc<Mutex<Option<OutboundSink>>> = Arc::new(Mutex::new(None));

        let (hb_tx, _hb_rx) = mpsc::channel(8);
        let (adhoc_tx, _adhoc_rx) = mpsc::channel(8);
        *outbound_slot.lock().await = Some(OutboundSink::AdHoc(adhoc_tx));

        clear_session_state(&cmd_slot, &outbound_slot, &hb_tx).await;
        assert!(
            outbound_slot.lock().await.is_some(),
            "an ad-hoc sink belongs to the ad-hoc lifecycle"
        );
    }

    // ── TURN-over-heartbeat round-trip ────────────────────────────────

    #[tokio::test]
    async fn request_turn_via_heartbeat_returns_servers_on_reply() {
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<HeartbeatCommand>(8);
        let pending: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Option<TurnCredentials>>>>> =
            Arc::new(Mutex::new(None));

        // Fake forwarder: observe the request command, then fulfil the
        // pending waiter like the real loop does on BackendFrame::TurnCredentials.
        let pending_for_reply = pending.clone();
        tokio::spawn(async move {
            match cmd_rx.recv().await {
                Some(HeartbeatCommand::Send(SharerFrame::TurnCredentialsRequest)) => {}
                other => panic!("expected TurnCredentialsRequest, got {other:?}"),
            }
            let waiter = pending_for_reply
                .lock()
                .await
                .take()
                .expect("waiter installed before the request was sent");
            let _ = waiter.send(Some(TurnCredentials {
                urls: vec!["turn:t.auffi.app:3478".to_string()],
                username: "u".to_string(),
                credential: "c".to_string(),
                ttl: 3600,
            }));
        });

        let servers = request_turn_via_heartbeat(&cmd_tx, &pending).await;
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].urls, vec!["turn:t.auffi.app:3478"]);
    }

    #[tokio::test]
    async fn request_turn_via_heartbeat_degrades_to_empty_on_closed_channel() {
        let (cmd_tx, cmd_rx) = mpsc::channel::<HeartbeatCommand>(1);
        drop(cmd_rx);
        let pending = Arc::new(Mutex::new(None));
        let servers = request_turn_via_heartbeat(&cmd_tx, &pending).await;
        assert!(servers.is_empty());
        assert!(
            pending.lock().await.is_none(),
            "failed request must not leave a stale waiter behind"
        );
    }

    #[tokio::test]
    async fn request_turn_via_heartbeat_null_reply_means_stun_less() {
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<HeartbeatCommand>(8);
        let pending: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Option<TurnCredentials>>>>> =
            Arc::new(Mutex::new(None));
        let pending_for_reply = pending.clone();
        tokio::spawn(async move {
            let _ = cmd_rx.recv().await;
            let waiter = pending_for_reply.lock().await.take().expect("waiter");
            let _ = waiter.send(None);
        });
        let servers = request_turn_via_heartbeat(&cmd_tx, &pending).await;
        assert!(servers.is_empty());
    }

    // ── validate_backend_url (security hardening) ─────────────────────
    //
    // Tests operate on the pure function so they never touch real env
    // vars (CQ M-20: parallel tests racing on env vars flaked CI).
    // The `allow_insecure` flag is passed explicitly, matching what
    // `backend_ws_url_secure()` reads from AUFFI_ALLOW_INSECURE.

    #[test]
    fn validate_backend_url_accepts_wss_scheme() {
        assert!(
            validate_backend_url("wss://auffi.app/signal", false).is_ok(),
            "wss:// must be accepted without the insecure flag"
        );
    }

    #[test]
    fn validate_backend_url_accepts_https_scheme() {
        assert!(
            validate_backend_url("https://auffi.app/api", false).is_ok(),
            "https:// must be accepted without the insecure flag"
        );
    }

    #[test]
    fn validate_backend_url_rejects_ws_without_insecure_flag() {
        let err = validate_backend_url("ws://localhost:8080/signal", false)
            .expect_err("ws:// without AUFFI_ALLOW_INSECURE must be rejected");
        assert!(
            err.contains("ws://localhost:8080/signal"),
            "error must name the rejected URL: {err}"
        );
        assert!(
            err.contains("AUFFI_ALLOW_INSECURE"),
            "error must mention the escape hatch: {err}"
        );
    }

    #[test]
    fn validate_backend_url_rejects_http_without_insecure_flag() {
        let err = validate_backend_url("http://localhost:8080", false)
            .expect_err("http:// without AUFFI_ALLOW_INSECURE must be rejected");
        assert!(
            err.contains("http://localhost:8080"),
            "error must name the rejected URL: {err}"
        );
    }

    #[test]
    fn validate_backend_url_permits_ws_with_insecure_flag() {
        assert!(
            validate_backend_url("ws://localhost:8080/signal", true).is_ok(),
            "ws:// with allow_insecure=true must be accepted for local dev"
        );
    }

    #[test]
    fn validate_backend_url_permits_http_with_insecure_flag() {
        assert!(
            validate_backend_url("http://localhost:8080", true).is_ok(),
            "http:// with allow_insecure=true must be accepted for local dev"
        );
    }
}
