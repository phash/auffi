//! RTP timing for the video track: the RTP timestamp must follow the
//! CAPTURE time of each frame, not a fixed per-frame increment.
//!
//! `TrackLocalStaticSample` derives the timestamp increment from a constant
//! `Sample.duration`, and the sharer fed it 33 ms for every frame. WGC and
//! pipewiresrc deliver frames only on change, so on a near-static screen the
//! RTP clock claimed 33 ms between frames that really arrived 300–500 ms
//! apart. Chrome's receive-side bandwidth estimator (the path it takes for
//! our stream — no transport-cc or abs-send-time extension is stamped on the
//! way out) compares arrival gaps with RTP-timestamp gaps and read that
//! persistent mismatch as congestion; since REMB became a hard cap in
//! `bitrate_controller`, a static screen pinned the encoder at the floor and
//! the picture stayed blurry for seconds after motion resumed. The wrong
//! clock also inflated the viewer's jitter estimate and playout delay.
//!
//! So the sharer packetizes itself: [`RtpClock`] turns capture timestamps
//! into 90 kHz tick deltas, [`FramePacketizer`] applies them to a
//! `rtp::Packetizer` and hands the packets to a `TrackLocalStaticRTP`, which
//! rewrites payload type and SSRC per binding.

use bytes::Bytes;
use webrtc::rtp::packet::Packet;
use webrtc::rtp::packetizer::{new_packetizer, Packetizer, Payloader};
use webrtc::rtp::sequence::new_random_sequencer;

/// RTP clock rate for video (RFC 7741 §4 for VP8; universal for video).
pub const VIDEO_CLOCK_RATE: u32 = 90_000;

/// Longest gap the clock advances by in one step. A capture that stalled
/// (or a frozen laptop coming back from suspend) must not jump the RTP
/// clock by minutes — the receiver's inter-arrival filter resets on jumps
/// of that size and the stream restarts from scratch.
const MAX_GAP_US: u64 = 2_000_000;

/// Step used when a frame's pts is not after the previous one — a fresh
/// capturer after a monitor switch restarts its pts at zero. Two frames with
/// the same timestamp would be one frame to the decoder, so the clock moves
/// by a nominal 30 fps frame instead.
pub const NOMINAL_FRAME_TICKS: u32 = 2_970;

/// Same MTU `TrackLocalStaticSample` used (`webrtc::track::RTP_OUTBOUND_MTU`,
/// which is crate-private there).
const RTP_OUTBOUND_MTU: usize = 1200;

/// Placeholder payload type / SSRC. `TrackLocalStaticRTP` overwrites both per
/// binding with the negotiated values, so what is set here never reaches the
/// wire.
const UNBOUND_PAYLOAD_TYPE: u8 = 96;
const UNBOUND_SSRC: u32 = 0;

/// Converts capture timestamps (µs) into 90 kHz RTP tick deltas.
#[derive(Debug, Default)]
pub struct RtpClock {
    last_pts_us: Option<u64>,
}

impl RtpClock {
    /// Ticks to advance the RTP timestamp by for a frame captured at
    /// `pts_us`. Zero for the very first frame; otherwise strictly positive.
    pub fn advance(&mut self, pts_us: u64) -> u32 {
        let ticks = match self.last_pts_us {
            None => 0,
            Some(prev) if pts_us > prev => {
                let gap_us = (pts_us - prev).min(MAX_GAP_US);
                // ≤ 180_000 for a 2 s gap, so the cast cannot truncate.
                (gap_us * u64::from(VIDEO_CLOCK_RATE) / 1_000_000).max(1) as u32
            }
            Some(_) => NOMINAL_FRAME_TICKS,
        };
        self.last_pts_us = Some(pts_us);
        ticks
    }
}

/// Owns the RTP packetizer for the video track and stamps every frame with
/// its capture time.
pub struct FramePacketizer {
    clock: RtpClock,
    packetizer: Box<dyn Packetizer + Send + Sync>,
}

impl FramePacketizer {
    pub fn new(payloader: Box<dyn Payloader + Send + Sync>) -> Self {
        Self {
            clock: RtpClock::default(),
            packetizer: Box::new(new_packetizer(
                RTP_OUTBOUND_MTU,
                UNBOUND_PAYLOAD_TYPE,
                UNBOUND_SSRC,
                payloader,
                Box::new(new_random_sequencer()),
                VIDEO_CLOCK_RATE,
            )),
        }
    }

    /// Split one encoded frame captured at `pts_us` into RTP packets whose
    /// timestamp reflects that capture time.
    pub fn packetize(&mut self, pts_us: u64, frame: Vec<u8>) -> Result<Vec<Packet>, webrtc::rtp::Error> {
        // `packetize` stamps the CURRENT timestamp and then adds `samples`
        // for the next call; advancing first and passing 0 puts the whole
        // delta on this frame instead of the next one.
        self.packetizer.skip_samples(self.clock.advance(pts_us));
        self.packetizer.packetize(&Bytes::from(frame), 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_follow_capture_time() {
        let mut c = RtpClock::default();
        assert_eq!(c.advance(0), 0, "the first frame anchors the clock");
        assert_eq!(c.advance(33_000), 2_970);
        assert_eq!(c.advance(533_000), 45_000);
    }

    #[test]
    fn a_stalled_capture_is_clamped() {
        let mut c = RtpClock::default();
        c.advance(0);
        assert_eq!(
            c.advance(60_000_000),
            180_000,
            "2 s cap keeps the clock monotonic without overshoot"
        );
    }

    #[test]
    fn pts_going_backwards_still_advances_by_a_nominal_frame() {
        // A monitor switch installs a fresh capturer whose pts restarts at 0.
        // Two frames with the same RTP timestamp would be one frame to the
        // decoder, so the clock steps by a nominal frame instead of stalling.
        let mut c = RtpClock::default();
        c.advance(5_000_000);
        assert_eq!(c.advance(1_000), NOMINAL_FRAME_TICKS);
        assert_eq!(c.advance(34_000), 2_970, "and continues from the new base");
    }

    #[test]
    fn frame_packetizer_stamps_capture_time_and_contiguous_sequence_numbers() {
        let mut fp =
            FramePacketizer::new(Box::new(webrtc::rtp::codecs::vp8::Vp8Payloader::default()));
        let mut all = Vec::new();
        for pts in [0u64, 33_000, 533_000] {
            all.extend(fp.packetize(pts, vec![0x10]).expect("packetize"));
        }
        assert_eq!(all.len(), 3);
        let ts: Vec<u32> = all.iter().map(|p| p.header.timestamp).collect();
        assert_eq!(ts[1].wrapping_sub(ts[0]), 2_970);
        assert_eq!(ts[2].wrapping_sub(ts[1]), 45_000);
        let seq: Vec<u16> = all.iter().map(|p| p.header.sequence_number).collect();
        assert_eq!(seq[1].wrapping_sub(seq[0]), 1);
        assert_eq!(seq[2].wrapping_sub(seq[1]), 1);
    }
}
