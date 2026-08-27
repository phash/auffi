use std::sync::mpsc;
use std::time::{Duration, Instant};

use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
    HBITMAP, HDC, HGDIOBJ, SRCCOPY,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use xcap::Monitor;

use super::{stop_signaled, BgraFrame, DisplayInfo};

/// WGC is given this long to deliver its first frame before we declare it
/// unusable and fall back to GDI. WGC `video_recorder()` can initialise yet
/// never produce a frame (RDP sessions, GPU-less servers); without this probe
/// the viewer would see a permanently black screen with no error.
const WGC_FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(3);

/// GDI fallback capture cadence (~30 fps). BitBlt is synchronous and CPU-bound,
/// so we pace it rather than spin.
const GDI_FRAME_INTERVAL: Duration = Duration::from_millis(33);

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
    /// Tries Windows Graphics Capture first; if WGC cannot initialise or does
    /// not deliver a frame (common over RDP / on GPU-less servers, where its
    /// hardware-only Direct3D path is unavailable) it transparently falls back
    /// to a GDI BitBlt capture that works in those environments.
    pub fn start(display_id: u32) -> Result<Self, String> {
        match Self::start_wgc(display_id) {
            Ok(cap) => Ok(cap),
            Err(e) => {
                crate::dbg_log(&format!(
                    "[capture] WGC unavailable ({e}); falling back to GDI BitBlt"
                ));
                log::warn!("WGC capture unavailable ({e}); falling back to GDI BitBlt");
                Self::start_gdi(display_id)
                    .map_err(|gdi| format!("WGC failed ({e}); GDI fallback also failed ({gdi})"))
            }
        }
    }

    /// Windows Graphics Capture path.
    ///
    /// Uses xcap's `Monitor::video_recorder` API which opens **one**
    /// `GraphicsCaptureSession` and reuses it for the entire session. The
    /// per-frame `capture_image()` path xcap also exposes spins up a fresh
    /// `Direct3D11CaptureFramePool` + `GraphicsCaptureSession` 30×/s; DWM
    /// reacts to that churn by toggling the system-cursor compositing path,
    /// visible as a persistent cursor flicker across the entire desktop.
    fn start_wgc(display_id: u32) -> Result<Self, String> {
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
            .name("screen-capture-wgc".to_string())
            .spawn(move || wgc_worker(display_id, tx, stop_rx, init_tx))
            .map_err(|e| e.to_string())?;

        match init_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                rx,
                _stop_tx: stop_tx,
                frame_width: width,
                frame_height: height,
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("WGC capture worker exited before reporting init".to_string()),
        }
    }

    /// GDI BitBlt fallback path — works over RDP and without a GPU.
    fn start_gdi(display_id: u32) -> Result<Self, String> {
        let (x, y, width, height) = {
            let monitor = pick_monitor(display_id)?;
            (
                monitor.x().map_err(|e| e.to_string())?,
                monitor.y().map_err(|e| e.to_string())?,
                monitor.width().map_err(|e| e.to_string())?,
                monitor.height().map_err(|e| e.to_string())?,
            )
        };
        if width == 0 || height == 0 {
            return Err(format!("GDI: monitor {display_id} reports zero size"));
        }

        let (tx, rx) = mpsc::sync_channel::<BgraFrame>(2);
        let (stop_tx, stop_rx) = mpsc::sync_channel::<()>(1);
        let (init_tx, init_rx) = mpsc::sync_channel::<Result<(), String>>(1);

        std::thread::Builder::new()
            .name("screen-capture-gdi".to_string())
            .spawn(move || gdi_worker(x, y, width, height, tx, stop_rx, init_tx))
            .map_err(|e| e.to_string())?;

        match init_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                rx,
                _stop_tx: stop_tx,
                frame_width: width,
                frame_height: height,
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("GDI capture worker exited before reporting init".to_string()),
        }
    }
}

/// Initialises a multithreaded COM apartment for the lifetime of the capture
/// worker thread. WGC's activation factory (`RoGetActivationFactory`, reached
/// via xcap's `factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()`)
/// and the Direct3D interop require an initialised apartment on the **calling**
/// thread. A bare `std::thread` has none, so `monitor.video_recorder()` failed
/// with `E_NOINTERFACE` (0x80004002). MTA matches WGC's free-threaded frame
/// pool, whose `FrameArrived` callbacks fire on threadpool threads.
struct ComMta {
    initialised: bool,
}

impl ComMta {
    fn init() -> Self {
        // SAFETY: paired with CoUninitialize in Drop. is_ok() covers S_OK and
        // S_FALSE (already initialised on this thread). RPC_E_CHANGED_MODE means
        // the thread is already an STA — we leave it as-is and skip uninit.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        ComMta {
            initialised: hr.is_ok(),
        }
    }
}

impl Drop for ComMta {
    fn drop(&mut self) {
        if self.initialised {
            // SAFETY: balances the successful CoInitializeEx on this thread.
            unsafe { CoUninitialize() };
        }
    }
}

fn wgc_worker(
    display_id: u32,
    tx: mpsc::SyncSender<BgraFrame>,
    stop_rx: mpsc::Receiver<()>,
    init_tx: mpsc::SyncSender<Result<(), String>>,
) {
    let _com = ComMta::init();

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
                "screen-capture: video_recorder init failed (monitor {display_id}): {e}"
            )));
            return;
        }
    };

    if let Err(e) = recorder.start() {
        let _ = init_tx.send(Err(format!("screen-capture: recorder.start failed: {e}")));
        return;
    }

    let start_instant = Instant::now();

    // Probe for the first frame before committing to WGC. If none arrives the
    // caller falls back to GDI rather than streaming a black screen.
    let first = match frame_rx.recv_timeout(WGC_FIRST_FRAME_TIMEOUT) {
        Ok(frame) => frame,
        Err(_) => {
            let _ = init_tx.send(Err(
                "screen-capture: WGC produced no frames within timeout".to_string()
            ));
            return;
        }
    };
    let _ = init_tx.send(Ok(()));
    crate::dbg_log("[capture] WGC active");

    if send_bgra(&tx, rgba_to_bgra(first.raw), start_instant.elapsed()).is_break() {
        return;
    }

    loop {
        if stop_signaled(&stop_rx) {
            break;
        }

        // recv_timeout instead of recv so we observe stop_signaled within
        // 500ms even if the WGC pipeline stalls (e.g. monitor unplugged).
        match frame_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(frame) => {
                if send_bgra(&tx, rgba_to_bgra(frame.raw), start_instant.elapsed()).is_break() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // WgcRuntime::Drop closes the session + frame pool when the recorder
    // goes out of scope here.
    drop(recorder);
}

/// Forward a BGRA frame to the encoder. Returns `Break` when the consumer is
/// gone so the worker can exit; a full channel just drops the frame.
fn send_bgra(
    tx: &mpsc::SyncSender<BgraFrame>,
    data: Vec<u8>,
    elapsed: Duration,
) -> std::ops::ControlFlow<()> {
    let pts_us = elapsed.as_micros() as u64;
    match tx.try_send(BgraFrame { data, pts_us }) {
        Ok(()) | Err(mpsc::TrySendError::Full(_)) => std::ops::ControlFlow::Continue(()),
        Err(mpsc::TrySendError::Disconnected(_)) => std::ops::ControlFlow::Break(()),
    }
}

fn gdi_worker(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    tx: mpsc::SyncSender<BgraFrame>,
    stop_rx: mpsc::Receiver<()>,
    init_tx: mpsc::SyncSender<Result<(), String>>,
) {
    // GDI does not require a COM apartment, but the encoder downstream is the
    // same; capture is BGRA top-down with no cursor (matching WGC, which xcap
    // configures with cursor capture disabled).
    let capture = match GdiCapture::new(x, y, width, height) {
        Ok(c) => c,
        Err(e) => {
            let _ = init_tx.send(Err(format!("screen-capture: GDI init failed: {e}")));
            return;
        }
    };

    let start_instant = Instant::now();

    // Confirm the first grab works before reporting success.
    match capture.grab(start_instant.elapsed()) {
        Ok(frame) => {
            let _ = init_tx.send(Ok(()));
            crate::dbg_log("[capture] GDI fallback active");
            if tx.send(frame).is_err() {
                return;
            }
        }
        Err(e) => {
            let _ = init_tx.send(Err(format!("screen-capture: GDI first grab failed: {e}")));
            return;
        }
    }

    loop {
        if stop_signaled(&stop_rx) {
            break;
        }
        match capture.grab(start_instant.elapsed()) {
            Ok(frame) => match tx.try_send(frame) {
                Ok(()) | Err(mpsc::TrySendError::Full(_)) => {}
                Err(mpsc::TrySendError::Disconnected(_)) => break,
            },
            Err(e) => {
                log::warn!("GDI grab failed: {e}");
                break;
            }
        }
        std::thread::sleep(GDI_FRAME_INTERVAL);
    }
}

/// Owns the GDI device contexts + bitmap for a single capture session.
/// Created and used entirely on the GDI worker thread; cleaned up on drop.
struct GdiCapture {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    screen_dc: HDC,
    mem_dc: HDC,
    bitmap: HBITMAP,
    prev_obj: HGDIOBJ,
    // GDI device contexts/bitmaps are thread-affine: they must be used on the
    // thread that created them. The handle newtypes are `Send`, so without this
    // marker `GdiCapture` would be accidentally `Send` and a future refactor
    // could call `grab()` from another thread (UB per the Win32 contract).
    _not_send: std::marker::PhantomData<*mut ()>,
}

impl GdiCapture {
    fn new(x: i32, y: i32, width: u32, height: u32) -> Result<Self, String> {
        unsafe {
            let screen_dc = GetDC(None);
            if screen_dc.is_invalid() {
                return Err("GetDC(screen) returned null".to_string());
            }
            let mem_dc = CreateCompatibleDC(Some(screen_dc));
            if mem_dc.is_invalid() {
                ReleaseDC(None, screen_dc);
                return Err("CreateCompatibleDC failed".to_string());
            }
            let bitmap = CreateCompatibleBitmap(screen_dc, width as i32, height as i32);
            if bitmap.is_invalid() {
                let _ = DeleteDC(mem_dc);
                ReleaseDC(None, screen_dc);
                return Err("CreateCompatibleBitmap failed".to_string());
            }
            let prev_obj = SelectObject(mem_dc, HGDIOBJ(bitmap.0));
            // SelectObject returns HGDI_ERROR ((HGDIOBJ)-1) on failure; without
            // the bitmap selected, BitBlt would draw into the DC's default 1×1
            // bitmap and every frame would come back black.
            if prev_obj == HGDIOBJ(-1isize as *mut std::ffi::c_void) {
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
                let _ = DeleteDC(mem_dc);
                ReleaseDC(None, screen_dc);
                return Err("SelectObject failed".to_string());
            }
            Ok(Self {
                x,
                y,
                width,
                height,
                screen_dc,
                mem_dc,
                bitmap,
                prev_obj,
                _not_send: std::marker::PhantomData,
            })
        }
    }

    fn grab(&self, elapsed: Duration) -> Result<BgraFrame, String> {
        unsafe {
            // CAPTUREBLT also grabs layered windows. SRCCOPY straight blit.
            BitBlt(
                self.mem_dc,
                0,
                0,
                self.width as i32,
                self.height as i32,
                Some(self.screen_dc),
                self.x,
                self.y,
                SRCCOPY | CAPTUREBLT,
            )
            .map_err(|e| format!("BitBlt: {e}"))?;

            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: self.width as i32,
                    // Negative height => top-down rows, matching the encoder's
                    // expected orientation (same as the WGC path).
                    biHeight: -(self.height as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };

            let buf_len = (self.width as usize)
                .checked_mul(self.height as usize)
                .and_then(|n| n.checked_mul(4))
                .ok_or_else(|| "GDI: frame dimensions overflow buffer size".to_string())?;
            let mut buf = vec![0u8; buf_len];
            let scanlines = GetDIBits(
                self.mem_dc,
                self.bitmap,
                0,
                self.height,
                Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
                &mut info,
                DIB_RGB_COLORS,
            );
            if scanlines == 0 {
                return Err("GetDIBits returned 0 scanlines".to_string());
            }

            // 32-bit BI_RGB DIBs are stored as B,G,R,X — already BGRA byte
            // order for the encoder (alpha is unused downstream).
            Ok(BgraFrame {
                data: buf,
                pts_us: elapsed.as_micros() as u64,
            })
        }
    }
}

impl Drop for GdiCapture {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.mem_dc, self.prev_obj);
            let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            let _ = DeleteDC(self.mem_dc);
            ReleaseDC(None, self.screen_dc);
        }
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
        let displays =
            list_displays_inner().expect("xcap monitor enumeration must succeed on this host");
        assert!(!displays.is_empty(), "expected at least one monitor");
    }

    // Display/GPU-requiring: starts a real capture on the primary monitor and
    // asserts a frame pipeline initialises. Reproduces the E_NOINTERFACE
    // regression (worker thread had no COM apartment) and proves the COM-init
    // fix + GDI fallback. Run on a host with a real session:
    //   cargo test --lib -- --ignored windows_capturer
    #[test]
    #[ignore = "requires a real desktop session (GPU for WGC, or GDI fallback)"]
    fn windows_capturer_starts_and_yields_a_frame() {
        let cap =
            WindowsCapturer::start(0).expect("capture must initialise on the primary monitor");
        assert!(
            cap.frame_width > 0 && cap.frame_height > 0,
            "capturer must report non-zero dimensions"
        );
        let frame = cap
            .rx
            .recv_timeout(Duration::from_secs(5))
            .expect("must receive at least one frame");
        assert_eq!(
            frame.data.len(),
            cap.frame_width as usize * cap.frame_height as usize * 4,
            "frame buffer must be width*height*4 BGRA bytes"
        );
    }
}
