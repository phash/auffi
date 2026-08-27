//! Combines `device_password::verify` and `local_lockout::LocalLockout`
//! into the decision an unattended-mode sharer makes when a `pw-check`
//! frame arrives from the backend. Split into two phases —
//! [`check_locked`] (cheap gate) and [`outcome_from_verify`]
//! (bookkeeping) — so the caller can run the expensive argon2 verify
//! on a blocking worker between them without holding the lockout lock.
//!
//! Pure-Rust integration layer wired into `heartbeat::HeartbeatEvent`
//! handling at the Tauri-app layer (gh #24 acceptance).

use std::time::{Duration, Instant};

use crate::device_password;
use crate::local_lockout::{LocalLockout, LockoutState};

/// What the heartbeat event-loop should do with this pw-check.
#[derive(Debug, PartialEq)]
pub enum PwCheckOutcome {
    /// Locally rate-limited (10+ fails in 5 min). Per spec section 6
    /// the sharer MUST NOT reply — silent drop keeps an attacker from
    /// confirming the device is alive. `remaining` is the lockout
    /// time left, for tray-notification text only.
    DropSilently { remaining: Duration },
    /// Verified AND the device's `auto_accept` is on. Caller replies
    /// `pw-check-result: ok` immediately — no UI prompt.
    AutoAccepted,
    /// Verified BUT `auto_accept` is off. Caller shows the
    /// manual-confirm toast (60 s timeout per spec section 6) and
    /// later sends `pw-check-result: ok` on accept or
    /// `pw-check-result: rejected` on decline.
    NeedsConfirm,
    /// Argon2-verify said no — caller sends `pw-check-result: fail`.
    /// Counter has already been incremented.
    Wrong,
    /// The on-disk password file is corrupt or missing. Per spec,
    /// the sharer cannot answer without a password set — treat as
    /// Wrong to avoid leaking the fact that the device hasn't yet
    /// been initialised. The user will see no auth prompt because
    /// the mode-toggle UI gates entering unattended mode on
    /// device_password::is_set.
    NotConfigured,
}

/// Phase 1: lockout gate. `Some(DropSilently)` when locked — the
/// caller must NOT proceed to the verify (spec section 6: a locked
/// sharer sends nothing, and skipping the verify also skips burning
/// 64 MiB of argon2 work per attempt while locked).
pub fn check_locked(lockout: &mut LocalLockout, now: Instant) -> Option<PwCheckOutcome> {
    if let LockoutState::Locked { remaining } = lockout.check(now) {
        return Some(PwCheckOutcome::DropSilently { remaining });
    }
    None
}

/// Phase 2: map the (possibly off-thread) verify result onto the wire
/// decision and update the lockout bookkeeping.
pub fn outcome_from_verify(
    verify_result: Result<bool, device_password::DevicePasswordError>,
    auto_accept: bool,
    lockout: &mut LocalLockout,
    now: Instant,
) -> PwCheckOutcome {
    match verify_result {
        Ok(true) => {
            lockout.record_success();
            if auto_accept {
                PwCheckOutcome::AutoAccepted
            } else {
                PwCheckOutcome::NeedsConfirm
            }
        }
        Ok(false) => {
            lockout.record_fail(now);
            PwCheckOutcome::Wrong
        }
        Err(device_password::DevicePasswordError::Io(_))
        | Err(device_password::DevicePasswordError::Corrupt) => {
            // Treat as "not configured". Caller should NOT show any
            // toast — the UI flow already prevents reaching this
            // state in healthy operation, and the silent surface
            // avoids leaking the existence of an unconfigured device.
            // We still count it as a fail so a malicious caller
            // hammering the endpoint hits the lockout eventually.
            lockout.record_fail(now);
            PwCheckOutcome::NotConfigured
        }
        Err(_) => {
            // TooShort / Hash errors are caller-input or internal
            // problems, not "wrong password". Treat as Wrong for the
            // wire response (we never want to send Ok on error) but
            // do not count toward the lockout — those errors come
            // from US, not the attacker.
            PwCheckOutcome::Wrong
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_password;
    use tempfile::tempdir;

    fn pw_path(dir: &tempfile::TempDir) -> std::path::PathBuf {
        dir.path().join("device_password.phc")
    }

    /// The forwarder's two-phase flow (lockout gate → verify →
    /// bookkeeping) composed into one call so these tests pin the
    /// protocol end-to-end. Production runs the same two phases with a
    /// `spawn_blocking` between them (see `unattended_cmd.rs`).
    fn handle_pw_check(
        attempt: &str,
        auto_accept: bool,
        password_path: &std::path::Path,
        lockout: &mut LocalLockout,
        now: Instant,
    ) -> PwCheckOutcome {
        if let Some(out) = check_locked(lockout, now) {
            return out;
        }
        outcome_from_verify(
            device_password::verify(attempt, password_path),
            auto_accept,
            lockout,
            now,
        )
    }

    #[test]
    fn correct_password_with_auto_accept_returns_auto_accepted() {
        let dir = tempdir().unwrap();
        let path = pw_path(&dir);
        device_password::set("correct horse battery staple", &path).unwrap();
        let mut l = LocalLockout::new();
        let now = Instant::now();
        for i in 0..3 {
            l.record_fail(now + Duration::from_secs(i));
        }
        let out = handle_pw_check(
            "correct horse battery staple",
            true,
            &path,
            &mut l,
            now + Duration::from_secs(5),
        );
        assert_eq!(out, PwCheckOutcome::AutoAccepted);
        assert_eq!(l.fails_in_window(), 0);
    }

    #[test]
    fn correct_password_without_auto_accept_returns_needs_confirm() {
        // gh #25: same input but auto_accept=false → caller must
        // show a manual-confirm toast before replying.
        let dir = tempdir().unwrap();
        let path = pw_path(&dir);
        device_password::set("correct horse battery staple", &path).unwrap();
        let mut l = LocalLockout::new();
        let out = handle_pw_check(
            "correct horse battery staple",
            false,
            &path,
            &mut l,
            Instant::now(),
        );
        assert_eq!(out, PwCheckOutcome::NeedsConfirm);
        // Counter still resets — argon2-verify succeeded; the
        // user's accept/decline decision is orthogonal to whether
        // the password was correct.
        assert_eq!(l.fails_in_window(), 0);
    }

    #[test]
    fn wrong_password_returns_wrong_regardless_of_auto_accept() {
        let dir = tempdir().unwrap();
        let path = pw_path(&dir);
        device_password::set("correct horse battery staple", &path).unwrap();
        let mut l = LocalLockout::new();
        let now = Instant::now();
        assert_eq!(
            handle_pw_check("nope!", true, &path, &mut l, now),
            PwCheckOutcome::Wrong
        );
        assert_eq!(
            handle_pw_check("nope!", false, &path, &mut l, now),
            PwCheckOutcome::Wrong
        );
        assert_eq!(l.fails_in_window(), 2);
    }

    #[test]
    fn ten_wrong_attempts_lock_then_drop_silently() {
        let dir = tempdir().unwrap();
        let path = pw_path(&dir);
        device_password::set("correct horse battery staple", &path).unwrap();
        let mut l = LocalLockout::new();
        let now = Instant::now();
        for i in 0..10 {
            assert_eq!(
                handle_pw_check("wrong", true, &path, &mut l, now + Duration::from_secs(i)),
                PwCheckOutcome::Wrong
            );
        }
        match handle_pw_check(
            "anything",
            true,
            &path,
            &mut l,
            now + Duration::from_secs(11),
        ) {
            PwCheckOutcome::DropSilently { remaining } => {
                assert!(remaining > Duration::from_secs(60 * 59));
                assert!(remaining <= Duration::from_secs(60 * 60));
            }
            other => panic!("expected DropSilently, got {other:?}"),
        }
    }

    #[test]
    fn drop_silently_bypasses_auto_accept_flag() {
        // gh #25 + section 6 invariant: a locked sharer never
        // auto-accepts even if auto_accept=true would have applied.
        let dir = tempdir().unwrap();
        let path = pw_path(&dir);
        device_password::set("correct horse battery staple", &path).unwrap();
        let mut l = LocalLockout::new();
        let now = Instant::now();
        for i in 0..10 {
            l.record_fail(now + Duration::from_secs(i));
        }
        match handle_pw_check(
            "correct horse battery staple",
            true,
            &path,
            &mut l,
            now + Duration::from_secs(11),
        ) {
            PwCheckOutcome::DropSilently { .. } => {}
            other => panic!("expected DropSilently, got {other:?}"),
        }
    }

    #[test]
    fn check_locked_gates_before_any_verify() {
        // The split phases must preserve handle_pw_check's semantics:
        // while locked, phase 1 short-circuits (the forwarder never
        // reaches the spawn_blocking verify); once the lock lapses,
        // phase 1 passes and phase 2 maps the verify result.
        let mut l = LocalLockout::new();
        let now = Instant::now();
        for i in 0..10 {
            l.record_fail(now + Duration::from_secs(i));
        }
        match check_locked(&mut l, now + Duration::from_secs(11)) {
            Some(PwCheckOutcome::DropSilently { .. }) => {}
            other => panic!("expected Some(DropSilently), got {other:?}"),
        }

        let mut fresh = LocalLockout::new();
        assert_eq!(check_locked(&mut fresh, Instant::now()), None);
    }

    #[test]
    fn outcome_from_verify_maps_results_like_the_composed_call() {
        let mut l = LocalLockout::new();
        let now = Instant::now();
        assert_eq!(
            outcome_from_verify(Ok(true), true, &mut l, now),
            PwCheckOutcome::AutoAccepted
        );
        assert_eq!(
            outcome_from_verify(Ok(true), false, &mut l, now),
            PwCheckOutcome::NeedsConfirm
        );
        assert_eq!(
            outcome_from_verify(Ok(false), true, &mut l, now),
            PwCheckOutcome::Wrong
        );
        assert_eq!(l.fails_in_window(), 1, "a wrong verify must count");
        assert_eq!(
            outcome_from_verify(
                Err(device_password::DevicePasswordError::Corrupt),
                true,
                &mut l,
                now
            ),
            PwCheckOutcome::NotConfigured
        );
        assert_eq!(l.fails_in_window(), 2, "corrupt file counts as a fail too");
    }

    #[test]
    fn missing_password_file_returns_not_configured() {
        let dir = tempdir().unwrap();
        let path = pw_path(&dir);
        let mut l = LocalLockout::new();
        let now = Instant::now();
        let out = handle_pw_check("anything", true, &path, &mut l, now);
        assert_eq!(out, PwCheckOutcome::NotConfigured);
        assert_eq!(l.fails_in_window(), 1);
    }

    #[test]
    fn corrupt_password_file_returns_not_configured() {
        let dir = tempdir().unwrap();
        let path = pw_path(&dir);
        std::fs::write(&path, "not an argon2 hash").unwrap();
        let mut l = LocalLockout::new();
        let now = Instant::now();
        let out = handle_pw_check("anything", true, &path, &mut l, now);
        assert_eq!(out, PwCheckOutcome::NotConfigured);
        assert_eq!(l.fails_in_window(), 1);
    }
}
