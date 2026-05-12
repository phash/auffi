use serde::Deserialize;
use webrtc::ice_transport::{ice_credential_type::RTCIceCredentialType, ice_server::RTCIceServer};

#[derive(Deserialize)]
pub struct TurnCredentials {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
    pub ttl: u32,
}

/// Convert optional TURN credentials into a `Vec<RTCIceServer>`.
///
/// When credentials are absent the returned vec is empty — direct connections
/// still work via peer-reflexive candidates on most home NATs.
/// Third-party STUN servers are intentionally not used (DSGVO compliance).
pub fn to_ice_servers(creds: Option<TurnCredentials>) -> Vec<RTCIceServer> {
    let Some(c) = creds else {
        return Vec::new();
    };

    c.urls
        .into_iter()
        .map(|url| RTCIceServer {
            urls: vec![url],
            username: c.username.clone(),
            credential: c.credential.clone(),
            credential_type: RTCIceCredentialType::Password,
        })
        .collect()
}

/// Fetch ephemeral TURN credentials from the backend and return a ready-to-use
/// `Vec<RTCIceServer>`.
///
/// On any failure (network error, non-200 response, parse failure, timeout)
/// returns an empty list — the caller proceeds with no STUN/TURN servers.
/// Third-party STUN fallbacks are intentionally omitted (DSGVO compliance).
pub async fn fetch_ice_servers(backend_http_url: &str) -> Vec<RTCIceServer> {
    let url = format!("{backend_http_url}/turn-credentials");

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("TURN fetch: failed to build HTTP client: {e}");
            return Vec::new();
        }
    };

    let resp = match client.post(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("TURN fetch: request to {url} failed: {e}");
            return Vec::new();
        }
    };

    if !resp.status().is_success() {
        log::warn!("TURN fetch: server returned {}", resp.status());
        return Vec::new();
    }

    let creds: TurnCredentials = match resp.json().await {
        Ok(c) => c,
        Err(e) => {
            log::warn!("TURN fetch: failed to parse response: {e}");
            return Vec::new();
        }
    };

    log::debug!("TURN fetch: credentials valid for {} seconds", creds.ttl);
    to_ice_servers(Some(creds))
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

        let servers = to_ice_servers(Some(creds));

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
    fn empty_when_no_credentials() {
        let servers = to_ice_servers(None);
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
            ws_url_to_http("wss://auffi.example.com/signal"),
            "https://auffi.example.com"
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
