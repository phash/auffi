//! Update-Notifier — checks GitHub Releases for a newer Sharer version.
//!
//! Called from the webview on app start. Returns an `UpdateInfo` that
//! the UI uses to decide whether to show the "Neue Version verfügbar"-
//! Banner. Any network or parse failure returns `available: false` so
//! the banner stays hidden — we never want to bother the user with a
//! "couldn't check for updates" notice; the next launch will retry.
//!
//! Network call is gated on debug-vs-release: in `cargo test --lib`
//! the actual fetch is never exercised; only the pure helpers
//! (`parse_version`, `is_newer_version`) are.

use serde::{Deserialize, Serialize};

/// Result type returned over IPC to the webview.
///
/// `available=false` is the safe default — both for "couldn't reach
/// GitHub" and for "user is already on latest". The webview hides the
/// banner in both cases.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateInfo {
    pub available: bool,
    pub current: String,
    pub latest: String,
    pub download_url: String,
}

/// Parse a `major.minor.patch`-style version string into a 3-tuple.
///
/// Accepts an optional leading `v` so `v0.4.5` (GitHub tag form) and
/// `0.4.5` (Cargo.toml form) round-trip equivalently. Returns `None`
/// on anything that doesn't match exactly three numeric parts —
/// callers should treat that as "no comparison possible".
pub(crate) fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
    let v = v.strip_prefix('v').unwrap_or(v);
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ))
}

/// True if `latest` is a strictly newer version than `current`.
///
/// Safety property: if either input fails to parse, returns `false`.
/// A malformed tag from GitHub or a corrupted local version string
/// must NEVER nudge the user toward downloading an unverified
/// "update" — the banner stays hidden on parse failure.
pub(crate) fn is_newer_version(current: &str, latest: &str) -> bool {
    match (parse_version(current), parse_version(latest)) {
        (Some(c), Some(l)) => l > c,
        _ => false,
    }
}

/// User-facing landing for the "Jetzt herunterladen" link in the banner.
/// Kept as a constant so tests can pin it and copy-paste audits stay easy.
pub(crate) const DOWNLOAD_LANDING: &str = "https://auffi.app/download/";

/// GitHub-Releases-API endpoint. The endpoint redirects from the
/// `latest`-symlink to the actual release JSON; default reqwest follows
/// 30x so we don't need to handle that here.
const GITHUB_LATEST: &str = "https://api.github.com/repos/phash/auffi/releases/latest";

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
}

/// Fetch the latest release's `tag_name` from GitHub. Times out at 5 s
/// (we want a snappy app start; if GitHub is slow we just skip the check
/// this launch). The `User-Agent` is mandatory — GitHub-API rejects
/// requests without one with HTTP 403.
async fn fetch_latest_tag() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .user_agent(format!("auffi-sharer/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(GITHUB_LATEST)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("github api status {}", response.status()));
    }
    let body: GhRelease = response.json().await.map_err(|e| e.to_string())?;
    Ok(body.tag_name)
}

/// Tauri command — webview calls this on app init.
#[tauri::command]
pub async fn check_for_update() -> UpdateInfo {
    let current = env!("CARGO_PKG_VERSION").to_string();
    match fetch_latest_tag().await {
        Ok(tag) => {
            let latest = tag.strip_prefix('v').unwrap_or(&tag).to_string();
            UpdateInfo {
                available: is_newer_version(&current, &latest),
                current,
                latest,
                download_url: DOWNLOAD_LANDING.to_string(),
            }
        }
        Err(_) => UpdateInfo {
            available: false,
            current: current.clone(),
            latest: current,
            download_url: DOWNLOAD_LANDING.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_accepts_plain_and_v_prefixed() {
        assert_eq!(parse_version("0.4.5"), Some((0, 4, 5)));
        assert_eq!(parse_version("v0.4.5"), Some((0, 4, 5)));
        assert_eq!(parse_version("1.2.3"), Some((1, 2, 3)));
    }

    #[test]
    fn parse_version_rejects_malformed() {
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("0.4"), None);
        assert_eq!(parse_version("0.4.5.6"), None);
        assert_eq!(parse_version("0.4.x"), None);
        assert_eq!(parse_version("vNext"), None);
    }

    #[test]
    fn is_newer_version_detects_patch_minor_major_bumps() {
        assert!(is_newer_version("0.4.4", "0.4.5"));
        assert!(is_newer_version("0.4.4", "0.5.0"));
        assert!(is_newer_version("0.4.4", "1.0.0"));
    }

    #[test]
    fn is_newer_version_equal_or_older_returns_false() {
        assert!(!is_newer_version("0.4.4", "0.4.4"));
        assert!(!is_newer_version("0.4.4", "0.4.3"));
        assert!(!is_newer_version("1.0.0", "0.9.99"));
    }

    #[test]
    fn is_newer_version_tolerates_v_prefix_on_either_side() {
        assert!(is_newer_version("0.4.4", "v0.4.5"));
        assert!(is_newer_version("v0.4.4", "0.4.5"));
        assert!(is_newer_version("v0.4.4", "v0.4.5"));
    }

    #[test]
    fn is_newer_version_returns_false_on_unparseable_input() {
        // Safety pin: malformed input MUST NOT nudge the user toward an
        // unverified "update". The banner stays hidden on parse failure.
        assert!(!is_newer_version("garbage", "0.4.5"));
        assert!(!is_newer_version("0.4.4", "garbage"));
        assert!(!is_newer_version("garbage", "garbage"));
        assert!(!is_newer_version("", ""));
    }

    #[test]
    fn download_landing_points_at_auffi_app_download_page() {
        // Pin the destination so a future refactor can't silently
        // redirect users to a third-party host.
        assert_eq!(DOWNLOAD_LANDING, "https://auffi.app/download/");
    }
}
