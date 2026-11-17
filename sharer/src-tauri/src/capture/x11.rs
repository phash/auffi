use std::sync::mpsc;

use x11rb::{
    connection::Connection,
    protocol::{
        randr::ConnectionExt as RandrExt,
        shm::{self, ConnectionExt as ShmExt},
        xproto::{ConnectionExt as XprotoExt, ImageFormat, Window},
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
                let shm_image =
                    match ShmImage::new(&conn, usize::from(frame_w) * usize::from(frame_h) * 4) {
                        Ok(shm_image) => Some(shm_image),
                        Err(e) => {
                            crate::dbg_log(&format!(
                                "[screen-capture] MIT-SHM unavailable ({e}); falling back to GetImage"
                            ));
                            None
                        }
                    };
                let start = std::time::Instant::now();
                let mut pacer = super::FramePacer::new(super::FRAME_INTERVAL, start);
                loop {
                    if super::stop_signaled(&stop_rx) {
                        break;
                    }

                    let pts_us = start.elapsed().as_micros() as u64;

                    let grabbed = match &shm_image {
                        Some(shm_image) => shm_image.grab(root, frame_x, frame_y, frame_w, frame_h),
                        None => conn
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
                            .map(|img| (img.data, img.depth)),
                    };
                    let (data, depth) = match grabbed {
                        Ok(image) => image,
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

                    let bgra = convert_to_bgra(data, depth);
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

                    std::thread::sleep(pacer.wait(std::time::Instant::now()));
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

/// A SysV shared-memory segment the X server writes captured frames into.
///
/// Plain `GetImage` ships every frame through the X socket — about 8 MB per
/// 1080p frame, which took ~17 ms on its own and held the loop below 60 fps
/// (and near 30 at 1440p). With MIT-SHM the server writes straight into
/// memory both sides map.
struct ShmImage<'c> {
    conn: &'c RustConnection,
    seg: shm::Seg,
    addr: *mut libc::c_void,
    len: usize,
}

impl<'c> ShmImage<'c> {
    fn new(conn: &'c RustConnection, len: usize) -> Result<Self, String> {
        conn.shm_query_version()
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| format!("no MIT-SHM extension: {e}"))?;
        // SAFETY: plain SysV calls; every failure path below releases what
        // was acquired before it.
        let id = unsafe { libc::shmget(libc::IPC_PRIVATE, len, libc::IPC_CREAT | 0o600) };
        if id < 0 {
            return Err(format!("shmget: {}", std::io::Error::last_os_error()));
        }
        let addr = unsafe { libc::shmat(id, std::ptr::null(), 0) };
        if addr as isize == -1 {
            let err = std::io::Error::last_os_error();
            unsafe { libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut()) };
            return Err(format!("shmat: {err}"));
        }
        let attached = conn
            .generate_id()
            .map_err(|e| e.to_string())
            .and_then(|seg| {
                conn.shm_attach(seg, id as u32, false)
                    .map_err(|e| e.to_string())?
                    .check()
                    .map_err(|e| format!("server cannot attach the segment: {e}"))?;
                Ok(seg)
            });
        // Marked for removal once both sides are attached: the kernel frees it
        // when the last of them detaches, so a crash cannot leak the segment.
        unsafe { libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut()) };
        match attached {
            Ok(seg) => Ok(Self {
                conn,
                seg,
                addr,
                len,
            }),
            Err(e) => {
                unsafe { libc::shmdt(addr) };
                Err(e)
            }
        }
    }

    /// Capture one frame; returns its bytes and the image depth.
    fn grab(&self, root: Window, x: i16, y: i16, w: u16, h: u16) -> Result<(Vec<u8>, u8), String> {
        let reply = self
            .conn
            .shm_get_image(
                root,
                x,
                y,
                w,
                h,
                !0,
                ImageFormat::Z_PIXMAP.into(),
                self.seg,
                0,
            )
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        let size = (reply.size as usize).min(self.len);
        // SAFETY: `addr` maps `len` bytes for as long as `self` lives, and the
        // reply arrives only after the server finished writing them.
        let data = unsafe { std::slice::from_raw_parts(self.addr.cast::<u8>(), size) }.to_vec();
        Ok((data, reply.depth))
    }
}

impl Drop for ShmImage<'_> {
    fn drop(&mut self) {
        let _ = self.conn.shm_detach(self.seg);
        let _ = self.conn.flush();
        // SAFETY: `addr` came from shmat in `new` and is detached only here.
        unsafe { libc::shmdt(self.addr) };
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
            // as_chunks_mut over chunks_exact_mut: the const chunk size gives
            // fixed-size arrays, so the alpha write needs no bounds check.
            // A trailing partial pixel (len not a multiple of 4) is malformed
            // input and stays untouched, same as before.
            for pixel in out.as_chunks_mut::<4>().0 {
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

    /// Frames the capture thread delivers per second when the consumer keeps
    /// up. Needs an X server (e.g. `Xvfb :99 -screen 0 1920x1080x24` and
    /// DISPLAY=:99); prints the rate rather than asserting a number, which
    /// depends on the machine.
    #[test]
    #[ignore = "requires an X11 display"]
    fn x11_capture_rate() {
        let cap = X11Capturer::start(0).expect("x11 capture must start");
        let started = std::time::Instant::now();
        let mut frames = 0u32;
        while started.elapsed() < std::time::Duration::from_secs(3) {
            if cap
                .rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .is_ok()
            {
                frames += 1;
            }
        }
        let fps = f64::from(frames) / started.elapsed().as_secs_f64();
        println!("x11 capture: {fps:.1} fps");
        assert!(frames > 0, "no frame in 3 s");
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
