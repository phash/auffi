//! GStreamer-based Wayland screen-capture backend.
//!
//! Uses the xdg-desktop-portal ScreenCast portal to obtain a PipeWire stream
//! file descriptor + node id, then feeds them into a GStreamer pipeline:
//!
//! ```text
//! pipewiresrc fd=<fd> path=<node_id> do-timestamp=true
//!   ! videoconvert
//!   ! video/x-raw,format=BGRA
//!   ! appsink emit-signals=true sync=false max-buffers=2 drop=true
//! ```
//!
//! `pipewiresrc` (from `gst-plugin-pipewire`) handles all the SPA pod
//! negotiation, DMA-BUF imports, modifier handshakes, and format conversion
//! that direct pipewire-rs makes us hand-craft.  `videoconvert` then forces
//! whatever the compositor delivers (BGRA / BGRx / YUV / modifier-encoded
//! DMA-BUF) into tightly-packed BGRA that the rest of our encoder pipeline
//! already speaks.
//!
//! `sync=false` decouples frame delivery from wall-clock — we want to drain
//! samples as fast as they arrive.  `max-buffers=2 drop=true` keeps memory
//! bounded if the encoder falls behind: stale frames get discarded rather
//! than queued.

use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::mpsc;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;

use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SourceType},
    PersistMode, Session,
};

use super::BgraFrame;
use crate::dbg_log;

/// What the portal handed us and what we owe it back.
///
/// `pipewiresrc` dups the fd it is given (`pw_context_connect_fd(fcntl(fd,
/// F_DUPFD_CLOEXEC, ..))`) and never closes the original, so the `OwnedFd`
/// must stay ours and be closed by us. The ashpd `Session` has no `Drop`
/// impl and ashpd keeps one process-wide zbus connection, so
/// xdg-desktop-portal never sees a peer disconnect that would garbage-
/// collect the session either — it has to be `close()`d explicitly.
/// Dropping this handle does both.
struct PortalHandle {
    pw_fd: Option<OwnedFd>,
    session: Option<Session<'static, Screencast<'static>>>,
}

impl Drop for PortalHandle {
    fn drop(&mut self) {
        // The fd closes with the field. `close()` is async and Drop is not;
        // Tauri's runtime outlives every capturer, so the request is handed
        // to it rather than blocked on (Drop runs inside the streaming loop).
        if let Some(session) = self.session.take() {
            tauri::async_runtime::spawn(async move {
                match session.close().await {
                    Ok(()) => dbg_log("[gst-portal] session closed"),
                    Err(e) => dbg_log(&format!("[gst-portal] session close failed: {e}")),
                }
            });
        }
    }
}

/// Output of the async portal negotiation step.
struct PortalStreams {
    portal: PortalHandle,
    node_id: u32,
    width: u32,
    height: u32,
}

/// Run the ashpd ScreenCast handshake. Blocks until the user clicks "Teilen"
/// in the compositor dialog.
///
/// Always-prompt policy: the user picks the monitor every session, so no
/// restore token is requested or kept. Until 2026-09 the portal was asked to
/// persist a grant that was written to disk and never read back (only an
/// undocumented env flag enabled the read), i.e. persisted state with no
/// retention policy. Unattended access (gh #85, #86) may re-introduce a
/// pre-grant deliberately.
async fn open_portal() -> Result<PortalStreams, String> {
    dbg_log("[gst-portal] open_portal start");
    let proxy = Screencast::new()
        .await
        .map_err(|e| format!("screencast portal unavailable: {e}"))?;

    let session = proxy
        .create_session()
        .await
        .map_err(|e| format!("create_session failed: {e}"))?;
    dbg_log("[gst-portal] session created");

    // A cancelled dialog or a failed start must not leave the session
    // registered at the portal either.
    match negotiate(&proxy, &session).await {
        Ok((pw_fd, node_id, width, height)) => Ok(PortalStreams {
            portal: PortalHandle {
                pw_fd: Some(pw_fd),
                session: Some(session),
            },
            node_id,
            width,
            height,
        }),
        Err(e) => {
            if let Err(close_err) = session.close().await {
                dbg_log(&format!(
                    "[gst-portal] session close after failed negotiation: {close_err}"
                ));
            }
            Err(e)
        }
    }
}

/// Source selection, start, and the PipeWire remote — everything between
/// `create_session` and a usable stream. Returns `(fd, node_id, w, h)`.
async fn negotiate(
    proxy: &Screencast<'static>,
    session: &Session<'static, Screencast<'static>>,
) -> Result<(OwnedFd, u32, u32, u32), String> {
    proxy
        .select_sources(
            session,
            CursorMode::Embedded,
            SourceType::Monitor.into(),
            // single monitor only: open_portal uses just the first stream, so
            // letting the dialog multi-select would silently discard the rest
            false,
            None,
            PersistMode::DoNot,
        )
        .await
        .map_err(|e| format!("select_sources failed: {e}"))?;
    dbg_log("[gst-portal] select_sources OK");

    let response = proxy
        .start(session, None)
        .await
        .map_err(|e| format!("start failed: {e}"))?
        .response()
        .map_err(|e| format!("portal dialog cancelled or rejected: {e}"))?;
    dbg_log("[gst-portal] start() returned");

    let stream = response
        .streams()
        .first()
        .ok_or_else(|| "portal returned no streams".to_string())?;

    let node_id = stream.pipe_wire_node_id();
    // If the portal can't tell us a size, something is wrong upstream
    // (mis-configured compositor, broken portal impl). Fall-back to a
    // hardcoded 1920x1080 silently hides protocol misbehaviour and the
    // VP8 encoder then scales/crops away pixels with no warning. Bail
    // out instead — the user sees a clear error instead of a degraded
    // stream.
    let (width, height) = stream
        .size()
        .map(|(w, h)| (w.max(0) as u32, h.max(0) as u32))
        .ok_or_else(|| "portal returned stream without size".to_string())?;
    dbg_log(&format!(
        "[gst-portal] stream node_id={node_id} size={width}x{height}"
    ));

    let pw_fd = proxy
        .open_pipe_wire_remote(session)
        .await
        .map_err(|e| format!("open_pipe_wire_remote failed: {e}"))?;
    dbg_log("[gst-portal] open_pipe_wire_remote OK");

    Ok((pw_fd, node_id, width, height))
}

/// Whether a delivered sample still matches the geometry the encoder was
/// built for. The pipeline caps pin only `format=BGRA`, so when the
/// compositor renegotiates the PipeWire stream (output mode or scale change
/// mid-session) `videoconvert` passes the new size straight through. The
/// encoder downstream rejects a smaller buffer on every frame (frozen
/// picture) and reads a larger one with the stale stride (skewed picture),
/// both silently — so the capture must end instead and let the
/// `streaming-failed` restart machinery take over.
fn check_frame_geometry(
    expected: (u32, u32),
    caps: Option<(u32, u32)>,
    len: usize,
) -> Result<(), String> {
    let (w, h) = expected;
    if let Some((cw, ch)) = caps {
        if (cw, ch) != (w, h) {
            return Err(format!(
                "stream renegotiated to {cw}x{ch}, encoder expects {w}x{h}"
            ));
        }
    }
    let needed = (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| format!("dimension overflow at {w}x{h}"))?;
    if len < needed {
        return Err(format!(
            "buffer holds {len} bytes, {w}x{h} BGRA needs {needed}"
        ));
    }
    Ok(())
}

/// Active GStreamer-based capture session.
pub struct GstPortalCapturer {
    /// Wrapped in Option so callers can `.take_rx()` and store the receiver
    /// in their own struct without partially moving the GstPortalCapturer
    /// (which still owns the pipeline and must live until Drop).
    rx: Option<mpsc::Receiver<BgraFrame>>,
    /// The running pipeline.  Drop sends it to Null, which tears down the
    /// pipewiresrc connection and unblocks the appsink consumer thread.
    _pipeline: gst::Pipeline,
    /// Declared AFTER `_pipeline`: fields drop in declaration order once
    /// `Drop::drop` has set the pipeline to Null, so the PipeWire fd is
    /// closed and the portal session ended only after pipewiresrc let go.
    _portal: PortalHandle,
    pub frame_width: u32,
    pub frame_height: u32,
}

impl GstPortalCapturer {
    /// Hand out the frame-receiver exactly once.  Returns None if already taken.
    pub fn take_rx(&mut self) -> Option<mpsc::Receiver<BgraFrame>> {
        self.rx.take()
    }
}

impl GstPortalCapturer {
    /// Async because the portal handshake is async — and because ashpd
    /// caches its `zbus::Connection` in a process-wide static. The cached
    /// connection is bound to the first tokio runtime that called into
    /// ashpd; if that runtime dies (e.g. a per-call short-lived runtime)
    /// the cached connection becomes a zombie and subsequent
    /// `create_session()` calls hang forever. Running the portal handshake
    /// on the long-lived Tauri runtime keeps the cached connection alive
    /// across switch_monitor reinvocations.
    pub async fn start() -> Result<Self, String> {
        let streams = open_portal().await?;

        log::info!(
            "[gst-capture] portal ready: node_id={} size={}x{}",
            streams.node_id,
            streams.width,
            streams.height
        );

        gst::init().map_err(|e| format!("gst::init failed: {e}"))?;

        let raw_fd = streams
            .portal
            .pw_fd
            .as_ref()
            .ok_or_else(|| "portal handle without PipeWire fd".to_string())?
            .as_raw_fd();
        let pipeline_desc = format!(
            "pipewiresrc fd={raw_fd} path={node_id} do-timestamp=true \
             ! videoconvert \
             ! video/x-raw,format=BGRA \
             ! appsink name=sink emit-signals=true sync=false max-buffers=2 drop=true",
            node_id = streams.node_id,
        );

        let pipeline = gst::parse::launch(&pipeline_desc)
            .map_err(|e| format!("gst pipeline parse failed: {e}"))?
            .downcast::<gst::Pipeline>()
            .map_err(|_| "parsed element is not a Pipeline".to_string())?;

        let appsink = pipeline
            .by_name("sink")
            .ok_or_else(|| "appsink element 'sink' missing".to_string())?
            .downcast::<gst_app::AppSink>()
            .map_err(|_| "sink element is not an AppSink".to_string())?;

        let (tx, rx) = mpsc::sync_channel::<BgraFrame>(4);
        let start_instant = std::time::Instant::now();
        let expected = (streams.width, streams.height);

        // The sender lives in an Option so a geometry mismatch can drop it
        // from inside the callback: closing the channel is what makes
        // `ScreenCapturer::next_frame` return Err and the streaming loop
        // emit `streaming-failed`. GStreamer may call `new_sample` again
        // before the pipeline reaches Null, hence the idempotent `take`.
        let mut tx = Some(tx);
        appsink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let Some(sender) = tx.as_ref() else {
                        return Err(gst::FlowError::Eos);
                    };
                    let sample = match sink.pull_sample() {
                        Ok(s) => s,
                        Err(_) => return Err(gst::FlowError::Eos),
                    };
                    let buffer = match sample.buffer() {
                        Some(b) => b,
                        None => return Ok(gst::FlowSuccess::Ok),
                    };
                    let map = match buffer.map_readable() {
                        Ok(m) => m,
                        Err(_) => return Ok(gst::FlowSuccess::Ok),
                    };
                    let caps_dims = sample
                        .caps()
                        .and_then(|c| gst_video::VideoInfo::from_caps(c).ok())
                        .map(|info| (info.width(), info.height()));
                    if let Err(e) = check_frame_geometry(expected, caps_dims, map.len()) {
                        dbg_log(&format!(
                            "[gst-capture] frame geometry changed ({e}) — ending capture so the session restarts"
                        ));
                        tx = None;
                        return Err(gst::FlowError::Error);
                    }

                    let frame = BgraFrame {
                        data: map.as_slice().to_vec(),
                        pts_us: start_instant.elapsed().as_micros() as u64,
                    };
                    // try_send: drop the frame if the consumer fell behind
                    // rather than block the GStreamer streaming thread.
                    let _ = sender.try_send(frame);
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("pipeline.set_state(Playing) failed: {e}"))?;

        Ok(Self {
            rx: Some(rx),
            _pipeline: pipeline,
            _portal: streams.portal,
            frame_width: streams.width,
            frame_height: streams.height,
        })
    }
}

impl Drop for GstPortalCapturer {
    fn drop(&mut self) {
        // Best-effort teardown; `_portal` then closes the fd and the session.
        let _ = self._pipeline.set_state(gst::State::Null);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    fn inode_of(fd: i32) -> Option<u64> {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        (unsafe { libc::fstat(fd, &mut st) } == 0).then_some(st.st_ino)
    }

    // `into_raw_fd()` gave the PipeWire socket away for good: pipewiresrc
    // dups the fd it is handed and nobody closed the original, so every
    // session start and every monitor switch leaked one fd (and one portal
    // session) for the process lifetime — a 24/7 unattended sharer runs out.
    #[test]
    fn portal_handle_drop_closes_pw_fd() {
        let mut fds = [0i32; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let read_end = unsafe { OwnedFd::from_raw_fd(fds[0]) };
        let write_end = unsafe { OwnedFd::from_raw_fd(fds[1]) };
        let raw = read_end.as_raw_fd();
        let inode = inode_of(raw).expect("open pipe has an inode");

        drop(PortalHandle {
            pw_fd: Some(read_end),
            session: None,
        });

        // Closed, or — if another thread already reused the number — a
        // different file entirely. Either way our pipe end is gone.
        assert_ne!(inode_of(raw), Some(inode), "read end must be closed by Drop");
        assert!(inode_of(write_end.as_raw_fd()).is_some(), "control: the write end is untouched");
    }

    /// End-to-end leak check against a real portal. Needs a Wayland session
    /// and three clicks on "Teilen"; run with
    /// `cargo test --lib -- --ignored start_drop_cycles`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn start_drop_cycles_do_not_leak_fds() {
        let open_fds = || std::fs::read_dir("/proc/self/fd").expect("procfs").count();
        let baseline = open_fds();
        for _ in 0..3 {
            let cap = GstPortalCapturer::start().await.expect("portal + pipeline");
            drop(cap);
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        assert_eq!(open_fds(), baseline, "every start/drop cycle must return all fds");
    }

    // The pipeline caps pin only `format=BGRA`, so a compositor renegotiation
    // (dock/undock, scale change during a session) changes the buffer size
    // under a running encoder built for the portal-declared geometry. That
    // used to freeze (smaller) or skew (larger) the picture silently; the
    // callback must refuse such a sample so the stream fails loud instead.

    #[test]
    fn check_frame_geometry_accepts_matching_caps_and_length() {
        assert!(check_frame_geometry((4, 4), Some((4, 4)), 64).is_ok());
    }

    #[test]
    fn check_frame_geometry_rejects_renegotiated_dimensions() {
        let err = check_frame_geometry((1920, 1080), Some((2560, 1440)), 2560 * 1440 * 4)
            .expect_err("a larger stream must not be consumed with the old stride");
        assert!(err.contains("1920x1080") && err.contains("2560x1440"), "{err}");
        assert!(check_frame_geometry((1920, 1080), Some((1280, 720)), 1280 * 720 * 4).is_err());
    }

    #[test]
    fn check_frame_geometry_rejects_short_buffers_even_without_caps() {
        assert!(check_frame_geometry((4, 4), None, 48).is_err());
        assert!(check_frame_geometry((4, 4), None, 64).is_ok());
    }

    #[test]
    fn check_frame_geometry_rejects_overflowing_dimensions() {
        assert!(check_frame_geometry((u32::MAX, u32::MAX), None, usize::MAX).is_err());
    }
}
