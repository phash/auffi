use serde::Deserialize;
use webrtc::ice_transport::{ice_credential_type::RTCIceCredentialType, ice_server::RTCIceServer};

#[derive(Deserialize)]
pub struct TurnCredentials {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
    pub ttl: u32,
}

/// Convert optional TURN credentials and an optional fallback STUN URL into a
/// `Vec<RTCIceServer>`.
///
/// TURN servers (with Password credential type) are prepended so they are tried
/// first; the fallback STUN server is appended last.  When both are absent the
/// returned vec is empty — the WebRTC stack's built-in candidates still work for
/// direct connections.
pub fn to_ice_servers(
    creds: Option<TurnCredentials>,
    fallback_stun: Option<&str>,
) -> Vec<RTCIceServer> {
    let mut servers: Vec<RTCIceServer> = Vec::new();

    if let Some(c) = creds {
        for url in c.urls {
            servers.push(RTCIceServer {
                urls: vec![url],
                username: c.username.clone(),
                credential: c.credential.clone(),
                credential_type: RTCIceCredentialType::Password,
            });
        }
    }

    if let Some(stun) = fallback_stun {
        servers.push(RTCIceServer {
            urls: vec![stun.to_string()],
            ..Default::default()
        });
    }

    servers
}

/// Fetch ephemeral TURN credentials from the backend and return a ready-to-use
/// `Vec<RTCIceServer>`.
///
/// On any failure (network error, non-200 response, parse failure, timeout) the
/// function falls back gracefully — it never propagates errors to the caller.
pub async fn fetch_ice_servers(backend_http_url: &str) -> Vec<RTCIceServer> {
    let fallback_stun = std::env::var("SCREENIE_FALLBACK_STUN").ok();
    let fallback_ref = fallback_stun.as_deref();

    let url = format!("{backend_http_url}/turn-credentials");

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("TURN fetch: failed to build HTTP client: {e}");
            return to_ice_servers(None, fallback_ref);
        }
    };

    let resp = match client.post(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("TURN fetch: request to {url} failed: {e}");
            return to_ice_servers(None, fallback_ref);
        }
    };

    if !resp.status().is_success() {
        log::warn!("TURN fetch: server returned {}", resp.status());
        return to_ice_servers(None, fallback_ref);
    }

    let creds: TurnCredentials = match resp.json().await {
        Ok(c) => c,
        Err(e) => {
            log::warn!("TURN fetch: failed to parse response: {e}");
            return to_ice_servers(None, fallback_ref);
        }
    };

    log::debug!("TURN fetch: credentials valid for {} seconds", creds.ttl);
    to_ice_servers(Some(creds), fallback_ref)
}

/// Derive an HTTP/HTTPS base URL from the WebSocket signaling URL by:
/// - replacing the `ws://` or `wss://` scheme with `http://` or `https://`
/// - stripping any trailing `/signal` path suffix
pub fn ws_url_to_http(ws_url: &str) -> String {
    let without_scheme = if let Some(rest) = ws_url.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = ws_url.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        ws_url.to_string()
    };

    without_scheme
        .strip_suffix("/signal")
        .unwrap_or(&without_scheme)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_turn_credentials_from_json() {
        let json = r#"{
            "urls": ["turn:turn.example.com:3478", "turns:turn.example.com:5349"],
            "username": "1234567890:some-uuid",
            "credential": "abc123base64==",
            "ttl": 3600
        }"#;
        let creds: TurnCredentials =
            serde_json::from_str(json).expect("should deserialize TurnCredentials");
        assert_eq!(creds.urls.len(), 2);
        assert_eq!(creds.urls[0], "turn:turn.example.com:3478");
        assert_eq!(creds.username, "1234567890:some-uuid");
        assert_eq!(creds.credential, "abc123base64==");
        assert_eq!(creds.ttl, 3600);
    }

    #[test]
    fn convert_credentials_to_ice_servers() {
        let creds = TurnCredentials {
            urls: vec![
                "turn:turn.example.com:3478".to_string(),
                "turns:turn.example.com:5349".to_string(),
            ],
            username: "user123".to_string(),
            credential: "cred456".to_string(),
            ttl: 3600,
        };

        let servers = to_ice_servers(Some(creds), None);

        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].urls, vec!["turn:turn.example.com:3478"]);
        assert_eq!(servers[0].username, "user123");
        assert_eq!(servers[0].credential, "cred456");
        assert!(matches!(
            servers[0].credential_type,
            RTCIceCredentialType::Password
        ));
        assert_eq!(servers[1].urls, vec!["turns:turn.example.com:5349"]);
        assert_eq!(servers[1].username, "user123");
        assert_eq!(servers[1].credential, "cred456");
    }

    #[test]
    fn fallback_only_when_no_credentials() {
        let servers = to_ice_servers(None, Some("stun:stun.example.com:3478"));
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].urls, vec!["stun:stun.example.com:3478"]);
        assert_eq!(servers[0].username, "");
        assert_eq!(servers[0].credential, "");
    }

    #[test]
    fn empty_when_neither_credentials_nor_fallback() {
        let servers = to_ice_servers(None, None);
        assert!(servers.is_empty());
    }

    #[test]
    fn ws_url_to_http_converts_ws_scheme() {
        assert_eq!(
            ws_url_to_http("ws://localhost:8080/signal"),
            "http://localhost:8080"
        );
    }

    #[test]
    fn ws_url_to_http_converts_wss_scheme() {
        assert_eq!(
            ws_url_to_http("wss://screenie.example.com/signal"),
            "https://screenie.example.com"
        );
    }

    #[test]
    fn ws_url_to_http_no_signal_suffix() {
        assert_eq!(
            ws_url_to_http("ws://localhost:8080"),
            "http://localhost:8080"
        );
    }
}
