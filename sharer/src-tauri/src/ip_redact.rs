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
//! as `IpAddr`, or whose host does when the token is a URL / `ip:port`
//! (`redact_ips_in_url` — TURN URLs like `turn:84.131.5.42:3478`). mDNS
//! `.local` hostnames don't parse as `IpAddr` so they pass through
//! untouched — they're already anonymised by design.

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
/// address, or that is a URL / `ip:port` with an IP-literal host.
/// Other tokens — including mDNS `.local` hostnames and bare port
/// numbers — pass through unchanged.
pub fn redact_ips_in_text(text: &str) -> String {
    text.split(' ')
        .map(|token| {
            if let Ok(ip) = IpAddr::from_str(token) {
                redact_ip_addr(&ip)
            } else {
                redact_ips_in_url(token)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Redact an IP-literal host inside a URL-shaped string: `scheme:host`,
/// `scheme:host:port[?query]` (TURN/STUN URIs, RFC 7065), `scheme://host…`,
/// or a bare `ip:port`. Bracketed IPv6 keeps its brackets. Anything whose
/// host is not an IP literal — hostnames, plain words — is returned
/// unchanged, so this is safe to run over every token of a log line.
pub fn redact_ips_in_url(url: &str) -> String {
    let Some((scheme, after_scheme)) = url.split_once(':') else {
        return url.to_string();
    };
    // `1.2.3.4:5000` — no scheme, the "scheme" IS the host.
    if let Ok(ip) = IpAddr::from_str(scheme) {
        return format!("{}:{after_scheme}", redact_ip_addr(&ip));
    }
    let (authority_prefix, rest) = match after_scheme.strip_prefix("//") {
        Some(r) => ("//", r),
        None => ("", after_scheme),
    };
    let hostport_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (hostport, tail) = rest.split_at(hostport_end);
    let (host, port_suffix) = if let Some(v6) = hostport.strip_prefix('[') {
        match v6.split_once(']') {
            Some((inner, after)) => (inner, after),
            None => return url.to_string(),
        }
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) => (h, &hostport[h.len()..h.len() + 1 + p.len()]),
            None => (hostport, ""),
        }
    };
    let Ok(ip) = IpAddr::from_str(host) else {
        return url.to_string();
    };
    let redacted = redact_ip_addr(&ip);
    let host_out = if hostport.starts_with('[') {
        format!("[{redacted}]")
    } else {
        redacted
    };
    format!("{scheme}:{authority_prefix}{host_out}{port_suffix}{tail}")
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

    // turn_config.rs logs TURN URLs through the redactor and promises
    // relay addresses never reach the diagnostic log — but a
    // `scheme:host:port` token does not parse as an IpAddr, so an
    // IP-literal TURN_HOSTS config (realistic for self-hosters) leaked
    // the full relay address.
    #[test]
    fn turn_url_with_ipv4_literal_host_is_redacted() {
        assert_eq!(
            redact_ips_in_url("turn:84.131.5.42:3478?transport=udp"),
            "turn:84.xxx:3478?transport=udp"
        );
        assert_eq!(redact_ips_in_url("stun:84.131.5.42"), "stun:84.xxx");
    }

    #[test]
    fn turn_url_with_bracketed_ipv6_host_is_redacted() {
        assert_eq!(
            redact_ips_in_url("turns:[2a01:4f8:abcd:1234::1]:5349"),
            "turns:[2a01:4f8:xxx]:5349"
        );
    }

    #[test]
    fn turn_url_with_hostname_passes_through_unchanged() {
        assert_eq!(
            redact_ips_in_url("turns:t.auffi.app:5349?transport=tcp"),
            "turns:t.auffi.app:5349?transport=tcp"
        );
        assert_eq!(
            redact_ips_in_url("https://auffi.app/signal"),
            "https://auffi.app/signal"
        );
        assert_eq!(redact_ips_in_url("not a url"), "not a url");
    }

    #[test]
    fn text_tokens_shaped_like_urls_or_ip_port_are_redacted_too() {
        assert_eq!(
            redact_ips_in_text("urls turn:84.131.5.42:3478 and 10.0.0.7:5000"),
            "urls turn:84.xxx:3478 and 10.xxx:5000"
        );
    }

    #[test]
    fn bare_port_numbers_pass_through_unchanged() {
        // `50000` parses as a `u16` but NOT as an `IpAddr`, so it must
        // not be touched. Guards against an over-eager future helper.
        let s = "50000";
        assert_eq!(redact_ips_in_text(s), s);
    }
}
