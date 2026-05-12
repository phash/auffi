use std::sync::Arc;

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};
use tokio::sync::Mutex;

use crate::input::InputController;

/// Payload emitted to the webview when the input pause state changes.
#[derive(Clone, serde::Serialize)]
struct PausedChangedPayload {
    paused: bool,
}

/// Registers `Ctrl+Alt+Pause` (and the fallback `Ctrl+Alt+P` for keyboards
/// without a Pause key).  On each press, the controller's paused state is
/// toggled and an `input-paused-changed` event is emitted to the webview so
/// the UI can update accordingly.
///
/// Idempotent: any previous registration of these two shortcuts is removed
/// before the new one is installed.  Without this, restarting streaming
/// after a disconnect would fail with "HotKey already registered".
pub fn register_pause_hotkey<R: Runtime>(
    app: &AppHandle<R>,
    controller: Arc<Mutex<Option<InputController>>>,
) -> Result<(), String> {
    let ctrl_alt = Modifiers::CONTROL | Modifiers::ALT;

    let pause_shortcut = tauri_plugin_global_shortcut::Shortcut::new(Some(ctrl_alt), Code::Pause);
    let p_shortcut = tauri_plugin_global_shortcut::Shortcut::new(Some(ctrl_alt), Code::KeyP);

    // Best-effort unregister of any previous handler — ignore errors because
    // on the first invocation the shortcuts are not yet registered and the
    // plugin returns NotRegistered, which is not actionable here.
    let _ = app.global_shortcut().unregister(pause_shortcut);
    let _ = app.global_shortcut().unregister(p_shortcut);

    let controller_pause = Arc::clone(&controller);
    let app_pause = app.clone();

    let controller_p = Arc::clone(&controller);
    let app_p = app.clone();

    app.global_shortcut()
        .on_shortcut(pause_shortcut, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let controller_clone = Arc::clone(&controller_pause);
                let app_clone = app_pause.clone();
                tauri::async_runtime::spawn(async move {
                    let mut guard = controller_clone.lock().await;
                    if let Some(ctrl) = guard.as_mut() {
                        let paused = ctrl.toggle_paused();
                        log::info!("input paused: {paused} (Ctrl+Alt+Pause)");
                        let _ =
                            app_clone.emit("input-paused-changed", PausedChangedPayload { paused });
                    }
                });
            }
        })
        .map_err(|e| format!("failed to register Ctrl+Alt+Pause: {e}"))?;

    app.global_shortcut()
        .on_shortcut(p_shortcut, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let controller_clone = Arc::clone(&controller_p);
                let app_clone = app_p.clone();
                tauri::async_runtime::spawn(async move {
                    let mut guard = controller_clone.lock().await;
                    if let Some(ctrl) = guard.as_mut() {
                        let paused = ctrl.toggle_paused();
                        log::info!("input paused: {paused} (Ctrl+Alt+P)");
                        let _ =
                            app_clone.emit("input-paused-changed", PausedChangedPayload { paused });
                    }
                });
            }
        })
        .map_err(|e| format!("failed to register Ctrl+Alt+P: {e}"))?;

    Ok(())
}
