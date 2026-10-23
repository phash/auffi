//! Single home for the `ws[s]://…` → `http[s]://…` mappings every
//! backend-facing module needs (HTTP API base, WS `Origin` header).
//!
//! Four near-identical copies of this mapping used to live in
//! `heartbeat.rs`, `signaling.rs`, `unattended_cmd.rs` and
//! `turn_config.rs`, each with a *different* unknown-scheme fallback
//! ("http://localhost", "http://localhost:8080", input-unchanged).
//! The deliberate unified behaviour is:
//!
//! * scheme swap `wss → https` / `ws → http`
//! * host[:port] only — the path is always dropped. An `Origin`
//!   header cannot carry a path, and every HTTP caller builds its own
//!   path on top of the base.
//! * unknown scheme → `http://localhost:8080` (the dev backend).
//!   Real configs never hit this: `backend_ws_url_secure()` only
//!   passes `ws://`/`wss://` URLs through.

/// Map a backend WS URL to the matching HTTP base (`scheme://host[:port]`).
pub fn http_base_from_ws(ws_url: &str) -> String {
    if let Some(rest) = ws_url.strip_prefix("wss://") {
        return format!("https://{}", authority_host(rest));
    }
    if let Some(rest) = ws_url.strip_prefix("ws://") {
        return format!("http://{}", authority_host(rest));
    }
    "http://localhost:8080".to_string()
}

/// `host[:port]` of the part after `scheme://`: the authority ends at the
/// first `/`, `?` or `#`, and any `user:pass@` is dropped — credentials have
/// no place in an `Origin` header or a REST base.
fn authority_host(rest: &str) -> &str {
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    authority.rsplit('@').next().unwrap_or(authority)
}

/// The `Origin` header value for requests to the backend (WS upgrade
/// and `/turn-credentials`). The backend's `verifyClient` and the TURN
/// endpoint both check it against `ALLOWED_ORIGINS`; native clients
/// send no Origin by default, so we supply the backend's own origin —
/// overridable via `AUFFI_SHARER_ORIGIN` for split-host deployments.
pub fn origin_from_ws(ws_url: &str) -> String {
    if let Ok(custom) = std::env::var("AUFFI_SHARER_ORIGIN") {
        return custom;
    }
    http_base_from_ws(ws_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The env-override branch of `origin_from_ws` is deliberately not
    // exercised here: parallel tests racing on process-wide env vars
    // flaked CI (CQ M-20). Only the pure mapping is pinned.

    #[test]
    fn wss_maps_to_https_dropping_the_path() {
        assert_eq!(
            http_base_from_ws("wss://auffi.app/signal"),
            "https://auffi.app"
        );
    }

    #[test]
    fn ws_maps_to_http_keeping_the_port() {
        assert_eq!(
            http_base_from_ws("ws://localhost:8080/signal"),
            "http://localhost:8080"
        );
    }

    #[test]
    fn no_path_is_fine() {
        assert_eq!(
            http_base_from_ws("ws://localhost:8080"),
            "http://localhost:8080"
        );
    }

    #[test]
    fn unknown_scheme_falls_back_to_dev_backend() {
        // One deliberate fallback for the whole crate — previously the four
        // copies disagreed ("http://localhost" vs ":8080" vs input-unchanged).
        assert_eq!(http_base_from_ws("garbage://nope"), "http://localhost:8080");
        assert_eq!(
            http_base_from_ws("https://auffi.app"),
            "http://localhost:8080"
        );
    }

    // A query or fragment directly after the host stayed glued to it
    // ("https://auffi.app?x=1"), and userinfo ended up in the Origin header
    // and in every REST URL built on the base.
    #[test]
    fn query_fragment_and_userinfo_never_reach_the_base() {
        assert_eq!(
            http_base_from_ws("wss://auffi.app?v=2"),
            "https://auffi.app"
        );
        assert_eq!(
            http_base_from_ws("wss://auffi.app#frag"),
            "https://auffi.app"
        );
        assert_eq!(
            http_base_from_ws("wss://user:secret@auffi.app/signal"),
            "https://auffi.app"
        );
        assert_eq!(
            http_base_from_ws("ws://me@localhost:8080?x=1"),
            "http://localhost:8080"
        );
    }

    #[test]
    fn origin_equals_http_base_without_override() {
        // AUFFI_SHARER_ORIGIN is unset in the test environment.
        assert_eq!(
            origin_from_ws("wss://auffi.app/signal"),
            "https://auffi.app"
        );
    }
}
