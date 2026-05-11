use std::sync::Arc;

use interceptor::registry::Registry;
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors, media_engine::MediaEngine, APIBuilder,
    },
    ice_transport::{
        ice_candidate::{RTCIceCandidate, RTCIceCandidateInit},
        ice_server::RTCIceServer,
    },
    peer_connection::{configuration::RTCConfiguration, RTCPeerConnection},
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    track::track_local::track_local_static_sample::TrackLocalStaticSample,
    Error,
};

/// A WebRTC peer connection for the sharer side.
///
/// Holds a VP8 video track and the underlying `RTCPeerConnection`.
pub struct SharerPeer {
    pc: Arc<RTCPeerConnection>,
    pub track: Arc<TrackLocalStaticSample>,
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
            "screenshare".to_string(),
        ));

        pc.add_track(track.clone() as Arc<dyn webrtc::track::track_local::TrackLocal + Send + Sync>)
            .await?;

        Ok(Self { pc, track })
    }

    /// Set the remote offer SDP and return a local answer SDP string.
    pub async fn set_remote_offer(&self, sdp: String) -> Result<String, Error> {
        let offer = webrtc::peer_connection::sdp::session_description::RTCSessionDescription::offer(sdp)?;
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn peer_new_succeeds() {
        let servers = vec!["stun:stun.l.google.com:19302".to_string()];
        SharerPeer::new(servers).await.expect("SharerPeer::new failed");
    }
}
