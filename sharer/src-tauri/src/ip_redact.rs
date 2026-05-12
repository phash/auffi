//! IP-address redaction for diagnostic logs.
//!
//! CLAUDE.md's DSGVO rule forbids "IPs in plain text in logs (use
//! truncated `84.xxx`)". The backend's `signaling.ts::ipPrefix()`
//! applies the same convention end-to-end. This module mirrors that
//! contract on the Rust side so the sharer's `dbg_log` traces (and any
//! `log::warn!` that includes a candidate string) follow the same
//! truncation scheme:
//!
//! - IPv4 keeps the first octet:    `84.131.5.42` → `84.xxx`
//! - IPv6 keeps the first two groups: `2a01:4f8:abcd:1234::1` → `2a01:4f8:xxx`
//!
//! `redact_ips_in_text` walks an arbitrary whitespace-tokenised string
//! (e.g. an SDP ICE-candidate line) and rewrites any token that parses
//! as `IpAddr`. mDNS `.local` hostnames don't parse as `IpAddr` so they
//! pass through untouched — they're already anonymised by design.

use std::net::IpAddr;
use std::str::FromStr;

/// Truncate a known `IpAddr` to the prefix that's allowed in logs.
pub fn redact_ip_addr(ip: &IpAddr) -> String {
    match ip {
        IpAddr::V4(a) => {
            let o = a.octets();
            format!("{}.xxx", o[0])
        }
        IpAddr::V6(a) => {
            let s = a.segments();
            format!("{:x}:{:x}:xxx", s[0], s[1])
        }
    }
}

/// Walk a whitespace-separated string (typical SDP / ICE candidate
/// line) and redact every token that parses as an IPv4 or IPv6
/// address. Non-IP tokens — including mDNS `.local` hostnames and bare
/// port numbers — pass through unchanged.
pub fn redact_ips_in_text(text: &str) -> String {
    text.split(' ')
        .map(|token| {
            if let Ok(ip) = IpAddr::from_str(token) {
                redact_ip_addr(&ip)
            } else {
                token.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn redact_ipv4_keeps_first_octet_only() {
        let ip = IpAddr::V4(Ipv4Addr::new(84, 131, 5, 42));
        assert_eq!(redact_ip_addr(&ip), "84.xxx");
    }

    #[test]
    fn redact_ipv6_keeps_first_two_groups() {
        let ip = IpAddr::V6(Ipv6Addr::new(0x2a01, 0x4f8, 0xabcd, 0x1234, 0, 0, 0, 1));
        assert_eq!(redact_ip_addr(&ip), "2a01:4f8:xxx");
    }

    #[test]
    fn redact_ipv4_loopback_still_redacts() {
        // Loopback is not technically personal data, but the contract is
        // "no full IPs in logs" — uniform handling avoids "but my router
        // also returns…" exceptions creeping in later.
        let ip = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
        assert_eq!(redact_ip_addr(&ip), "127.xxx");
    }

    #[test]
    fn ice_candidate_line_has_ip_replaced() {
        // Realistic ICE candidate string. The 5th token is the address
        // and the 9th/10th tokens after `raddr` are also addresses.
        let candidate =
            "candidate:1 1 udp 2122252543 88.133.5.105 50000 typ srflx raddr 192.168.1.42 rport 50000";
        let got = redact_ips_in_text(candidate);
        assert!(
            !got.contains("88.133.5.105"),
            "ipv4 address leaked through: {got}"
        );
        assert!(
            !got.contains("192.168.1.42"),
            "private ipv4 leaked through: {got}"
        );
        assert!(got.contains("88.xxx"), "ipv4 prefix missing: {got}");
        assert!(got.contains("192.xxx"), "ipv4 prefix missing: {got}");
        // Port numbers and SDP keywords must stay intact for diagnostics.
        assert!(got.contains("50000"), "port stripped accidentally: {got}");
        assert!(got.contains("typ srflx"), "keywords stripped: {got}");
    }

    #[test]
    fn mdns_local_hostname_passes_through_unchanged() {
        // .local mDNS hostnames are already anonymised — redacting them
        // would be wasted work and lose the diagnostic value of seeing
        // which candidate "type" was emitted.
        let candidate =
            "candidate:2 1 udp 2113937151 abcd1234-5678-90ab-cdef-1234567890ab.local 50001 typ host";
        let got = redact_ips_in_text(candidate);
        assert!(
            got.contains("abcd1234-5678-90ab-cdef-1234567890ab.local"),
            "mDNS hostname mangled: {got}"
        );
    }

    #[test]
    fn pure_text_passes_through_unchanged() {
        let s = "end-of-candidates";
        assert_eq!(redact_ips_in_text(s), s);
    }

    #[test]
    fn bare_port_numbers_pass_through_unchanged() {
        // `50000` parses as a `u16` but NOT as an `IpAddr`, so it must
        // not be touched. Guards against an over-eager future helper.
        let s = "50000";
        assert_eq!(redact_ips_in_text(s), s);
    }
}
