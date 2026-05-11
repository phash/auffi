use std::sync::Arc;

use interceptor::registry::Registry;
use tokio::sync::mpsc;
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors, media_engine::MediaEngine, APIBuilder,
    },
    data_channel::RTCDataChannel,
    ice_transport::{
        ice_candidate::{RTCIceCandidate, RTCIceCandidateInit},
        ice_server::RTCIceServer,
    },
    peer_connection::{configuration::RTCConfiguration, RTCPeerConnection},
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    track::track_local::track_local_static_sample::TrackLocalStaticSample,
    Error,
};

use crate::files::FileMessage;
use crate::input::InputEvent;

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
    /// Create a new peer connection with the provided STUN/TURN servers.
    pub async fn new(ice_servers: Vec<String>) -> Result<Self, Error> {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs()?;

        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut media_engine)?;

        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build();

        let config = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: ice_servers,
                ..Default::default()
            }],
            ..Default::default()
        };

        let pc = Arc::new(api.new_peer_connection(config).await?);

        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: "video/VP8".to_string(),
                ..Default::default()
            },
            "video".to_string(),
            "screenie".to_string(),
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
        F: FnMut(Option<RTCIceCandidate>) + Send + Sync + 'static,
    {
        use std::sync::Mutex;
        let handler = Arc::new(Mutex::new(handler));
        self.pc.on_ice_candidate(Box::new(move |candidate| {
            let handler = handler.clone();
            Box::pin(async move {
                if let Ok(mut h) = handler.lock() {
                    h(candidate);
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
    use super::*;
    use crate::input::InputEvent;

    #[tokio::test]
    async fn peer_new_succeeds() {
        let servers = vec!["stun:stun.l.google.com:19302".to_string()];
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
