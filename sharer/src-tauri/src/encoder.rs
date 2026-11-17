use std::ffi::c_void;
use std::os::raw::{c_int, c_uchar};
use std::sync::OnceLock;

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

        pub fn vpx_shim_set_bitrate(ctx: *mut c_void, bitrate_kbps: c_uint) -> c_int;

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
    /// Target bitrate currently configured in libvpx, so a repeated request
    /// for the same rate does not reconfigure the codec.
    bitrate_kbps: u32,
    /// I420 conversion buffer, reused across frames.
    i420: Vec<u8>,
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
            bitrate_kbps,
            i420: Vec::new(),
        })
    }

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

    /// The bitrate libvpx is currently targeting, in kbps.
    ///
    /// Test-only: production reads the target from `SessionMetrics` and lets
    /// [`Self::set_bitrate_kbps`] decide whether anything changed.
    #[cfg(test)]
    pub fn bitrate_kbps(&self) -> u32 {
        self.bitrate_kbps
    }

    /// Retarget the encoder without restarting it.
    ///
    /// Congestion control adjusts this while streaming (gh #120). Reconfiguring
    /// keeps the reference chain, so it costs no keyframe — which is the point,
    /// since the rate drops precisely when there is no room for one.
    pub fn set_bitrate_kbps(&mut self, bitrate_kbps: u32) -> Result<(), String> {
        if bitrate_kbps == self.bitrate_kbps {
            return Ok(());
        }
        let rc = unsafe { ffi::vpx_shim_set_bitrate(self.ctx, bitrate_kbps) };
        if rc != 0 {
            return Err(format!("vpx_shim_set_bitrate error code {rc}"));
        }
        self.bitrate_kbps = bitrate_kbps;
        Ok(())
    }

    /// Encode one BGRA frame.
    ///
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
        bgra_to_i420_into(frame_bgra, self.src_width, self.src_height, &mut self.i420)?;
        let i420 = &self.i420;
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
    // from_raw_parts on null is UB even for size 0; an empty packet carries
    // nothing the track could use anyway.
    if data.is_null() || size == 0 {
        return;
    }
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
///
/// Chroma is the rounded average of each 2x2 block, as libyuv does; sampling
/// only the top-left pixel dropped the colour of one-pixel strokes. `out` is
/// reused across frames, and the frame is split into row bands converted in
/// parallel: at 1080p the single-threaded loop took ~7 ms, half of the whole
/// encode budget of a 60 fps frame.
fn bgra_to_i420_into(
    bgra: &[u8],
    width: u32,
    height: u32,
    out: &mut Vec<u8>,
) -> Result<(), String> {
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
    out.resize(y_size + 2 * uv_size, 0);
    let (y_plane, uv_planes) = out.split_at_mut(y_size);
    let (u_plane, v_plane) = uv_planes.split_at_mut(uv_size);

    let pairs = ch / 2;
    let pairs_per_band = pairs.div_ceil(conversion_threads().min(pairs));
    std::thread::scope(|scope| {
        let bands = y_plane
            .chunks_mut(pairs_per_band * 2 * cw)
            .zip(u_plane.chunks_mut(pairs_per_band * cw / 2))
            .zip(v_plane.chunks_mut(pairs_per_band * cw / 2));
        for (band, ((y_band, u_band), v_band)) in bands.enumerate() {
            let first_row = band * pairs_per_band * 2;
            scope.spawn(move || convert_band(bgra, w, cw, first_row, y_band, u_band, v_band));
        }
    });
    Ok(())
}

/// Threads for [`bgra_to_i420_into`]; libvpx runs its own on the same cores.
fn conversion_threads() -> usize {
    static THREADS: OnceLock<usize> = OnceLock::new();
    *THREADS.get_or_init(|| {
        std::thread::available_parallelism()
            .map_or(1, std::num::NonZeroUsize::get)
            .min(4)
    })
}

/// Convert the row pairs starting at source row `first_row` into the given
/// slices of the Y, U and V planes. All outputs stay within 16..=240 (235 for
/// Y) for any input, so the narrowing casts cannot wrap.
fn convert_band(
    bgra: &[u8],
    stride_px: usize,
    cw: usize,
    first_row: usize,
    y_band: &mut [u8],
    u_band: &mut [u8],
    v_band: &mut [u8],
) {
    let luma = |b: i32, g: i32, r: i32| (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16) as u8;
    let rows = y_band
        .chunks_exact_mut(2 * cw)
        .zip(u_band.chunks_exact_mut(cw / 2))
        .zip(v_band.chunks_exact_mut(cw / 2));
    for (pair, ((y_rows, u_row), v_row)) in rows.enumerate() {
        let top_start = (first_row + 2 * pair) * stride_px * 4;
        let bottom_start = top_start + stride_px * 4;
        let top = &bgra[top_start..top_start + cw * 4];
        let bottom = &bgra[bottom_start..bottom_start + cw * 4];
        let (y_top, y_bottom) = y_rows.split_at_mut(cw);
        let blocks = top
            .as_chunks::<8>()
            .0
            .iter()
            .zip(bottom.as_chunks::<8>().0)
            .zip(
                y_top
                    .as_chunks_mut::<2>()
                    .0
                    .iter_mut()
                    .zip(y_bottom.as_chunks_mut::<2>().0),
            )
            .zip(u_row.iter_mut().zip(v_row.iter_mut()));
        for (((t, b), (yt, yb)), (u, v)) in blocks {
            let px = [
                (i32::from(t[0]), i32::from(t[1]), i32::from(t[2])),
                (i32::from(t[4]), i32::from(t[5]), i32::from(t[6])),
                (i32::from(b[0]), i32::from(b[1]), i32::from(b[2])),
                (i32::from(b[4]), i32::from(b[5]), i32::from(b[6])),
            ];
            yt[0] = luma(px[0].0, px[0].1, px[0].2);
            yt[1] = luma(px[1].0, px[1].1, px[1].2);
            yb[0] = luma(px[2].0, px[2].1, px[2].2);
            yb[1] = luma(px[3].0, px[3].1, px[3].2);
            let bb = (px[0].0 + px[1].0 + px[2].0 + px[3].0 + 2) >> 2;
            let gg = (px[0].1 + px[1].1 + px[2].1 + px[3].1 + 2) >> 2;
            let rr = (px[0].2 + px[1].2 + px[2].2 + px[3].2 + 2) >> 2;
            *u = (((-38 * rr - 74 * gg + 112 * bb + 128) >> 8) + 128) as u8;
            *v = (((112 * rr - 94 * gg - 18 * bb + 128) >> 8) + 128) as u8;
        }
    }
}

#[cfg(test)]
fn bgra_to_i420(bgra: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    bgra_to_i420_into(bgra, width, height, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Per-frame cost of the encode path on screen-like content (a page of
    /// "text" scrolling 8 rows per frame). Not a pass/fail test: run it in
    /// release on the target hardware to see how far 60 fps is away.
    ///   cargo test --release --lib bench_encode_path -- --ignored --nocapture
    #[test]
    #[ignore = "benchmark; run in release with --nocapture"]
    fn bench_encode_path() {
        for (w, h) in [(1920u32, 1080u32), (2560, 1440)] {
            let page_h = h as usize * 3;
            let mut page = vec![0u8; w as usize * page_h * 4];
            for y in 0..page_h {
                for x in 0..w as usize {
                    let glyph =
                        ((x / 7) * 31 + (y / 12) * 17) % 5 == 0 && (y % 12) < 9 && (x % 7) < 5;
                    let v = if glyph {
                        30
                    } else {
                        235 - (x * 20 / w as usize) as u8
                    };
                    let i = (y * w as usize + x) * 4;
                    page[i..i + 4].copy_from_slice(&[v, v, v.saturating_sub(10), 255]);
                }
            }
            let frame_len = w as usize * h as usize * 4;
            let frames = 120usize;
            let mut enc = Vp8Encoder::new(w, h, crate::bitrate_controller::MAX_BITRATE_KBPS)
                .expect("encoder");
            let (mut conv, mut total) = (std::time::Duration::ZERO, std::time::Duration::ZERO);
            for n in 0..frames {
                let off = ((n * 8) % (page_h - h as usize)) * w as usize * 4;
                let frame = &page[off..off + frame_len];
                let t0 = std::time::Instant::now();
                let _ = std::hint::black_box(bgra_to_i420(frame, w, h).expect("convert"));
                conv += t0.elapsed();
                let t1 = std::time::Instant::now();
                enc.encode(frame, (n as u64) * 16_667).expect("encode");
                total += t1.elapsed();
            }
            let ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0 / frames as f64;
            println!(
                "{w}x{h}: bgra_to_i420 {:.2} ms/frame, encode (incl. conversion) {:.2} ms/frame -> max {:.0} fps",
                ms(conv),
                ms(total),
                1000.0 / ms(total)
            );
        }
    }

    // `slice::from_raw_parts` on a null pointer is UB even for size 0, and
    // the shim forwards whatever libvpx hands it.
    #[test]
    fn collect_packet_ignores_a_null_or_empty_packet() {
        let mut packets: Vec<EncodedPacket> = Vec::new();
        let user = &mut packets as *mut Vec<EncodedPacket> as *mut c_void;
        let byte = 7u8;
        unsafe {
            collect_packet(std::ptr::null(), 0, 1, user);
            collect_packet(std::ptr::null(), 16, 1, user);
            collect_packet(&byte, 0, 1, user);
        }
        assert!(packets.is_empty());
        unsafe { collect_packet(&byte, 1, 1, user) };
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0].data, vec![7]);
    }

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

    // Chroma is subsampled 2x2. Sampling only the top-left pixel turns a
    // one-pixel coloured glyph stroke on odd columns into no colour at all;
    // averaging the block (what libyuv does) keeps it.
    #[test]
    fn bgra_to_i420_chroma_is_the_average_of_the_2x2_block() {
        // 2x2: red, green / blue, white (BGRA byte order).
        let bgra = [
            0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255,
        ];
        let i420 = bgra_to_i420(&bgra, 2, 2).expect("convert");
        let (r, g, b) = (
            (255 + 255) / 4 + 1,
            (255 + 255 + 2) / 4,
            (255 + 255 + 2) / 4,
        );
        let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
        let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
        assert_eq!(&i420[4..6], &[u as u8, v as u8]);
    }

    /// Straightforward per-pixel reference the fast path must match exactly.
    fn reference_i420(bgra: &[u8], w: usize, h: usize) -> Vec<u8> {
        let (cw, ch) = (w & !1, h & !1);
        let mut y_p = vec![0u8; cw * ch];
        let mut u_p = vec![0u8; cw * ch / 4];
        let mut v_p = vec![0u8; cw * ch / 4];
        let px = |r: usize, c: usize| {
            let i = (r * w + c) * 4;
            (
                i32::from(bgra[i + 2]),
                i32::from(bgra[i + 1]),
                i32::from(bgra[i]),
            )
        };
        for r in 0..ch {
            for c in 0..cw {
                let (rr, gg, bb) = px(r, c);
                y_p[r * cw + c] = (((66 * rr + 129 * gg + 25 * bb + 128) >> 8) + 16) as u8;
            }
        }
        for r in (0..ch).step_by(2) {
            for c in (0..cw).step_by(2) {
                let ps = [px(r, c), px(r, c + 1), px(r + 1, c), px(r + 1, c + 1)];
                let avg = |f: fn(&(i32, i32, i32)) -> i32| (ps.iter().map(f).sum::<i32>() + 2) >> 2;
                let (rr, gg, bb) = (avg(|p| p.0), avg(|p| p.1), avg(|p| p.2));
                let i = (r / 2) * (cw / 2) + c / 2;
                u_p[i] = (((-38 * rr - 74 * gg + 112 * bb + 128) >> 8) + 128) as u8;
                v_p[i] = (((112 * rr - 94 * gg - 18 * bb + 128) >> 8) + 128) as u8;
            }
        }
        [y_p, u_p, v_p].concat()
    }

    // The fast path splits the frame into row bands converted in parallel; a
    // band boundary must not shift or skip a row. Odd sizes on purpose.
    #[test]
    fn bgra_to_i420_matches_the_per_pixel_reference_on_a_large_odd_frame() {
        let (w, h) = (643usize, 481usize);
        let bgra: Vec<u8> = (0..w * h * 4).map(|i| (i * 7919 % 251) as u8).collect();
        let fast = bgra_to_i420(&bgra, w as u32, h as u32).expect("convert");
        assert_eq!(fast, reference_i420(&bgra, w, h));
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

    /// A frame with enough detail that the encoder's output actually tracks
    /// the target bitrate — a flat surface compresses to almost nothing at any
    /// setting and would make a rate test meaningless.
    fn noisy_frame(w: u32, h: u32, seed: u32) -> Vec<u8> {
        let mut v = vec![0u8; (w * h * 4) as usize];
        let mut x = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
        for b in v.iter_mut() {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            *b = (x >> 24) as u8;
        }
        v
    }

    #[test]
    fn a_new_encoder_reports_the_bitrate_it_was_built_with() {
        assert_eq!(
            Vp8Encoder::new(64, 64, 750)
                .expect("encoder")
                .bitrate_kbps(),
            750
        );
    }

    #[test]
    fn set_bitrate_is_accepted_by_libvpx_mid_stream() {
        let mut enc = Vp8Encoder::new(320, 240, 2000).expect("encoder");
        enc.encode(&noisy_frame(320, 240, 1), 0).expect("first");
        enc.set_bitrate_kbps(400)
            .expect("libvpx must accept a mid-stream retarget");
        assert_eq!(enc.bitrate_kbps(), 400);
        // Still encodes afterwards — a rejected config would break the codec.
        enc.encode(&noisy_frame(320, 240, 2), 33_000)
            .expect("after retarget");
    }

    #[test]
    fn retargeting_does_not_cost_a_keyframe() {
        // Congestion control lowers the rate exactly when there is no spare
        // bandwidth; if the change itself forced a keyframe it would make the
        // congestion worse than doing nothing.
        let mut enc = Vp8Encoder::new(320, 240, 2000).expect("encoder");
        let frame = noisy_frame(320, 240, 7);
        enc.encode(&frame, 0).expect("first");
        enc.set_bitrate_kbps(300).expect("retarget");
        let packets = enc.encode(&frame, 33_000).expect("next");
        assert!(
            !packets.iter().any(|p| p.is_keyframe),
            "a bitrate change must not reset the reference chain"
        );
    }

    #[test]
    fn a_lower_bitrate_actually_produces_fewer_bytes() {
        // Proves the setting reaches libvpx's rate control rather than just
        // being recorded in our own field.
        fn bytes_at(kbps: u32) -> usize {
            let mut enc = Vp8Encoder::new(320, 240, kbps).expect("encoder");
            let mut total = 0usize;
            // Skip the keyframe: its size is dominated by the intra coding.
            enc.encode(&noisy_frame(320, 240, 0), 0).expect("first");
            for i in 1..30u64 {
                for p in enc
                    .encode(&noisy_frame(320, 240, i as u32), i * 33_000)
                    .expect("frame")
                {
                    total += p.data.len();
                }
            }
            total
        }
        let high = bytes_at(2000);
        let low = bytes_at(200);
        assert!(
            low < high,
            "200 kbps produced {low} bytes, 2000 kbps {high}"
        );
    }

    #[test]
    fn setting_the_same_bitrate_twice_is_a_no_op() {
        let mut enc = Vp8Encoder::new(64, 64, 500).expect("encoder");
        enc.set_bitrate_kbps(500).expect("same value");
        assert_eq!(enc.bitrate_kbps(), 500);
    }
}
