//! UPnP-IGD external-IP discovery — phase 1 of issue #89.
//!
//! Asks the home router (if it speaks UPnP) for its public IPv4 and
//! caches the result for [`CACHE_TTL`]. `SharerPeer::new` reads the
//! cache and, if a public IP was found, declares it to `webrtc-rs`
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

use std::future::Future;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use igd_next::aio::tokio::search_gateway;
use igd_next::SearchOptions;
use tokio::sync::Mutex;

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
        // An IPv4-mapped address is an IPv4 answer in disguise and gets the
        // V4 rules; `igd-next` hands back whatever the SOAP body said.
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_plausible_external_ip(&IpAddr::V4(v4)),
            None => {
                !v6.is_loopback()
                    && !v6.is_unspecified()
                    && !v6.is_multicast()
                    && !v6.is_unique_local()
                    && !v6.is_unicast_link_local()
                    && !is_documentation_v6(v6)
            }
        },
    }
}

/// `Ipv6Addr::is_documentation` is still nightly-only: 2001:db8::/32
/// (RFC 3849) and 3fff::/20 (RFC 9637).
fn is_documentation_v6(v6: &std::net::Ipv6Addr) -> bool {
    let s = v6.segments();
    (s[0] == 0x2001 && s[1] == 0x0db8) || (s[0] == 0x3fff && (s[1] & 0xf000) == 0)
}

/// One discovery result and when it was obtained.
struct CachedProbe {
    probed_at: Instant,
    endpoint: Option<ExternalEndpoint>,
}

type Cache = Mutex<Option<CachedProbe>>;

/// Process-wide cache. Callers within [`CACHE_TTL`] of the last probe see
/// its result instantly; the first caller after that pays the discovery
/// cost again. The unattended sharer runs for days — residential ISPs
/// rotate the public IPv4 nightly and laptops roam — so a result must not
/// live for the process lifetime, and a probe that failed because the
/// network was not up yet at autostart must not disable the feature for
/// good. A `None` is cached for the same TTL: a router without UPnP would
/// otherwise cost every session start the full discovery budget.
static CACHE: Cache = Mutex::const_new(None);

/// How long a discovery result (positive or negative) is trusted.
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);

/// Hard upper bound on the SSDP+SOAP roundtrip. Routers that don't
/// answer within this window are treated as "no UPnP available." Kept
/// short because this runs on the session-start critical path; we'd
/// rather lose a slow router's contribution than block the user's
/// "Verbindung wird hergestellt…" UI.
const DISCOVERY_BUDGET: Duration = Duration::from_millis(1500);

/// Return the cached external endpoint, running discovery when the cache
/// is empty or older than [`CACHE_TTL`]. Discovery has a hard
/// `DISCOVERY_BUDGET` so a slow or unreachable router can't stall the
/// caller.
pub async fn cached_external_endpoint() -> Option<ExternalEndpoint> {
    external_endpoint_at(&CACHE, Instant::now(), || {
        probe_with_budget(DISCOVERY_BUDGET)
    })
    .await
}

/// Cache policy with the clock and the prober injected, so the TTL contract
/// is unit-testable without a router. The lock is held across the probe on
/// purpose: two sessions starting at once must not both discover.
async fn external_endpoint_at<F, Fut>(
    cache: &Cache,
    now: Instant,
    probe: F,
) -> Option<ExternalEndpoint>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Option<ExternalEndpoint>>,
{
    let mut guard = cache.lock().await;
    if let Some(cached) = guard.as_ref() {
        if now.saturating_duration_since(cached.probed_at) < CACHE_TTL {
            return cached.endpoint;
        }
    }
    let endpoint = probe().await;
    *guard = Some(CachedProbe {
        probed_at: now,
        endpoint,
    });
    endpoint
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

    // The result used to live in a OnceCell for the process lifetime. An
    // unattended sharer runs for days: after the ISP's nightly IPv4 rotation
    // or a laptop roaming to another network, every new session advertised
    // the OLD address as its srflx candidate, and a probe that failed because
    // the network was not up yet at autostart disabled the feature for good.
    mod cache {
        use super::super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Instant;

        fn ep(last: u8) -> Option<ExternalEndpoint> {
            Some(ExternalEndpoint {
                ip: IpAddr::V4(std::net::Ipv4Addr::new(84, 131, 5, last)),
            })
        }

        #[tokio::test]
        async fn a_fresh_result_is_reused_within_the_ttl() {
            let cache: Cache = Mutex::const_new(None);
            let probes = AtomicUsize::new(0);
            let t0 = Instant::now();
            let first = external_endpoint_at(&cache, t0, || async {
                probes.fetch_add(1, Ordering::SeqCst);
                ep(1)
            })
            .await;
            let second = external_endpoint_at(&cache, t0 + CACHE_TTL / 2, || async {
                probes.fetch_add(1, Ordering::SeqCst);
                ep(2)
            })
            .await;
            assert_eq!(
                probes.load(Ordering::SeqCst),
                1,
                "second call must hit the cache"
            );
            assert_eq!(first.map(|e| e.ip), second.map(|e| e.ip));
        }

        #[tokio::test]
        async fn a_stale_result_is_reprobed_and_replaced() {
            let cache: Cache = Mutex::const_new(None);
            let t0 = Instant::now();
            external_endpoint_at(&cache, t0, || async { ep(1) }).await;
            let later = external_endpoint_at(&cache, t0 + CACHE_TTL, || async { ep(2) }).await;
            assert_eq!(
                later.map(|e| e.ip),
                ep(2).map(|e| e.ip),
                "rotated IP must win"
            );
        }

        #[tokio::test]
        async fn a_failed_probe_is_retried_once_the_ttl_passed() {
            let cache: Cache = Mutex::const_new(None);
            let t0 = Instant::now();
            assert!(external_endpoint_at(&cache, t0, || async { None })
                .await
                .is_none());
            assert!(
                external_endpoint_at(&cache, t0 + CACHE_TTL / 2, || async { ep(1) })
                    .await
                    .is_none(),
                "a negative answer is cached for the TTL, not re-asked on every session start"
            );
            let recovered = external_endpoint_at(&cache, t0 + CACHE_TTL, || async { ep(1) }).await;
            assert_eq!(recovered.map(|e| e.ip), ep(1).map(|e| e.ip));
        }
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

    // AUF-M-01 guard, V6 arm: a LAN host winning the SSDP race could return
    // an IPv4-mapped private address, a link-local or a documentation prefix
    // and the sharer would advertise it as its public srflx candidate for the
    // whole process lifetime. The V4 arm already rejects the equivalents.
    #[test]
    fn rejects_mapped_private_link_local_and_documentation_v6() {
        use std::net::Ipv6Addr;
        for addr in [
            "::ffff:192.168.1.1".parse::<Ipv6Addr>().unwrap(), // IPv4-mapped RFC1918
            "::ffff:127.0.0.1".parse::<Ipv6Addr>().unwrap(),   // IPv4-mapped loopback
            Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1),        // link-local
            Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1),    // documentation (RFC 3849)
            Ipv6Addr::new(0x3fff, 0x0abc, 0, 0, 0, 0, 0, 1),   // documentation (RFC 9637)
        ] {
            assert!(
                !is_plausible_external_ip(&IpAddr::V6(addr)),
                "should reject bogus public ipv6 {addr}"
            );
        }
        // A mapped PUBLIC v4 is still a usable answer.
        let mapped_public = "::ffff:84.131.5.42".parse::<Ipv6Addr>().unwrap();
        assert!(is_plausible_external_ip(&IpAddr::V6(mapped_public)));
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
