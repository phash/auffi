//! Account / device-pairing module for unattended mode.
//!
//! Trades a one-time pairing code (minted by the dashboard) for a
//! permanent `device_id` + `device_token` via `POST /api/devices/redeem`,
//! then persists:
//!   • `device_token`  → OS-native secure credential store (keyring)
//!   • `device_id`     → plain config file (non-sensitive identifier)
//!
//! The token MUST NEVER touch the plain filesystem — anyone who can
//! read it can impersonate the device against the backend WSS endpoint.
//! Keyring backends: Secret Service on Linux, Keychain on macOS,
//! Credential Manager on Windows.
//!
//! `unpair` is best-effort against the backend (DELETE may be rejected
//! if the backend hasn't yet wired Bearer-auth DELETE — gh #16 / #17)
//! but the local wipe is unconditional and idempotent. The user can
//! always re-pair with a fresh code.

// Wired in by gh #20 (mode toggle UI) and gh #23 (heartbeat). Keep the
// pub surface dead-code-allowed until those land.
#![allow(dead_code)]

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Service identifier shown in the OS credential UI. Must stay stable —
/// renaming it would orphan every existing paired device's token entry.
pub const KEYRING_SERVICE: &str = "auffi-sharer";

/// Username slot under [`KEYRING_SERVICE`]. Single token per install,
/// so a fixed slot rather than per-device-id.
pub const KEYRING_USER: &str = "device-token";

/// Filename for the plain-text device-id config file (sibling of
/// `device_password.phc`). Non-sensitive; reveals only which device
/// the install is paired to, not any credential.
pub const DEVICE_ID_FILE: &str = "device_id.txt";

#[derive(Debug)]
pub enum AccountError {
    /// Pairing code rejected: empty, malformed, already used, or
    /// expired. Backend distinguishes these via the JSON `error` field.
    InvalidCode(String),
    /// HTTP transport failure (DNS, TLS, connection reset, …).
    Transport(String),
    /// Backend returned a non-2xx status we didn't otherwise classify.
    Backend { status: u16, body: String },
    /// Local IO failed when reading/writing the device-id config file.
    Io(io::Error),
    /// Keyring access failed (DBus error, locked Secret Service, …).
    Keyring(String),
    /// Backend response body didn't match the expected `{device_id, token}`
    /// shape.
    MalformedResponse(String),
}

impl std::fmt::Display for AccountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidCode(msg) => write!(f, "ungültiger Pairing-Code: {msg}"),
            Self::Transport(msg) => write!(f, "Backend nicht erreichbar: {msg}"),
            Self::Backend { status, body } => write!(f, "Backend-Fehler ({status}): {body}"),
            Self::Io(e) => write!(f, "Konfig-Datei-IO fehlgeschlagen: {e}"),
            Self::Keyring(msg) => write!(f, "Schlüsselbund-Zugriff fehlgeschlagen: {msg}"),
            Self::MalformedResponse(msg) => write!(f, "unerwartete Backend-Antwort: {msg}"),
        }
    }
}

impl std::error::Error for AccountError {}

impl From<io::Error> for AccountError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingResponse {
    pub device_id: String,
    pub token: String,
}

/// Wire shape of `POST /api/devices/redeem`. The backend
/// (`backend/src/devices/handlers.ts`) requires both `code` and `alias`:
/// the alias is the human label the dashboard shows in the device list,
/// 1-80 chars, trimmed. The sharer caller supplies it from
/// `gethostname()` (default) or a user override.
#[derive(Debug, Deserialize, Serialize)]
struct RedeemRequest<'a> {
    code: &'a str,
    alias: &'a str,
}

/// Abstraction over the OS-native credential store so tests can swap in
/// an in-memory implementation without touching DBus / Keychain.
pub trait TokenStore: Send + Sync {
    fn write(&self, token: &str) -> Result<(), AccountError>;
    /// Returns `Ok(None)` for "no entry yet"; `Err(Keyring)` for actual
    /// backend errors. Distinguishing these matters because the UI
    /// shows "Mit Account verbinden" vs an error toast.
    fn read(&self) -> Result<Option<String>, AccountError>;
    /// Idempotent: deleting a non-existent entry is `Ok(())`.
    fn delete(&self) -> Result<(), AccountError>;
}

/// Production [`TokenStore`] backed by the `keyring` crate.
pub struct KeyringTokenStore {
    service: String,
    user: String,
}

impl KeyringTokenStore {
    pub fn new(service: &str, user: &str) -> Self {
        Self {
            service: service.to_string(),
            user: user.to_string(),
        }
    }

    pub fn default_for_auffi() -> Self {
        Self::new(KEYRING_SERVICE, KEYRING_USER)
    }

    fn entry(&self) -> Result<keyring::Entry, AccountError> {
        keyring::Entry::new(&self.service, &self.user)
            .map_err(|e| AccountError::Keyring(e.to_string()))
    }
}

impl TokenStore for KeyringTokenStore {
    fn write(&self, token: &str) -> Result<(), AccountError> {
        self.entry()?
            .set_password(token)
            .map_err(|e| AccountError::Keyring(e.to_string()))
    }

    fn read(&self) -> Result<Option<String>, AccountError> {
        match self.entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AccountError::Keyring(e.to_string())),
        }
    }

    fn delete(&self) -> Result<(), AccountError> {
        match self.entry()?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AccountError::Keyring(e.to_string())),
        }
    }
}

/// Validate and normalise a user-typed pairing code to the exact wire
/// shape the backend expects (`backend/src/devices/handlers.ts`):
/// `^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{2}$` (10 chars, two dashes).
/// Strips whitespace and lower-cases input but **preserves the dashes**
/// — the backend's `normalizePairingCode` keeps them and matches the
/// hashed value off the dashed form. Accepts paste-from-mail-client
/// artefacts (smart-dashes, surrounding whitespace, lower-case typing)
/// and converts to the canonical form.
///
/// Pure for unit-pinning. The dash policy is a wire-contract pin: the
/// previous implementation stripped dashes and produced an 8-char
/// payload that the backend rejected with 400 `bad-code`.
pub fn normalise_pairing_code(input: &str) -> Result<String, AccountError> {
    // Collapse en-dash / em-dash / NBSP-hyphen into ASCII '-' first.
    let pre: String = input
        .chars()
        .map(|c| match c {
            '\u{2013}' | '\u{2014}' | '\u{2212}' | '\u{2010}' | '\u{2011}' => '-',
            _ => c,
        })
        .collect();
    // Strip whitespace and any character outside [A-Z0-9-] after
    // upper-casing. Then collapse runs of dashes.
    let mut buf = String::with_capacity(pre.len());
    for c in pre.chars() {
        if c.is_whitespace() {
            continue;
        }
        let up = c.to_ascii_uppercase();
        if up.is_ascii_alphanumeric() || up == '-' {
            buf.push(up);
        }
    }
    while buf.contains("--") {
        buf = buf.replace("--", "-");
    }
    if !is_valid_pairing_code(&buf) {
        return Err(AccountError::InvalidCode(format!(
            "Code muss Form XXX-XXX-XX haben (bekam {buf:?})"
        )));
    }
    Ok(buf)
}

/// True iff `s` matches `^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{2}$`. Split
/// out so `pair()` can re-check after normalisation without re-parsing.
fn is_valid_pairing_code(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    if bytes[3] != b'-' || bytes[7] != b'-' {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        if i == 3 || i == 7 {
            continue;
        }
        if !(b.is_ascii_uppercase() || b.is_ascii_digit()) {
            return false;
        }
    }
    true
}

fn device_id_path(config_dir: &Path) -> PathBuf {
    config_dir.join(DEVICE_ID_FILE)
}

fn write_device_id(config_dir: &Path, device_id: &str) -> io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let path = device_id_path(config_dir);
    let tmp = path.with_extension("txt.tmp");
    {
        use std::io::Write;
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // device_id itself is non-sensitive but we keep the parent-
            // pattern symmetric with device_password.phc so a careless
            // umask doesn't leak it either.
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(device_id.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn read_device_id(config_dir: &Path) -> Result<Option<String>, AccountError> {
    let path = device_id_path(config_dir);
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s.trim().to_string())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AccountError::Io(e)),
    }
}

fn delete_device_id(config_dir: &Path) -> io::Result<()> {
    let path = device_id_path(config_dir);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Maximum alias length the backend will accept. Mirrors the constraint
/// in `backend/src/devices/handlers.ts`: 1-80 chars, trimmed. We
/// truncate here so a long hostname (e.g. macOS auto-names like
/// `Hans-Mustermann-MacBook-Pro-15-Inch-Mid-2024.local`) still pairs.
pub const MAX_ALIAS_LEN: usize = 80;

/// Normalise the alias: trim, drop control chars, truncate to
/// [`MAX_ALIAS_LEN`]. Returns `InvalidCode` if the result is empty —
/// the user has to type *something* the dashboard can display.
fn normalise_alias(input: &str) -> Result<String, AccountError> {
    let cleaned: String = input
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() {
        return Err(AccountError::InvalidCode(
            "Gerätename darf nicht leer sein".to_string(),
        ));
    }
    let truncated: String = cleaned.chars().take(MAX_ALIAS_LEN).collect();
    Ok(truncated)
}

/// Redeem a pairing code and persist the resulting credentials.
/// On success returns the `device_id` (the token is already stored).
/// On any failure the local state is left untouched so the user can
/// retry without first needing to unpair.
///
/// `alias` is the human label that will show up in the dashboard's
/// device list; trimmed and truncated to [`MAX_ALIAS_LEN`]. Callers
/// typically pass the OS hostname as a sensible default; the user can
/// later rename via the dashboard.
pub async fn pair<S: TokenStore>(
    http: &reqwest::Client,
    store: &S,
    backend_base: &str,
    code: &str,
    alias: &str,
    config_dir: &Path,
) -> Result<String, AccountError> {
    let normalised = normalise_pairing_code(code)?;
    let alias = normalise_alias(alias)?;
    let url = format!("{}/api/devices/redeem", backend_base.trim_end_matches('/'));
    let resp = http
        .post(&url)
        .json(&RedeemRequest {
            code: &normalised,
            alias: &alias,
        })
        .send()
        .await
        .map_err(|e| AccountError::Transport(e.to_string()))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AccountError::Transport(e.to_string()))?;
    if !status.is_success() {
        // Spec §5.2: backend returns 400/410 with {error: "expired"} etc.
        // We don't try to parse here — the surface area would couple us
        // to backend strings; instead surface the raw body so the UI
        // can show a friendly toast distinguishing "ungültig/abgelaufen"
        // from "Backend down".
        if status.as_u16() == 400 || status.as_u16() == 404 || status.as_u16() == 410 {
            return Err(AccountError::InvalidCode(body));
        }
        return Err(AccountError::Backend {
            status: status.as_u16(),
            body,
        });
    }
    let parsed: PairingResponse =
        serde_json::from_str(&body).map_err(|e| AccountError::MalformedResponse(e.to_string()))?;
    if parsed.device_id.is_empty() || parsed.token.is_empty() {
        return Err(AccountError::MalformedResponse(
            "device_id oder token leer".to_string(),
        ));
    }
    store.write(&parsed.token)?;
    write_device_id(config_dir, &parsed.device_id)?;
    Ok(parsed.device_id)
}

/// Best-effort unpair: try to revoke the token at the backend, then
/// wipe local secrets unconditionally. Idempotent — calling on an
/// already-unpaired install returns `Ok(())`.
pub async fn unpair<S: TokenStore>(
    http: &reqwest::Client,
    store: &S,
    backend_base: &str,
    config_dir: &Path,
) -> Result<(), AccountError> {
    let token = store.read()?;
    let device_id = read_device_id(config_dir)?;

    if let (Some(token), Some(device_id)) = (token.as_ref(), device_id.as_ref()) {
        let url = format!(
            "{}/api/devices/{}",
            backend_base.trim_end_matches('/'),
            device_id
        );
        // Best-effort: failure to contact the backend (or the backend
        // not yet supporting Bearer-DELETE) is NOT a hard error — the
        // user's intent is "stop being paired", and wiping local state
        // accomplishes that even if the server-side token outlives it.
        let _ = http.delete(&url).bearer_auth(token).send().await;
    }

    store.delete()?;
    delete_device_id(config_dir)?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Public-within-crate so other modules' tests (gh #23 heartbeat)
    //! can reuse the in-memory token store fake without rebuilding it.
    use super::*;
    use std::sync::Mutex;

    pub struct MemTokenStore {
        slot: Mutex<Option<String>>,
    }

    impl Default for MemTokenStore {
        fn default() -> Self {
            Self {
                slot: Mutex::new(None),
            }
        }
    }

    impl TokenStore for MemTokenStore {
        fn write(&self, token: &str) -> Result<(), AccountError> {
            *self.slot.lock().unwrap() = Some(token.to_string());
            Ok(())
        }
        fn read(&self) -> Result<Option<String>, AccountError> {
            Ok(self.slot.lock().unwrap().clone())
        }
        fn delete(&self) -> Result<(), AccountError> {
            *self.slot.lock().unwrap() = None;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::MemTokenStore;
    use super::*;
    use tempfile::tempdir;

    fn http() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap()
    }

    // ── normalise_pairing_code ────────────────────────────────────────
    // Wire-contract pin: backend/src/devices/handlers.ts accepts the
    // shape `^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{2}$` (10 chars with
    // dashes), NOT the bare 8-char form. Anyone "simplifying" the
    // normaliser to strip dashes recreates the gh #21/#16 contract
    // mismatch we shipped on 2026-05-14.

    #[test]
    fn normalise_uppercases_and_preserves_dashes() {
        assert_eq!(normalise_pairing_code("7k3-9pq-xr").unwrap(), "7K3-9PQ-XR");
        assert_eq!(
            normalise_pairing_code("  7K3-9PQ-XR  ").unwrap(),
            "7K3-9PQ-XR"
        );
    }

    #[test]
    fn normalise_strips_internal_whitespace_but_keeps_dashes() {
        assert_eq!(
            normalise_pairing_code("7K3 - 9PQ - XR").unwrap(),
            "7K3-9PQ-XR"
        );
    }

    #[test]
    fn normalise_collapses_runs_of_dashes() {
        assert_eq!(
            normalise_pairing_code("7K3--9PQ---XR").unwrap(),
            "7K3-9PQ-XR"
        );
    }

    #[test]
    fn normalise_converts_smart_dashes_into_ascii_dashes() {
        // En-dash, em-dash, hyphen-bullet. Mail clients love these.
        assert_eq!(
            normalise_pairing_code("7K3\u{2013}9PQ\u{2014}XR").unwrap(),
            "7K3-9PQ-XR"
        );
    }

    #[test]
    fn normalise_rejects_wrong_length_or_shape() {
        for bad in ["ABC", "ABCDEFGHIJ", "ABC-DEF-GH-XX", "ABCD-EF-XY", ""] {
            assert!(
                matches!(
                    normalise_pairing_code(bad),
                    Err(AccountError::InvalidCode(_))
                ),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn normalise_rejects_non_alphanumeric_in_letter_slots() {
        assert!(matches!(
            normalise_pairing_code("AB!-DEF-GH"),
            Err(AccountError::InvalidCode(_))
        ));
    }

    // ── normalise_alias ──────────────────────────────────────────────

    #[test]
    fn normalise_alias_trims_and_drops_controls() {
        assert_eq!(
            normalise_alias("  Manuel's Laptop\t\n ").unwrap(),
            "Manuel's Laptop"
        );
    }

    #[test]
    fn normalise_alias_truncates_to_80_chars() {
        let long: String = "x".repeat(200);
        assert_eq!(normalise_alias(&long).unwrap().chars().count(), 80);
    }

    #[test]
    fn normalise_alias_rejects_empty_after_trim() {
        assert!(matches!(
            normalise_alias("   \n\t  "),
            Err(AccountError::InvalidCode(_))
        ));
    }

    // ── pair (happy path) ─────────────────────────────────────────────

    #[tokio::test]
    async fn pair_redeems_code_and_persists_credentials() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/api/devices/redeem")
            .match_header("content-type", "application/json")
            .match_body(mockito::Matcher::JsonString(
                r#"{"code":"7K3-9PQ-XR","alias":"Manuels Laptop"}"#.to_string(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"deviceId":"123-456-789","token":"deadbeef0123"}"#)
            .create_async()
            .await;

        let store = MemTokenStore::default();
        let dir = tempdir().unwrap();

        let device_id = pair(
            &http(),
            &store,
            &server.url(),
            "7k3-9pq-xr",
            "Manuels Laptop",
            dir.path(),
        )
        .await
        .expect("pair succeeds");

        assert_eq!(device_id, "123-456-789");
        assert_eq!(
            store.read().unwrap(),
            Some("deadbeef0123".to_string()),
            "token must be in store"
        );
        assert_eq!(
            read_device_id(dir.path()).unwrap(),
            Some("123-456-789".to_string()),
            "device_id must be on disk"
        );
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn pair_400_response_surfaces_as_invalid_code() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/api/devices/redeem")
            .with_status(410)
            .with_body(r#"{"error":"expired"}"#)
            .create_async()
            .await;

        let store = MemTokenStore::default();
        let dir = tempdir().unwrap();
        let err = pair(
            &http(),
            &store,
            &server.url(),
            "7K3-9PQ-XR",
            "Laptop",
            dir.path(),
        )
        .await
        .expect_err("expired must fail");
        assert!(matches!(err, AccountError::InvalidCode(_)));
        assert!(
            store.read().unwrap().is_none(),
            "failed pair must not write token"
        );
        assert!(
            read_device_id(dir.path()).unwrap().is_none(),
            "failed pair must not write device_id"
        );
    }

    #[tokio::test]
    async fn pair_500_response_surfaces_as_backend_error() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/api/devices/redeem")
            .with_status(500)
            .with_body("internal")
            .create_async()
            .await;

        let store = MemTokenStore::default();
        let dir = tempdir().unwrap();
        let err = pair(
            &http(),
            &store,
            &server.url(),
            "7K3-9PQ-XR",
            "Laptop",
            dir.path(),
        )
        .await
        .expect_err("500 must fail");
        match err {
            AccountError::Backend { status, .. } => assert_eq!(status, 500),
            other => panic!("expected Backend, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn pair_rejects_malformed_response() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/api/devices/redeem")
            .with_status(200)
            .with_body(r#"{"unexpected":"shape"}"#)
            .create_async()
            .await;

        let store = MemTokenStore::default();
        let dir = tempdir().unwrap();
        let err = pair(
            &http(),
            &store,
            &server.url(),
            "7K3-9PQ-XR",
            "Laptop",
            dir.path(),
        )
        .await
        .expect_err("malformed response must fail");
        assert!(matches!(err, AccountError::MalformedResponse(_)));
    }

    #[tokio::test]
    async fn pair_rejects_empty_token_in_response() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/api/devices/redeem")
            .with_status(200)
            .with_body(r#"{"deviceId":"123-456-789","token":""}"#)
            .create_async()
            .await;

        let store = MemTokenStore::default();
        let dir = tempdir().unwrap();
        let err = pair(
            &http(),
            &store,
            &server.url(),
            "7K3-9PQ-XR",
            "Laptop",
            dir.path(),
        )
        .await
        .expect_err("empty token must fail");
        assert!(matches!(err, AccountError::MalformedResponse(_)));
        assert!(
            store.read().unwrap().is_none(),
            "no token must be persisted on malformed response"
        );
    }

    // ── unpair ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn unpair_wipes_local_state_on_success() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("DELETE", "/api/devices/123-456-789")
            .match_header("authorization", "Bearer deadbeef0123")
            .with_status(204)
            .create_async()
            .await;

        let store = MemTokenStore::default();
        store.write("deadbeef0123").unwrap();
        let dir = tempdir().unwrap();
        write_device_id(dir.path(), "123-456-789").unwrap();

        unpair(&http(), &store, &server.url(), dir.path())
            .await
            .expect("unpair succeeds");
        assert!(store.read().unwrap().is_none(), "token must be wiped");
        assert!(
            read_device_id(dir.path()).unwrap().is_none(),
            "device_id must be wiped"
        );
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn unpair_is_idempotent_when_nothing_is_paired() {
        let server = mockito::Server::new_async().await;
        let store = MemTokenStore::default();
        let dir = tempdir().unwrap();

        // No HTTP mock — unpair must NOT call DELETE without credentials.
        unpair(&http(), &store, &server.url(), dir.path())
            .await
            .expect("unpair-when-unpaired is Ok");
    }

    #[tokio::test]
    async fn unpair_wipes_local_state_even_when_backend_rejects_delete() {
        // Backend might not yet support Bearer-DELETE (gh #16/#17 not
        // wired). The user's intent is "stop being paired"; honour it
        // locally regardless of what the server says.
        let mut server = mockito::Server::new_async().await;
        server
            .mock("DELETE", "/api/devices/123-456-789")
            .with_status(401)
            .create_async()
            .await;

        let store = MemTokenStore::default();
        store.write("deadbeef0123").unwrap();
        let dir = tempdir().unwrap();
        write_device_id(dir.path(), "123-456-789").unwrap();

        unpair(&http(), &store, &server.url(), dir.path())
            .await
            .expect("unpair tolerates backend-side failure");
        assert!(
            store.read().unwrap().is_none(),
            "token must still be wiped locally"
        );
        assert!(
            read_device_id(dir.path()).unwrap().is_none(),
            "device_id must still be wiped locally"
        );
    }

    #[tokio::test]
    async fn unpair_tolerates_transport_error() {
        // Point at an unreachable URL — the DELETE will fail
        // immediately. unpair must still wipe local state.
        let store = MemTokenStore::default();
        store.write("deadbeef0123").unwrap();
        let dir = tempdir().unwrap();
        write_device_id(dir.path(), "123-456-789").unwrap();

        // 127.0.0.1:1 is RFC-reserved and connect-refused on Linux.
        unpair(&http(), &store, "http://127.0.0.1:1", dir.path())
            .await
            .expect("unpair tolerates transport error");
        assert!(store.read().unwrap().is_none());
    }

    // ── read_device_id ───────────────────────────────────────────────

    #[test]
    fn read_device_id_returns_none_when_file_missing() {
        let dir = tempdir().unwrap();
        assert!(read_device_id(dir.path()).unwrap().is_none());
    }

    #[test]
    fn read_device_id_trims_trailing_newline() {
        let dir = tempdir().unwrap();
        std::fs::write(device_id_path(dir.path()), "123-456-789\n").unwrap();
        assert_eq!(
            read_device_id(dir.path()).unwrap(),
            Some("123-456-789".to_string())
        );
    }
}
