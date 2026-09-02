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
//! # Public interface
//!
//! ```text
//! pub fn list_displays() -> Vec<DisplayInfo>;
//! pub struct DisplayInfo { id, title, x, y, width, height }
//! pub struct BgraFrame  { data: Vec<u8>, pts_us: u64 }
//! pub struct ScreenCapturer { … }
//! impl ScreenCapturer {
//!     pub async fn start(display_id: u32) -> Result<Self, String>;
//!     pub fn next_frame(&mut self) -> Result<NextFrame, String>;
//!     pub fn width(&self) -> u32;
//!     pub fn height(&self) -> u32;
//! }
//! ```
//!
//! `start` is `async` on purpose — the portal handshake must run on the
//! caller's long-lived tokio runtime (pinned by
//! `lib.rs::tests::screen_capturer_start_remains_async`).

#[cfg(target_os = "linux")]
mod gst_portal;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "linux")]
mod x11;

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

/// Result of one successful `ScreenCapturer::next_frame` poll.
pub enum NextFrame {
    Frame(BgraFrame),
    /// No frame arrived within the poll window. The source may be stalled
    /// with its channel still open (Wayland: compositor revoked the
    /// screencast, appsink stops firing; Windows: WGC stops delivering while
    /// the worker loops on its own timeout) — the caller MUST re-check its
    /// shutdown signal and poll again instead of blocking forever.
    Timeout,
}

/// How long `next_frame` blocks before reporting [`NextFrame::Timeout`].
/// Bounded so the streaming loop always gets back to its switch-channel
/// shutdown check even when the capture source stalls silently.
const NEXT_FRAME_POLL: std::time::Duration = std::time::Duration::from_millis(500);

// ── Stop-signal helper ──────────────────────────────────────────────────────

/// Returns `true` when the capture worker thread should exit, either because
/// the owner sent an explicit stop OR because the sender was dropped — the
/// latter is the canonical Drop signal from `ScreenCapturer::_stop` /
/// `StopHandle`.
///
/// Pre-fix this check was inlined as `stop_rx.try_recv().is_ok()` in each
/// backend. `try_recv()` returns `Ok(_)` only on an actual message;
/// `Err(Disconnected)` (all senders dropped) was missed, so the loop never
/// broke when `disconnect_streaming` tore the capturer down. On Windows the
/// runaway loop kept creating and destroying WGC `GraphicsCaptureSession`s
/// at 30 fps, which DWM rendered as a persistent system-cursor flicker
/// until the sharer process exited.
pub(super) fn stop_signaled(stop_rx: &mpsc::Receiver<()>) -> bool {
    matches!(
        stop_rx.try_recv(),
        Ok(_) | Err(mpsc::TryRecvError::Disconnected)
    )
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
/// For the X11 and Windows backends this wraps the worker's
/// `mpsc::SyncSender<()>`; for the portal backend it boxes the whole
/// `GstPortalCapturer`, whose Drop sets the GStreamer pipeline to Null and
/// then closes the PipeWire fd and portal session. We box-erase the type so
/// `ScreenCapturer` doesn't need to be generic.
///
/// The inner value is intentionally never read — it exists solely so that
/// whatever it holds is dropped together with `ScreenCapturer`, which is the
/// backend's teardown signal.
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
    /// Async so the portal handshake can run on the caller's long-lived
    /// tokio runtime. See `gst_portal::GstPortalCapturer::start` for why.
    /// The X11 / Windows arms remain synchronous internally but get
    /// wrapped in `spawn_blocking` here so the async signature is uniform.
    pub async fn start(display_id: u32) -> Result<Self, String> {
        match select_backend() {
            #[cfg(target_os = "linux")]
            Backend::Portal => Self::start_portal().await,
            #[cfg(target_os = "linux")]
            Backend::X11 => tokio::task::spawn_blocking(move || Self::start_x11(display_id))
                .await
                .map_err(|e| format!("x11 capture spawn join failed: {e}"))?,
            #[cfg(target_os = "windows")]
            Backend::Windows => {
                tokio::task::spawn_blocking(move || Self::start_windows(display_id))
                    .await
                    .map_err(|e| format!("windows capture spawn join failed: {e}"))?
            }
        }
    }

    #[cfg(target_os = "linux")]
    async fn start_portal() -> Result<Self, String> {
        // GStreamer pipewiresrc handles all the DMA-BUF / SHM / modifier
        // negotiation a direct pipewire-rs SHM path can't ergonomically
        // express (and that broke on Plasma 6's DMA-BUF-only output). The
        // legacy direct-pipewire fallback was kept "in case" for a while
        // but stalls in the same place gst-portal handles cleanly, so it
        // is gone — if gst-portal fails today we want a fast, loud error,
        // not silent fallback to a known-broken code path.
        let mut cap = gst_portal::GstPortalCapturer::start().await?;
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

        Ok(Self {
            rx: bridge_rx,
            _stop: StopHandle(Box::new(cap)),
            frame_width: w,
            frame_height: h,
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

    /// Wait up to [`NEXT_FRAME_POLL`] for the next BGRA video frame.
    ///
    /// Returns `Ok(NextFrame::Timeout)` when no frame arrived in the window
    /// and `Err` only when the capture worker is gone (channel closed). An
    /// unbounded `recv()` here previously let a stalled-but-open source park
    /// the streaming loop forever, past `disconnect_streaming`.
    pub fn next_frame(&mut self) -> Result<NextFrame, String> {
        match self.rx.recv_timeout(NEXT_FRAME_POLL) {
            Ok(f) => Ok(NextFrame::Frame(f)),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(NextFrame::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("capture channel closed".to_string()),
        }
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

    #[test]
    fn stop_signaled_false_when_sender_alive_and_no_message() {
        let (_tx, rx) = mpsc::sync_channel::<()>(1);
        assert!(
            !stop_signaled(&rx),
            "alive sender with empty channel must not look like a stop"
        );
    }

    #[test]
    fn stop_signaled_true_after_explicit_send() {
        let (tx, rx) = mpsc::sync_channel::<()>(1);
        tx.send(()).expect("send into empty bounded channel");
        assert!(stop_signaled(&rx));
    }

    #[test]
    fn stop_signaled_true_when_sender_dropped() {
        // This is the canonical Drop path: the capturer goes out of scope,
        // its `_stop_tx` is dropped, the worker must observe Disconnected
        // and exit. The pre-fix `try_recv().is_ok()` check missed this
        // path entirely and left the WGC capture loop running forever.
        let (tx, rx) = mpsc::sync_channel::<()>(1);
        drop(tx);
        assert!(
            stop_signaled(&rx),
            "dropped sender must be observed as stop — otherwise capture leaks past disconnect_streaming"
        );
    }

    // ── next_frame poll behaviour (2026-08 review) ──────────────────────
    // A stalled-but-open capture source (Wayland screencast revoked, WGC
    // silent stop) must NOT park next_frame forever — the streaming loop
    // needs to get back to its switch-channel shutdown check.

    fn capturer_with_channel() -> (mpsc::SyncSender<BgraFrame>, ScreenCapturer) {
        let (tx, rx) = mpsc::sync_channel::<BgraFrame>(2);
        let cap = ScreenCapturer {
            rx,
            _stop: StopHandle(Box::new(())),
            frame_width: 4,
            frame_height: 4,
        };
        (tx, cap)
    }

    #[test]
    fn next_frame_returns_frame_when_available() {
        let (tx, mut cap) = capturer_with_channel();
        tx.send(BgraFrame {
            data: vec![0u8; 4],
            pts_us: 42,
        })
        .expect("send");
        match cap.next_frame() {
            Ok(NextFrame::Frame(f)) => assert_eq!(f.pts_us, 42),
            Ok(NextFrame::Timeout) => panic!("expected frame, got timeout"),
            Err(e) => panic!("expected frame, got Err: {e}"),
        }
    }

    #[test]
    fn next_frame_times_out_when_source_stalls_with_channel_open() {
        let (_tx, mut cap) = capturer_with_channel();
        let start = std::time::Instant::now();
        match cap.next_frame() {
            Ok(NextFrame::Timeout) => {}
            Ok(NextFrame::Frame(_)) => panic!("no frame was sent"),
            Err(e) => panic!("open-but-stalled channel must be Timeout, got Err: {e}"),
        }
        assert!(
            start.elapsed() >= NEXT_FRAME_POLL,
            "timeout must wait the full poll window"
        );
        assert!(
            start.elapsed() < NEXT_FRAME_POLL * 4,
            "timeout must be bounded, not a blocking recv"
        );
    }

    #[test]
    fn next_frame_errors_when_capture_worker_gone() {
        let (tx, mut cap) = capturer_with_channel();
        drop(tx);
        assert!(
            cap.next_frame().is_err(),
            "closed channel means the worker died — must surface as Err"
        );
    }
}
