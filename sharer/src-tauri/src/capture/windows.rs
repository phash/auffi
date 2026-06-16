use std::sync::mpsc;
use std::time::Duration;

use xcap::Monitor;

use super::{stop_signaled, BgraFrame, DisplayInfo};

/// Enumerate monitors via xcap (Windows Graphics Capture under the hood).
pub(super) fn list_displays_inner() -> Result<Vec<DisplayInfo>, Box<dyn std::error::Error>> {
    let monitors = Monitor::all()?;
    if monitors.is_empty() {
        return Err("no monitors enumerated".into());
    }

    Ok(monitors
        .into_iter()
        .enumerate()
        .map(|(idx, m)| DisplayInfo {
            id: idx as u32,
            title: m.name().unwrap_or_default(),
            x: m.x().unwrap_or(0),
            y: m.y().unwrap_or(0),
            width: m.width().unwrap_or(0),
            height: m.height().unwrap_or(0),
        })
        .collect())
}

pub struct WindowsCapturer {
    pub rx: mpsc::Receiver<BgraFrame>,
    /// Held so the background capture thread exits when this capturer is dropped.
    pub _stop_tx: mpsc::SyncSender<()>,
    pub frame_width: u32,
    pub frame_height: u32,
}

impl WindowsCapturer {
    /// Start capturing the monitor identified by `display_id` (index into
    /// `list_displays`).
    ///
    /// Uses xcap's `Monitor::video_recorder` API which opens **one**
    /// `GraphicsCaptureSession` and reuses it for the entire session. The
    /// per-frame `capture_image()` path xcap also exposes spins up a fresh
    /// `Direct3D11CaptureFramePool` + `GraphicsCaptureSession` 30×/s; DWM
    /// reacts to that churn by toggling the system-cursor compositing path,
    /// visible as a persistent cursor flicker across the entire desktop.
    ///
    /// Re-acquires the `xcap::Monitor` inside the worker thread because the
    /// Windows backing wraps a raw `HMONITOR` pointer that is not `Send`.
    /// Index-based lookup avoids moving the handle across threads.
    pub fn start(display_id: u32) -> Result<Self, String> {
        let (width, height) = {
            let monitor = pick_monitor(display_id)?;
            let w = monitor.width().map_err(|e| e.to_string())?;
            let h = monitor.height().map_err(|e| e.to_string())?;
            (w, h)
        };

        let (tx, rx) = mpsc::sync_channel::<BgraFrame>(2);
        let (stop_tx, stop_rx) = mpsc::sync_channel::<()>(1);
        let (init_tx, init_rx) = mpsc::sync_channel::<Result<(), String>>(1);

        std::thread::Builder::new()
            .name("screen-capture-win".to_string())
            .spawn(move || worker(display_id, tx, stop_rx, init_tx))
            .map_err(|e| e.to_string())?;

        match init_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                rx,
                _stop_tx: stop_tx,
                frame_width: width,
                frame_height: height,
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("screen-capture worker exited before reporting init".to_string()),
        }
    }
}

fn worker(
    display_id: u32,
    tx: mpsc::SyncSender<BgraFrame>,
    stop_rx: mpsc::Receiver<()>,
    init_tx: mpsc::SyncSender<Result<(), String>>,
) {
    let monitor = match pick_monitor(display_id) {
        Ok(m) => m,
        Err(e) => {
            let _ = init_tx.send(Err(format!(
                "screen-capture: re-acquire monitor {display_id}: {e}"
            )));
            return;
        }
    };

    let (recorder, frame_rx) = match monitor.video_recorder() {
        Ok(pair) => pair,
        Err(e) => {
            let _ = init_tx.send(Err(format!(
                "screen-capture: video_recorder init failed (monitor {display_id}): {e} — \
                 ensure Windows Graphics Capture is available (Win10 1903+) and that no \
                 exclusive-fullscreen app is blocking it."
            )));
            return;
        }
    };

    if let Err(e) = recorder.start() {
        let _ = init_tx.send(Err(format!("screen-capture: recorder.start failed: {e}")));
        return;
    }

    let _ = init_tx.send(Ok(()));

    let start_instant = std::time::Instant::now();
    loop {
        if stop_signaled(&stop_rx) {
            break;
        }

        // recv_timeout instead of recv so we observe stop_signaled within
        // 500ms even if the WGC pipeline stalls (e.g. monitor unplugged).
        match frame_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(frame) => {
                let pts_us = start_instant.elapsed().as_micros() as u64;
                let bgra = rgba_to_bgra(frame.raw);
                match tx.try_send(BgraFrame { data: bgra, pts_us }) {
                    Ok(()) => {}
                    Err(mpsc::TrySendError::Full(_)) => {
                        // Encoder behind — drop this frame, keep capturing.
                    }
                    Err(mpsc::TrySendError::Disconnected(_)) => {
                        // Consumer gone — nothing left to feed.
                        break;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // No frame within window — loop and re-check stop signal.
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Recorder pipeline ended (session closed or process tearing
                // down) — nothing to wait for anymore.
                break;
            }
        }
    }

    // WgcRuntime::Drop closes the session + frame pool when the recorder
    // goes out of scope here.
    drop(recorder);
}

/// Convert packed RGBA (xcap output) to packed BGRA (libvpx input).
fn rgba_to_bgra(mut data: Vec<u8>) -> Vec<u8> {
    for px in data.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    data
}

/// Look up a single monitor by its index in `Monitor::all()`.
fn pick_monitor(display_id: u32) -> Result<Monitor, String> {
    Monitor::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .nth(display_id as usize)
        .ok_or_else(|| format!("monitor index {display_id} not found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_to_bgra_swaps_red_blue() {
        let rgba = vec![0x10, 0x20, 0x30, 0xff, 0x40, 0x50, 0x60, 0xee];
        let bgra = rgba_to_bgra(rgba);
        assert_eq!(bgra, vec![0x30, 0x20, 0x10, 0xff, 0x60, 0x50, 0x40, 0xee]);
    }

    #[test]
    fn rgba_to_bgra_preserves_alpha_and_green() {
        let rgba = vec![0xaa, 0xbb, 0xcc, 0x7f];
        let bgra = rgba_to_bgra(rgba);
        assert_eq!(bgra[1], 0xbb, "green channel must be untouched");
        assert_eq!(bgra[3], 0x7f, "alpha channel must be untouched");
    }

    #[test]
    fn rgba_to_bgra_handles_empty() {
        let bgra = rgba_to_bgra(Vec::new());
        assert!(bgra.is_empty());
    }

    #[test]
    fn list_displays_inner_returns_at_least_one() {
        let displays =
            list_displays_inner().expect("xcap monitor enumeration must succeed on this host");
        assert!(!displays.is_empty(), "expected at least one monitor");
    }
}
