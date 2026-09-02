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

    // Both shortcuts run the identical "lock controller, toggle, emit"
    // sequence — the only difference was a log-message suffix. Build the
    // handler once and register it twice.
    fn register_one<R: Runtime>(
        app: &AppHandle<R>,
        shortcut: tauri_plugin_global_shortcut::Shortcut,
        controller: Arc<Mutex<Option<InputController>>>,
        label: &'static str,
    ) -> Result<(), String> {
        let app_handle = app.clone();
        app.global_shortcut()
            .on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let controller = Arc::clone(&controller);
                let app_clone = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mut guard = controller.lock().await;
                    if let Some(ctrl) = guard.as_mut() {
                        let paused = ctrl.toggle_paused();
                        log::info!("input paused: {paused} ({label})");
                        let _ =
                            app_clone.emit("input-paused-changed", PausedChangedPayload { paused });
                    }
                });
            })
            .map_err(|e| format!("failed to register {label}: {e}"))
    }

    register_one(
        app,
        pause_shortcut,
        Arc::clone(&controller),
        "Ctrl+Alt+Pause",
    )?;
    register_one(app, p_shortcut, controller, "Ctrl+Alt+P")?;
    Ok(())
}

/// Gives the chords back to the desktop when the session ends. The hotkey
/// only means something while an `InputController` exists; left registered
/// it kept swallowing Ctrl+Alt+P / Ctrl+Alt+Pause system-wide for the rest
/// of the process, doing nothing. Errors are ignored: not-registered is the
/// normal case when streaming was stopped before a controller existed.
pub fn unregister_pause_hotkey<R: Runtime>(app: &AppHandle<R>) {
    let ctrl_alt = Modifiers::CONTROL | Modifiers::ALT;
    for code in [Code::Pause, Code::KeyP] {
        let shortcut = tauri_plugin_global_shortcut::Shortcut::new(Some(ctrl_alt), code);
        let _ = app.global_shortcut().unregister(shortcut);
    }
}
