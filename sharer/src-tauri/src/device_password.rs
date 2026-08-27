//! Local device-password store for unattended mode.
//!
//! Persists an argon2id hash of the user's per-device password to a
//! plain file on the local filesystem (mode 0600 on Linux). The sharer
//! uses this hash to verify viewer-supplied passwords during the
//! `pw-check` flow without ever sending the password — plaintext or
//! hashed — back to the backend.
//!
//! Kept in its own file separate from the device token (see
//! `account.rs`, gh #21) so the user can reset the password without
//! re-pairing the device.
//!
//! Argon2id parameters mirror `backend/src/auth/argon.ts`:
//! m = 64 MiB, t = 3, p = 1. Hashes are stored in the standard PHC
//! string format — params travel with the hash, so changing them later
//! does not invalidate existing entries.

use std::fs;
use std::io;
use std::path::Path;

use argon2::password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier};
use argon2::{Algorithm, Argon2, Params, Version};

/// Minimum plaintext length. Below this argon2 effectively becomes a
/// CPU puzzle of trivial size — see spec §5.2 "min 8 Zeichen, keine
/// Komplexitätsregeln über Min-Länge hinaus" (passphrases welcome).
pub const MIN_PASSWORD_LEN: usize = 8;

/// Errors returned by the device-password module. The `Wrong` /
/// `TooShort` variants carry no plaintext so they are safe to log; the
/// IO and Corrupt variants stringify the underlying cause without
/// echoing user input.
#[derive(Debug)]
pub enum DevicePasswordError {
    /// Plaintext is shorter than `MIN_PASSWORD_LEN`.
    TooShort,
    /// IO failure reading or writing the hash file.
    Io(io::Error),
    /// The file exists but its contents are not a valid PHC argon2id
    /// hash — usually a partially-written file or external tampering.
    /// Callers should treat this the same as "no password set" and
    /// prompt the user to set a new one.
    Corrupt,
    /// Argon2 hashing itself failed (only realistic on OOM or a
    /// catastrophic algorithm-config bug — kept distinct so logs can
    /// tell IO vs crypto failures apart).
    Hash(String),
}

impl std::fmt::Display for DevicePasswordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooShort => write!(f, "password is shorter than {MIN_PASSWORD_LEN} characters"),
            Self::Io(e) => write!(f, "device-password file IO failed: {e}"),
            Self::Corrupt => write!(f, "device-password file is corrupt or not an argon2id hash"),
            Self::Hash(msg) => write!(f, "argon2 hashing failed: {msg}"),
        }
    }
}

impl std::error::Error for DevicePasswordError {}

impl From<io::Error> for DevicePasswordError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// Build the Argon2 instance we use throughout the module. Params are
/// pulled out so a single source-of-truth bug is enough to mismatch the
/// backend.
fn argon() -> Argon2<'static> {
    // Params::new returns Err only on out-of-range values. The literals
    // below are the same as the backend's and well within range; if
    // they ever drift out of range the unit tests will catch it.
    let params = Params::new(64 * 1024, 3, 1, None).expect("argon2 params in range");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Hash `plaintext` and persist the PHC string to `path`. Returns
/// `TooShort` without doing any IO if `plaintext.chars().count()` is
/// below the minimum (we count chars so multi-byte passphrases aren't
/// rejected on byte length alone).
///
/// On Linux the file is created with mode 0600 so other local accounts
/// cannot read it. On Windows the file inherits the user-profile ACL,
/// which is the standard "current user only" policy for app data.
pub fn set(plaintext: &str, path: &Path) -> Result<(), DevicePasswordError> {
    if plaintext.chars().count() < MIN_PASSWORD_LEN {
        return Err(DevicePasswordError::TooShort);
    }

    // password-hash 0.6 generates the random salt itself (getrandom).
    let hash = argon()
        .hash_password(plaintext.as_bytes())
        .map_err(|e| DevicePasswordError::Hash(e.to_string()))?
        .to_string();

    write_atomic(path, hash.as_bytes())?;
    Ok(())
}

/// Verify `plaintext` against the persisted hash. Returns:
///   • `Ok(true)`  — file exists, parseable, plaintext matches
///   • `Ok(false)` — file exists, parseable, plaintext does NOT match
///   • `Err(Corrupt)` — file exists but is not a valid PHC argon2id hash
///   • `Err(Io)`      — file IO failed (incl. ENOENT — see [`is_set`])
///
/// Callers should typically check [`is_set`] first to distinguish
/// "never set" from "wrong password".
pub fn verify(plaintext: &str, path: &Path) -> Result<bool, DevicePasswordError> {
    let stored = fs::read_to_string(path)?;
    let trimmed = stored.trim();
    let parsed = PasswordHash::new(trimmed).map_err(|_| DevicePasswordError::Corrupt)?;
    if parsed.algorithm.as_str() != "argon2id" {
        return Err(DevicePasswordError::Corrupt);
    }
    match argon().verify_password(plaintext.as_bytes(), &parsed) {
        Ok(()) => Ok(true),
        Err(argon2::password_hash::Error::PasswordInvalid) => Ok(false),
        Err(_) => Err(DevicePasswordError::Corrupt),
    }
}

/// Returns true iff a password hash file exists at `path`, regardless
/// of whether its contents parse. UI gating only — never use this as a
/// security check.
pub fn is_set(path: &Path) -> bool {
    path.is_file()
}

/// Write `bytes` to `path` atomically: stage in a sibling temp file,
/// fsync, then rename. On Linux the file gets mode 0600 BEFORE the
/// rename so it never exists with broader permissions on the final
/// inode.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let stage_name = match path.file_name() {
        Some(n) => {
            let mut s = n.to_os_string();
            s.push(".tmp");
            s
        }
        None => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "device-password path has no filename component",
            ));
        }
    };
    let stage = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.join(&stage_name),
        _ => Path::new(&stage_name).to_path_buf(),
    };

    {
        use std::io::Write;
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&stage)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }

    fs::rename(&stage, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn file_path(dir: &tempfile::TempDir) -> std::path::PathBuf {
        dir.path().join("device_password.phc")
    }

    #[test]
    fn set_then_verify_returns_true_for_same_plaintext() {
        let dir = tempdir().unwrap();
        let path = file_path(&dir);
        set("correct horse battery staple", &path).expect("set succeeds");
        assert!(verify("correct horse battery staple", &path).expect("verify ok"));
    }

    #[test]
    fn verify_returns_false_for_wrong_plaintext_without_error() {
        let dir = tempdir().unwrap();
        let path = file_path(&dir);
        set("correct horse battery staple", &path).expect("set succeeds");
        assert!(!verify("wrong password", &path).expect("verify returns Ok(false)"));
    }

    #[test]
    fn set_rejects_plaintext_shorter_than_min_len_without_writing_file() {
        let dir = tempdir().unwrap();
        let path = file_path(&dir);
        assert!(matches!(
            set("short", &path),
            Err(DevicePasswordError::TooShort)
        ));
        assert!(!path.exists(), "no file should be written when too short");
    }

    #[test]
    fn set_accepts_unicode_passphrase_above_min_chars() {
        let dir = tempdir().unwrap();
        let path = file_path(&dir);
        // 8 chars exactly, multi-byte: would fail a naive byte-length
        // gate but must pass a char-count gate (passphrases-friendly).
        let pw = "Höße🦀";
        // 5 chars, below MIN — must fail.
        assert!(matches!(set(pw, &path), Err(DevicePasswordError::TooShort)));
        let pw_ok = "Höße🦀123";
        set(pw_ok, &path).expect("8-char unicode passphrase accepted");
        assert!(verify(pw_ok, &path).expect("unicode passphrase verifies"));
    }

    #[test]
    fn verify_treats_garbage_file_as_corrupt() {
        let dir = tempdir().unwrap();
        let path = file_path(&dir);
        std::fs::write(&path, b"not an argon2 hash at all").unwrap();
        assert!(matches!(
            verify("anything", &path),
            Err(DevicePasswordError::Corrupt)
        ));
    }

    #[test]
    fn verify_rejects_non_argon2id_algorithm() {
        let dir = tempdir().unwrap();
        let path = file_path(&dir);
        // A valid PHC string but for argon2i, not argon2id. Forces a
        // future maintainer to consciously decide whether to accept
        // weaker variants (we don't).
        let valid_other =
            "$argon2i$v=19$m=4096,t=3,p=1$c2FsdHNhbHQ$pBSrshjnFE5kn33EhBoyZx5lFQQrjPxJZw1bYr3F26U";
        std::fs::write(&path, valid_other).unwrap();
        assert!(matches!(
            verify("anything", &path),
            Err(DevicePasswordError::Corrupt)
        ));
    }

    #[test]
    fn verify_returns_io_error_when_file_missing() {
        let dir = tempdir().unwrap();
        let path = file_path(&dir); // never written
        let err = verify("anything", &path).expect_err("missing file is Err");
        assert!(matches!(err, DevicePasswordError::Io(_)));
    }

    #[test]
    fn is_set_distinguishes_present_from_absent_file() {
        let dir = tempdir().unwrap();
        let path = file_path(&dir);
        assert!(!is_set(&path));
        set("correct horse battery staple", &path).expect("set");
        assert!(is_set(&path));
    }

    #[cfg(unix)]
    #[test]
    fn set_writes_file_with_mode_0600_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let path = file_path(&dir);
        set("correct horse battery staple", &path).expect("set");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "device-password file must be 0600, got 0o{mode:o}"
        );
    }

    #[test]
    fn set_overwrites_existing_hash() {
        let dir = tempdir().unwrap();
        let path = file_path(&dir);
        set("first password chosen", &path).expect("set 1");
        set("second password chosen", &path).expect("set 2");
        assert!(!verify("first password chosen", &path).expect("verify 1"));
        assert!(verify("second password chosen", &path).expect("verify 2"));
    }

    /// The PHC strings stored on disk MUST embed the same params the
    /// backend uses (m=64 MiB, t=3, p=1) — otherwise an unattended
    /// password set on a new sharer build verifies differently than one
    /// migrated from an older build. Pin the params via the stored
    /// PHC string.
    #[test]
    fn stored_phc_string_carries_64mib_3_iter_1_lane_params() {
        let dir = tempdir().unwrap();
        let path = file_path(&dir);
        set("correct horse battery staple", &path).expect("set");
        let stored = std::fs::read_to_string(&path).unwrap();
        assert!(
            stored.starts_with("$argon2id$"),
            "expected argon2id PHC string, got: {stored}"
        );
        // Params section: $argon2id$v=19$m=65536,t=3,p=1$...
        assert!(
            stored.contains("m=65536,t=3,p=1"),
            "expected m=65536,t=3,p=1 params, got: {stored}"
        );
    }
}
