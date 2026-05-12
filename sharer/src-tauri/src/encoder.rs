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
            cb: vpx_shim_packet_cb,
            user_data: *mut c_void,
        ) -> c_int;
    }
}

/// A VP8 encoder wrapping libvpx via a thin C shim.
pub struct Vp8Encoder {
    ctx: *mut c_void,
    width: u32,
    height: u32,
}

/// Safety: The libvpx context is not shared; we move `Vp8Encoder` between threads only
/// when the caller guarantees exclusive access.
unsafe impl Send for Vp8Encoder {}

pub struct EncodedPacket {
    pub data: Vec<u8>,
}

impl Vp8Encoder {
    /// Create a new VP8 encoder.
    ///
    /// `bitrate_kbps` is the target bitrate in kilobits per second.
    pub fn new(width: u32, height: u32, bitrate_kbps: u32) -> Result<Self, String> {
        let ctx = unsafe { ffi::vpx_shim_create(width, height, bitrate_kbps) };
        if ctx.is_null() {
            return Err("vpx_shim_create failed".to_string());
        }
        Ok(Self { ctx, width, height })
    }

    /// Encode one BGRA frame.
    ///
    /// Converts BGRA→I420 (BT.601 limited-range) then calls libvpx.
    /// Returns zero or more encoded packets per call.
    pub fn encode(
        &mut self,
        frame_bgra: &[u8],
        timestamp_us: u64,
    ) -> Result<Vec<EncodedPacket>, String> {
        let i420 = bgra_to_i420(frame_bgra, self.width, self.height)?;
        let mut packets: Vec<EncodedPacket> = Vec::new();

        let result = unsafe {
            ffi::vpx_shim_encode(
                self.ctx,
                i420.as_ptr(),
                self.width,
                self.height,
                timestamp_us as i64,
                collect_packet,
                &mut packets as *mut Vec<EncodedPacket> as *mut c_void,
            )
        };

        if result != 0 {
            return Err(format!("vpx_shim_encode error code {result}"));
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
    let _ = is_keyframe; // consumed by libvpx RTP packetizer; not needed by caller
    packets.push(EncodedPacket { data: bytes });
}

/// Maximum supported frame dimension on either axis.
///
/// 16384 covers all real consumer monitors (8K is 7680, dual-8K is 15360) and
/// keeps the worst-case I420 allocation at ~600 MB, well below an OOM risk.
/// Anything beyond this is treated as malicious or buggy input.
const MAX_FRAME_DIM: u32 = 16384;

/// Convert packed BGRA to planar I420 (YUV 4:2:0, BT.601 limited-range).
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

    let y_size = w * h;
    let uv_size = (w / 2) * (h / 2);
    let mut i420 = vec![0u8; y_size + 2 * uv_size];

    let (y_plane, uv_planes) = i420.split_at_mut(y_size);
    let (u_plane, v_plane) = uv_planes.split_at_mut(uv_size);

    for row in 0..h {
        for col in 0..w {
            let idx = (row * w + col) * 4;
            let b = bgra[idx] as i32;
            let g = bgra[idx + 1] as i32;
            let r = bgra[idx + 2] as i32;

            let y = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
            y_plane[row * w + col] = y.clamp(0, 255) as u8;

            if row % 2 == 0 && col % 2 == 0 {
                let uv_row = row / 2;
                let uv_col = col / 2;
                let uv_idx = uv_row * (w / 2) + uv_col;
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
}
