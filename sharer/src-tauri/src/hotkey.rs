use std::sync::Arc;

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio::sync::Mutex;

use crate::input::InputController;

/// Payload emitted to the webview when the input pause state changes.
#[derive(Clone, serde::Serialize)]
struct PausedChangedPayload {
    paused: bool,
}

/// The input-pause chords with their log labels. `Ctrl+Alt+P` is the
/// fallback for keyboards without a Pause key. One list for register and
/// unregister, so a chord can never be grabbed without being released.
fn pause_shortcuts() -> [(Shortcut, &'static str); 2] {
    let ctrl_alt = Modifiers::CONTROL | Modifiers::ALT;
    [
        (Shortcut::new(Some(ctrl_alt), Code::Pause), "Ctrl+Alt+Pause"),
        (Shortcut::new(Some(ctrl_alt), Code::KeyP), "Ctrl+Alt+P"),
    ]
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
    // Best-effort unregister of any previous handler — ignore errors because
    // on the first invocation the shortcuts are not yet registered and the
    // plugin returns NotRegistered, which is not actionable here.
    unregister_pause_hotkey(app);

    // Both shortcuts run the identical "lock controller, toggle, emit"
    // sequence — the only difference was a log-message suffix. Build the
    // handler once and register it twice.
    fn register_one<R: Runtime>(
        app: &AppHandle<R>,
        shortcut: Shortcut,
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

    for (shortcut, label) in pause_shortcuts() {
        register_one(app, shortcut, Arc::clone(&controller), label)?;
    }
    Ok(())
}

/// Gives the chords back to the desktop when the session ends. The hotkey
/// only means something while an `InputController` exists; left registered
/// it kept swallowing Ctrl+Alt+P / Ctrl+Alt+Pause system-wide for the rest
/// of the process, doing nothing. Errors are ignored: not-registered is the
/// normal case when streaming was stopped before a controller existed.
pub fn unregister_pause_hotkey<R: Runtime>(app: &AppHandle<R>) {
    for (shortcut, _) in pause_shortcuts() {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Register and unregister used to spell the chords out separately; a
    // chord added to one list but not the other stayed grabbed system-wide
    // after the session (or was never released on re-register).
    #[test]
    fn the_pause_chords_are_ctrl_alt_pause_and_ctrl_alt_p() {
        let ctrl_alt = Modifiers::CONTROL | Modifiers::ALT;
        assert_eq!(
            pause_shortcuts(),
            [
                (Shortcut::new(Some(ctrl_alt), Code::Pause), "Ctrl+Alt+Pause"),
                (Shortcut::new(Some(ctrl_alt), Code::KeyP), "Ctrl+Alt+P"),
            ]
        );
    }
}
