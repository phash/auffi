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

/// Discovered external endpoint. Currently a single-field wrapper around
/// the public IPv4; kept as a struct (rather than a bare `IpAddr`) so
/// phase 2 of #89 can grow a `port` field without breaking call sites.
#[derive(Debug, Clone, Copy)]
pub struct ExternalEndpoint {
    pub ip: IpAddr,
}

/// Reject obviously bogus or unsafe responses before we trust the
/// answer as our public endpoint. SSDP discovery on UDP/1900 is a
/// multicast race that any host on the LAN can win with a forged
/// response; without this guard a hostile peer on the same network
/// could make us advertise `127.0.0.1`, an RFC1918 address, or any
/// arbitrary public IP it controls as our srflx candidate (AppSec
/// finding AUF-M-01).
///
/// `IpAddr::is_global()` would express this more directly but is still
/// nightly-only in Rust stable (tracking issue rust-lang/rust#27709),
/// so the excluded ranges are enumerated explicitly.
fn is_plausible_external_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !v4.is_private()
                && !v4.is_loopback()
                && !v4.is_link_local()
                && !v4.is_broadcast()
                && !v4.is_unspecified()
                && !v4.is_documentation()
                && !v4.is_multicast()
        }
        IpAddr::V6(v6) => {
            !v6.is_loopback() && !v6.is_unspecified() && !v6.is_multicast() && !v6.is_unique_local()
        }
    }
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
        if !is_plausible_external_ip(&ip) {
            return None;
        }
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

    #[test]
    fn rejects_rfc1918_and_loopback_and_link_local_v4() {
        use std::net::Ipv4Addr;
        for addr in [
            Ipv4Addr::new(10, 0, 0, 1),        // RFC1918
            Ipv4Addr::new(192, 168, 1, 1),     // RFC1918
            Ipv4Addr::new(172, 16, 0, 1),      // RFC1918
            Ipv4Addr::new(127, 0, 0, 1),       // loopback
            Ipv4Addr::new(169, 254, 1, 1),     // link-local
            Ipv4Addr::new(0, 0, 0, 0),         // unspecified
            Ipv4Addr::new(255, 255, 255, 255), // broadcast
            Ipv4Addr::new(192, 0, 2, 1),       // documentation (TEST-NET-1)
            Ipv4Addr::new(224, 0, 0, 1),       // multicast
        ] {
            assert!(
                !is_plausible_external_ip(&IpAddr::V4(addr)),
                "should reject bogus public ip {addr}"
            );
        }
    }

    #[test]
    fn accepts_typical_residential_public_v4() {
        // A non-RFC1918 public IPv4 — the kind a real residential router
        // would legitimately return.
        let addr = IpAddr::V4(std::net::Ipv4Addr::new(84, 131, 5, 42));
        assert!(is_plausible_external_ip(&addr));
    }

    #[test]
    fn rejects_loopback_and_unique_local_v6() {
        use std::net::Ipv6Addr;
        for addr in [
            Ipv6Addr::LOCALHOST,
            Ipv6Addr::UNSPECIFIED,
            Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 1), // multicast
            Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 1), // ULA
            Ipv6Addr::new(0xfd12, 0, 0, 0, 0, 0, 0, 1), // ULA
        ] {
            assert!(
                !is_plausible_external_ip(&IpAddr::V6(addr)),
                "should reject bogus public ipv6 {addr}"
            );
        }
    }

    #[test]
    fn accepts_typical_public_v6() {
        // Real global-unicast IPv6 prefix (2000::/3).
        let addr = IpAddr::V6(std::net::Ipv6Addr::new(
            0x2a01, 0x4f8, 0xabcd, 0x1234, 0, 0, 0, 1,
        ));
        assert!(is_plausible_external_ip(&addr));
    }
}
