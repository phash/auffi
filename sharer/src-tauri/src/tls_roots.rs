//! TLS trust anchors for the signaling WebSockets and the REST clients.
//!
//! `tokio-tungstenite`'s `rustls-tls-native-roots` feature builds its
//! connector from the OS certificate store alone, read once at process start.
//! On Windows that store is populated lazily: a machine that has not yet
//! cached a given root simply does not have it, and rustls — unlike the
//! platform verifier Edge uses — never triggers Windows' on-demand fetch.
//!
//! Observed on a fresh Windows 11 (2026-08-28): `auffi.app` serves the newer
//! Let's Encrypt hierarchy (ISRG Root X2), Edge loaded the site fine, and the
//! sharer failed every connection with `invalid peer certificate:
//! UnknownIssuer`. The app was unusable on exactly the kind of rarely-updated
//! machine it exists to help.
//!
//! So the trust anchors are merged rather than chosen:
//!   - the OS store, so a self-hoster's private or corporate CA keeps working
//!     (dropping it for bundled roots alone would break self-hosting, which is
//!     a core promise of the project);
//!   - Mozilla's bundled set as a floor, so a stale OS store cannot break the
//!     public service.

use std::sync::{Arc, OnceLock};

use rustls::pki_types::CertificateDer;
use rustls::{ClientConfig, RootCertStore};
use tokio_tungstenite::Connector;

use crate::dbg_log;

/// Merge OS-provided trust anchors with the bundled Mozilla set.
///
/// Malformed or unsupported OS certificates are skipped rather than fatal —
/// a single bad entry in a corporate store must not cost the user every
/// other anchor.
pub(crate) fn merge_roots<I>(native: I) -> RootCertStore
where
    I: IntoIterator<Item = CertificateDer<'static>>,
{
    let mut store = RootCertStore::empty();
    store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for cert in native {
        // add() rejects anchors it cannot parse; ignoring the error is the
        // point — see the doc comment above.
        let _ = store.add(cert);
    }
    store
}

/// Shared connector for every signaling WebSocket.
pub(crate) fn connector() -> Connector {
    Connector::Rustls(client_config())
}

/// HTTP client for every REST call the sharer makes (pairing, feedback,
/// TURN credentials, update check), on the same merged trust anchors as the
/// WebSockets. reqwest's own rustls setup trusts one source only, which is
/// the Windows `UnknownIssuer` failure this module exists for.
pub(crate) fn http_client(timeout: std::time::Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .use_preconfigured_tls(ClientConfig::clone(&client_config()))
        .timeout(timeout)
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// The merged-roots rustls config, built once: reading the OS store on every
/// reconnect would be wasted work, and the heartbeat reconnects on a backoff.
/// Loading the OS store can fail wholesale (no permission, no store) — that
/// degrades to the bundled roots, which still reach the public service, and
/// is logged once here.
fn client_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    let config = CONFIG.get_or_init(|| {
        let loaded = rustls_native_certs::load_native_certs();
        let native = loaded.certs.len();
        for err in &loaded.errors {
            dbg_log(&format!("[tls] OS trust store: {err}"));
        }
        let store = merge_roots(loaded.certs);
        dbg_log(&format!(
            "[tls] trust anchors: {} from the OS store, {} total after merging the bundled set",
            native,
            store.len()
        ));
        // Name the provider instead of relying on the process default: both
        // 'ring' and 'aws-lc-rs' are in the graph, so rustls refuses to pick
        // one, and the default is installed by run() — which unit tests and
        // any future non-Tauri entry point never call.
        Arc::new(
            ClientConfig::builder_with_provider(rustls::crypto::ring::default_provider().into())
                .with_safe_default_protocol_versions()
                .expect("ring provider supports the default protocol versions")
                .with_root_certificates(store)
                .with_no_client_auth(),
        )
    });
    Arc::clone(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_roots_stand_alone_when_the_os_store_is_empty() {
        // The Windows failure this module exists for: the OS store yields
        // nothing usable, and the connection must still succeed against the
        // public service.
        let store = merge_roots(Vec::new());
        assert!(
            store.len() > 100,
            "bundled Mozilla set should carry a full root list, got {}",
            store.len()
        );
    }

    #[test]
    fn os_anchors_are_added_on_top_of_the_bundled_set() {
        // A self-hoster's private CA has to survive the merge, or self-hosting
        // against an internal endpoint breaks.
        let baseline = merge_roots(Vec::new()).len();
        let extra = CertificateDer::from(SELF_SIGNED_DER.to_vec());
        let merged = merge_roots(vec![extra]);
        assert_eq!(
            merged.len(),
            baseline + 1,
            "a valid extra anchor must be added, not dropped"
        );
    }

    #[test]
    fn a_malformed_os_anchor_does_not_cost_the_others() {
        let baseline = merge_roots(Vec::new()).len();
        let junk = CertificateDer::from(vec![0x00, 0x01, 0x02, 0x03]);
        let merged = merge_roots(vec![junk]);
        assert_eq!(
            merged.len(),
            baseline,
            "unparsable anchor should be skipped, leaving the rest intact"
        );
    }

    #[test]
    fn the_root_the_windows_machine_lacked_is_always_present() {
        // auffi.app's chain terminates at ISRG Root X2. A fresh Windows 11
        // store did not have it, Edge fetched it on demand and rustls did
        // not — which is the whole reason this module exists. Pin it: if the
        // bundled set ever loses this anchor, the Windows failure returns.
        let found = webpki_roots::TLS_SERVER_ROOTS.iter().any(|anchor| {
            anchor
                .subject
                .as_ref()
                .windows(b"ISRG Root X2".len())
                .any(|w| w == b"ISRG Root X2")
        });
        assert!(found, "bundled roots must carry ISRG Root X2");
    }

    // The REST clients (pairing, feedback, TURN fetch, update check) built
    // their own reqwest client on the OS store alone — the same Windows
    // UnknownIssuer failure the WSS fix closed, one layer over. They must run
    // on the merged config; reqwest only accepts a preconfigured rustls
    // config of the exact rustls version it links, so building is the check.
    #[tokio::test]
    async fn the_rest_client_runs_on_the_merged_config() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/ping")
            .with_status(204)
            .create_async()
            .await;
        let client = http_client(std::time::Duration::from_secs(5)).expect("client builds");
        let status = client
            .get(format!("{}/ping", server.url()))
            .send()
            .await
            .expect("request")
            .status();
        assert_eq!(status.as_u16(), 204);
        mock.assert_async().await;
    }

    /// Minimal self-signed DER used only to prove the merge path accepts a
    /// valid anchor. Generated once; not a trusted certificate anywhere.
    const SELF_SIGNED_DER: &[u8] = include_bytes!("../tests/fixtures/test-ca.der");
}
