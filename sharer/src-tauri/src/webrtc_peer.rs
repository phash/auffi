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
    track::track_local::track_local_static_rtp::TrackLocalStaticRTP,
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
/// Pinned mDNS gathering mode for every SharerPeer we build. See the
/// long comment inside `SharerPeer::new` for the rationale; the constant
/// is hoisted out so the regression test below can assert on it without
/// having to introspect a `SettingEngine` (webrtc-rs doesn't expose
/// getters for its internal state).
const MDNS_MODE: MulticastDnsMode = MulticastDnsMode::QueryAndGather;

/// Slot holding an optional observer callback.
///
/// webrtc-rs allows one `on_ice_connection_state_change` handler, so the ICE
/// registration installed in [`SharerPeer::new`] dispatches to these instead —
/// neither observer can displace the other, whatever order the caller
/// registers them in.
type ObserverSlot<T> = Arc<std::sync::Mutex<Option<Arc<dyn Fn(T) + Send + Sync>>>>;

/// `files_dc` is populated once the viewer opens the `"files"` channel so the
/// sharer can send file offers and chunks back.
pub struct SharerPeer {
    pc: Arc<RTCPeerConnection>,
    /// The video track's RTP sender. Kept so the caller can drain its RTCP
    /// stream — a viewer that lost the reference frame asks for a new one
    /// there (PLI), and without reading it we would never hear the request.
    sender: Arc<webrtc::rtp_transceiver::rtp_sender::RTCRtpSender>,
    /// The video track. RTP-level (not sample-level) on purpose: the streaming
    /// loop packetizes frames itself so every RTP timestamp carries the
    /// frame's capture time — see `rtp_clock.rs` for why the constant
    /// per-sample duration of `TrackLocalStaticSample` was a bitrate bug.
    pub track: Arc<TrackLocalStaticRTP>,
    /// The `"files"` DataChannel, set once the viewer opens it.
    files_dc: Arc<tokio::sync::Mutex<Option<Arc<RTCDataChannel>>>>,
    /// Observer for every ICE connection-state change.
    ///
    /// webrtc-rs allows a single `on_ice_connection_state_change` handler, and
    /// the connection-type resolution already claims it. Both observers hang
    /// off one registration installed in [`SharerPeer::new`] instead, so
    /// neither can silently displace the other.
    ice_state_cb: ObserverSlot<RTCIceConnectionState>,
    type_cb: ObserverSlot<ConnectionType>,
}

/// What a viewer's RTCP told us.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SenderFeedback {
    /// The decoder cannot continue and needs a fresh reference frame (PLI/FIR).
    KeyframeRequest,
    /// A Receiver Report's loss fraction, 8-bit fixed point (256 = 100 %).
    Loss { fraction_lost: u8 },
    /// A REMB estimate: the receiver naming a bitrate ceiling, in bits/s.
    Remb { bitrate_bps: f32 },
}

/// Map one RTCP packet to zero or more pieces of sender feedback.
///
/// Split out from the read loop so the mapping is testable without a live
/// peer connection — the loop itself is then trivial enough to read.
fn classify_rtcp(packet: &(dyn webrtc::rtcp::packet::Packet + Send + Sync)) -> Vec<SenderFeedback> {
    use webrtc::rtcp::payload_feedbacks::{
        full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
        receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate,
    };
    use webrtc::rtcp::receiver_report::ReceiverReport;

    let any = packet.as_any();
    if any.downcast_ref::<PictureLossIndication>().is_some()
        || any.downcast_ref::<FullIntraRequest>().is_some()
    {
        return vec![SenderFeedback::KeyframeRequest];
    }
    if let Some(remb) = any.downcast_ref::<ReceiverEstimatedMaximumBitrate>() {
        return vec![SenderFeedback::Remb {
            bitrate_bps: remb.bitrate,
        }];
    }
    if let Some(rr) = any.downcast_ref::<ReceiverReport>() {
        // One report block per source the viewer is hearing. With a single
        // video track there is normally exactly one.
        return rr
            .reports
            .iter()
            .map(|r| SenderFeedback::Loss {
                fraction_lost: r.fraction_lost,
            })
            .collect();
    }
    Vec::new()
}

/// Route one `files` DataChannel message by its transport type.
///
/// Text frames carry a `FileEvent` (JSON), binary frames carry a chunk frame
/// (8-byte header + payload). The type bit comes from the SCTP PPID the
/// viewer set when sending (`send()` vs `send_text()` on its side), so it is
/// authoritative — content sniffing is not: a chunk frame begins with the
/// FNV-1a hash of the transfer id, and for 1 in 256 ids that hash's low byte
/// is `{`.
fn route_files_message(is_string: bool, bytes: &[u8]) -> Result<FileMessage, String> {
    if is_string {
        serde_json::from_slice::<crate::files::FileEvent>(bytes)
            .map(FileMessage::Event)
            .map_err(|e| e.to_string())
    } else {
        Ok(FileMessage::Chunk(bytes.to_vec()))
    }
}

impl SharerPeer {
    /// Create a new peer connection with the provided ICE servers.
    pub async fn new(ice_servers: Vec<RTCIceServer>) -> Result<Self, Error> {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs()?;

        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut media_engine)?;

        // mDNS gathering policy is pinned via a named constant so a future
        // refactor that "simplifies" the SettingEngine setup can't silently
        // regress to QueryOnly. The QueryOnly default forces every same-LAN
        // session through TURN relay because the sharer's raw private IPs
        // never pair with Chrome's mDNS-anonymized `.local` candidates —
        // see `docs/postmortem-2026-05-13-connectivity.md`. webrtc-rs
        // requires a local mDNS responder (avahi / systemd-resolved on
        // Linux) for resolution to work end-to-end.
        let mut setting_engine = SettingEngine::default();
        setting_engine.set_ice_multicast_dns_mode(MDNS_MODE);

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
                crate::ip_redact::redact_ip_addr(&ep.ip)
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

        let track = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability {
                mime_type: "video/VP8".to_string(),
                ..Default::default()
            },
            "video".to_string(),
            "auffi".to_string(),
        ));

        let sender = pc
            .add_track(
                track.clone() as Arc<dyn webrtc::track::track_local::TrackLocal + Send + Sync>
            )
            .await?;

        let ice_state_cb: ObserverSlot<RTCIceConnectionState> =
            Arc::new(std::sync::Mutex::new(None));
        let type_cb: ObserverSlot<ConnectionType> = Arc::new(std::sync::Mutex::new(None));

        // The single ICE-state registration. Both observers read their slot at
        // call time, so registration order at the call site does not matter and
        // neither can overwrite the other.
        {
            let pc_for_cb = Arc::clone(&pc);
            let state_slot = Arc::clone(&ice_state_cb);
            let type_slot = Arc::clone(&type_cb);
            let last: Arc<tokio::sync::Mutex<Option<ConnectionType>>> =
                Arc::new(tokio::sync::Mutex::new(None));
            pc.on_ice_connection_state_change(Box::new(move |state: RTCIceConnectionState| {
                let pc = Arc::clone(&pc_for_cb);
                let state_slot = Arc::clone(&state_slot);
                let type_slot = Arc::clone(&type_slot);
                let last = Arc::clone(&last);
                Box::pin(async move {
                    let observer = state_slot.lock().unwrap_or_else(|p| p.into_inner()).clone();
                    if let Some(observer) = observer {
                        observer(state);
                    }
                    if state != RTCIceConnectionState::Connected
                        && state != RTCIceConnectionState::Completed
                    {
                        return;
                    }
                    let report = pc.get_stats().await;
                    let Some(conn_type) = resolve_connection_type(&report.reports) else {
                        return;
                    };
                    let mut guard = last.lock().await;
                    if *guard != Some(conn_type) {
                        *guard = Some(conn_type);
                        let handler = type_slot.lock().unwrap_or_else(|p| p.into_inner()).clone();
                        if let Some(handler) = handler {
                            handler(conn_type);
                        }
                    }
                })
            }));
        }

        Ok(Self {
            pc,
            track,
            sender,
            files_dc: Arc::new(tokio::sync::Mutex::new(None)),
            ice_state_cb,
            type_cb,
        })
    }

    /// Observe every ICE connection-state change, including the terminal ones.
    ///
    /// `disconnected`, `failed` and `closed` were previously discarded, so the
    /// sharer never learned that the viewer had gone: it kept capturing and
    /// encoding into a dead peer indefinitely. The viewer has had the mirror
    /// of this since the beginning (`viewer/src/ice-state-handler.ts`).
    pub fn on_ice_state<F>(&self, handler: F)
    where
        F: Fn(RTCIceConnectionState) + Send + Sync + 'static,
    {
        *self.ice_state_cb.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(handler));
    }

    /// Drain the video sender's RTCP stream and report what the viewer said.
    ///
    /// There is exactly ONE drain: `read_rtcp` hands each packet to a single
    /// reader, so a second loop elsewhere would not see a copy — it would race
    /// for packets and both would miss half. Every consumer of sender feedback
    /// therefore goes through this one callback.
    ///
    /// Runs until the sender closes; errors end the loop rather than spin.
    pub fn spawn_rtcp_listener<F>(&self, on_feedback: F)
    where
        F: Fn(SenderFeedback) + Send + Sync + 'static,
    {
        let sender = Arc::clone(&self.sender);
        tokio::spawn(async move {
            while let Ok((packets, _)) = sender.read_rtcp().await {
                for packet in packets {
                    for feedback in classify_rtcp(packet.as_ref()) {
                        on_feedback(feedback);
                    }
                }
            }
        });
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
        *self.type_cb.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(handler));
    }

    /// Register senders for both the `"input"` and `"files"` DataChannels in a
    /// single `on_data_channel` callback.
    ///
    /// Must be called before ICE negotiation completes so the callback is in
    /// place when the viewer opens the channels.  Also stores the `"files"` DC
    /// internally so the sharer can send outbound file data via `send_on_files`.
    ///
    /// The `"files"` channel carries two kinds of data, told apart by the
    /// DataChannel message type (see [`route_files_message`]):
    /// - text frames: a `FileEvent` as JSON.
    /// - binary frames: a raw chunk frame with an 8-byte header.
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
                            let is_string = msg.is_string;
                            let bytes = msg.data.clone();
                            Box::pin(async move {
                                let message = match route_files_message(is_string, &bytes) {
                                    Ok(m) => m,
                                    Err(e) => {
                                        log::warn!("files channel: failed to parse JSON: {e}");
                                        return;
                                    }
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
    ///
    /// As a TEXT frame: the viewer routes by message type too
    /// (`ev.data instanceof ArrayBuffer` → chunk handler), so a binary frame
    /// carrying JSON would land in its chunk path and be dropped.
    pub async fn send_file_event(&self, event: &crate::files::FileEvent) -> Result<(), String> {
        let guard = self.files_dc.lock().await;
        let dc = guard
            .as_ref()
            .ok_or_else(|| "files data channel not open".to_string())?;
        let json = serde_json::to_string(event).map_err(|e| e.to_string())?;
        dc.send_text(json)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Close the underlying `RTCPeerConnection`, tearing down its ICE agent,
    /// DTLS/SCTP transports and bound UDP sockets.
    ///
    /// webrtc-rs has NO `Drop`-based teardown — merely dropping the peer
    /// leaks all of that for the process lifetime. Worse, the
    /// `on_connection_type` closure holds an `Arc` back to the pc (stored on
    /// the pc itself), so the strong count never reaches zero; the handler is
    /// cleared first to break that cycle so the pc's memory can free after
    /// close. Closing also drops the DataChannel `on_message` closures, whose
    /// held senders let the input-applier and file tasks observe channel
    /// close and exit.
    pub async fn close(&self) -> Result<(), Error> {
        self.pc
            .on_ice_connection_state_change(Box::new(|_| Box::pin(async {})));
        self.pc.close().await
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

    /// Pinned regression for the 2026-08 review: teardown MUST go through an
    /// explicit `close()` — webrtc-rs has no Drop impl, so "drop the peer"
    /// leaves the connection (and its ICE/DTLS/SCTP tasks + UDP sockets)
    /// alive forever. Anyone removing `SharerPeer::close` or its call site in
    /// `disconnect_streaming` is recreating that leak.
    #[tokio::test]
    async fn peer_close_transitions_connection_to_closed() {
        use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;

        let peer = SharerPeer::new(vec![]).await.expect("SharerPeer::new");
        // Install the connection-type handler so close() also exercises the
        // Arc-cycle-breaking path (the closure holds an Arc back to the pc).
        peer.on_connection_type(|_| {});
        peer.close().await.expect("close");
        assert_eq!(peer.pc.connection_state(), RTCPeerConnectionState::Closed);
    }

    // The files channel used to decide JSON-vs-chunk by peeking at the first
    // payload byte. A chunk frame starts with the little-endian FNV-1a of the
    // transfer id, so for 1 in 256 ids that byte is 0x7B ('{') and every
    // chunk of the transfer was fed to the JSON parser and dropped — the
    // helper streamed the whole file, then both sides reported failure.
    // The DataChannel message type (string vs binary) is authoritative.
    mod files_routing {
        use super::super::route_files_message;
        use crate::files::{build_chunk_frame, fnv1a32, FileEvent, FileMessage};

        #[test]
        fn chunk_frame_whose_hash_starts_with_brace_routes_as_chunk() {
            let id = (0u32..)
                .map(|i| format!("id-{i}"))
                .find(|s| fnv1a32(s) & 0xFF == 0x7B)
                .expect("some id hashes to a leading brace");
            let frame = build_chunk_frame(&id, 0, b"abc");
            assert_eq!(frame[0], b'{', "premise: the frame looks like JSON");
            assert!(matches!(
                route_files_message(false, &frame),
                Ok(FileMessage::Chunk(b)) if b == frame
            ));
        }

        #[test]
        fn text_frame_routes_as_event() {
            let routed = route_files_message(true, br#"{"kind":"file-done","id":"x"}"#);
            assert!(matches!(
                routed,
                Ok(FileMessage::Event(FileEvent::FileDone { id })) if id == "x"
            ));
        }

        #[test]
        fn malformed_text_frame_is_an_error() {
            assert!(route_files_message(true, b"not json").is_err());
        }

        #[test]
        fn binary_frame_starting_with_brace_is_never_parsed_as_json() {
            let looks_like_json = br#"{"kind":"file-done","id":"x"}"#;
            assert!(matches!(
                route_files_message(false, looks_like_json),
                Ok(FileMessage::Chunk(_))
            ));
        }
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

    mod classify {
        use super::super::{classify_rtcp, SenderFeedback};
        use webrtc::rtcp::payload_feedbacks::{
            full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
            receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate,
        };
        use webrtc::rtcp::receiver_report::ReceiverReport;
        use webrtc::rtcp::reception_report::ReceptionReport;

        #[test]
        fn a_picture_loss_indication_asks_for_a_keyframe() {
            let pli = PictureLossIndication::default();
            assert_eq!(classify_rtcp(&pli), vec![SenderFeedback::KeyframeRequest]);
        }

        #[test]
        fn a_full_intra_request_asks_for_a_keyframe() {
            // FIR is the other spelling of the same ask; a viewer may send
            // either, and answering only one leaves the other black.
            let fir = FullIntraRequest::default();
            assert_eq!(classify_rtcp(&fir), vec![SenderFeedback::KeyframeRequest]);
        }

        #[test]
        fn a_remb_carries_its_bitrate_through() {
            let remb = ReceiverEstimatedMaximumBitrate {
                bitrate: 750_000.0,
                ..Default::default()
            };
            assert_eq!(
                classify_rtcp(&remb),
                vec![SenderFeedback::Remb {
                    bitrate_bps: 750_000.0
                }]
            );
        }

        #[test]
        fn a_receiver_report_yields_its_loss_fraction() {
            let rr = ReceiverReport {
                reports: vec![ReceptionReport {
                    fraction_lost: 64,
                    ..Default::default()
                }],
                ..Default::default()
            };
            assert_eq!(
                classify_rtcp(&rr),
                vec![SenderFeedback::Loss { fraction_lost: 64 }]
            );
        }

        #[test]
        fn every_report_block_is_reported() {
            // One block per source the viewer hears. Taking only the first
            // would silently ignore feedback once anything else is added.
            let rr = ReceiverReport {
                reports: vec![
                    ReceptionReport {
                        fraction_lost: 8,
                        ..Default::default()
                    },
                    ReceptionReport {
                        fraction_lost: 40,
                        ..Default::default()
                    },
                ],
                ..Default::default()
            };
            assert_eq!(
                classify_rtcp(&rr),
                vec![
                    SenderFeedback::Loss { fraction_lost: 8 },
                    SenderFeedback::Loss { fraction_lost: 40 },
                ]
            );
        }

        #[test]
        fn a_report_with_no_blocks_says_nothing() {
            assert!(classify_rtcp(&ReceiverReport::default()).is_empty());
        }

        #[test]
        fn an_unrelated_packet_is_ignored() {
            // Sender Reports arrive on the same stream and carry no feedback
            // for us; treating an unknown packet as loss would be a disaster.
            let sr = webrtc::rtcp::sender_report::SenderReport::default();
            assert!(classify_rtcp(&sr).is_empty());
        }
    }
}
