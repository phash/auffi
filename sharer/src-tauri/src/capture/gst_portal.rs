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

use std::os::fd::IntoRawFd;
use std::sync::mpsc;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SourceType},
    PersistMode,
};

use super::BgraFrame;

/// Output of the async portal negotiation step.
struct PortalStreams {
    pw_fd: std::os::fd::OwnedFd,
    node_id: u32,
    width: u32,
    height: u32,
}

/// Run the ashpd ScreenCast handshake.  Blocks until the user clicks "Teilen"
/// in the compositor dialog.
async fn open_portal() -> Result<PortalStreams, String> {
    let proxy = Screencast::new()
        .await
        .map_err(|e| format!("screencast portal unavailable: {e}"))?;

    let session = proxy
        .create_session()
        .await
        .map_err(|e| format!("create_session failed: {e}"))?;

    proxy
        .select_sources(
            &session,
            CursorMode::Embedded,
            SourceType::Monitor.into(),
            false,
            None,
            PersistMode::DoNot,
        )
        .await
        .map_err(|e| format!("select_sources failed: {e}"))?;

    let response = proxy
        .start(&session, None)
        .await
        .map_err(|e| format!("start failed: {e}"))?
        .response()
        .map_err(|e| format!("portal dialog cancelled or rejected: {e}"))?;

    let stream = response
        .streams()
        .first()
        .ok_or_else(|| "portal returned no streams".to_string())?;

    let node_id = stream.pipe_wire_node_id();
    let (width, height) = stream
        .size()
        .map(|(w, h)| (w.max(0) as u32, h.max(0) as u32))
        .unwrap_or((1920, 1080));

    let pw_fd = proxy
        .open_pipe_wire_remote(&session)
        .await
        .map_err(|e| format!("open_pipe_wire_remote failed: {e}"))?;

    Ok(PortalStreams {
        pw_fd,
        node_id,
        width,
        height,
    })
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
    pub fn start() -> Result<Self, String> {
        // The portal call is async; drive it on a fresh single-threaded tokio
        // runtime INSIDE a dedicated OS thread. Calling block_on() directly
        // would panic because start() runs on a Tauri tokio worker.
        let streams = std::thread::Builder::new()
            .name("auffi-gst-portal-init".to_string())
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|e| format!("tokio runtime build failed: {e}"))?
                    .block_on(open_portal())
            })
            .map_err(|e| format!("portal init thread spawn failed: {e}"))?
            .join()
            .map_err(|_| "portal init thread panicked".to_string())??;

        log::info!(
            "[gst-capture] portal ready: node_id={} size={}x{}",
            streams.node_id,
            streams.width,
            streams.height
        );

        gst::init().map_err(|e| format!("gst::init failed: {e}"))?;

        let raw_fd = streams.pw_fd.into_raw_fd();
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

        appsink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
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

                    let frame = BgraFrame {
                        data: map.as_slice().to_vec(),
                        pts_us: start_instant.elapsed().as_micros() as u64,
                    };
                    // try_send: drop the frame if the consumer fell behind
                    // rather than block the GStreamer streaming thread.
                    let _ = tx.try_send(frame);
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
            frame_width: streams.width,
            frame_height: streams.height,
        })
    }
}

impl Drop for GstPortalCapturer {
    fn drop(&mut self) {
        // Best-effort teardown.
        let _ = self._pipeline.set_state(gst::State::Null);
    }
}
