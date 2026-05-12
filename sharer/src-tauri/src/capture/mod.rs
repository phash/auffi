//! Screen-capture abstraction with automatic backend selection.
//!
//! # Backend selection
//!
//! On Linux, the module inspects `XDG_SESSION_TYPE`:
//!
//! - `wayland` → portal backend (xdg-desktop-portal + PipeWire).
//!   The compositor shows a "Choose what to share" dialog; the user's choice
//!   becomes the active stream.  `list_displays` returns a single placeholder
//!   entry because monitors are not enumerable until the user opens the portal
//!   dialog.
//!
//! - `x11` / anything else → x11rb backend (XRandR enumeration + GetImage).
//!   `list_displays` returns the full RandR monitor list.
//!
//! On Windows the xcap backend (Windows Graphics Capture under the hood) is
//! always selected. `list_displays` returns all monitors enumerated by xcap.
//!
//! # Public interface (unchanged from the original single-file implementation)
//!
//! ```text
//! pub fn list_displays() -> Vec<DisplayInfo>;
//! pub struct DisplayInfo { id, title, x, y, width, height }
//! pub struct BgraFrame  { data: Vec<u8>, pts_us: u64 }
//! pub struct ScreenCapturer { … }
//! impl ScreenCapturer {
//!     pub fn start(display_id: u32) -> Result<Self, String>;
//!     pub fn next_frame(&mut self) -> Result<BgraFrame, String>;
//!     pub fn width(&self) -> u32;
//!     pub fn height(&self) -> u32;
//! }
//! ```

#[cfg(target_os = "linux")]
mod gst_portal;

/// Re-export of the portal restore-token reset helper. Lib.rs's
/// `switch_monitor` command calls this on Wayland to force the portal
/// dialog to re-prompt for a source.
#[cfg(target_os = "linux")]
pub use gst_portal::delete_restore_token;

/// No-op on non-Linux targets so call sites stay portable.
#[cfg(not(target_os = "linux"))]
pub fn delete_restore_token() {}
#[cfg(target_os = "linux")]
mod portal;
#[cfg(target_os = "linux")]
mod x11;
#[cfg(target_os = "windows")]
mod windows;

use std::sync::mpsc;

#[derive(Debug, Clone, serde::Serialize)]
pub struct DisplayInfo {
    pub id: u32,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// A single BGRA video frame captured from the screen.
pub struct BgraFrame {
    /// Raw pixel bytes in BGRA format.
    pub data: Vec<u8>,
    /// Monotonic presentation timestamp in microseconds.
    pub pts_us: u64,
}

// ── Backend selection helper ────────────────────────────────────────────────

/// The backend variant selected for this process invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    #[cfg(target_os = "linux")]
    Portal,
    #[cfg(target_os = "linux")]
    X11,
    #[cfg(target_os = "windows")]
    Windows,
}

/// Decide which backend to use based on the session environment.
///
/// Extracted into a standalone function so it can be unit-tested without
/// touching any OS resources.
pub fn select_backend() -> Backend {
    #[cfg(target_os = "linux")]
    {
        match std::env::var("XDG_SESSION_TYPE")
            .unwrap_or_default()
            .to_lowercase()
            .as_str()
        {
            "wayland" => Backend::Portal,
            _ => Backend::X11,
        }
    }
    #[cfg(target_os = "windows")]
    {
        Backend::Windows
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Return all capturable displays.
///
/// On Wayland the portal model does not permit enumerating monitors before the
/// user opens the share dialog, so a single placeholder entry is returned.
/// The actual monitor is chosen inside the compositor dialog when
/// `ScreenCapturer::start` is called.
///
/// On X11 the full RandR monitor list is returned.
/// On Windows the full xcap monitor list is returned.
pub fn list_displays() -> Vec<DisplayInfo> {
    match select_backend() {
        #[cfg(target_os = "linux")]
        Backend::Portal => vec![DisplayInfo {
            id: 0,
            title: "Wähle Bildschirm…".to_string(),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        }],
        #[cfg(target_os = "linux")]
        Backend::X11 => x11::list_displays_inner().unwrap_or_else(|_| {
            vec![DisplayInfo {
                id: 0,
                title: "Primary Display".to_string(),
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            }]
        }),
        #[cfg(target_os = "windows")]
        Backend::Windows => windows::list_displays_inner().unwrap_or_else(|_| {
            vec![DisplayInfo {
                id: 0,
                title: "Primary Display".to_string(),
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            }]
        }),
    }
}

// ── ScreenCapturer ──────────────────────────────────────────────────────────

/// Opaque stop handle whose Drop impl ends the capture session.
///
/// For the X11 and Windows backends this wraps an `mpsc::SyncSender<()>`; for
/// the portal backend it is a `pw::channel::Sender<()>`. We box-erase the type
/// so `ScreenCapturer` doesn't need to be generic.
///
/// The inner value is intentionally never read — it exists solely so that the
/// boxed sender is dropped together with `ScreenCapturer`, closing the channel
/// and causing the capture thread to exit.
struct StopHandle(#[allow(dead_code)] Box<dyn Send>);

/// An active screen capture session.
///
/// Wraps the active platform backend transparently. Drop to stop.
pub struct ScreenCapturer {
    /// Unified frame receive endpoint.
    rx: mpsc::Receiver<BgraFrame>,
    /// Kept alive to ensure the underlying backend (and its stop signal) lives
    /// as long as this ScreenCapturer.
    _stop: StopHandle,
    frame_width: u32,
    frame_height: u32,
}

impl ScreenCapturer {
    /// Start capturing.
    ///
    /// On Wayland the `display_id` parameter is ignored — the user picks the
    /// monitor in the compositor dialog opened by the portal.
    ///
    /// On X11 `display_id` selects the RandR monitor index.
    /// On Windows `display_id` selects the xcap monitor index.
    pub fn start(display_id: u32) -> Result<Self, String> {
        match select_backend() {
            #[cfg(target_os = "linux")]
            Backend::Portal => Self::start_portal(),
            #[cfg(target_os = "linux")]
            Backend::X11 => Self::start_x11(display_id),
            #[cfg(target_os = "windows")]
            Backend::Windows => Self::start_windows(display_id),
        }
    }

    #[cfg(target_os = "linux")]
    fn start_portal() -> Result<Self, String> {
        // Try the GStreamer-based capture first. `pipewiresrc` handles the
        // DMA-BUF / SHM / VideoModifier negotiation that direct pipewire-rs
        // makes us hand-craft (and that broke on KDE Plasma 6's DMA-BUF-only
        // output). Fall back to the legacy SHM-only PipeWire path if the
        // GStreamer crate or runtime is missing.
        let (frame_width, frame_height, bridge_rx, stop_box): (u32, u32, _, Box<dyn Send>) =
            match gst_portal::GstPortalCapturer::start() {
                Ok(mut cap) => {
                    let w = cap.frame_width;
                    let h = cap.frame_height;
                    let src_rx = cap
                        .take_rx()
                        .ok_or_else(|| "gst capturer rx already taken".to_string())?;
                    let (bridge_tx, bridge_rx) = mpsc::sync_channel::<BgraFrame>(4);
                    std::thread::Builder::new()
                        .name("capture-relay-gst".to_string())
                        .spawn(move || {
                            for frame in src_rx {
                                if bridge_tx.send(frame).is_err() {
                                    break;
                                }
                            }
                        })
                        .map_err(|e| e.to_string())?;
                    // Keep the GstPortalCapturer alive — its Drop tears down
                    // the pipeline. Box it as the StopHandle inner.
                    (w, h, bridge_rx, Box::new(cap))
                }
                Err(e) => {
                    crate::dbg_log(&format!(
                        "[capture] gst-portal backend failed ({e}); falling back to pipewire-rs SHM path"
                    ));
                    let cap = portal::PortalCapturer::start()?;
                    let w = cap.frame_width;
                    let h = cap.frame_height;
                    let (bridge_tx, bridge_rx) = mpsc::sync_channel::<BgraFrame>(4);
                    let src_rx = cap.rx;
                    let stop_tx = cap._stop_tx;
                    std::thread::Builder::new()
                        .name("capture-relay-pw".to_string())
                        .spawn(move || {
                            for frame in src_rx {
                                if bridge_tx.send(frame).is_err() {
                                    break;
                                }
                            }
                        })
                        .map_err(|e| e.to_string())?;
                    (w, h, bridge_rx, Box::new(stop_tx))
                }
            };

        Ok(Self {
            rx: bridge_rx,
            _stop: StopHandle(stop_box),
            frame_width,
            frame_height,
        })
    }

    #[cfg(target_os = "linux")]
    fn start_x11(display_id: u32) -> Result<Self, String> {
        let cap = x11::X11Capturer::start(display_id)?;
        let frame_width = cap.frame_width;
        let frame_height = cap.frame_height;

        let (bridge_tx, bridge_rx) = mpsc::sync_channel::<BgraFrame>(4);
        let src_rx = cap.rx;
        let stop_tx = cap._stop_tx;

        std::thread::Builder::new()
            .name("capture-relay-x11".to_string())
            .spawn(move || {
                for frame in src_rx {
                    if bridge_tx.send(frame).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        Ok(Self {
            rx: bridge_rx,
            _stop: StopHandle(Box::new(stop_tx)),
            frame_width,
            frame_height,
        })
    }

    #[cfg(target_os = "windows")]
    fn start_windows(display_id: u32) -> Result<Self, String> {
        let cap = windows::WindowsCapturer::start(display_id)?;
        let frame_width = cap.frame_width;
        let frame_height = cap.frame_height;

        let (bridge_tx, bridge_rx) = mpsc::sync_channel::<BgraFrame>(4);
        let src_rx = cap.rx;
        let stop_tx = cap._stop_tx;

        std::thread::Builder::new()
            .name("capture-relay-win".to_string())
            .spawn(move || {
                for frame in src_rx {
                    if bridge_tx.send(frame).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        Ok(Self {
            rx: bridge_rx,
            _stop: StopHandle(Box::new(stop_tx)),
            frame_width,
            frame_height,
        })
    }

    /// Block until the next BGRA video frame is available.
    pub fn next_frame(&mut self) -> Result<BgraFrame, String> {
        self.rx.recv().map_err(|e| e.to_string())
    }

    pub fn width(&self) -> u32 {
        self.frame_width
    }

    pub fn height(&self) -> u32 {
        self.frame_height
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // XDG_SESSION_TYPE is process-global and read at the same instant by
    // every backend-selection test. `cargo test` runs tests in parallel by
    // default — without a serializing lock the three tests below race and
    // the test that reads after another wrote a different value flakes.
    // This affected cargo-tarpaulin in particular (cargo test happened to
    // not race in our local runs, but tarpaulin's instrumentation changes
    // the timing). Use a single Mutex shared by all env-mutating tests.
    #[cfg(target_os = "linux")]
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(target_os = "linux")]
    #[test]
    fn capture_backend_selection_prefers_portal_on_wayland() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var("XDG_SESSION_TYPE", "wayland");
        assert_eq!(select_backend(), Backend::Portal);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn capture_backend_selection_falls_back_to_x11_on_xorg() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var("XDG_SESSION_TYPE", "x11");
        assert_eq!(select_backend(), Backend::X11);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn backend_unknown_session_maps_to_x11() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var("XDG_SESSION_TYPE", "mir");
        assert_eq!(select_backend(), Backend::X11);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn backend_on_windows_is_windows() {
        assert_eq!(select_backend(), Backend::Windows);
    }

    #[test]
    fn list_displays_returns_at_least_one() {
        let displays = list_displays();
        assert!(!displays.is_empty(), "expected at least one display entry");
    }

    #[test]
    fn display_info_serializes_to_json() {
        let info = DisplayInfo {
            id: 1,
            title: "Test Display".to_string(),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let json = serde_json::to_string(&info).expect("serialize DisplayInfo");
        assert!(json.contains("\"id\":1"), "id field missing: {json}");
        assert!(
            json.contains("\"title\":\"Test Display\""),
            "title field missing: {json}"
        );
    }

    #[test]
    fn display_info_json_contains_expected_keys() {
        let info = DisplayInfo {
            id: 0,
            title: "Primary Display".to_string(),
            x: 1920,
            y: 0,
            width: 2560,
            height: 1440,
        };
        let val: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&info).unwrap()).unwrap();
        assert_eq!(val["id"], 0);
        assert_eq!(val["title"], "Primary Display");
        assert_eq!(val["x"], 1920);
        assert_eq!(val["y"], 0);
        assert_eq!(val["width"], 2560);
        assert_eq!(val["height"], 1440);
    }
}
