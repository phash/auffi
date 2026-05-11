use std::sync::mpsc;

use x11rb::{
    connection::Connection,
    protocol::{
        randr::ConnectionExt as RandrExt,
        xproto::{ConnectionExt as XprotoExt, ImageFormat},
    },
    rust_connection::RustConnection,
};

#[derive(Debug, Clone, serde::Serialize)]
pub struct DisplayInfo {
    pub id: u32,
    pub title: String,
    pub width: u32,
    pub height: u32,
}

/// Returns all capturable displays via RandR monitor enumeration.
pub fn list_displays() -> Vec<DisplayInfo> {
    list_displays_inner().unwrap_or_else(|_| {
        vec![DisplayInfo {
            id: 0,
            title: "Primary Display".to_string(),
            width: 1920,
            height: 1080,
        }]
    })
}

fn list_displays_inner() -> Result<Vec<DisplayInfo>, Box<dyn std::error::Error>> {
    let (conn, screen_num) = RustConnection::connect(None)?;
    let screen = &conn.setup().roots[screen_num];
    let root = screen.root;

    let monitors = conn
        .randr_get_monitors(root, true)?
        .reply()?;

    let mut displays = Vec::new();
    for (idx, m) in monitors.monitors.iter().enumerate() {
        let name = conn
            .get_atom_name(m.name)?
            .reply()
            .map(|r| String::from_utf8_lossy(&r.name).to_string())
            .unwrap_or_else(|_| format!("Display {idx}"));

        displays.push(DisplayInfo {
            id: idx as u32,
            title: name,
            width: m.width as u32,
            height: m.height as u32,
        });
    }

    if displays.is_empty() {
        let screen = &conn.setup().roots[screen_num];
        displays.push(DisplayInfo {
            id: 0,
            title: "Primary Display".to_string(),
            width: screen.width_in_pixels as u32,
            height: screen.height_in_pixels as u32,
        });
    }

    Ok(displays)
}

/// A single BGRA video frame captured from the screen.
pub struct BgraFrame {
    pub width: i32,
    pub height: i32,
    /// Raw pixel bytes in BGRA format.
    pub data: Vec<u8>,
    /// Monotonic presentation timestamp in microseconds.
    pub pts_us: u64,
}

/// An active screen capture session, sending frames over a channel.
pub struct ScreenCapturer {
    rx: mpsc::Receiver<BgraFrame>,
    stop_tx: mpsc::SyncSender<()>,
    frame_width: u32,
    frame_height: u32,
}

impl ScreenCapturer {
    /// Start capturing the display identified by `display_id`.
    ///
    /// Spawns a background thread that polls X11 for frames at ~30 fps.
    pub fn start(display_id: u32) -> Result<Self, String> {
        let (conn, screen_num) =
            RustConnection::connect(None).map_err(|e| e.to_string())?;

        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;
        let root_width = screen.width_in_pixels;
        let root_height = screen.height_in_pixels;

        let (frame_x, frame_y, frame_width, frame_height) = {
            let monitors = conn
                .randr_get_monitors(root, true)
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?;

            monitors
                .monitors
                .get(display_id as usize)
                .map(|m| (m.x as i16, m.y as i16, m.width, m.height))
                .unwrap_or((0, 0, root_width, root_height))
        };

        let (tx, rx) = mpsc::sync_channel::<BgraFrame>(2);
        let (stop_tx, stop_rx) = mpsc::sync_channel::<()>(1);

        let frame_w = frame_width;
        let frame_h = frame_height;

        std::thread::Builder::new()
            .name("screen-capture".to_string())
            .spawn(move || {
                let interval = std::time::Duration::from_millis(33); // ~30 fps
                let start = std::time::Instant::now();
                loop {
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }

                    let pts_us = start.elapsed().as_micros() as u64;

                    let image = match conn
                        .get_image(
                            ImageFormat::Z_PIXMAP,
                            root,
                            frame_x,
                            frame_y,
                            frame_w,
                            frame_h,
                            !0u32,
                        )
                        .map_err(|e| e.to_string())
                        .and_then(|cookie| cookie.reply().map_err(|e| e.to_string()))
                    {
                        Ok(img) => img,
                        Err(_e) => break,
                    };

                    let bgra = convert_to_bgra(image.data, image.depth);
                    let frame = BgraFrame {
                        width: frame_w as i32,
                        height: frame_h as i32,
                        data: bgra,
                        pts_us,
                    };

                    if tx.try_send(frame).is_err() {
                        // Receiver is full or dropped; drop this frame.
                    }

                    std::thread::sleep(interval);
                }
            })
            .map_err(|e| e.to_string())?;

        Ok(Self {
            rx,
            stop_tx,
            frame_width: frame_w as u32,
            frame_height: frame_h as u32,
        })
    }

    /// Block until the next BGRA video frame is available.
    pub fn next_frame(&mut self) -> Result<BgraFrame, String> {
        self.rx.recv().map_err(|e| e.to_string())
    }

    /// Stop the capture session.
    pub fn stop(&mut self) {
        let _ = self.stop_tx.try_send(());
    }

    pub fn width(&self) -> u32 {
        self.frame_width
    }

    pub fn height(&self) -> u32 {
        self.frame_height
    }
}

/// Convert raw X11 image bytes to packed BGRA.
///
/// X11 ZPixmap at 24-bit depth returns BGRX (4 bytes per pixel, alpha unused);
/// at 32-bit depth it returns BGRA already.
fn convert_to_bgra(data: Vec<u8>, depth: u8) -> Vec<u8> {
    match depth {
        24 => {
            // BGRX → BGRA: set alpha=255
            let mut out = data;
            for pixel in out.chunks_exact_mut(4) {
                pixel[3] = 0xff;
            }
            out
        }
        32 => data,
        _ => {
            // Unknown depth: best-effort, pass through unchanged
            data
        }
    }
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
    fn display_info_serializes_to_json() {
        let info = DisplayInfo {
            id: 1,
            title: "Test Display".to_string(),
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
            width: 2560,
            height: 1440,
        };
        let val: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&info).unwrap()).unwrap();
        assert_eq!(val["id"], 0);
        assert_eq!(val["title"], "Primary Display");
        assert_eq!(val["width"], 2560);
        assert_eq!(val["height"], 1440);
    }

    #[test]
    fn convert_to_bgra_sets_alpha_for_24bit() {
        let data = vec![0x10, 0x20, 0x30, 0x00, 0x40, 0x50, 0x60, 0x00];
        let result = convert_to_bgra(data, 24);
        assert_eq!(result[3], 0xff);
        assert_eq!(result[7], 0xff);
    }

    #[test]
    fn convert_to_bgra_passthrough_for_32bit() {
        let data = vec![0x10, 0x20, 0x30, 0xff];
        let result = convert_to_bgra(data.clone(), 32);
        assert_eq!(result, data);
    }
}
