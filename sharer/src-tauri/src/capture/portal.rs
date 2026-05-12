//! Wayland screen-capture backend using xdg-desktop-portal (ScreenCast portal) + PipeWire.
//!
//! # Flow
//!
//! 1. Async step (tokio): open a ScreenCast portal session, let the user pick a monitor
//!    via the compositor's "Choose what to share" dialog, obtain a PipeWire node ID and fd.
//! 2. Sync step (dedicated OS thread): run a PipeWire MainLoop that reads frames from the
//!    negotiated stream node and pushes BGRA-converted frames into an mpsc channel.
//!
//! The public `PortalCapturer::start()` performs step 1 synchronously (blocking tokio on a
//! new runtime) then hands off to the PW thread for step 2.
//!
//! # Portal security model
//!
//! The user must click "Share" in the portal dialog on every Sharer launch.  That is the
//! compositor's security boundary — there is no "remember this choice" for screen capture
//! by default.  This is documented in INSTALL-LINUX.md so users know to expect it.

use std::sync::mpsc;

use pipewire as pw;
use pw::{properties::properties, spa};
use spa::pod::Pod;

use super::BgraFrame;

/// Result of the async portal negotiation step.
struct PortalStreams {
    /// PipeWire remote fd (authorised by the portal).
    pw_fd: std::os::fd::OwnedFd,
    /// PipeWire node ID of the selected screen-cast stream.
    node_id: u32,
    /// Width as reported by the portal (may differ from pixel width on HiDPI).
    width: u32,
    /// Height as reported by the portal.
    height: u32,
}

/// Run the ashpd portal handshake on the current tokio runtime.
///
/// Blocks until the user has interacted with the compositor's "Choose what to
/// share" dialog.  Returns an error string if the portal call fails or the user
/// cancels.
async fn open_portal() -> Result<PortalStreams, String> {
    use ashpd::desktop::{
        screencast::{CursorMode, Screencast, SourceType},
        PersistMode,
    };

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
            false, // single monitor only
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

/// User data threaded through the PipeWire stream callbacks.
struct StreamUserData {
    /// The negotiated video format, filled in during `param_changed`.
    format: spa::param::video::VideoInfoRaw,
    /// Channel to push decoded BGRA frames to.
    frame_tx: mpsc::SyncSender<BgraFrame>,
    /// Monotonic start instant for PTS computation.
    start: std::time::Instant,
}

pub struct PortalCapturer {
    pub rx: mpsc::Receiver<BgraFrame>,
    /// Sending the stop signal quits the PipeWire main loop, ending the capture thread.
    pub _stop_tx: pw::channel::Sender<()>,
    pub frame_width: u32,
    pub frame_height: u32,
}

impl PortalCapturer {
    /// Open the ScreenCast portal, show the compositor's monitor-picker, then
    /// start streaming frames into the returned capturer.
    pub fn start() -> Result<Self, String> {
        // Run the async portal negotiation on a fresh single-threaded tokio
        // runtime — INSIDE a dedicated OS thread. Calling block_on() directly
        // here would panic because start() is invoked from a tokio worker
        // (the Tauri async-runtime), and tokio refuses to start a new runtime
        // from within an active one. The OS thread sidesteps that detection.
        let streams = std::thread::Builder::new()
            .name("screenie-portal-init".to_string())
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

        let (frame_tx, rx) = mpsc::sync_channel::<BgraFrame>(4);
        let (pw_stop_tx, pw_stop_rx) = pw::channel::channel::<()>();

        let frame_width = streams.width;
        let frame_height = streams.height;

        std::thread::Builder::new()
            .name("screen-capture-pw".to_string())
            .spawn(move || {
                if let Err(e) = run_pipewire_loop(streams, frame_tx, pw_stop_rx) {
                    log::error!("[screen-capture-pw] PipeWire loop exited with error: {e}");
                }
            })
            .map_err(|e| e.to_string())?;

        Ok(Self {
            rx,
            _stop_tx: pw_stop_tx,
            frame_width,
            frame_height,
        })
    }
}

/// Run the PipeWire main loop synchronously in a dedicated thread.
///
/// Connects to the PW remote authorised by the portal fd, creates an input
/// stream attached to `node_id`, and drives the event loop until the
/// `pw_stop_rx` channel fires (signalled when `PortalCapturer` is dropped).
fn run_pipewire_loop(
    streams: PortalStreams,
    frame_tx: mpsc::SyncSender<BgraFrame>,
    pw_stop_rx: pw::channel::Receiver<()>,
) -> Result<(), String> {
    pw::init();

    // Use MainLoopRc (Rc-based) because we need to clone it for the quit callback.
    let mainloop = pw::main_loop::MainLoopRc::new(None)
        .map_err(|e| format!("pw MainLoop::new failed: {e}"))?;

    let context = pw::context::ContextRc::new(&mainloop, None)
        .map_err(|e| format!("pw Context::new failed: {e}"))?;

    let core = context
        .connect_fd(streams.pw_fd, None)
        .map_err(|e| format!("pw Context::connect_fd failed: {e}"))?;

    // Attach the stop receiver to the loop: when the sender side is dropped
    // (PortalCapturer goes out of scope), the channel send returns an error,
    // but the receiver side receives the () message to quit.
    let mainloop_quit = mainloop.clone();
    let _stop_receiver = pw_stop_rx.attach(mainloop.loop_(), move |_| {
        mainloop_quit.quit();
    });

    let stream = pw::stream::StreamBox::new(
        &core,
        "screenie-capture",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|e| format!("pw Stream::new failed: {e}"))?;

    let user_data = StreamUserData {
        format: Default::default(),
        frame_tx,
        start: std::time::Instant::now(),
    };

    // Register callbacks before connecting.
    let _listener = stream
        .add_local_listener_with_user_data(user_data)
        .state_changed(|_, _, old, new| {
            log::debug!("[screen-capture-pw] stream state: {:?} → {:?}", old, new);
        })
        .param_changed(|stream, user_data, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Ok((mt, mst)) = spa::param::format_utils::parse_format(param) else {
                return;
            };
            if mt != spa::param::format::MediaType::Video
                || mst != spa::param::format::MediaSubtype::Raw
            {
                return;
            }
            if user_data.format.parse(param).is_err() {
                log::warn!("[screen-capture-pw] failed to parse VideoInfoRaw from param");
                return;
            }
            log::info!(
                "[screen-capture-pw] negotiated format: {:?} {}x{}",
                user_data.format.format(),
                user_data.format.size().width,
                user_data.format.size().height,
            );

            // Acknowledge the format by updating params (empty update signals acceptance).
            let mut empty: Vec<&Pod> = Vec::new();
            if let Err(e) = stream.update_params(&mut empty) {
                log::warn!("[screen-capture-pw] update_params failed: {e}");
            }
        })
        .process(|stream, user_data| {
            let Some(mut buf) = stream.dequeue_buffer() else {
                return;
            };

            let datas = buf.datas_mut();
            if datas.is_empty() {
                return;
            }

            let data = &mut datas[0];
            let chunk_size = data.chunk().size() as usize;
            if chunk_size == 0 {
                return;
            }

            let Some(raw) = data.data() else { return };
            let pixel_bytes = &raw[..chunk_size.min(raw.len())];

            let fmt = user_data.format.format();
            let bgra = pixels_to_bgra(pixel_bytes, fmt);
            if bgra.is_empty() {
                log::warn!(
                    "[screen-capture-pw] unsupported pixel format {:?}, skipping frame",
                    fmt
                );
                return;
            }

            let pts_us = user_data.start.elapsed().as_micros() as u64;
            let frame = BgraFrame { data: bgra, pts_us };
            if user_data.frame_tx.try_send(frame).is_err() {
                // Receiver full or dropped; discard frame.
            }
        })
        .register()
        .map_err(|e| format!("pw stream listener register failed: {e}"))?;

    // Build the format negotiation pod: prefer BGRA, then BGRx, then RGBA, then RGBx.
    let format_pod_bytes = build_video_format_pod();
    let format_pod = Pod::from_bytes(&format_pod_bytes)
        .ok_or_else(|| "failed to parse format pod bytes".to_string())?;
    let mut params = [format_pod];

    stream
        .connect(
            spa::utils::Direction::Input,
            Some(streams.node_id),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .map_err(|e| format!("pw stream connect failed: {e}"))?;

    mainloop.run();

    Ok(())
}

/// Serialise a SPA pod describing the preferred video formats for the stream.
///
/// We list BGRA and BGRx first (native format for the encoder pipeline),
/// followed by RGBA and RGBx (need R/B swap), so PipeWire picks the best
/// mutually-supported format.
fn build_video_format_pod() -> Vec<u8> {
    let obj = pw::spa::pod::object!(
        pw::spa::utils::SpaTypes::ObjectParamFormat,
        pw::spa::param::ParamType::EnumFormat,
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaType,
            Id,
            pw::spa::param::format::MediaType::Video
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaSubtype,
            Id,
            pw::spa::param::format::MediaSubtype::Raw
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            // Default (highest preference): BGRA — already what the encoder needs.
            pw::spa::param::video::VideoFormat::BGRA,
            pw::spa::param::video::VideoFormat::BGRA,
            pw::spa::param::video::VideoFormat::BGRx,
            pw::spa::param::video::VideoFormat::RGBA,
            pw::spa::param::video::VideoFormat::RGBx,
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            pw::spa::utils::Rectangle {
                width: 1920,
                height: 1080
            },
            pw::spa::utils::Rectangle {
                width: 1,
                height: 1
            },
            pw::spa::utils::Rectangle {
                width: 7680,
                height: 4320
            }
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            pw::spa::utils::Fraction { num: 30, denom: 1 },
            pw::spa::utils::Fraction { num: 1, denom: 1 },
            pw::spa::utils::Fraction { num: 240, denom: 1 }
        ),
    );

    pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(obj),
    )
    .expect("format pod serialization must not fail")
    .0
    .into_inner()
}

/// Convert a raw pixel buffer in the given SPA format to packed BGRA.
///
/// Returns an empty Vec for formats we cannot handle; the caller logs a
/// warning and drops the frame.
pub(super) fn pixels_to_bgra(src: &[u8], fmt: spa::param::video::VideoFormat) -> Vec<u8> {
    use spa::param::video::VideoFormat;

    match fmt {
        VideoFormat::BGRA => src.to_vec(),
        VideoFormat::BGRx => {
            // BGRx: alpha byte is padding (0x00 from source); set to 0xFF.
            let mut out = src.to_vec();
            for pixel in out.chunks_exact_mut(4) {
                pixel[3] = 0xff;
            }
            out
        }
        VideoFormat::RGBA => {
            // RGBA → BGRA: swap R and B channels.
            let mut out = src.to_vec();
            for pixel in out.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
            out
        }
        VideoFormat::RGBx => {
            // RGBx → BGRA: swap R/B, set alpha to 0xFF.
            let mut out = src.to_vec();
            for pixel in out.chunks_exact_mut(4) {
                pixel.swap(0, 2);
                pixel[3] = 0xff;
            }
            out
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixels_to_bgra_passthrough_for_bgra() {
        let src = vec![0x10_u8, 0x20, 0x30, 0x80];
        let out = pixels_to_bgra(&src, spa::param::video::VideoFormat::BGRA);
        assert_eq!(out, src);
    }

    #[test]
    fn pixels_to_bgra_sets_alpha_for_bgrx() {
        let src = vec![0x10_u8, 0x20, 0x30, 0x00];
        let out = pixels_to_bgra(&src, spa::param::video::VideoFormat::BGRx);
        assert_eq!(out, vec![0x10, 0x20, 0x30, 0xff]);
    }

    #[test]
    fn pixels_to_bgra_swaps_rb_for_rgba() {
        let src = vec![0xAA_u8, 0xBB, 0xCC, 0xDD];
        let out = pixels_to_bgra(&src, spa::param::video::VideoFormat::RGBA);
        assert_eq!(out, vec![0xCC, 0xBB, 0xAA, 0xDD]);
    }

    #[test]
    fn pixels_to_bgra_swaps_rb_and_sets_alpha_for_rgbx() {
        let src = vec![0xAA_u8, 0xBB, 0xCC, 0x00];
        let out = pixels_to_bgra(&src, spa::param::video::VideoFormat::RGBx);
        assert_eq!(out, vec![0xCC, 0xBB, 0xAA, 0xff]);
    }

    #[test]
    fn pixels_to_bgra_returns_empty_for_unsupported() {
        let src = vec![0x00_u8; 4];
        let out = pixels_to_bgra(&src, spa::param::video::VideoFormat::I420);
        assert!(out.is_empty());
    }
}
