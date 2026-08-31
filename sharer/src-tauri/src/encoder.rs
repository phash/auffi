use std::ffi::c_void;
use std::os::raw::{c_int, c_uchar};

/// FFI declarations for the vpx_shim.c C helper.
mod ffi {
    use std::ffi::c_void;
    use std::os::raw::{c_int, c_uchar, c_uint};

    #[allow(non_camel_case_types)]
    pub type vpx_shim_packet_cb = unsafe extern "C" fn(
        data: *const c_uchar,
        size: usize,
        is_keyframe: c_int,
        user_data: *mut c_void,
    );

    extern "C" {
        pub fn vpx_shim_create(width: c_uint, height: c_uint, bitrate_kbps: c_uint) -> *mut c_void;

        pub fn vpx_shim_destroy(ctx: *mut c_void);

        pub fn vpx_shim_encode(
            ctx: *mut c_void,
            i420: *const c_uchar,
            width: c_uint,
            height: c_uint,
            pts_us: i64,
            force_keyframe: c_int,
            cb: vpx_shim_packet_cb,
            user_data: *mut c_void,
        ) -> c_int;
    }
}

/// A VP8 encoder wrapping libvpx via a thin C shim.
pub struct Vp8Encoder {
    ctx: *mut c_void,
    /// Source frame dimensions as delivered by the capture backend (may be odd
    /// — VM auto-resize guests and custom modes produce odd monitor sizes).
    src_width: u32,
    src_height: u32,
    /// Even-cropped dimensions actually encoded. I420 chroma is subsampled
    /// 2x2, so libvpx needs even axes; the bottom/right edge row/column of an
    /// odd source is cropped away.
    enc_width: u32,
    enc_height: u32,
    /// Set by [`Vp8Encoder::request_keyframe`], consumed by the next
    /// [`Vp8Encoder::encode`].
    force_keyframe: bool,
    /// When the last keyframe left the encoder, for [`Vp8Encoder::request_keyframe_throttled`].
    last_keyframe_at: Option<std::time::Instant>,
}

/// Safety: The libvpx context is not shared; we move `Vp8Encoder` between threads only
/// when the caller guarantees exclusive access.
unsafe impl Send for Vp8Encoder {}

pub struct EncodedPacket {
    pub data: Vec<u8>,
    /// True for a keyframe. Reported by libvpx and surfaced here so callers —
    /// and tests — can tell whether a requested keyframe actually happened,
    /// rather than inferring it from packet size.
    pub is_keyframe: bool,
}

impl Vp8Encoder {
    /// Create a new VP8 encoder.
    ///
    /// `width`/`height` are the source frame dimensions; odd axes are cropped
    /// down to even for the encode (see `bgra_to_i420`).
    /// `bitrate_kbps` is the target bitrate in kilobits per second.
    pub fn new(width: u32, height: u32, bitrate_kbps: u32) -> Result<Self, String> {
        let enc_width = width & !1;
        let enc_height = height & !1;
        if enc_width == 0 || enc_height == 0 {
            return Err(format!(
                "frame dimensions {width}x{height} too small — no even encode size left"
            ));
        }
        let ctx = unsafe { ffi::vpx_shim_create(enc_width, enc_height, bitrate_kbps) };
        if ctx.is_null() {
            return Err("vpx_shim_create failed".to_string());
        }
        Ok(Self {
            ctx,
            src_width: width,
            src_height: height,
            enc_width,
            enc_height,
            // The first encoded frame is a keyframe anyway, but a viewer that
            // attaches later needs one on demand — see request_keyframe.
            force_keyframe: false,
            last_keyframe_at: None,
        })
    }

    /// Encode one BGRA frame.
    ///
    /// Shortest gap between two keyframes produced on request.
    ///
    /// A viewer on a lossy link sends a Picture Loss Indication whenever it
    /// cannot decode, which can be several times a second. Honouring each one
    /// is a feedback loop: a keyframe is an order of magnitude larger than a
    /// delta, so answering loss with more bytes causes more loss. One per
    /// second is enough to recover a stalled decoder without feeding the
    /// congestion that stalled it.
    const MIN_KEYFRAME_GAP: std::time::Duration = std::time::Duration::from_secs(1);

    /// Ask for the next encoded frame to be a keyframe.
    ///
    /// A VP8 decoder cannot show anything until it has one. The encoder's own
    /// scene detection will not fire on a static screen, and it has no way to
    /// know a viewer just attached — so whoever learns that a peer connected
    /// has to say so. Without this, a helper joining a motionless screen sees
    /// black until something moves.
    pub fn request_keyframe(&mut self) {
        self.force_keyframe = true;
    }

    /// Like [`Self::request_keyframe`], but ignored if one was produced less
    /// than [`Self::MIN_KEYFRAME_GAP`] ago. Use for viewer-driven requests
    /// (PLI); a peer actually connecting should use the unthrottled call.
    pub fn request_keyframe_throttled(&mut self) {
        let recent = self
            .last_keyframe_at
            .is_some_and(|t| t.elapsed() < Self::MIN_KEYFRAME_GAP);
        if !recent {
            self.force_keyframe = true;
        }
    }

    /// Converts BGRA→I420 (BT.601 limited-range) then calls libvpx.
    /// Returns zero or more encoded packets per call.
    ///
    /// Consumes any pending [`Self::request_keyframe`]: the flag is cleared
    /// here so one request produces exactly one keyframe.
    pub fn encode(
        &mut self,
        frame_bgra: &[u8],
        timestamp_us: u64,
    ) -> Result<Vec<EncodedPacket>, String> {
        let force = std::mem::take(&mut self.force_keyframe);
        let i420 = bgra_to_i420(frame_bgra, self.src_width, self.src_height)?;
        let mut packets: Vec<EncodedPacket> = Vec::new();

        let result = unsafe {
            ffi::vpx_shim_encode(
                self.ctx,
                i420.as_ptr(),
                self.enc_width,
                self.enc_height,
                timestamp_us as i64,
                c_int::from(force),
                collect_packet,
                &mut packets as *mut Vec<EncodedPacket> as *mut c_void,
            )
        };

        if result != 0 {
            return Err(format!("vpx_shim_encode error code {result}"));
        }
        if packets.iter().any(|p| p.is_keyframe) {
            self.last_keyframe_at = Some(std::time::Instant::now());
        }
        Ok(packets)
    }
}

impl Drop for Vp8Encoder {
    fn drop(&mut self) {
        unsafe { ffi::vpx_shim_destroy(self.ctx) };
    }
}

/// Callback invoked by the C shim for each encoded packet.
unsafe extern "C" fn collect_packet(
    data: *const c_uchar,
    size: usize,
    is_keyframe: c_int,
    user_data: *mut c_void,
) {
    let packets = &mut *(user_data as *mut Vec<EncodedPacket>);
    let bytes = std::slice::from_raw_parts(data, size).to_vec();
    packets.push(EncodedPacket {
        data: bytes,
        is_keyframe: is_keyframe != 0,
    });
}

/// Maximum supported frame dimension on either axis.
///
/// 16384 covers all real consumer monitors (8K is 7680, dual-8K is 15360) and
/// keeps the worst-case I420 allocation at ~600 MB, well below an OOM risk.
/// Anything beyond this is treated as malicious or buggy input.
const MAX_FRAME_DIM: u32 = 16384;

/// Convert packed BGRA to planar I420 (YUV 4:2:0, BT.601 limited-range).
///
/// Odd source axes are cropped down to even: 4:2:0 chroma is subsampled 2x2,
/// so an odd axis would make the last even column/row index one past the
/// chroma plane and panic (the pre-fix behaviour — the panic killed the
/// spawned streaming task silently). The source buffer is still read with the
/// full `width` stride; only the output loses the last row/column.
fn bgra_to_i420(bgra: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || width > MAX_FRAME_DIM || height > MAX_FRAME_DIM {
        return Err(format!(
            "unreasonable frame dimensions {width}x{height} (max {MAX_FRAME_DIM} per axis)"
        ));
    }
    let w = width as usize;
    let h = height as usize;
    let expected = w
        .checked_mul(h)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| format!("dimension overflow at {width}x{height}"))?;
    if bgra.len() < expected {
        return Err(format!(
            "BGRA buffer too small: expected {expected}, got {}",
            bgra.len()
        ));
    }

    let cw = w & !1;
    let ch = h & !1;
    if cw == 0 || ch == 0 {
        return Err(format!(
            "frame dimensions {width}x{height} too small — no even encode size left"
        ));
    }

    let y_size = cw * ch;
    let uv_size = (cw / 2) * (ch / 2);
    let mut i420 = vec![0u8; y_size + 2 * uv_size];

    let (y_plane, uv_planes) = i420.split_at_mut(y_size);
    let (u_plane, v_plane) = uv_planes.split_at_mut(uv_size);

    for row in 0..ch {
        for col in 0..cw {
            let idx = (row * w + col) * 4;
            let b = bgra[idx] as i32;
            let g = bgra[idx + 1] as i32;
            let r = bgra[idx + 2] as i32;

            let y = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
            y_plane[row * cw + col] = y.clamp(0, 255) as u8;

            if row % 2 == 0 && col % 2 == 0 {
                let uv_row = row / 2;
                let uv_col = col / 2;
                let uv_idx = uv_row * (cw / 2) + uv_col;
                let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                u_plane[uv_idx] = u.clamp(0, 255) as u8;
                v_plane[uv_idx] = v.clamp(0, 255) as u8;
            }
        }
    }

    Ok(i420)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoder_new_succeeds() {
        Vp8Encoder::new(640, 360, 1000).expect("encoder creation failed");
    }

    #[test]
    fn encode_solid_color_frame_produces_packets() {
        let mut enc = Vp8Encoder::new(64, 64, 500).expect("encoder");
        let pixel = [0xff_u8, 0x00, 0x00, 0xff];
        let frame: Vec<u8> = pixel.iter().cycle().copied().take(64 * 64 * 4).collect();
        let packets = enc.encode(&frame, 0).expect("encode");
        assert!(!packets.is_empty(), "expected at least one encoded packet");
    }

    #[test]
    fn first_encode_produces_non_empty_packet() {
        let mut enc = Vp8Encoder::new(64, 64, 500).expect("encoder");
        let frame = vec![0x80_u8; 64 * 64 * 4];
        let packets = enc.encode(&frame, 0).expect("encode");
        let first = packets.into_iter().next().expect("at least one packet");
        assert!(
            !first.data.is_empty(),
            "first encoded packet must have non-empty data"
        );
    }

    #[test]
    fn bgra_to_i420_correct_size() {
        let w = 4u32;
        let h = 4u32;
        let bgra = vec![0u8; (w * h * 4) as usize];
        let i420 = bgra_to_i420(&bgra, w, h).expect("conversion");
        let expected = (w * h + 2 * (w / 2) * (h / 2)) as usize;
        assert_eq!(i420.len(), expected);
    }

    #[test]
    fn bgra_to_i420_rejects_zero_dimension() {
        assert!(bgra_to_i420(&[], 0, 1080).is_err());
        assert!(bgra_to_i420(&[], 1920, 0).is_err());
    }

    #[test]
    fn bgra_to_i420_rejects_oversize_dimension() {
        // Anything beyond MAX_FRAME_DIM is treated as malicious/buggy input.
        assert!(bgra_to_i420(&[], MAX_FRAME_DIM + 1, 1080).is_err());
        assert!(bgra_to_i420(&[], 1920, MAX_FRAME_DIM + 1).is_err());
    }

    #[test]
    fn bgra_to_i420_rejects_short_buffer() {
        let result = bgra_to_i420(&[0u8; 3], 4, 4);
        assert!(result.is_err());
    }

    // ── Odd-dimension regression pins (2026-08 review) ──────────────────
    // The chroma planes are (w/2)*(h/2); before the even-crop fix an odd
    // axis made the subsampling loop index one past the plane end and
    // panic inside the spawned streaming task (silently dead stream).

    #[test]
    fn bgra_to_i420_handles_odd_width_without_panicking() {
        // The reported concrete case: w=3,h=2 → 1-byte uv planes, the old
        // code wrote uv_idx=1.
        let bgra = vec![0x80u8; 3 * 2 * 4];
        let i420 = bgra_to_i420(&bgra, 3, 2).expect("odd width must convert");
        // Crops to 2x2: Y=4 + U=1 + V=1.
        assert_eq!(i420.len(), 6);
    }

    #[test]
    fn bgra_to_i420_handles_odd_height_without_panicking() {
        let bgra = vec![0x80u8; 4 * 5 * 4];
        let i420 = bgra_to_i420(&bgra, 4, 5).expect("odd height must convert");
        assert_eq!(i420.len(), 4 * 4 + 2 * (2 * 2));
    }

    #[test]
    fn bgra_to_i420_handles_both_axes_odd() {
        let bgra = vec![0x80u8; 5 * 5 * 4];
        let i420 = bgra_to_i420(&bgra, 5, 5).expect("odd dims must convert");
        assert_eq!(i420.len(), 4 * 4 + 2 * (2 * 2));
    }

    #[test]
    fn bgra_to_i420_odd_width_crop_reads_with_source_stride() {
        // 3x2 frame with per-pixel gray value v = (row*3+col)*10. If the
        // crop wrongly used the cropped width as the source stride, the
        // second output row would sample the wrong source pixels.
        let mut bgra = Vec::new();
        for i in 0..6u8 {
            let v = i * 10;
            bgra.extend_from_slice(&[v, v, v, 0xff]);
        }
        let i420 = bgra_to_i420(&bgra, 3, 2).expect("convert");
        let y = |v: i32| ((((66 + 129 + 25) * v + 128) >> 8) + 16) as u8;
        let expected = [y(0), y(10), y(30), y(40)];
        assert_eq!(&i420[0..4], expected.as_slice());
    }

    #[test]
    fn encoder_handles_odd_monitor_resolution_end_to_end() {
        // Odd monitors exist (VM auto-resize, custom modes). The encoder
        // must crop to even and produce packets instead of panicking.
        let mut enc = Vp8Encoder::new(65, 65, 500).expect("encoder for odd dims");
        let frame = vec![0x80u8; 65 * 65 * 4];
        let packets = enc.encode(&frame, 0).expect("encode odd frame");
        assert!(!packets.is_empty(), "expected packets for odd-dim frame");
    }

    // The bug this guards (2026-08-31, from a user log): the sole keyframe was
    // emitted 234 ms BEFORE the peer connection existed, so it went nowhere.
    // The screen was then static, VP8 scene detection never fired, and the
    // helper saw black for the whole session. Whoever learns a viewer attached
    // must be able to demand a keyframe.
    fn flat_frame(w: u32, h: u32) -> Vec<u8> {
        vec![0x40u8; (w * h * 4) as usize]
    }

    #[test]
    fn a_static_screen_stops_producing_keyframes_on_its_own() {
        // Establishes the premise: without an explicit request there is
        // nothing for a late viewer to decode.
        let mut enc = Vp8Encoder::new(64, 64, 500).expect("encoder");
        let frame = flat_frame(64, 64);
        assert!(
            enc.encode(&frame, 0)
                .expect("first")
                .iter()
                .any(|p| p.is_keyframe),
            "the very first frame is always a keyframe"
        );
        for i in 1..20u64 {
            let packets = enc.encode(&frame, i * 33_000).expect("delta");
            assert!(
                !packets.iter().any(|p| p.is_keyframe),
                "frame {i} on an unchanging picture must not be a keyframe"
            );
        }
    }

    #[test]
    fn request_keyframe_forces_one_on_the_next_frame() {
        let mut enc = Vp8Encoder::new(64, 64, 500).expect("encoder");
        let frame = flat_frame(64, 64);
        enc.encode(&frame, 0).expect("first");
        enc.encode(&frame, 33_000).expect("delta");

        enc.request_keyframe();
        assert!(
            enc.encode(&frame, 66_000)
                .expect("forced")
                .iter()
                .any(|p| p.is_keyframe),
            "a requested keyframe must actually be a keyframe"
        );
    }

    #[test]
    fn one_request_produces_exactly_one_keyframe() {
        let mut enc = Vp8Encoder::new(64, 64, 500).expect("encoder");
        let frame = flat_frame(64, 64);
        enc.encode(&frame, 0).expect("first");

        enc.request_keyframe();
        enc.encode(&frame, 33_000).expect("forced");
        assert!(
            !enc.encode(&frame, 66_000)
                .expect("after")
                .iter()
                .any(|p| p.is_keyframe),
            "the flag must be consumed, not stick for every later frame"
        );
    }

    #[test]
    fn a_throttled_request_is_dropped_right_after_a_keyframe() {
        // A viewer on a lossy link repeats its PLI several times a second.
        // Answering each one sends an order of magnitude more bytes into the
        // congestion that caused the loss.
        let mut enc = Vp8Encoder::new(64, 64, 500).expect("encoder");
        let frame = flat_frame(64, 64);
        enc.encode(&frame, 0).expect("first is a keyframe");

        enc.request_keyframe_throttled();
        assert!(
            !enc.encode(&frame, 33_000)
                .expect("throttled")
                .iter()
                .any(|p| p.is_keyframe),
            "a request within the gap must be dropped"
        );
    }

    #[test]
    fn a_connect_request_is_never_throttled() {
        // The peer connecting is not congestion feedback — that viewer has
        // nothing to decode at all and must be served immediately.
        let mut enc = Vp8Encoder::new(64, 64, 500).expect("encoder");
        let frame = flat_frame(64, 64);
        enc.encode(&frame, 0).expect("first is a keyframe");

        enc.request_keyframe();
        assert!(
            enc.encode(&frame, 33_000)
                .expect("forced")
                .iter()
                .any(|p| p.is_keyframe),
            "an unthrottled request must be honoured even right after a keyframe"
        );
    }

    #[test]
    fn encoder_rejects_one_pixel_axis() {
        // 1 crops to 0 — there is no valid even encode size left.
        assert!(Vp8Encoder::new(1, 64, 500).is_err());
        assert!(Vp8Encoder::new(64, 1, 500).is_err());
    }
}
