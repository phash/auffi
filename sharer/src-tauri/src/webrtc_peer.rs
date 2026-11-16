use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Instant;

use std::collections::VecDeque;

use bytes::BytesMut;
use rtc::ice::mdns::MulticastDnsMode;
use rtc::interceptor::{Attribute, Interceptor, Packet, Slot, StreamInfo, TaggedPacket};
use rtc::peer_connection::configuration::media_engine::MIME_TYPE_VP8;
use rtc::rtcp;
use rtc::rtp;
use rtc::rtp_transceiver::rtp_sender;
use rtc::statistics::stats::ice_candidate_pair::RTCStatsIceCandidatePairState;
use tokio::sync::mpsc;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::error::Error;
use webrtc::media_stream::track_local::static_rtp::TrackLocalStaticRTP;
use webrtc::media_stream::track_local::{TrackLocal, TrackLocalEvent};
use webrtc::media_stream::MediaStreamTrack;
use webrtc::peer_connection::{
    register_default_interceptors, MediaEngine, PeerConnection, PeerConnectionBuilder,
    PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceCandidate, RTCIceCandidateInit,
    RTCIceCandidateType, RTCIceConnectionState, RTCIceGatheringState, RTCIceServer,
    RTCPeerConnectionIceEvent, RTCPeerConnectionState, RTCSessionDescription, RTCStatsReport,
    RTCStatsReportEntry, Registry, SettingEngineBuilder, StatsSelector,
};
use webrtc::rtp_transceiver::RtpSender;

use crate::files::FileMessage;
use crate::input::{InputCommand, InputEvent};

/// Whether the active ICE path uses a TURN relay or a direct route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionType {
    P2p,
    Relay,
}

/// The ids of the local and remote candidate of the nominated, succeeded
/// pair, if there is one yet.
fn select_active_pair<'a>(
    pairs: impl IntoIterator<Item = (RTCStatsIceCandidatePairState, bool, &'a str, &'a str)>,
) -> Option<(&'a str, &'a str)> {
    pairs
        .into_iter()
        .find(|(state, nominated, _, _)| {
            *state == RTCStatsIceCandidatePairState::Succeeded && *nominated
        })
        .map(|(_, _, local, remote)| (local, remote))
}

/// A path is relayed when either end of it is a TURN relay candidate; a
/// candidate the report does not list counts as not relayed.
fn connection_type_of(
    local: Option<RTCIceCandidateType>,
    remote: Option<RTCIceCandidateType>,
) -> ConnectionType {
    if local == Some(RTCIceCandidateType::Relay) || remote == Some(RTCIceCandidateType::Relay) {
        ConnectionType::Relay
    } else {
        ConnectionType::P2p
    }
}

/// Connection type of the nominated, succeeded candidate pair; `None` while
/// no such pair exists yet.
fn resolve_connection_type(report: &RTCStatsReport) -> Option<ConnectionType> {
    let (local_id, remote_id) = select_active_pair(report.candidate_pairs().map(|p| {
        (
            p.state,
            p.nominated,
            p.local_candidate_id.as_str(),
            p.remote_candidate_id.as_str(),
        )
    }))?;
    let local = match report.get(local_id) {
        Some(RTCStatsReportEntry::LocalCandidate(c)) => Some(c.candidate_type),
        _ => None,
    };
    let remote = match report.get(remote_id) {
        Some(RTCStatsReportEntry::RemoteCandidate(c)) => Some(c.candidate_type),
        _ => None,
    };
    Some(connection_type_of(local, remote))
}

/// Pinned mDNS gathering mode for every SharerPeer we build. The webrtc-rs
/// default is `QueryOnly`: it resolves the viewer's `.local` candidates but
/// publishes raw private IPs for its own, and against Chrome (which publishes
/// only `.local` names) every same-LAN session then settled on the TURN relay
/// — see `docs/postmortem-2026-05-13-connectivity.md`. Hoisted out so the
/// regression test can assert on it: the `SettingEngine` has no getter a test
/// could use without building a peer.
const MDNS_MODE: MulticastDnsMode = MulticastDnsMode::QueryAndGather;

/// Placeholder until the answer names the viewer's VP8 payload type. No
/// payload type is above 127, so this never collides with a real one.
const PAYLOAD_TYPE_NOT_NEGOTIATED: u16 = u16::MAX;

/// The IPv4 address the OS would route public traffic from: the interface
/// the viewer most likely reaches us on.
///
/// webrtc-rs 0.21 hides exactly one host address behind the mDNS name (the
/// one set as `multicast_dns_local_ip`); without it the responder answers for
/// 127.0.0.1 and every host candidate goes out as a raw private IP — the
/// relay-on-the-same-LAN bug `MDNS_MODE` exists to prevent. Binding the peer
/// to this one address also keeps Docker bridges and VPN adapters out of the
/// candidate list. `connect` on a UDP socket only consults the routing table;
/// nothing is sent.
fn primary_ipv4() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

/// One optional observer callback, filled in after the peer is built.
type ObserverSlot<T> = Arc<std::sync::Mutex<Option<Arc<dyn Fn(T) + Send + Sync>>>>;

type CandidateSlot = Arc<std::sync::Mutex<Option<Box<dyn FnMut(Option<RTCIceCandidate>) + Send>>>>;

fn read_slot<T>(slot: &ObserverSlot<T>) -> Option<Arc<dyn Fn(T) + Send + Sync>> {
    slot.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// The callbacks the event handler dispatches to.
///
/// webrtc-rs 0.21 takes its single event handler when the connection is
/// built, before any caller could register an observer, so the handler reads
/// these slots at call time instead. Callbacks run on the connection's driver
/// task: anything that calls back into the connection (stats, sends) is
/// spawned, because the driver cannot answer while it is running the callback.
#[derive(Default)]
struct Observers {
    ice_candidate: CandidateSlot,
    ice_state: ObserverSlot<RTCIceConnectionState>,
    conn_type: ObserverSlot<ConnectionType>,
    data_channel: ObserverSlot<Arc<dyn DataChannel>>,
    last_conn_type: Arc<tokio::sync::Mutex<Option<ConnectionType>>>,
    /// Set once DTLS is up. Before that webrtc-rs 0.21 drops every RTP packet
    /// (no SRTP context), so the connection type — on which lib.rs forces
    /// the viewer's first keyframe — must not be reported earlier.
    secured: std::sync::atomic::AtomicBool,
    /// Weak: the driver owns this handler, and a strong reference back to the
    /// connection would keep both alive after `close`.
    pc: OnceLock<Weak<dyn PeerConnection>>,
}

impl Observers {
    fn clear(&self) {
        *self.ice_candidate.lock().unwrap_or_else(|p| p.into_inner()) = None;
        *self.ice_state.lock().unwrap_or_else(|p| p.into_inner()) = None;
        *self.conn_type.lock().unwrap_or_else(|p| p.into_inner()) = None;
        *self.data_channel.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

struct Handler(Arc<Observers>);

impl Handler {
    /// Resolve the selected pair's type off the driver task (callbacks run on
    /// it, and `get_stats` needs it) and report it if it changed.
    fn report_connection_type(&self) {
        let Some(pc) = self.0.pc.get().and_then(Weak::upgrade) else {
            return;
        };
        let type_slot = Arc::clone(&self.0.conn_type);
        let last = Arc::clone(&self.0.last_conn_type);
        tokio::spawn(async move {
            let report = pc.get_stats(Instant::now(), StatsSelector::None).await;
            let Some(conn_type) = resolve_connection_type(&report) else {
                return;
            };
            let mut guard = last.lock().await;
            if *guard != Some(conn_type) {
                *guard = Some(conn_type);
                if let Some(handler) = read_slot(&type_slot) {
                    handler(conn_type);
                }
            }
        });
    }
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Some(cb) = self
            .0
            .ice_candidate
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
        {
            cb(Some(event.candidate));
        }
    }

    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state != RTCIceGatheringState::Complete {
            return;
        }
        if let Some(cb) = self
            .0
            .ice_candidate
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
        {
            cb(None);
        }
    }

    async fn on_ice_connection_state_change(&self, state: RTCIceConnectionState) {
        if let Some(observer) = read_slot(&self.0.ice_state) {
            observer(state);
        }
        // A path change after an ICE restart re-reports; the first report
        // waits for DTLS in on_connection_state_change.
        let connected =
            state == RTCIceConnectionState::Connected || state == RTCIceConnectionState::Completed;
        if connected && self.0.secured.load(Ordering::Acquire) {
            self.report_connection_type();
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        if state == RTCPeerConnectionState::Connected {
            self.0.secured.store(true, Ordering::Release);
            self.report_connection_type();
        }
    }

    async fn on_data_channel(&self, data_channel: Arc<dyn DataChannel>) {
        if let Some(observer) = read_slot(&self.0.data_channel) {
            observer(data_channel);
        }
    }
}

/// The VP8 track as the streaming loop sees it.
///
/// webrtc-rs 0.21 sends an RTP packet only if its SSRC is one the track
/// announced and its payload type one the answer negotiated, and drops any
/// other packet with nothing but a log line. This stamps both on every packet,
/// so the packetizer in `rtp_clock.rs` stays unaware of either. Until the
/// answer is set there is no payload type to stamp and packets are discarded,
/// as the 0.17 track did while unbound.
#[derive(Clone)]
pub struct VideoTrack {
    track: Arc<TrackLocalStaticRTP>,
    ssrc: u32,
    payload_type: Arc<AtomicU16>,
}

impl VideoTrack {
    pub(crate) fn new() -> Self {
        let ssrc = rand::random::<u32>();
        let codec = vp8_codec();
        let track = TrackLocalStaticRTP::new(MediaStreamTrack::new(
            "auffi".to_string(),
            "video".to_string(),
            "video".to_string(),
            rtp_sender::RtpCodecKind::Video,
            vec![rtp_sender::RTCRtpEncodingParameters {
                rtp_coding_parameters: rtp_sender::RTCRtpCodingParameters {
                    ssrc: Some(ssrc),
                    ..Default::default()
                },
                codec,
                ..Default::default()
            }],
        ));
        Self {
            track: Arc::new(track),
            ssrc,
            payload_type: Arc::new(AtomicU16::new(PAYLOAD_TYPE_NOT_NEGOTIATED)),
        }
    }

    /// Send one packet, or drop it while no payload type is negotiated.
    pub async fn write_rtp(&self, mut packet: rtp::Packet) -> Result<(), Error> {
        let Ok(payload_type) = u8::try_from(self.payload_type.load(Ordering::Acquire)) else {
            return Ok(());
        };
        packet.header.ssrc = self.ssrc;
        packet.header.payload_type = payload_type;
        self.track.write_rtp(packet).await
    }

    fn set_payload_type(&self, payload_type: u8) {
        self.payload_type
            .store(u16::from(payload_type), Ordering::Release);
    }
}

fn vp8_codec() -> rtp_sender::RTCRtpCodec {
    rtp_sender::RTCRtpCodec {
        mime_type: MIME_TYPE_VP8.to_string(),
        clock_rate: crate::rtp_clock::VIDEO_CLOCK_RATE,
        ..Default::default()
    }
}

/// A WebRTC peer connection for the sharer side: one VP8 video track plus the
/// `"input"` and `"files"` DataChannels the viewer opens.
pub struct SharerPeer {
    pc: Arc<dyn PeerConnection>,
    /// The video track's RTP sender, asked for the negotiated payload type
    /// once the answer is set.
    sender: Arc<dyn RtpSender>,
    /// RTP-level (not sample-level) on purpose: the streaming loop packetizes
    /// frames itself so every RTP timestamp carries the frame's capture time —
    /// see `rtp_clock.rs` for why a constant per-sample duration was a bitrate
    /// bug.
    pub track: VideoTrack,
    /// The `"files"` DataChannel, set once the viewer opens it.
    files_dc: FilesChannel,
    observers: Arc<Observers>,
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
fn classify_rtcp(packet: &dyn rtcp::Packet) -> Vec<SenderFeedback> {
    use rtcp::payload_feedbacks::{
        full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
        receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate,
    };
    use rtcp::receiver_report::ReceiverReport;

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

/// Passes the viewer's sender feedback — the packets [`classify_rtcp`] reads —
/// on to the application.
///
/// webrtc-rs 0.21 ends inbound RTCP at the end of its interceptor chain:
/// only a packet an interceptor marks with `DeliverToApplication` reaches
/// `TrackLocal::poll`. Without this one the sharer would never hear a PLI
/// (the viewer stays black after a loss) nor a loss report or REMB (the
/// bitrate controller never moves).
///
/// Registered application-most ([`FEEDBACK_FORWARDER_SLOT`]), so every
/// interceptor has seen the whole of the inbound RTCP before this narrows it.
#[derive(Default)]
struct FeedbackForwarder {
    read_queue: VecDeque<TaggedPacket>,
    write_queue: VecDeque<TaggedPacket>,
}

/// Past every slot `rtc` defines, so the forwarder runs last.
const FEEDBACK_FORWARDER_SLOT: usize = 14_000;

impl rtc::sansio::Protocol<TaggedPacket, TaggedPacket, ()> for FeedbackForwarder {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = Error;
    type Time = Instant;

    fn handle_read(&mut self, mut msg: TaggedPacket) -> Result<(), Self::Error> {
        if let Packet::Rtcp(packets) = &msg.message.packet {
            let feedback: Vec<Box<dyn rtcp::Packet>> = packets
                .iter()
                .filter(|p| !classify_rtcp(p.as_ref()).is_empty())
                .cloned()
                .collect();
            if feedback.is_empty() {
                return Ok(());
            }
            msg.message.packet = Packet::Rtcp(feedback);
            msg.message.add(Attribute::DeliverToApplication);
        }
        self.read_queue.push_back(msg);
        Ok(())
    }

    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.read_queue.pop_front()
    }

    fn handle_write(&mut self, msg: TaggedPacket) -> Result<(), Self::Error> {
        self.write_queue.push_back(msg);
        Ok(())
    }

    fn poll_write(&mut self) -> Option<Self::Wout> {
        self.write_queue.pop_front()
    }
}

impl Interceptor for FeedbackForwarder {
    fn bind_local_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _info: &StreamInfo) {}
    fn bind_remote_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _info: &StreamInfo) {}
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

/// Apply every message of the `"input"` channel until it closes, then release
/// whatever the viewer still held.
///
/// The release goes through the same queue as the events, so it never
/// overtakes a press that is still in flight. It also runs when the whole
/// connection closes, which ends `poll` without an `OnClose`.
async fn pump_input_channel(dc: Arc<dyn DataChannel>, tx: mpsc::Sender<InputCommand>) {
    while let Some(event) = dc.poll().await {
        match event {
            DataChannelEvent::OnMessage(msg) => {
                match serde_json::from_slice::<InputEvent>(&msg.data) {
                    Ok(event) => {
                        if tx.send(InputCommand::Apply(event)).await.is_err() {
                            log::warn!("input channel: receiver dropped");
                        }
                    }
                    Err(e) => log::warn!("input channel: failed to parse event: {e}"),
                }
            }
            DataChannelEvent::OnClose => break,
            _ => {}
        }
    }
    crate::dbg_log("[input] data channel closed — releasing held input");
    let _ = tx.send(InputCommand::ReleaseAll).await;
}

async fn pump_files_channel(dc: Arc<dyn DataChannel>, tx: mpsc::Sender<FileMessage>) {
    while let Some(event) = dc.poll().await {
        match event {
            DataChannelEvent::OnMessage(msg) => {
                let message = match route_files_message(msg.is_string, &msg.data) {
                    Ok(m) => m,
                    Err(e) => {
                        log::warn!("files channel: failed to parse JSON: {e}");
                        continue;
                    }
                };
                if tx.send(message).await.is_err() {
                    log::warn!("files channel: receiver dropped");
                }
            }
            DataChannelEvent::OnClose => break,
            _ => {}
        }
    }
}

/// Everything a connection is built from; kept so the build can be repeated
/// with another mDNS mode.
struct ConnectionPlan {
    ice_servers: Vec<RTCIceServer>,
    primary: Option<IpAddr>,
    public_ip: Option<IpAddr>,
    observers: Arc<Observers>,
}

impl ConnectionPlan {
    async fn build(&self, mdns: MulticastDnsMode) -> Result<Arc<dyn PeerConnection>, Error> {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs()?;
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)?.with(
            Slot::from(FEEDBACK_FORWARDER_SLOT),
            FeedbackForwarder::default(),
        );

        let mut settings = SettingEngineBuilder::new()
            .with_multicast_dns_mode(mdns)
            .with_multicast_dns_local_ip(self.primary);
        if let Some(ip) = self.public_ip {
            settings = settings.with_nat_1to1_ips(vec![ip.to_string()], RTCIceCandidateType::Srflx);
        }

        let bind = match self.primary {
            Some(ip) => SocketAddr::new(ip, 0),
            None => {
                crate::dbg_log("[webrtc] no routable ipv4 found — binding every interface");
                SocketAddr::from(([0, 0, 0, 0], 0))
            }
        };

        let pc = PeerConnectionBuilder::new()
            .with_configuration(
                RTCConfigurationBuilder::new()
                    .with_ice_servers(self.ice_servers.clone())
                    .build(),
            )
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_setting_engine(settings.build())
            .with_handler(Arc::new(Handler(Arc::clone(&self.observers))))
            .with_udp_addrs(vec![bind])
            .build()
            .await?;
        Ok(Arc::new(pc))
    }
}

impl SharerPeer {
    /// Create a new peer connection with the provided ICE servers.
    pub async fn new(ice_servers: Vec<RTCIceServer>) -> Result<Self, Error> {
        let primary = primary_ipv4();
        // Best-effort UPnP-IGD discovery of our home router's public IPv4. If
        // the router answers, the public address is declared as a `Srflx`
        // candidate so peers behind STUN-hostile networks (corporate
        // firewalls that block 3478) still see our public endpoint. `Host`
        // would replace the local address and with it the mDNS candidate.
        // The cache returns instantly on subsequent calls. See issue #89.
        let public_ip = crate::nat_traversal::cached_external_endpoint()
            .await
            .map(|ep| ep.ip);
        match public_ip {
            Some(ip) => crate::dbg_log(&format!(
                "[nat_traversal] declaring upnp-discovered public ip {} as srflx candidate",
                crate::ip_redact::redact_ip_addr(&ip)
            )),
            None => {
                crate::dbg_log("[nat_traversal] no upnp public ip available — relying on stun/turn")
            }
        }

        let observers = Arc::new(Observers::default());
        let plan = ConnectionPlan {
            ice_servers,
            primary,
            public_ip,
            observers: Arc::clone(&observers),
        };
        // The mDNS responder binds UDP 5353 next to the OS's own one. Should
        // that ever be refused, a peer without mDNS still connects — over a
        // raw host candidate or the relay — where a failed build would end
        // the session before it started.
        let pc = match plan.build(MDNS_MODE).await {
            Ok(pc) => pc,
            Err(e) => {
                crate::dbg_log(&format!(
                    "[webrtc] peer with mDNS failed ({e}) — retrying without mDNS"
                ));
                plan.build(MulticastDnsMode::Disabled).await?
            }
        };
        let _ = observers.pc.set(Arc::downgrade(&pc));

        let track = VideoTrack::new();
        let sender = pc
            .add_track(Arc::clone(&track.track) as Arc<dyn TrackLocal>)
            .await?;

        Ok(Self {
            pc,
            sender,
            track,
            files_dc: FilesChannel::default(),
            observers,
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
        *self
            .observers
            .ice_state
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(handler));
    }

    /// Drain the video track's RTCP feedback and report what the viewer said.
    ///
    /// There is exactly ONE drain: `poll` hands each event to a single
    /// reader, so a second loop elsewhere would not see a copy — it would race
    /// for packets and both would miss half. Every consumer of sender feedback
    /// therefore goes through this one callback.
    ///
    /// Runs until the connection closes.
    pub fn spawn_rtcp_listener<F>(&self, on_feedback: F)
    where
        F: Fn(SenderFeedback) + Send + Sync + 'static,
    {
        let track = Arc::clone(&self.track.track);
        tokio::spawn(async move {
            while let Some(event) = track.poll().await {
                let TrackLocalEvent::OnRtcpPacket(packets) = event else {
                    continue;
                };
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
        let offer = RTCSessionDescription::offer(sdp)?;
        self.pc.set_remote_description(offer).await?;
        let answer = self.pc.create_answer(None).await?;
        self.pc.set_local_description(answer.clone()).await?;
        let params = self.sender.get_parameters().await?;
        match params
            .rtp_parameters
            .codecs
            .iter()
            .find(|c| c.rtp_codec.mime_type.eq_ignore_ascii_case(MIME_TYPE_VP8))
        {
            Some(codec) => self.track.set_payload_type(codec.payload_type),
            None => crate::dbg_log("[webrtc] answer negotiated no VP8 — the viewer gets no video"),
        }
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
        *self
            .observers
            .ice_candidate
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(Box::new(handler));
    }

    /// Register a callback that fires once the connection is up (ICE
    /// connected and DTLS done, so media sent from then on reaches the
    /// viewer) and emits whether the path uses a TURN relay or a direct
    /// route. The handler is called at most once per flip between `P2p` and
    /// `Relay`.
    pub fn on_connection_type<F>(&self, handler: F)
    where
        F: Fn(ConnectionType) + Send + Sync + 'static,
    {
        *self
            .observers
            .conn_type
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(handler));
    }

    /// Route the `"input"` and `"files"` DataChannels the viewer opens.
    ///
    /// Must be called before ICE negotiation completes so the observer is in
    /// place when the viewer opens the channels. Also stores the `"files"` DC
    /// so the sharer can send outbound file data through [`FilesChannel`].
    ///
    /// The `"files"` channel carries two kinds of data, told apart by the
    /// DataChannel message type (see [`route_files_message`]):
    /// - text frames: a `FileEvent` as JSON.
    /// - binary frames: a raw chunk frame with an 8-byte header.
    pub fn on_data_channels(
        &self,
        input_tx: mpsc::Sender<InputCommand>,
        files_tx: mpsc::Sender<FileMessage>,
    ) {
        let files_dc_slot = Arc::clone(&self.files_dc.0);
        let observer = move |dc: Arc<dyn DataChannel>| {
            let input_tx = input_tx.clone();
            let files_tx = files_tx.clone();
            let slot = Arc::clone(&files_dc_slot);
            tokio::spawn(async move {
                let label = match dc.label().await {
                    Ok(label) => label,
                    Err(e) => {
                        log::warn!("data channel label unavailable: {e}");
                        return;
                    }
                };
                match label.as_str() {
                    "input" => pump_input_channel(dc, input_tx).await,
                    "files" => {
                        *slot.lock().await = Some(Arc::clone(&dc));
                        pump_files_channel(dc, files_tx).await;
                    }
                    other => log::warn!("unexpected data channel: {other}"),
                }
            });
        };
        *self
            .observers
            .data_channel
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(observer));
    }

    /// Send a JSON-serialized `FileEvent` on the `"files"` DataChannel (as a
    /// text frame, see [`FilesChannel`]).
    pub async fn send_file_event(&self, event: &crate::files::FileEvent) -> Result<(), String> {
        use crate::files::FileSink;
        self.files_dc.send_event(event).await
    }

    /// A cheap handle on the `"files"` DataChannel that outlives the lock on
    /// the peer slot: an outbound transfer waits up to a minute for the
    /// helper's answer and must not hold `WebRtcState` that long — Beenden
    /// takes the same lock.
    pub fn files_channel(&self) -> FilesChannel {
        self.files_dc.clone()
    }

    /// Close the underlying connection: its driver, ICE agent, DTLS/SCTP
    /// state and bound UDP sockets.
    ///
    /// Dropping the peer does not stop the driver task, so teardown has to go
    /// through here. The observer callbacks are cleared first: they hold the
    /// app state lib.rs handed them, and the driver owns the handler that
    /// holds them. Closing also ends every DataChannel `poll`, which lets the
    /// input-applier and file tasks observe channel close and exit.
    pub async fn close(&self) -> Result<(), Error> {
        self.observers.clear();
        self.pc.close().await
    }
}

/// Shared slot for the `"files"` DataChannel; empty until the viewer opens it.
#[derive(Clone, Default)]
pub struct FilesChannel(Arc<tokio::sync::Mutex<Option<Arc<dyn DataChannel>>>>);

impl FilesChannel {
    async fn channel(&self) -> Result<Arc<dyn DataChannel>, String> {
        self.0
            .lock()
            .await
            .clone()
            .ok_or_else(|| "files data channel not open".to_string())
    }
}

impl crate::files::FileSink for FilesChannel {
    /// As a TEXT frame: the viewer routes by message type
    /// (`ev.data instanceof ArrayBuffer` → chunk handler), so a binary frame
    /// carrying JSON would land in its chunk path and be dropped.
    async fn send_event(&self, event: &crate::files::FileEvent) -> Result<(), String> {
        let json = serde_json::to_string(event).map_err(|e| e.to_string())?;
        self.channel()
            .await?
            .send_text(&json)
            .await
            .map_err(|e| e.to_string())
    }

    async fn send_chunk(&self, frame: Vec<u8>) -> Result<(), String> {
        self.channel()
            .await?
            .send(BytesMut::from(frame.as_slice()))
            .await
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::InputEvent;

    #[test]
    fn mdns_mode_is_pinned_to_query_and_gather() {
        assert_eq!(MDNS_MODE, MulticastDnsMode::QueryAndGather);
    }

    #[test]
    fn the_succeeded_nominated_pair_is_the_active_one() {
        let pairs = [
            (RTCStatsIceCandidatePairState::Succeeded, false, "a", "b"),
            (RTCStatsIceCandidatePairState::InProgress, true, "c", "d"),
            (RTCStatsIceCandidatePairState::Succeeded, true, "e", "f"),
        ];
        assert_eq!(select_active_pair(pairs), Some(("e", "f")));
    }

    #[test]
    fn no_active_pair_before_one_succeeded() {
        let pairs = [(RTCStatsIceCandidatePairState::InProgress, false, "a", "b")];
        assert_eq!(select_active_pair(pairs), None);
        assert_eq!(select_active_pair([]), None);
    }

    #[test]
    fn host_candidates_are_a_direct_path() {
        assert_eq!(
            connection_type_of(
                Some(RTCIceCandidateType::Host),
                Some(RTCIceCandidateType::Host)
            ),
            ConnectionType::P2p
        );
    }

    #[test]
    fn a_local_relay_candidate_is_a_relayed_path() {
        assert_eq!(
            connection_type_of(
                Some(RTCIceCandidateType::Relay),
                Some(RTCIceCandidateType::Host)
            ),
            ConnectionType::Relay
        );
    }

    #[test]
    fn a_remote_relay_candidate_is_a_relayed_path() {
        assert_eq!(
            connection_type_of(
                Some(RTCIceCandidateType::Srflx),
                Some(RTCIceCandidateType::Relay)
            ),
            ConnectionType::Relay
        );
    }

    #[test]
    fn an_unlisted_candidate_does_not_count_as_relay() {
        assert_eq!(connection_type_of(None, None), ConnectionType::P2p);
    }

    #[tokio::test]
    async fn peer_new_succeeds() {
        let peer = SharerPeer::new(vec![])
            .await
            .expect("SharerPeer::new failed");
        peer.close().await.expect("close");
    }

    /// Pinned regression for the 2026-08 review: teardown MUST go through an
    /// explicit `close()` — dropping the peer leaves the connection (and its
    /// driver, ICE/DTLS/SCTP state and UDP sockets) alive. Anyone removing
    /// `SharerPeer::close` or its call site in `disconnect_streaming` is
    /// recreating that leak.
    #[tokio::test]
    async fn peer_close_shuts_the_connection_down() {
        let peer = SharerPeer::new(vec![]).await.expect("SharerPeer::new");
        peer.on_connection_type(|_| {});
        peer.close().await.expect("close");
        assert!(
            peer.pc.create_offer(None).await.is_err(),
            "a closed connection refuses to negotiate"
        );
        assert!(
            read_slot(&peer.observers.conn_type).is_none(),
            "close drops the observers lib.rs installed"
        );
    }

    /// Without a negotiated payload type webrtc-rs would drop every packet
    /// with only a log line; before the answer the track discards them
    /// instead, as the 0.17 track did while unbound.
    #[tokio::test]
    async fn an_unnegotiated_track_discards_packets_without_error() {
        let track = VideoTrack::new();
        track
            .write_rtp(rtp::Packet::default())
            .await
            .expect("discarded, not failed");
    }

    /// End to end against a second webrtc-rs peer playing the viewer: the
    /// sharer's mDNS-masked candidate, the negotiated payload type, the RTCP
    /// path back (PLI and the receiver reports the bitrate controller reads)
    /// and both DataChannels all have to work for a session to.
    mod loopback {
        use super::super::*;
        use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
        use rtc::rtp_transceiver::{RTCRtpTransceiverDirection, RTCRtpTransceiverInit};
        use std::time::Duration;
        use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
        use tokio::time::timeout;
        use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};

        struct ViewerHandler {
            candidates: UnboundedSender<RTCIceCandidate>,
            tracks: UnboundedSender<Arc<dyn TrackRemote>>,
        }

        #[async_trait::async_trait]
        impl PeerConnectionEventHandler for ViewerHandler {
            async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
                let _ = self.candidates.send(event.candidate);
            }
            async fn on_track(&self, track: Arc<dyn TrackRemote>) {
                let _ = self.tracks.send(track);
            }
        }

        const WAIT: Duration = Duration::from_secs(20);

        async fn recv<T>(rx: &mut UnboundedReceiver<T>, what: &str) -> T {
            timeout(WAIT, rx.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
                .unwrap_or_else(|| panic!("{what}: channel closed"))
        }

        async fn wait_open(dc: &Arc<dyn DataChannel>) {
            timeout(WAIT, async {
                while let Some(event) = dc.poll().await {
                    if matches!(event, DataChannelEvent::OnOpen) {
                        return;
                    }
                }
                panic!("data channel ended before it opened");
            })
            .await
            .expect("data channel opens");
        }

        async fn viewer_peer(
            candidates: UnboundedSender<RTCIceCandidate>,
            tracks: UnboundedSender<Arc<dyn TrackRemote>>,
        ) -> Arc<dyn PeerConnection> {
            let mut media_engine = MediaEngine::default();
            media_engine.register_default_codecs().expect("codecs");
            let registry = register_default_interceptors(Registry::new(), &mut media_engine)
                .expect("registry");
            let ip = primary_ipv4().unwrap_or(IpAddr::from([127, 0, 0, 1]));
            let pc = PeerConnectionBuilder::new()
                .with_media_engine(media_engine)
                .with_interceptor_registry(registry)
                .with_setting_engine(
                    SettingEngineBuilder::new()
                        .with_multicast_dns_mode(MulticastDnsMode::Disabled)
                        .build(),
                )
                .with_handler(Arc::new(ViewerHandler { candidates, tracks }))
                .with_udp_addrs(vec![SocketAddr::new(ip, 0)])
                .build()
                .await
                .expect("viewer peer");
            Arc::new(pc)
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn a_viewer_gets_video_feedback_and_both_channels_through() {
            let sharer = Arc::new(SharerPeer::new(vec![]).await.expect("sharer peer"));
            let (input_tx, mut input_rx) = mpsc::channel(16);
            let (files_tx, mut files_rx) = mpsc::channel(16);
            sharer.on_data_channels(input_tx, files_tx);
            let (feedback_tx, mut feedback_rx) = unbounded_channel();
            sharer.spawn_rtcp_listener(move |f| {
                let _ = feedback_tx.send(f);
            });
            let (type_tx, mut type_rx) = unbounded_channel();
            sharer.on_connection_type(move |t| {
                let _ = type_tx.send(t);
            });
            let (sharer_cand_tx, mut sharer_cand_rx) = unbounded_channel();
            let (host_tx, mut host_rx) = unbounded_channel();
            sharer.on_ice_candidate(move |c| {
                if let Some(c) = c {
                    let init = c.to_json().expect("candidate json");
                    if init.candidate.contains(" typ host") {
                        let _ = host_tx.send(init.candidate.clone());
                    }
                    let _ = sharer_cand_tx.send(init);
                }
            });

            let (viewer_cand_tx, mut viewer_cand_rx) = unbounded_channel();
            let (track_tx, mut track_rx) = unbounded_channel();
            let viewer = viewer_peer(viewer_cand_tx, track_tx).await;
            viewer
                .add_transceiver_from_kind(
                    rtp_sender::RtpCodecKind::Video,
                    Some(RTCRtpTransceiverInit {
                        direction: RTCRtpTransceiverDirection::Recvonly,
                        ..Default::default()
                    }),
                )
                .await
                .expect("recvonly video");
            let input_dc = viewer
                .create_data_channel("input", None)
                .await
                .expect("input dc");
            let files_dc = viewer
                .create_data_channel("files", None)
                .await
                .expect("files dc");

            let offer = viewer.create_offer(None).await.expect("offer");
            viewer
                .set_local_description(offer.clone())
                .await
                .expect("local offer");
            let answer = sharer.set_remote_offer(offer.sdp).await.expect("answer");
            viewer
                .set_remote_description(RTCSessionDescription::answer(answer).expect("answer sdp"))
                .await
                .expect("remote answer");

            {
                let viewer = Arc::clone(&viewer);
                tokio::spawn(async move {
                    while let Some(init) = sharer_cand_rx.recv().await {
                        let _ = viewer.add_ice_candidate(init).await;
                    }
                });
                let sharer = Arc::clone(&sharer);
                tokio::spawn(async move {
                    while let Some(c) = viewer_cand_rx.recv().await {
                        if let Ok(init) = c.to_json() {
                            let _ = sharer.add_ice_candidate(init).await;
                        }
                    }
                });
            }

            assert_eq!(
                recv(&mut type_rx, "connection type").await,
                ConnectionType::P2p
            );

            // 0.21 masks only the address set as the mDNS local ip. A raw
            // private IP here is the same-LAN relay bug of 2026-05-13.
            if primary_ipv4().is_some() {
                let host = recv(&mut host_rx, "host candidate").await;
                assert!(
                    host.contains(".local"),
                    "host candidate is mDNS-masked: {host}"
                );
            }

            let writer = {
                let track = sharer.track.clone();
                tokio::spawn(async move {
                    let mut packetizer = crate::rtp_clock::FramePacketizer::new();
                    let mut pts_us = 0u64;
                    loop {
                        pts_us += 33_000;
                        let packets = packetizer
                            .packetize(pts_us, vec![0x10, 0x00, 0x9d, 0x01, 0x2a])
                            .expect("packetize");
                        for p in packets {
                            let _ = track.write_rtp(p).await;
                        }
                        tokio::time::sleep(Duration::from_millis(33)).await;
                    }
                })
            };
            let track = recv(&mut track_rx, "remote track").await;
            let packet = timeout(WAIT, async {
                while let Some(event) = track.poll().await {
                    if let TrackRemoteEvent::OnRtpPacket(p) = event {
                        return p;
                    }
                }
                panic!("remote track ended before any RTP");
            })
            .await
            .expect("an RTP packet arrives");
            let codec = track
                .codec(packet.header.ssrc)
                .await
                .expect("codec of the stream");
            assert!(codec.mime_type.eq_ignore_ascii_case(MIME_TYPE_VP8));

            track
                .write_rtcp(vec![Box::new(PictureLossIndication {
                    sender_ssrc: 0,
                    media_ssrc: packet.header.ssrc,
                })])
                .await
                .expect("send PLI");
            let mut keyframe_requested = false;
            let mut loss_reported = false;
            while !(keyframe_requested && loss_reported) {
                match recv(&mut feedback_rx, "keyframe request and receiver report").await {
                    SenderFeedback::KeyframeRequest => keyframe_requested = true,
                    SenderFeedback::Loss { .. } => loss_reported = true,
                    SenderFeedback::Remb { .. } => {}
                }
            }
            writer.abort();

            wait_open(&input_dc).await;
            input_dc
                .send_text(r#"{"kind":"mouse-move","x":0.5,"y":0.25}"#)
                .await
                .expect("send input");
            let command = timeout(WAIT, input_rx.recv()).await.expect("input arrives");
            assert!(matches!(
                command,
                Some(InputCommand::Apply(InputEvent::MouseMove { .. }))
            ));

            // A full viewer chunk: 16 KiB of payload behind the 8-byte header.
            wait_open(&files_dc).await;
            let frame = crate::files::build_chunk_frame("t", 0, &[7u8; 16 * 1024]);
            files_dc
                .send(BytesMut::from(frame.as_slice()))
                .await
                .expect("send chunk");
            let message = timeout(WAIT, files_rx.recv()).await.expect("chunk arrives");
            assert!(matches!(message, Some(FileMessage::Chunk(b)) if b == frame));

            sharer.close().await.expect("close sharer");
            let released = timeout(WAIT, async {
                while let Some(command) = input_rx.recv().await {
                    if matches!(command, InputCommand::ReleaseAll) {
                        return true;
                    }
                }
                false
            })
            .await
            .expect("input channel winds down");
            assert!(released, "closing the peer releases held input");
            viewer.close().await.expect("close viewer");
        }
    }

    // The files channel used to decide JSON-vs-chunk by peeking at the first
    // payload byte. A chunk frame starts with the little-endian FNV-1a of the
    // transfer id, so for 1 in 256 ids that byte is 0x7B ('{') and every
    // chunk of the transfer was fed to the JSON parser and dropped — the
    // helper streamed the whole file, then both sides reported failure.
    // The DataChannel message type (string vs binary) is authoritative.
    /// The same session against a real Chrome, the browser the viewer runs
    /// in. The webrtc-rs loopback above cannot catch what only Chrome does:
    /// it decodes nothing until a keyframe arrives intact over SRTP, and its
    /// demuxing and feedback differ from webrtc-rs's own. Needs node and the
    /// viewer's Playwright Chromium, hence ignored:
    /// `cargo test --lib chrome -- --ignored`.
    mod chrome {
        use super::super::*;
        use crate::encoder::Vp8Encoder;
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};
        use std::sync::atomic::AtomicBool;
        use std::time::Duration;
        use tokio::sync::mpsc::unbounded_channel;

        const WIDTH: u32 = 320;
        const HEIGHT: u32 = 240;

        fn frame(n: u32) -> Vec<u8> {
            let shade = (n * 7 % 256) as u8;
            (0..WIDTH * HEIGHT)
                .flat_map(|i| [shade, (i % WIDTH) as u8, (i / WIDTH) as u8, 255])
                .collect()
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        #[ignore = "needs node and the viewer's Playwright Chromium"]
        async fn a_chrome_viewer_decodes_the_stream() {
            let sharer = Arc::new(SharerPeer::new(vec![]).await.expect("sharer peer"));
            let (input_tx, _input_rx) = mpsc::channel(16);
            let (files_tx, _files_rx) = mpsc::channel(16);
            sharer.on_data_channels(input_tx, files_tx);

            // Mirrors lib.rs: a fresh viewer gets a keyframe forced when the
            // connection type resolves, a PLI asks for a throttled one.
            let force_keyframe = Arc::new(AtomicBool::new(false));
            let throttled_keyframe = Arc::new(AtomicBool::new(false));
            {
                let force = Arc::clone(&force_keyframe);
                sharer.on_connection_type(move |_| force.store(true, Ordering::Relaxed));
                let throttled = Arc::clone(&throttled_keyframe);
                sharer.spawn_rtcp_listener(move |f| {
                    if f == SenderFeedback::KeyframeRequest {
                        throttled.store(true, Ordering::Relaxed);
                    }
                });
            }

            let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/chrome-viewer.mjs");
            let mut child = Command::new("node")
                .args([script, "20000"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .expect("node runs the Chrome viewer");
            let stdin = Arc::new(std::sync::Mutex::new(child.stdin.take().expect("stdin")));
            let (lines_tx, mut lines_rx) = unbounded_channel::<serde_json::Value>();
            let stdout = child.stdout.take().expect("stdout");
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Ok(v) = serde_json::from_str(&line) {
                        let _ = lines_tx.send(v);
                    }
                }
            });
            let send = {
                let stdin = Arc::clone(&stdin);
                move |v: serde_json::Value| {
                    let mut w = stdin.lock().unwrap_or_else(|p| p.into_inner());
                    let _ = writeln!(w, "{v}");
                    let _ = w.flush();
                }
            };
            {
                let send = send.clone();
                sharer.on_ice_candidate(move |c| {
                    if let Some(init) = c.and_then(|c| c.to_json().ok()) {
                        send(serde_json::json!({ "candidate": {
                            "candidate": init.candidate,
                            "sdpMid": init.sdp_mid,
                            "sdpMLineIndex": init.sdp_mline_index,
                        }}));
                    }
                });
            }

            let writer = {
                let track = sharer.track.clone();
                let force = Arc::clone(&force_keyframe);
                let throttled = Arc::clone(&throttled_keyframe);
                tokio::spawn(async move {
                    let mut encoder = Vp8Encoder::new(WIDTH, HEIGHT, 1000).expect("encoder");
                    let mut packetizer = crate::rtp_clock::FramePacketizer::new();
                    for n in 0u32..1_000 {
                        if force.swap(false, Ordering::Relaxed) {
                            encoder.request_keyframe();
                        }
                        if throttled.swap(false, Ordering::Relaxed) {
                            encoder.request_keyframe_throttled();
                        }
                        let pts_us = u64::from(n) * 33_000;
                        for pkt in encoder.encode(&frame(n), pts_us).expect("encode") {
                            for p in packetizer.packetize(pts_us, pkt.data).expect("packetize") {
                                let _ = track.write_rtp(p).await;
                            }
                        }
                        // A still desktop: WGC delivers a burst at start and
                        // then only on change, so the keyframe forced at
                        // connect must survive on its own.
                        let gap = if n < 6 { 33 } else { 1600 };
                        tokio::time::sleep(Duration::from_millis(gap)).await;
                    }
                })
            };

            let mut last_stats = serde_json::Value::Null;
            let outcome = loop {
                let msg = tokio::time::timeout(Duration::from_secs(40), lines_rx.recv())
                    .await
                    .expect("the Chrome viewer reports")
                    .expect("the Chrome viewer ended without a result");
                if let Some(offer) = msg.get("offer").and_then(|v| v.as_str()) {
                    let answer = sharer
                        .set_remote_offer(offer.to_string())
                        .await
                        .expect("answer");
                    send(serde_json::json!({ "answer": answer }));
                } else if let Some(c) = msg.get("candidate") {
                    let init = RTCIceCandidateInit {
                        candidate: c["candidate"].as_str().unwrap_or_default().to_string(),
                        sdp_mid: c["sdpMid"].as_str().map(str::to_string),
                        sdp_mline_index: c["sdpMLineIndex"]
                            .as_u64()
                            .and_then(|i| u16::try_from(i).ok()),
                        username_fragment: None,
                        url: None,
                    };
                    let _ = sharer.add_ice_candidate(init).await;
                } else if let Some(stats) = msg.get("stats") {
                    last_stats = stats.clone();
                } else if let Some(result) = msg.get("result") {
                    break result.as_str().unwrap_or_default().to_string();
                }
            };
            writer.abort();
            let _ = sharer.close().await;
            let _ = child.wait();
            assert_eq!(outcome, "playing", "Chrome decoded no video: {last_stats}");
        }
    }

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
        use rtc::rtcp::payload_feedbacks::{
            full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
            receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate,
        };
        use rtc::rtcp::receiver_report::ReceiverReport;
        use rtc::rtcp::reception_report::ReceptionReport;

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
            let sr = rtc::rtcp::sender_report::SenderReport::default();
            assert!(classify_rtcp(&sr).is_empty());
        }
    }
}
