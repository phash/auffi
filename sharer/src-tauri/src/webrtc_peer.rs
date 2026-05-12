use std::sync::Arc;

use tokio::sync::mpsc;
use webrtc::interceptor::registry::Registry;
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors, media_engine::MediaEngine,
        setting_engine::SettingEngine, APIBuilder,
    },
    data_channel::RTCDataChannel,
    ice::{candidate::CandidateType, mdns::MulticastDnsMode},
    ice_transport::{
        ice_candidate::{RTCIceCandidate, RTCIceCandidateInit},
        ice_candidate_type::RTCIceCandidateType,
        ice_connection_state::RTCIceConnectionState,
        ice_server::RTCIceServer,
    },
    peer_connection::{configuration::RTCConfiguration, RTCPeerConnection},
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    stats::StatsReportType,
    track::track_local::track_local_static_sample::TrackLocalStaticSample,
    Error,
};

use crate::files::FileMessage;
use crate::input::InputEvent;

/// Whether the active ICE path uses a TURN relay or a direct route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionType {
    P2p,
    Relay,
}

/// Inspect a stats report and return the connection type for the nominated,
/// succeeded candidate pair. Returns `None` when no such pair exists yet.
///
/// Extracted as a pure function so it can be unit-tested without a real
/// `RTCPeerConnection`.
pub fn resolve_connection_type(
    reports: &std::collections::HashMap<String, StatsReportType>,
) -> Option<ConnectionType> {
    let active_pair = reports.values().find_map(|r| {
        if let StatsReportType::CandidatePair(pair) = r {
            use webrtc::ice::candidate::CandidatePairState;
            if pair.state == CandidatePairState::Succeeded && pair.nominated {
                return Some(pair);
            }
        }
        None
    })?;

    let local_relay = reports
        .get(&active_pair.local_candidate_id)
        .and_then(|r| {
            if let StatsReportType::LocalCandidate(c) = r {
                Some(c.candidate_type == CandidateType::Relay)
            } else {
                None
            }
        })
        .unwrap_or(false);

    let remote_relay = reports
        .get(&active_pair.remote_candidate_id)
        .and_then(|r| {
            if let StatsReportType::RemoteCandidate(c) = r {
                Some(c.candidate_type == CandidateType::Relay)
            } else {
                None
            }
        })
        .unwrap_or(false);

    if local_relay || remote_relay {
        Some(ConnectionType::Relay)
    } else {
        Some(ConnectionType::P2p)
    }
}

/// A WebRTC peer connection for the sharer side.
///
/// Holds a VP8 video track and the underlying `RTCPeerConnection`.
/// `files_dc` is populated once the viewer opens the `"files"` channel so the
/// sharer can send file offers and chunks back.
pub struct SharerPeer {
    pc: Arc<RTCPeerConnection>,
    pub track: Arc<TrackLocalStaticSample>,
    /// The `"files"` DataChannel, set once the viewer opens it.
    files_dc: Arc<tokio::sync::Mutex<Option<Arc<RTCDataChannel>>>>,
}

impl SharerPeer {
    /// Create a new peer connection with the provided ICE servers.
    pub async fn new(ice_servers: Vec<RTCIceServer>) -> Result<Self, Error> {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs()?;

        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut media_engine)?;

        // Use QueryAndGather so the sharer ALSO publishes mDNS-anonymized
        // candidates for its own host addresses. Without this the sharer
        // advertises ~25 raw private IPs (every Docker bridge on the host)
        // and the Chrome viewer publishes only mDNS .local hostnames —
        // none of the candidate pairs can connect-check, so ICE falls
        // back to the TURN relay even when both peers sit on the same
        // LAN. With mDNS on both ends the local responder (avahi /
        // systemd-resolved) bridges the two and direct LAN p2p works.
        // Spec: draft-ietf-rtcweb-mdns-ice-candidates.
        let mut setting_engine = SettingEngine::default();
        setting_engine.set_ice_multicast_dns_mode(MulticastDnsMode::QueryAndGather);

        // Best-effort UPnP-IGD discovery of our home router's public
        // IPv4. If the router answers, declare the public address as a
        // `Srflx` candidate so peers behind STUN-hostile networks
        // (corporate firewalls that block 3478) still see our public
        // endpoint. `Host` would replace local IPs entirely and conflict
        // with the mDNS gathering above (webrtc-rs forbids host+mDNS
        // combos). The cache returns instantly on subsequent calls.
        // See issue #89 — phase 2 will also pre-bind the UDP socket and
        // request a same-port mapping so the srflx candidate's port is
        // known to be reachable, not just probable.
        if let Some(ep) = crate::nat_traversal::cached_external_endpoint().await {
            crate::dbg_log(&format!(
                "[nat_traversal] declaring upnp-discovered public ip {} as srflx candidate",
                ep.ip
            ));
            setting_engine.set_nat_1to1_ips(vec![ep.ip.to_string()], RTCIceCandidateType::Srflx);
        } else {
            crate::dbg_log("[nat_traversal] no upnp public ip available — relying on stun/turn");
        }

        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_setting_engine(setting_engine)
            .build();

        let config = RTCConfiguration {
            ice_servers,
            ..Default::default()
        };

        let pc = Arc::new(api.new_peer_connection(config).await?);

        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: "video/VP8".to_string(),
                ..Default::default()
            },
            "video".to_string(),
            "auffi".to_string(),
        ));

        pc.add_track(track.clone() as Arc<dyn webrtc::track::track_local::TrackLocal + Send + Sync>)
            .await?;

        Ok(Self {
            pc,
            track,
            files_dc: Arc::new(tokio::sync::Mutex::new(None)),
        })
    }

    /// Set the remote offer SDP and return a local answer SDP string.
    pub async fn set_remote_offer(&self, sdp: String) -> Result<String, Error> {
        let offer =
            webrtc::peer_connection::sdp::session_description::RTCSessionDescription::offer(sdp)?;
        self.pc.set_remote_description(offer).await?;
        let answer = self.pc.create_answer(None).await?;
        self.pc.set_local_description(answer.clone()).await?;
        Ok(answer.sdp)
    }

    /// Add a remote ICE candidate received from the signaling channel.
    pub async fn add_ice_candidate(&self, candidate: RTCIceCandidateInit) -> Result<(), Error> {
        self.pc.add_ice_candidate(candidate).await
    }

    /// Register a callback that is invoked for each locally gathered ICE candidate.
    ///
    /// The callback receives `None` when ICE gathering is complete.
    pub fn on_ice_candidate<F>(&self, handler: F)
    where
        F: FnMut(Option<RTCIceCandidate>) + Send + 'static,
    {
        let handler = Arc::new(tokio::sync::Mutex::new(handler));
        self.pc.on_ice_candidate(Box::new(move |candidate| {
            let handler = handler.clone();
            Box::pin(async move {
                let mut h = handler.lock().await;
                h(candidate);
            })
        }));
    }

    /// Register a callback that fires once when the ICE connection reaches
    /// `Connected` or `Completed` and emits whether the path uses a TURN relay
    /// or a direct route.  The handler is called at most once per flip between
    /// `P2p` and `Relay`.
    pub fn on_connection_type<F>(&self, handler: F)
    where
        F: Fn(ConnectionType) + Send + Sync + 'static,
    {
        let pc_for_closure = Arc::clone(&self.pc);
        let handler = Arc::new(handler);
        let last: Arc<tokio::sync::Mutex<Option<ConnectionType>>> =
            Arc::new(tokio::sync::Mutex::new(None));

        self.pc
            .on_ice_connection_state_change(Box::new(move |state: RTCIceConnectionState| {
                let pc = Arc::clone(&pc_for_closure);
                let handler = Arc::clone(&handler);
                let last = Arc::clone(&last);
                Box::pin(async move {
                    if state != RTCIceConnectionState::Connected
                        && state != RTCIceConnectionState::Completed
                    {
                        return;
                    }
                    let report = pc.get_stats().await;
                    let conn_type = resolve_connection_type(&report.reports);
                    let Some(conn_type) = conn_type else { return };
                    let mut guard = last.lock().await;
                    if *guard != Some(conn_type) {
                        *guard = Some(conn_type);
                        handler(conn_type);
                    }
                })
            }));
    }

    /// Register senders for both the `"input"` and `"files"` DataChannels in a
    /// single `on_data_channel` callback.
    ///
    /// Must be called before ICE negotiation completes so the callback is in
    /// place when the viewer opens the channels.  Also stores the `"files"` DC
    /// internally so the sharer can send outbound file data via `send_on_files`.
    ///
    /// The `"files"` channel carries two kinds of data:
    /// - JSON text (first byte `{`): a `FileEvent`.
    /// - Binary: a raw chunk frame with an 8-byte header.
    pub fn on_data_channels(
        &self,
        input_tx: mpsc::Sender<InputEvent>,
        files_tx: mpsc::Sender<FileMessage>,
    ) {
        let files_dc_slot = Arc::clone(&self.files_dc);
        self.pc.on_data_channel(Box::new(move |dc| {
            let label = dc.label().to_string();
            match label.as_str() {
                "input" => {
                    let tx = input_tx.clone();
                    Box::pin(async move {
                        dc.on_message(Box::new(move |msg| {
                            let tx = tx.clone();
                            let bytes = msg.data.clone();
                            Box::pin(async move {
                                match serde_json::from_slice::<InputEvent>(&bytes) {
                                    Ok(event) => {
                                        if tx.send(event).await.is_err() {
                                            log::warn!("input channel: receiver dropped");
                                        }
                                    }
                                    Err(e) => {
                                        log::warn!("input channel: failed to parse event: {e}");
                                    }
                                }
                            })
                        }));
                    })
                }
                "files" => {
                    let tx = files_tx.clone();
                    let slot = Arc::clone(&files_dc_slot);
                    Box::pin(async move {
                        // Store the DataChannel so we can send on it.
                        {
                            let mut guard = slot.lock().await;
                            *guard = Some(Arc::clone(&dc));
                        }
                        dc.on_message(Box::new(move |msg| {
                            let tx = tx.clone();
                            let bytes = msg.data.clone();
                            Box::pin(async move {
                                let message = if bytes.first() == Some(&b'{') {
                                    match serde_json::from_slice::<crate::files::FileEvent>(&bytes)
                                    {
                                        Ok(ev) => FileMessage::Event(ev),
                                        Err(e) => {
                                            log::warn!("files channel: failed to parse JSON: {e}");
                                            return;
                                        }
                                    }
                                } else {
                                    FileMessage::Chunk(bytes.to_vec())
                                };
                                if tx.send(message).await.is_err() {
                                    log::warn!("files channel: receiver dropped");
                                }
                            })
                        }));
                    })
                }
                other => {
                    log::warn!("unexpected data channel: {other}");
                    Box::pin(async {})
                }
            }
        }));
    }

    /// Send a JSON-serialized `FileEvent` on the `"files"` DataChannel.
    pub async fn send_file_event(&self, event: &crate::files::FileEvent) -> Result<(), String> {
        let guard = self.files_dc.lock().await;
        let dc = guard
            .as_ref()
            .ok_or_else(|| "files data channel not open".to_string())?;
        let json = serde_json::to_vec(event).map_err(|e| e.to_string())?;
        dc.send(&bytes::Bytes::from(json))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Send a raw binary chunk frame on the `"files"` DataChannel.
    pub async fn send_file_chunk(&self, frame: Vec<u8>) -> Result<(), String> {
        let guard = self.files_dc.lock().await;
        let dc = guard
            .as_ref()
            .ok_or_else(|| "files data channel not open".to_string())?;
        dc.send(&bytes::Bytes::from(frame))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use tokio::time::Instant;
    use webrtc::ice::candidate::{CandidatePairState, CandidateType};
    use webrtc::ice::network_type::NetworkType;
    use webrtc::stats::{ICECandidatePairStats, ICECandidateStats, RTCStatsType, StatsReportType};

    use super::*;
    use crate::input::InputEvent;

    fn make_pair(
        local_id: &str,
        remote_id: &str,
        state: CandidatePairState,
        nominated: bool,
    ) -> ICECandidatePairStats {
        let now = Instant::now();
        ICECandidatePairStats {
            timestamp: now,
            stats_type: RTCStatsType::CandidatePair,
            id: "pair1".to_string(),
            local_candidate_id: local_id.to_string(),
            remote_candidate_id: remote_id.to_string(),
            state,
            nominated,
            packets_sent: 0,
            packets_received: 0,
            bytes_sent: 0,
            bytes_received: 0,
            last_packet_sent_timestamp: now,
            last_packet_received_timestamp: now,
            total_round_trip_time: 0.0,
            current_round_trip_time: 0.0,
            available_outgoing_bitrate: 0.0,
            available_incoming_bitrate: 0.0,
            requests_received: 0,
            requests_sent: 0,
            responses_received: 0,
            responses_sent: 0,
            consent_requests_sent: 0,
            circuit_breaker_trigger_count: 0,
            consent_expired_timestamp: now,
            first_request_timestamp: now,
            last_request_timestamp: now,
            retransmissions_sent: 0,
        }
    }

    fn make_candidate(
        id: &str,
        candidate_type: CandidateType,
        is_local: bool,
    ) -> ICECandidateStats {
        ICECandidateStats {
            timestamp: Instant::now(),
            stats_type: if is_local {
                RTCStatsType::LocalCandidate
            } else {
                RTCStatsType::RemoteCandidate
            },
            id: id.to_string(),
            candidate_type,
            deleted: false,
            ip: "127.0.0.1".to_string(),
            network_type: NetworkType::Udp4,
            port: 12345,
            priority: 100,
            relay_protocol: String::new(),
            url: String::new(),
        }
    }

    fn build_reports(
        pair: ICECandidatePairStats,
        local: ICECandidateStats,
        remote: ICECandidateStats,
    ) -> HashMap<String, StatsReportType> {
        let mut map = HashMap::new();
        map.insert(pair.id.clone(), StatsReportType::CandidatePair(pair));
        map.insert(local.id.clone(), StatsReportType::LocalCandidate(local));
        map.insert(remote.id.clone(), StatsReportType::RemoteCandidate(remote));
        map
    }

    #[test]
    fn resolve_connection_type_p2p_for_host_candidates() {
        let pair = make_pair("local1", "remote1", CandidatePairState::Succeeded, true);
        let local = make_candidate("local1", CandidateType::Host, true);
        let remote = make_candidate("remote1", CandidateType::Host, false);
        let reports = build_reports(pair, local, remote);
        assert_eq!(resolve_connection_type(&reports), Some(ConnectionType::P2p));
    }

    #[test]
    fn resolve_connection_type_relay_when_local_is_relay() {
        let pair = make_pair("local1", "remote1", CandidatePairState::Succeeded, true);
        let local = make_candidate("local1", CandidateType::Relay, true);
        let remote = make_candidate("remote1", CandidateType::Host, false);
        let reports = build_reports(pair, local, remote);
        assert_eq!(
            resolve_connection_type(&reports),
            Some(ConnectionType::Relay)
        );
    }

    #[test]
    fn resolve_connection_type_relay_when_remote_is_relay() {
        let pair = make_pair("local1", "remote1", CandidatePairState::Succeeded, true);
        let local = make_candidate("local1", CandidateType::ServerReflexive, true);
        let remote = make_candidate("remote1", CandidateType::Relay, false);
        let reports = build_reports(pair, local, remote);
        assert_eq!(
            resolve_connection_type(&reports),
            Some(ConnectionType::Relay)
        );
    }

    #[test]
    fn resolve_connection_type_none_when_no_succeeded_nominated_pair() {
        let pair = make_pair("local1", "remote1", CandidatePairState::InProgress, false);
        let local = make_candidate("local1", CandidateType::Host, true);
        let remote = make_candidate("remote1", CandidateType::Host, false);
        let reports = build_reports(pair, local, remote);
        assert_eq!(resolve_connection_type(&reports), None);
    }

    #[test]
    fn resolve_connection_type_none_for_empty_reports() {
        let reports = HashMap::new();
        assert_eq!(resolve_connection_type(&reports), None);
    }

    #[tokio::test]
    async fn peer_new_succeeds() {
        let servers = vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            ..Default::default()
        }];
        SharerPeer::new(servers)
            .await
            .expect("SharerPeer::new failed");
    }

    #[test]
    fn parses_input_event_from_bytes() {
        let bytes = br#"{"kind":"mouse-move","x":0.25,"y":0.75}"#;
        let ev: InputEvent =
            serde_json::from_slice(bytes).expect("should parse mouse-move from bytes");
        if let InputEvent::MouseMove { x, y } = ev {
            assert!((x - 0.25).abs() < f64::EPSILON);
            assert!((y - 0.75).abs() < f64::EPSILON);
        } else {
            panic!("expected MouseMove variant");
        }
    }

    #[test]
    fn rejects_malformed_input_event() {
        let bytes = b"not valid json {{{";
        let result = serde_json::from_slice::<InputEvent>(bytes);
        assert!(result.is_err(), "malformed JSON must be rejected");
    }
}
