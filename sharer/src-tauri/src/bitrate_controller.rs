//! Sender-side congestion control for the video encoder.
//!
//! The encoder used to be built with a fixed 2000 kbps target that was never
//! touched again, so the sharer pushed 2 Mbps into the link no matter what it
//! could carry (gh #120). On a weak uplink — mobile hotspot, thin DSL upload,
//! busy Wi-Fi — that is permanent loss the session never recovers from,
//! because nothing throttles.
//!
//! The signal is the receiver's own loss report. Every RTP receiver sends
//! Receiver Reports (RFC 3550 §6.4.2) carrying `fraction_lost`, regardless of
//! whether `goog-remb` or `transport-cc` was negotiated, which makes it the
//! one estimate that is always available. REMB, when the viewer sends it, is
//! applied on top as a hard ceiling.
//!
//! Transport-CC is deliberately NOT used: its feedback is only meaningful with
//! a full delay-based estimator (arrival-time filter plus trendline), which is
//! its own project. Loss-based control alone is what libwebrtc shipped for
//! years and it addresses the failure in #120 — a sender that never yields.
//!
//! The rules are the loss-based controller from the GCC draft
//! (draft-ietf-rmcat-gcc-02 §5.1), which is deliberately asymmetric: increases
//! are small and multiplicative, decreases are proportional to the loss just
//! measured, and the band in between holds steady so normal jitter does not
//! make the rate oscillate.
//!
//! Control runs in BOTH directions. Down-only was the cheaper option, but it
//! means one transient blip degrades the session permanently — worse for the
//! user than not adapting at all, since the rate can only ever ratchet down.
//!
//! Known limit, by construction: a loss-based controller settles INSIDE the
//! tolerance band rather than at the link's true capacity. Simulated against a
//! 600 kbps bottleneck it converges from 2000 to ~640 kbps within five reports
//! and then holds — about 7 % above capacity, i.e. a standing few percent of
//! loss. That is the equilibrium the rules define: below 2 % loss it climbs,
//! above 10 % it cuts, and in between it deliberately does nothing. Removing
//! that standing loss needs the delay-based estimator (transport-cc), which is
//! what libwebrtc added on top for exactly this reason. Compared to the
//! previous behaviour — 2000 kbps into a 600 kbps link, ~70 % loss, forever —
//! it is the difference between a broken session and a slightly lossy one.
//!
//! Pure: no clock, no libvpx, no webrtc types. The caller feeds it reports as
//! they arrive and applies the returned rate.

/// Never go below this. Under roughly 150 kbps VP8 at desktop resolution is
/// too smeared to read text, which is what a support session is *for* — a
/// still-legible slideshow beats a smooth blur.
pub const MIN_BITRATE_KBPS: u32 = 150;

/// Never go above this. Screen content at 2.5 Mbps is already visually clean;
/// higher just buys loss on links that turn out to be worse than they looked.
pub const MAX_BITRATE_KBPS: u32 = 2500;

/// Where a session starts, unchanged from the old fixed value so a good link
/// behaves exactly as it did before.
pub const START_BITRATE_KBPS: u32 = 2000;

/// Below this loss the link is considered healthy and the rate may grow.
const LOSS_INCREASE_BELOW: f64 = 0.02;

/// Above this loss the rate is cut proportionally.
const LOSS_DECREASE_ABOVE: f64 = 0.10;

/// Growth per healthy report. 8 % is the GCC value: at roughly one report per
/// second it takes ~20 s to double, slow enough that the probe itself does not
/// cause the congestion it is testing for.
const INCREASE_FACTOR: f64 = 1.08;

/// `fraction_lost` is 8-bit fixed point: 256 would be 100 % loss.
const FRACTION_LOST_SCALE: f64 = 256.0;

/// Tracks the send rate and adjusts it from receiver feedback.
pub struct BitrateController {
    current_kbps: u32,
    /// Latest REMB ceiling, if the viewer sends REMB at all.
    remb_cap_kbps: Option<u32>,
}

impl BitrateController {
    /// Start at `start_kbps`, clamped into the supported range.
    pub fn new(start_kbps: u32) -> Self {
        Self {
            current_kbps: start_kbps.clamp(MIN_BITRATE_KBPS, MAX_BITRATE_KBPS),
            remb_cap_kbps: None,
        }
    }

    /// Test-only: lets tests observe the rate without reaching into the field.
    #[cfg(test)]
    pub fn current_kbps(&self) -> u32 {
        self.current_kbps
    }

    /// Feed one Receiver Report's `fraction_lost`.
    ///
    /// Returns the new rate if it changed, so the caller only reconfigures the
    /// encoder when there is something to apply.
    pub fn on_receiver_report(&mut self, fraction_lost: u8) -> Option<u32> {
        let loss = f64::from(fraction_lost) / FRACTION_LOST_SCALE;
        let target = if loss < LOSS_INCREASE_BELOW {
            f64::from(self.current_kbps) * INCREASE_FACTOR
        } else if loss > LOSS_DECREASE_ABOVE {
            // Give back proportionally to what was actually lost: at 20 % loss
            // this cuts a tenth, at 100 % it halves. Cutting harder than the
            // measured loss overshoots and the rate takes minutes to recover.
            f64::from(self.current_kbps) * (1.0 - 0.5 * loss)
        } else {
            f64::from(self.current_kbps)
        };
        self.apply(target)
    }

    /// Feed a REMB estimate in bits per second.
    ///
    /// REMB is the receiver naming a number outright, so it wins over the
    /// loss-based estimate whenever it is lower.
    pub fn on_remb(&mut self, bitrate_bps: f32) -> Option<u32> {
        if !bitrate_bps.is_finite() || bitrate_bps <= 0.0 {
            return None;
        }
        let kbps = (f64::from(bitrate_bps) / 1000.0).round();
        // Saturating: a bogus huge REMB must not wrap the cast.
        self.remb_cap_kbps = Some(kbps.clamp(0.0, f64::from(u32::MAX)) as u32);
        self.apply(f64::from(self.current_kbps))
    }

    /// Clamp `target` into range, apply any REMB ceiling, and store it.
    fn apply(&mut self, target: f64) -> Option<u32> {
        let mut next =
            target.clamp(f64::from(MIN_BITRATE_KBPS), f64::from(MAX_BITRATE_KBPS)) as u32;
        if let Some(cap) = self.remb_cap_kbps {
            // The floor still wins: below MIN_BITRATE_KBPS the picture is
            // useless, so a tiny REMB is treated as "as low as we go".
            next = next.min(cap).max(MIN_BITRATE_KBPS);
        }
        if next == self.current_kbps {
            return None;
        }
        self.current_kbps = next;
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 8-bit fixed point, so 2 % loss is 0.02 * 256.
    fn loss(percent: f64) -> u8 {
        (percent / 100.0 * FRACTION_LOST_SCALE).round() as u8
    }

    #[test]
    fn starts_at_the_requested_rate() {
        assert_eq!(BitrateController::new(1200).current_kbps(), 1200);
    }

    #[test]
    fn a_start_outside_the_range_is_clamped() {
        assert_eq!(BitrateController::new(10).current_kbps(), MIN_BITRATE_KBPS);
        assert_eq!(
            BitrateController::new(999_999).current_kbps(),
            MAX_BITRATE_KBPS
        );
    }

    #[test]
    fn a_clean_link_ramps_up() {
        let mut c = BitrateController::new(1000);
        assert_eq!(c.on_receiver_report(loss(0.0)), Some(1080));
        assert_eq!(c.on_receiver_report(loss(0.0)), Some(1166));
    }

    #[test]
    fn the_ramp_stops_at_the_ceiling() {
        // Deliberately asserts the literal rather than MAX_BITRATE_KBPS: a
        // test that starts from the constant it is checking just moves with
        // it, and a raised ceiling would slip through.
        let mut c = BitrateController::new(2000);
        for _ in 0..100 {
            c.on_receiver_report(loss(0.0));
        }
        assert_eq!(c.current_kbps(), 2500);
        // At the top there is nothing left to report.
        assert_eq!(c.on_receiver_report(loss(0.0)), None);
    }

    #[test]
    fn the_floor_is_where_it_says_it_is() {
        // Same reasoning as the ceiling: pin the literal.
        let mut c = BitrateController::new(2000);
        for _ in 0..100 {
            c.on_receiver_report(loss(100.0));
        }
        assert_eq!(c.current_kbps(), 150);
    }

    #[test]
    fn moderate_loss_holds_the_rate() {
        // Between 2 % and 10 % is the band where the controller does nothing —
        // some loss is normal and reacting to it would oscillate.
        for pct in [2.5, 5.0, 9.0] {
            let mut c = BitrateController::new(1000);
            assert_eq!(c.on_receiver_report(loss(pct)), None, "at {pct} % loss");
            assert_eq!(c.current_kbps(), 1000);
        }
    }

    #[test]
    fn heavy_loss_cuts_proportionally() {
        let mut c = BitrateController::new(1000);
        // 20 % loss → factor 1 - 0.5*0.2 = 0.9
        let next = c.on_receiver_report(loss(20.0)).expect("must cut");
        assert!((890..=910).contains(&next), "expected ~900, got {next}");
    }

    #[test]
    fn worse_loss_cuts_harder() {
        let mut mild = BitrateController::new(1000);
        let mut severe = BitrateController::new(1000);
        mild.on_receiver_report(loss(15.0));
        severe.on_receiver_report(loss(50.0));
        assert!(
            severe.current_kbps() < mild.current_kbps(),
            "50 % loss must cut below 15 % loss ({} vs {})",
            severe.current_kbps(),
            mild.current_kbps()
        );
    }

    #[test]
    fn the_cut_stops_at_the_floor() {
        let mut c = BitrateController::new(MIN_BITRATE_KBPS);
        assert_eq!(c.on_receiver_report(loss(100.0)), None);
        assert_eq!(c.current_kbps(), MIN_BITRATE_KBPS);
    }

    #[test]
    fn a_link_that_recovers_climbs_back() {
        // The whole point of controlling in both directions: one bad patch
        // must not pin the session low for the rest of its life.
        let mut c = BitrateController::new(2000);
        for _ in 0..5 {
            c.on_receiver_report(loss(30.0));
        }
        let bottom = c.current_kbps();
        assert!(bottom < 2000, "should have backed off, got {bottom}");
        for _ in 0..20 {
            c.on_receiver_report(loss(0.0));
        }
        assert!(
            c.current_kbps() > bottom,
            "should have recovered above {bottom}, got {}",
            c.current_kbps()
        );
    }

    #[test]
    fn remb_caps_the_rate() {
        let mut c = BitrateController::new(2000);
        assert_eq!(c.on_remb(800_000.0), Some(800));
        // The loss-based side cannot climb past the cap either.
        for _ in 0..10 {
            c.on_receiver_report(loss(0.0));
        }
        assert_eq!(c.current_kbps(), 800);
    }

    #[test]
    fn a_lifted_remb_cap_allows_climbing_again() {
        let mut c = BitrateController::new(2000);
        c.on_remb(500_000.0);
        assert_eq!(c.current_kbps(), 500);
        c.on_remb(2_000_000.0);
        c.on_receiver_report(loss(0.0));
        assert!(
            c.current_kbps() > 500,
            "cap lifted, should climb, got {}",
            c.current_kbps()
        );
    }

    #[test]
    fn remb_never_forces_below_the_floor() {
        let mut c = BitrateController::new(2000);
        c.on_remb(1000.0); // 1 kbps
        assert_eq!(c.current_kbps(), MIN_BITRATE_KBPS);
    }

    #[test]
    fn a_nonsense_remb_is_ignored() {
        let mut c = BitrateController::new(1000);
        assert_eq!(c.on_remb(0.0), None);
        assert_eq!(c.on_remb(-5.0), None);
        assert_eq!(c.on_remb(f32::NAN), None);
        assert_eq!(c.on_remb(f32::INFINITY), None);
        assert_eq!(c.current_kbps(), 1000);
    }

    #[test]
    fn an_absurd_remb_does_not_wrap() {
        // f32::MAX / 1000 overflows u32; a saturating cast is the difference
        // between a ceiling of 2500 and a ceiling of nearly zero.
        let mut c = BitrateController::new(1000);
        c.on_remb(f32::MAX);
        c.on_receiver_report(loss(0.0));
        assert_eq!(c.current_kbps(), 1080);
    }

    #[test]
    fn no_change_reports_nothing() {
        let mut c = BitrateController::new(1000);
        assert_eq!(c.on_receiver_report(loss(5.0)), None);
    }

    /// A bottleneck link: everything above `capacity_kbps` is dropped, which is
    /// what the receiver then reports as loss.
    ///
    /// Closed-loop simulation, because the risk in a controller is never a
    /// single step — it is what the steps do to each other. gh #120 calls this
    /// out directly: component tests say little about a feedback loop.
    fn simulate(capacity_kbps: u32, seconds: usize, c: &mut BitrateController) -> Vec<u32> {
        let mut trace = Vec::with_capacity(seconds);
        for _ in 0..seconds {
            let rate = c.current_kbps();
            let lost = if rate > capacity_kbps {
                f64::from(rate - capacity_kbps) / f64::from(rate)
            } else {
                0.0
            };
            c.on_receiver_report((lost * FRACTION_LOST_SCALE).round().min(255.0) as u8);
            trace.push(c.current_kbps());
        }
        trace
    }

    #[test]
    fn it_converges_onto_a_narrow_link() {
        // 2000 kbps into a 600 kbps pipe: the failure in #120 was that this
        // never backed off at all.
        let mut c = BitrateController::new(2000);
        let trace = simulate(600, 120, &mut c);
        let settled = c.current_kbps();
        assert!(
            (500..=800).contains(&settled),
            "should settle near 600 kbps, ended at {settled} (trace tail {:?})",
            &trace[trace.len() - 5..]
        );
    }

    #[test]
    fn it_does_not_oscillate_once_settled() {
        // A controller that hunts is worse than one that is slightly wrong:
        // every swing is a visible quality change for the helper.
        let mut c = BitrateController::new(2000);
        let trace = simulate(600, 200, &mut c);
        let tail = &trace[trace.len() - 40..];
        let lo = *tail.iter().min().unwrap();
        let hi = *tail.iter().max().unwrap();
        assert!(
            f64::from(hi - lo) / f64::from(lo) < 0.35,
            "steady-state swing {lo}..{hi} is too wide"
        );
    }

    #[test]
    fn it_follows_a_link_that_gets_worse() {
        let mut c = BitrateController::new(2000);
        simulate(1500, 60, &mut c);
        let before = c.current_kbps();
        simulate(300, 120, &mut c);
        let after = c.current_kbps();
        assert!(
            after < before / 2,
            "capacity fell 1500->300 but rate only moved {before}->{after}"
        );
    }

    #[test]
    fn it_takes_a_link_that_gets_better() {
        let mut c = BitrateController::new(2000);
        simulate(300, 120, &mut c);
        let bottom = c.current_kbps();
        simulate(2500, 120, &mut c);
        assert!(
            c.current_kbps() > bottom * 2,
            "capacity rose 300->2500 but rate only moved {bottom}->{}",
            c.current_kbps()
        );
    }

    #[test]
    fn a_link_that_can_carry_everything_is_left_alone() {
        // No congestion must mean no penalty: a good link still gets the full
        // ceiling, which is the cost side of controlling in both directions.
        let mut c = BitrateController::new(2000);
        simulate(10_000, 60, &mut c);
        assert_eq!(c.current_kbps(), MAX_BITRATE_KBPS);
    }
}
