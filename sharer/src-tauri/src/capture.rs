use std::sync::mpsc;

use xcap::Monitor;

#[derive(Debug, Clone, serde::Serialize)]
pub struct DisplayInfo {
    pub id: u32,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Returns all capturable monitors via xcap.
///
/// Falls back to a single 1920x1080 entry only when xcap cannot enumerate any
/// monitor at all — keeps the UI populated so the user sees an obvious wrong
/// resolution instead of an empty list.
pub fn list_displays() -> Vec<DisplayInfo> {
    let monitors = match Monitor::all() {
        Ok(ms) if !ms.is_empty() => ms,
        _ => {
            return vec![DisplayInfo {
                id: 0,
                title: "Primary Display".to_string(),
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            }];
        }
    };

    monitors
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
        .collect()
}

/// A single BGRA video frame captured from the screen.
pub struct BgraFrame {
    pub data: Vec<u8>,
    pub pts_us: u64,
}

/// An active screen capture session, sending frames over a channel.
pub struct ScreenCapturer {
    rx: mpsc::Receiver<BgraFrame>,
    /// Held so the background capture thread exits when this capturer is dropped.
    _stop_tx: mpsc::SyncSender<()>,
    frame_width: u32,
    frame_height: u32,
}

impl ScreenCapturer {
    /// Start capturing the monitor identified by `display_id` (index into `list_displays`).
    ///
    /// Spawns a background thread that polls xcap at ~30 fps. The thread
    /// re-acquires its own `Monitor` handle because the Windows xcap monitor
    /// wraps a raw `HMONITOR` pointer that does not implement `Send`.
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
            .name("screen-capture".to_string())
            .spawn(move || {
                let monitor = match pick_monitor(display_id) {
                    Ok(m) => m,
                    Err(_) => return,
                };
                let interval = std::time::Duration::from_millis(33);
                let start = std::time::Instant::now();
                loop {
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }

                    let pts_us = start.elapsed().as_micros() as u64;

                    let image = match monitor.capture_image() {
                        Ok(img) => img,
                        Err(_) => break,
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
    fn list_displays_returns_at_least_one() {
        let displays = list_displays();
        assert!(!displays.is_empty(), "expected at least one display entry");
    }

    #[test]
    fn list_displays_mirrors_xcap_monitor_count() {
        let displays = list_displays();
        let xcap_count = xcap::Monitor::all().map(|m| m.len()).unwrap_or(0);
        if xcap_count == 0 {
            assert_eq!(
                displays.len(),
                1,
                "fallback path must give exactly one entry"
            );
        } else {
            assert_eq!(
                displays.len(),
                xcap_count,
                "list_displays() must mirror xcap"
            );
        }
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
}
