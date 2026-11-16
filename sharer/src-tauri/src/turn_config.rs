use serde::Deserialize;
use webrtc::peer_connection::RTCIceServer;

#[derive(Debug, Clone, Deserialize)]
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

    let stun: Vec<RTCIceServer> = c
        .urls
        .iter()
        .filter_map(|url| stun_url_of(url))
        .map(|url| RTCIceServer {
            urls: vec![url],
            ..Default::default()
        })
        .collect();
    c.urls
        .into_iter()
        .map(|url| RTCIceServer {
            urls: vec![url],
            username: c.username.clone(),
            credential: c.credential.clone(),
        })
        .chain(stun)
        .collect()
}

/// The `stun:` URL of the same host and port as a UDP `turn:` URL.
///
/// webrtc-rs 0.21 gathers server-reflexive candidates from `stun:` servers
/// only, while 0.17 asked every URL. coturn answers Binding requests on its
/// TURN port, so this restores the sharer's srflx candidate without a
/// third-party server.
fn stun_url_of(turn_url: &str) -> Option<String> {
    let rest = turn_url.strip_prefix("turn:")?;
    let (host_port, query) = rest.split_once('?').unwrap_or((rest, ""));
    let udp = query
        .split('&')
        .all(|param| param.strip_prefix("transport=").is_none_or(|t| t == "udp"));
    udp.then(|| format!("stun:{host_port}"))
}

/// Fetch ephemeral TURN credentials from the backend and return a ready-to-use
/// `Vec<RTCIceServer>`.
///
/// On any failure (network error, non-200 response, parse failure, timeout)
/// returns an empty list — the caller proceeds with no STUN/TURN servers.
/// Third-party STUN fallbacks are intentionally omitted (DSGVO compliance).
pub async fn fetch_ice_servers(
    backend_http_url: &str,
    origin: &str,
    session_code: &str,
) -> Vec<RTCIceServer> {
    let url = format!("{backend_http_url}/turn-credentials");

    // Backend enforces an Origin allow-list on /turn-credentials. reqwest
    // does not send Origin by default (it's a browser concept), so the
    // caller supplies one via `backend_urls::origin_from_ws`.
    let client = match crate::tls_roots::http_client(std::time::Duration::from_secs(3)) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("TURN fetch: failed to build HTTP client: {e}");
            return Vec::new();
        }
    };

    // Backend gates issuance on a live signaling session — the request
    // body must include the assigned 9-digit code (gh #60).
    let body = serde_json::json!({ "code": session_code });
    let resp = match client
        .post(&url)
        .header("Origin", origin)
        .json(&body)
        .send()
        .await
    {
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
    // Redact any IP literals in the TURN URLs before logging — don't expose
    // relay infrastructure addresses in the diagnostic log.
    let redacted_urls: Vec<String> = creds
        .urls
        .iter()
        .map(|u| crate::ip_redact::redact_ips_in_text(u))
        .collect();
    crate::dbg_log(&format!(
        "[turn-fetch] urls={redacted_urls:?} username_len={} credential_len={} ttl={}",
        creds.username.len(),
        creds.credential.len(),
        creds.ttl
    ));
    to_ice_servers(Some(creds))
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

        assert_eq!(
            servers.len(),
            3,
            "both TURN servers plus the derived STUN one"
        );
        assert_eq!(servers[0].urls, vec!["turn:turn.example.com:3478"]);
        assert_eq!(servers[0].username, "user123");
        assert_eq!(servers[0].credential, "cred456");
        assert_eq!(servers[1].urls, vec!["turns:turn.example.com:5349"]);
        assert_eq!(servers[1].username, "user123");
        assert_eq!(servers[1].credential, "cred456");
        assert_eq!(servers[2].urls, vec!["stun:turn.example.com:3478"]);
    }

    // webrtc-rs 0.21 asks only `stun:` servers for a server-reflexive
    // candidate (0.17 asked every URL, the TURN one included). Our coturn
    // answers plain Binding requests on the TURN port, so the sharer gets
    // its srflx candidate from the same host; without it a sharer behind
    // NAT had only host and relay candidates and more sessions went
    // through the relay.
    #[test]
    fn a_udp_turn_server_also_serves_as_stun() {
        let creds = TurnCredentials {
            urls: vec![
                "turn:turn.example.com:3478?transport=udp".to_string(),
                "turns:turn.example.com:5349?transport=tcp".to_string(),
            ],
            username: "user123".to_string(),
            credential: "cred456".to_string(),
            ttl: 3600,
        };

        let servers = to_ice_servers(Some(creds));

        let stun: Vec<_> = servers
            .iter()
            .filter(|s| s.urls.iter().any(|u| u.starts_with("stun:")))
            .collect();
        assert_eq!(stun.len(), 1);
        assert_eq!(stun[0].urls, vec!["stun:turn.example.com:3478"]);
        assert!(stun[0].username.is_empty() && stun[0].credential.is_empty());
    }

    #[test]
    fn empty_when_no_credentials() {
        let servers = to_ice_servers(None);
        assert!(servers.is_empty());
    }

    // The backend may now rate-limit /turn-credentials with 429. Like every
    // other non-OK answer that must degrade to "no TURN" (host/mDNS
    // candidates only), never fail the stream start.
    #[tokio::test]
    async fn rate_limited_turn_fetch_degrades_to_no_servers() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/turn-credentials")
            .with_status(429)
            .with_body(r#"{"error":"rate-limited"}"#)
            .create_async()
            .await;
        let servers = fetch_ice_servers(&server.url(), "https://auffi.app", "123456789").await;
        assert!(servers.is_empty());
        mock.assert_async().await;
    }
}
