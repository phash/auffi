//! Local password-attempt lockout for unattended mode.
//!
//! Spec section 6 (Lokales Lockout am Sharer): 10 failed password
//! attempts inside a 5-minute sliding window lock the sharer locally
//! for 1 hour. While locked, incoming `pw-check` requests are
//! silently dropped (the backend already returned `wrong-password`
//! at attempt #5, so a viewer beyond that is misbehaving anyway).
//!
//! This is layered ON TOP of the backend's rate_limit_buckets so even
//! an attacker who can stuff arbitrary `pw-check` frames into the
//! sharer's WSS (e.g. compromised backend) hits a second wall.
//!
//! Pure logic, no IO — wired into the heartbeat event-loop via
//! `pw_check::handle_pw_check`.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Sliding window: 10 fails inside `WINDOW` → 1 h lockout. Constants
/// chosen to match spec section 6 exactly; do not change without a
/// security review.
pub const MAX_FAILS_IN_WINDOW: usize = 10;
pub const WINDOW: Duration = Duration::from_secs(5 * 60);
pub const LOCKOUT_DURATION: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, PartialEq, Eq)]
pub enum LockoutState {
    /// The sharer is currently NOT locked. The caller may proceed to
    /// argon2-verify the pw-check attempt.
    Free,
    /// Locked. The Duration is the remaining wait time, derived from
    /// `now` at check-time. The caller MUST drop the pw-check
    /// silently (do not send pw-check-result: fail — that would just
    /// help an attacker confirm the device is alive).
    Locked { remaining: Duration },
}

#[derive(Debug, Default)]
pub struct LocalLockout {
    /// Timestamps of recent failed attempts. We drop entries older
    /// than `WINDOW` lazily on each check + record_fail call.
    fails: VecDeque<Instant>,
    locked_until: Option<Instant>,
}

impl LocalLockout {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read the current lockout state without mutating timing. Drops
    /// expired fails + clears the lockout flag if its time has passed.
    pub fn check(&mut self, now: Instant) -> LockoutState {
        self.gc(now);
        match self.locked_until {
            Some(until) if now < until => LockoutState::Locked {
                remaining: until.duration_since(now),
            },
            _ => LockoutState::Free,
        }
    }

    /// Record a failed pw-check. If this is the 10th fail inside
    /// `WINDOW`, also engage a fresh 1 h lockout.
    pub fn record_fail(&mut self, now: Instant) {
        self.gc(now);
        self.fails.push_back(now);
        if self.fails.len() >= MAX_FAILS_IN_WINDOW {
            self.locked_until = Some(now + LOCKOUT_DURATION);
            // Clear the queue so the next post-lockout-end fail
            // starts a fresh window instead of being pre-charged with
            // the prior 10.
            self.fails.clear();
        }
    }

    /// Successful pw-check — reset the counter and any pending lock.
    pub fn record_success(&mut self) {
        self.fails.clear();
        self.locked_until = None;
    }

    /// Lazy GC: drop fails older than `WINDOW` and clear an expired
    /// lockout. Called from every public op so callers don't need to.
    fn gc(&mut self, now: Instant) {
        if let Some(until) = self.locked_until {
            if now >= until {
                self.locked_until = None;
            }
        }
        let cutoff = now.checked_sub(WINDOW);
        if let Some(cutoff) = cutoff {
            while let Some(&front) = self.fails.front() {
                if front < cutoff {
                    self.fails.pop_front();
                } else {
                    break;
                }
            }
        }
    }

    /// Test-only introspection of the fail count inside the window.
    #[cfg(test)]
    pub(crate) fn fails_in_window(&self) -> usize {
        self.fails.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(base: Instant, offset_secs: u64) -> Instant {
        base + Duration::from_secs(offset_secs)
    }

    #[test]
    fn fresh_lockout_is_free() {
        let mut l = LocalLockout::new();
        assert_eq!(l.check(Instant::now()), LockoutState::Free);
    }

    #[test]
    fn nine_fails_in_window_do_not_lock() {
        let now = Instant::now();
        let mut l = LocalLockout::new();
        for i in 0..(MAX_FAILS_IN_WINDOW - 1) {
            l.record_fail(at(now, i as u64));
        }
        assert_eq!(l.check(at(now, 100)), LockoutState::Free);
    }

    #[test]
    fn tenth_fail_in_window_engages_one_hour_lockout() {
        let now = Instant::now();
        let mut l = LocalLockout::new();
        for i in 0..MAX_FAILS_IN_WINDOW {
            l.record_fail(at(now, i as u64));
        }
        match l.check(at(now, (MAX_FAILS_IN_WINDOW + 1) as u64)) {
            LockoutState::Locked { remaining } => {
                // 1 h minus the few seconds we advanced.
                assert!(remaining > Duration::from_secs(60 * 59));
                assert!(remaining <= LOCKOUT_DURATION);
            }
            LockoutState::Free => panic!("expected lockout to engage on 10th fail"),
        }
    }

    #[test]
    fn fails_outside_the_5min_window_do_not_count() {
        let now = Instant::now();
        let mut l = LocalLockout::new();
        // 9 fails inside the window, plus one fail 6 min ago — the
        // old one drops out, so we're still at 9 effective fails and
        // NOT locked yet.
        l.record_fail(at(now, 0));
        for i in 1..MAX_FAILS_IN_WINDOW {
            l.record_fail(at(now, 360 + i as u64));
        }
        let result = l.check(at(now, 360 + MAX_FAILS_IN_WINDOW as u64 + 1));
        assert_eq!(result, LockoutState::Free);
        assert_eq!(
            l.fails_in_window(),
            MAX_FAILS_IN_WINDOW - 1,
            "the first fail must have been dropped from the window"
        );
    }

    #[test]
    fn lockout_clears_after_one_hour() {
        let now = Instant::now();
        let mut l = LocalLockout::new();
        for i in 0..MAX_FAILS_IN_WINDOW {
            l.record_fail(at(now, i as u64));
        }
        // Right at the boundary: still locked (now < until).
        let one_h_later = at(now, 60 * 60 + MAX_FAILS_IN_WINDOW as u64);
        assert!(matches!(l.check(one_h_later), LockoutState::Free));
    }

    #[test]
    fn record_success_clears_counter_and_lockout() {
        let now = Instant::now();
        let mut l = LocalLockout::new();
        for i in 0..MAX_FAILS_IN_WINDOW {
            l.record_fail(at(now, i as u64));
        }
        l.record_success();
        assert_eq!(
            l.check(at(now, MAX_FAILS_IN_WINDOW as u64 + 1)),
            LockoutState::Free
        );
        assert_eq!(l.fails_in_window(), 0);
    }

    #[test]
    fn post_lockout_window_starts_fresh() {
        let now = Instant::now();
        let mut l = LocalLockout::new();
        for i in 0..MAX_FAILS_IN_WINDOW {
            l.record_fail(at(now, i as u64));
        }
        // Cross the lockout boundary.
        let after_lock = at(now, 60 * 60 + 10);
        assert_eq!(l.check(after_lock), LockoutState::Free);
        // The first post-lock fail must NOT immediately re-lock —
        // the window was cleared.
        l.record_fail(after_lock);
        assert_eq!(
            l.check(after_lock + Duration::from_secs(1)),
            LockoutState::Free
        );
        assert_eq!(l.fails_in_window(), 1);
    }
}
