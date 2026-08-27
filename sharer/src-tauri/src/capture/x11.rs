use std::sync::mpsc;

use x11rb::{
    connection::Connection,
    protocol::{
        randr::ConnectionExt as RandrExt,
        xproto::{ConnectionExt as XprotoExt, ImageFormat},
    },
    rust_connection::RustConnection,
};

use super::{BgraFrame, DisplayInfo};

/// Enumerate displays via RandR.
pub(super) fn list_displays_inner() -> Result<Vec<DisplayInfo>, Box<dyn std::error::Error>> {
    let (conn, screen_num) = RustConnection::connect(None)?;
    let screen = &conn.setup().roots[screen_num];
    let root = screen.root;

    let monitors = conn.randr_get_monitors(root, true)?.reply()?;

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
            x: m.x as i32,
            y: m.y as i32,
            width: m.width as u32,
            height: m.height as u32,
        });
    }

    if displays.is_empty() {
        let screen = &conn.setup().roots[screen_num];
        displays.push(DisplayInfo {
            id: 0,
            title: "Primary Display".to_string(),
            x: 0,
            y: 0,
            width: screen.width_in_pixels as u32,
            height: screen.height_in_pixels as u32,
        });
    }

    Ok(displays)
}

pub struct X11Capturer {
    pub rx: mpsc::Receiver<BgraFrame>,
    /// Held so the background capture thread exits when this capturer is dropped.
    pub _stop_tx: mpsc::SyncSender<()>,
    pub frame_width: u32,
    pub frame_height: u32,
}

impl X11Capturer {
    pub fn start(display_id: u32) -> Result<Self, String> {
        let (conn, screen_num) = RustConnection::connect(None).map_err(|e| e.to_string())?;

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
                .map(|m| (m.x, m.y, m.width, m.height))
                .unwrap_or((0, 0, root_width, root_height))
        };

        let (tx, rx) = mpsc::sync_channel::<BgraFrame>(2);
        let (stop_tx, stop_rx) = mpsc::sync_channel::<()>(1);

        let frame_w = frame_width;
        let frame_h = frame_height;

        std::thread::Builder::new()
            .name("screen-capture-x11".to_string())
            .spawn(move || {
                let interval = std::time::Duration::from_millis(33); // ~30 fps
                let start = std::time::Instant::now();
                loop {
                    if super::stop_signaled(&stop_rx) {
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
                        Err(e) => {
                            // dbg_log, not eprintln!: tauri-cli pipe buffering
                            // eats stderr and release builds have no console —
                            // this is the only diagnostic for a mid-session
                            // capture death (display change, XWayland).
                            crate::dbg_log(&format!(
                                "[screen-capture] X11 get_image failed at ({frame_x},{frame_y}) {frame_w}x{frame_h}: {e} — \
                                 this is expected on Wayland sessions (XWayland does not expose desktop content). \
                                 Log out and log back into an Xorg / X11 session, or wait for the Wayland-portal capture backend."
                            ));
                            break;
                        }
                    };

                    let bgra = convert_to_bgra(image.data, image.depth);
                    let frame = BgraFrame { data: bgra, pts_us };

                    match tx.try_send(frame) {
                        Ok(()) => {}
                        Err(mpsc::TrySendError::Full(_)) => {
                            // Encoder behind — drop this frame, keep capturing.
                        }
                        Err(mpsc::TrySendError::Disconnected(_)) => {
                            // Consumer gone — nothing left to feed.
                            break;
                        }
                    }

                    std::thread::sleep(interval);
                }
            })
            .map_err(|e| e.to_string())?;

        Ok(Self {
            rx,
            _stop_tx: stop_tx,
            frame_width: frame_w as u32,
            frame_height: frame_h as u32,
        })
    }
}

/// Convert raw X11 image bytes to packed BGRA.
///
/// X11 ZPixmap at 24-bit depth returns BGRX (4 bytes per pixel, alpha unused);
/// at 32-bit depth it returns BGRA already.
pub(super) fn convert_to_bgra(data: Vec<u8>, depth: u8) -> Vec<u8> {
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
