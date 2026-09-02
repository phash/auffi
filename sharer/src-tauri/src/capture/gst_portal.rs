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
use std::path::PathBuf;
use std::sync::mpsc;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;

use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SourceType},
    PersistMode,
};

use super::BgraFrame;
use crate::dbg_log;

/// Output of the async portal negotiation step.
struct PortalStreams {
    pw_fd: std::os::fd::OwnedFd,
    node_id: u32,
    width: u32,
    height: u32,
}

/// Path where the restore_token returned by the portal is cached so the
/// dialog does not re-prompt on subsequent shares (modeled on hoptodesk's
/// `wayland-restore-token` config key).
fn restore_token_path() -> Option<PathBuf> {
    let base = dirs::data_local_dir()?.join("auffi");
    Some(base.join("portal-restore-token"))
}

fn read_restore_token() -> Option<String> {
    // Always-prompt policy: until unattended-access (gh #20-#27) lands and
    // gives us a code path that explicitly wants to pre-grant a source,
    // we always show the portal dialog so the user picks the monitor each
    // session. The on-disk token is still written by write_restore_token
    // (cheap and forward-compatible) but never read here.
    //
    // Only treat the env var as enable when set to "1" or "true". Setting
    // it to the empty string (a common "disable" pattern) must NOT re-
    // enable token restore.
    let flag = std::env::var_os("AUFFI_ENABLE_RESTORE_TOKEN")?;
    if !matches!(flag.to_str(), Some("1") | Some("true")) {
        return None;
    }
    let p = restore_token_path()?;
    let t = std::fs::read_to_string(p).ok()?;
    let t = t.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn write_restore_token(token: &str) {
    let Some(p) = restore_token_path() else {
        return;
    };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&p, token);
    dbg_log(&format!("[gst-portal] saved restore_token to {p:?}"));
}

/// Delete the cached restore_token. Used by the runtime monitor-switch
/// command so the next `open_portal()` re-prompts the user for a source
/// instead of silently restoring the previously-selected monitor.
pub fn delete_restore_token() {
    let Some(p) = restore_token_path() else {
        return;
    };
    let _ = std::fs::remove_file(&p);
    dbg_log(&format!("[gst-portal] deleted restore_token {p:?}"));
}

/// Run the ashpd ScreenCast handshake.  Blocks until the user clicks "Teilen"
/// in the compositor dialog the first time; on subsequent runs the saved
/// restore_token lets the portal grant the same source without prompting.
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

    let saved_token = read_restore_token();
    dbg_log(&format!(
        "[gst-portal] restore_token present={}",
        saved_token.is_some()
    ));

    proxy
        .select_sources(
            &session,
            CursorMode::Embedded,
            SourceType::Monitor.into(),
            // single monitor only: open_portal uses just the first stream, so
            // letting the dialog multi-select would silently discard the rest
            false,
            saved_token.as_deref(), // re-attach previously-granted source
            PersistMode::ExplicitlyRevoked, // keep until user revokes in settings
        )
        .await
        .map_err(|e| format!("select_sources failed: {e}"))?;
    dbg_log("[gst-portal] select_sources OK");

    let response = proxy
        .start(&session, None)
        .await
        .map_err(|e| format!("start failed: {e}"))?
        .response()
        .map_err(|e| format!("portal dialog cancelled or rejected: {e}"))?;
    dbg_log("[gst-portal] start() returned");

    // Persist the restore_token so the next launch skips the dialog.
    if let Some(token) = response.restore_token() {
        write_restore_token(token);
    }

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
        .open_pipe_wire_remote(&session)
        .await
        .map_err(|e| format!("open_pipe_wire_remote failed: {e}"))?;
    dbg_log("[gst-portal] open_pipe_wire_remote OK");

    Ok(PortalStreams {
        pw_fd,
        node_id,
        width,
        height,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

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
