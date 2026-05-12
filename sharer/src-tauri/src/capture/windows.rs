use std::sync::mpsc;

use xcap::Monitor;

use super::{BgraFrame, DisplayInfo};

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
    /// Re-acquires the `xcap::Monitor` inside the worker thread because the
    /// Windows backing wraps a raw `HMONITOR` pointer that does not implement
    /// `Send`. Index-based lookup avoids moving the handle across threads.
    pub fn start(display_id: u32) -> Result<Self, String> {
        let (width, height) = {
            let monitor = pick_monitor(display_id)?;
            let w = monitor.width().map_err(|e| e.to_string())?;
            let h = monitor.height().map_err(|e| e.to_string())?;
            (w, h)
        };

        let (tx, rx) = mpsc::sync_channel::<BgraFrame>(2);
        let (stop_tx, stop_rx) = mpsc::sync_channel::<()>(1);

        std::thread::Builder::new()
            .name("screen-capture-win".to_string())
            .spawn(move || {
                let monitor = match pick_monitor(display_id) {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!(
                            "[screen-capture] could not re-acquire monitor {display_id} in capture thread: {e}"
                        );
                        return;
                    }
                };
                let interval = std::time::Duration::from_millis(33); // ~30 fps
                let start = std::time::Instant::now();
                loop {
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }

                    let pts_us = start.elapsed().as_micros() as u64;

                    let image = match monitor.capture_image() {
                        Ok(img) => img,
                        Err(e) => {
                            eprintln!(
                                "[screen-capture] xcap capture_image failed for monitor {display_id}: {e} — \
                                 ensure Windows Graphics Capture is available (Win10 1903+) and that no exclusive-fullscreen app is blocking it."
                            );
                            break;
                        }
                    };

                    let bgra = rgba_to_bgra(image.into_raw());
                    if tx.try_send(BgraFrame { data: bgra, pts_us }).is_err() {
                        // Receiver full or dropped; drop frame.
                    }

                    std::thread::sleep(interval);
                }
            })
            .map_err(|e| e.to_string())?;

        Ok(Self {
            rx,
            _stop_tx: stop_tx,
            frame_width: width,
            frame_height: height,
        })
    }
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
        let displays = list_displays_inner().expect("xcap monitor enumeration must succeed on this host");
        assert!(!displays.is_empty(), "expected at least one monitor");
    }
}
