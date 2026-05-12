//! UPnP-IGD external-IP discovery — phase 1 of issue #89.
//!
//! Asks the home router (if it speaks UPnP) for its public IPv4 and
//! caches the result for the process lifetime. `SharerPeer::new` reads
//! the cache and, if a public IP was found, declares it to `webrtc-rs`
//! as a `Srflx` candidate via `SettingEngine::set_nat_1to1_ips`. That
//! adds a second path to our public address alongside STUN — useful
//! when the STUN server is unreachable but the router still answers,
//! and a small precondition for phase 2 (port-pinned UDPMux mapping).
//!
//! All failures are silent: no gateway, gateway refuses, network down,
//! discovery timeout — every path returns `None`. Best-effort
//! augmentation, never blocks the connect flow.
//!
//! Phase 2 (deferred — tracked in #89): pre-bind a UdpSocket, request a
//! same-port UDP mapping from the gateway, and hand the socket to
//! webrtc-rs via UDPMux so ICE host candidates emit
//! `external_ip:external_port`. That needs a SharerPeer construction
//! restructure and is its own work item.

use std::net::IpAddr;
use std::time::Duration;

use igd_next::aio::tokio::search_gateway;
use igd_next::SearchOptions;
use tokio::sync::OnceCell;

/// Discovered external endpoint. Phase 1 only carries the IP — `port`
/// is reserved for phase 2 (port-pinned UDPMux).
#[derive(Debug, Clone, Copy)]
pub struct ExternalEndpoint {
    pub ip: IpAddr,
}

/// Process-wide cache. First caller pays the discovery cost; the rest
/// see the cached `Option<…>` instantly. A `None` value is cached too —
/// once we know the router doesn't speak UPnP there's no reason to
/// re-ask every session start.
static CACHE: OnceCell<Option<ExternalEndpoint>> = OnceCell::const_new();

/// Hard upper bound on the SSDP+SOAP roundtrip. Routers that don't
/// answer within this window are treated as "no UPnP available." Kept
/// short because this runs on the session-start critical path; we'd
/// rather lose a slow router's contribution than block the user's
/// "Verbindung wird hergestellt…" UI.
const DISCOVERY_BUDGET: Duration = Duration::from_millis(1500);

/// Return the cached external endpoint, running discovery on the first
/// call. Discovery has a hard `DISCOVERY_BUDGET` so a slow or
/// unreachable router can't stall the caller.
pub async fn cached_external_endpoint() -> Option<ExternalEndpoint> {
    *CACHE
        .get_or_init(|| async { probe_with_budget(DISCOVERY_BUDGET).await })
        .await
}

/// Probe the local UPnP IGD gateway for its external IP, with a hard
/// timeout. Pure function — does no caching — so unit tests can exercise
/// the timeout contract without touching the process-wide cache.
async fn probe_with_budget(budget: Duration) -> Option<ExternalEndpoint> {
    let fut = async {
        let opts = SearchOptions {
            timeout: Some(budget),
            ..SearchOptions::default()
        };
        let gateway = search_gateway(opts).await.ok()?;
        let ip = gateway.get_external_ip().await.ok()?;
        Some(ExternalEndpoint { ip })
    };

    // `Result<Option<_>, Elapsed>::unwrap_or_default()` collapses the
    // outer `Err` (timeout) into the inner `Option::default()` (`None`),
    // which is exactly the silent-failure contract.
    tokio::time::timeout(budget, fut).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn probe_returns_none_when_budget_is_zero() {
        // A 0 ms budget can't possibly complete the SSDP roundtrip —
        // confirms the silent-failure contract. If this ever panics or
        // hangs we've reintroduced a blocking failure path.
        let result = probe_with_budget(Duration::from_millis(0)).await;
        assert!(
            result.is_none(),
            "expected None on zero budget, got {result:?}"
        );
    }
}
