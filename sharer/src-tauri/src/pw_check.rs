//! Combines `device_password::verify` and `local_lockout::LocalLockout`
//! into the single decision an unattended-mode sharer makes when a
//! `pw-check` frame arrives from the backend.
//!
//! Pure-Rust integration layer wired into `heartbeat::HeartbeatEvent`
//! handling at the Tauri-app layer (gh #24 acceptance).

#![allow(dead_code)]

use std::path::Path;
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
    /// Password verified. The caller proceeds to either auto-accept
    /// (PwCheckResult::Ok immediately, gh #25 auto_accept = true) or
    /// show a manual-confirm toast and reply later.
    Verified,
    /// Argon2-verify said no — caller sends PwCheckResult::Fail.
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

/// Single-call decision: lockout-check → argon2-verify → state update.
/// Returns what the caller should send back. Pure on (attempt,
/// password_path, lockout-state, now) so the heartbeat tests can pin
/// the protocol without touching the actual filesystem more than once.
pub fn handle_pw_check(
    attempt: &str,
    password_path: &Path,
    lockout: &mut LocalLockout,
    now: Instant,
) -> PwCheckOutcome {
    if let LockoutState::Locked { remaining } = lockout.check(now) {
        return PwCheckOutcome::DropSilently { remaining };
    }
    match device_password::verify(attempt, password_path) {
        Ok(true) => {
            lockout.record_success();
            PwCheckOutcome::Verified
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

    #[test]
    fn correct_password_returns_verified_and_resets_lockout_counter() {
        let dir = tempdir().unwrap();
        let path = pw_path(&dir);
        device_password::set("correct horse battery staple", &path).unwrap();
        let mut l = LocalLockout::new();
        let now = Instant::now();
        // Pre-load 3 fails.
        for i in 0..3 {
            l.record_fail(now + Duration::from_secs(i));
        }
        let out = handle_pw_check(
            "correct horse battery staple",
            &path,
            &mut l,
            now + Duration::from_secs(5),
        );
        assert_eq!(out, PwCheckOutcome::Verified);
        assert_eq!(l.fails_in_window(), 0);
    }

    #[test]
    fn wrong_password_returns_wrong_and_increments_counter() {
        let dir = tempdir().unwrap();
        let path = pw_path(&dir);
        device_password::set("correct horse battery staple", &path).unwrap();
        let mut l = LocalLockout::new();
        let now = Instant::now();
        let out = handle_pw_check("nope!", &path, &mut l, now);
        assert_eq!(out, PwCheckOutcome::Wrong);
        assert_eq!(l.fails_in_window(), 1);
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
                handle_pw_check("wrong", &path, &mut l, now + Duration::from_secs(i)),
                PwCheckOutcome::Wrong
            );
        }
        // 11th attempt is locked — DropSilently with remaining < 1 h.
        match handle_pw_check("anything", &path, &mut l, now + Duration::from_secs(11)) {
            PwCheckOutcome::DropSilently { remaining } => {
                assert!(remaining > Duration::from_secs(60 * 59));
                assert!(remaining <= Duration::from_secs(60 * 60));
            }
            other => panic!("expected DropSilently, got {other:?}"),
        }
    }

    #[test]
    fn drop_silently_does_not_run_argon2_or_increment_counter() {
        // Pre-engage the lockout via direct record_fail calls so we
        // can prove the function early-returns without touching
        // device_password::verify.
        let dir = tempdir().unwrap();
        let path = pw_path(&dir); // intentionally never written
        let mut l = LocalLockout::new();
        let now = Instant::now();
        for i in 0..10 {
            l.record_fail(now + Duration::from_secs(i));
        }
        // path doesn't exist, but DropSilently must short-circuit
        // before verify() would Err with Io.
        match handle_pw_check("anything", &path, &mut l, now + Duration::from_secs(11)) {
            PwCheckOutcome::DropSilently { .. } => {}
            other => panic!("expected DropSilently, got {other:?}"),
        }
        // 10 fails (no increment from this call).
        assert_eq!(l.fails_in_window(), 0); // window of fails got cleared on lock
    }

    #[test]
    fn missing_password_file_returns_not_configured() {
        let dir = tempdir().unwrap();
        let path = pw_path(&dir); // never written
        let mut l = LocalLockout::new();
        let now = Instant::now();
        let out = handle_pw_check("anything", &path, &mut l, now);
        assert_eq!(out, PwCheckOutcome::NotConfigured);
        // Should still count toward lockout to prevent a misconfigured
        // sharer being used as a yes/no oracle.
        assert_eq!(l.fails_in_window(), 1);
    }

    #[test]
    fn corrupt_password_file_returns_not_configured() {
        let dir = tempdir().unwrap();
        let path = pw_path(&dir);
        std::fs::write(&path, "not an argon2 hash").unwrap();
        let mut l = LocalLockout::new();
        let now = Instant::now();
        let out = handle_pw_check("anything", &path, &mut l, now);
        assert_eq!(out, PwCheckOutcome::NotConfigured);
        assert_eq!(l.fails_in_window(), 1);
    }
}
