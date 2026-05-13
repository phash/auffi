//! `OutboundSink`: mode-agnostic abstraction over the channel WebRTC
//! SDP/ICE answers and `bye` notifications travel through.
//!
//! Ad-hoc mode uses the long-lived browser-viewer WS (the existing
//! `signaling.rs`/`protocol::Outgoing` path). Unattended mode (gh #20-#27)
//! piggybacks on the heartbeat WSS instead — same wire shape, different
//! transport. Code that produces outbound relay traffic
//! (`start_streaming`'s on_ice_candidate, `receive_offer`'s answer,
//! `disconnect_streaming`'s bye) shouldn't care which path is active.
//!
//! Set the sink from the path that started: `start_signaling` →
//! AdHoc, `unattended_start` → Unattended. Clear it on the matching
//! teardown. While set, every outbound relay routes through the
//! configured channel; calls when no sink is set return an error so a
//! bug surfacing here doesn't silently lose frames.

use serde_json::Value;
use tokio::sync::mpsc;

use crate::heartbeat::{HeartbeatCommand, SharerFrame};
use crate::protocol::Outgoing;

#[derive(Clone)]
pub enum OutboundSink {
    /// Browser-viewer flow: SDP/ICE goes via the per-session WS that
    /// `signaling.rs` runs.
    AdHoc(mpsc::Sender<Outgoing>),
    /// Unattended flow (gh #17/#23): SDP/ICE goes through the
    /// long-lived heartbeat WSS as `relay` frames.
    Unattended(mpsc::Sender<HeartbeatCommand>),
}

impl OutboundSink {
    /// Send a relay payload through whichever channel is active.
    /// Returns `Err` with a short tag on send failure — the caller
    /// is expected to log + carry on (relay drops should not crash
    /// the streaming loop).
    pub async fn send_relay(&self, payload: Value) -> Result<(), String> {
        match self {
            Self::AdHoc(tx) => tx
                .send(Outgoing::Relay { payload })
                .await
                .map_err(|e| format!("adhoc relay send: {e}")),
            Self::Unattended(tx) => tx
                .send(HeartbeatCommand::Send(SharerFrame::Relay { payload }))
                .await
                .map_err(|e| format!("unattended relay send: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn adhoc_send_wraps_as_outgoing_relay() {
        let (tx, mut rx) = mpsc::channel::<Outgoing>(4);
        let sink = OutboundSink::AdHoc(tx);
        let payload = serde_json::json!({"kind":"hello","ts":1});
        sink.send_relay(payload.clone()).await.unwrap();
        let got = rx.recv().await.expect("message arrived");
        match got {
            Outgoing::Relay { payload: p } => assert_eq!(p, payload),
            other => panic!("expected Relay, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn unattended_send_wraps_as_heartbeat_relay_command() {
        let (tx, mut rx) = mpsc::channel::<HeartbeatCommand>(4);
        let sink = OutboundSink::Unattended(tx);
        let payload = serde_json::json!({"kind":"ice","candidate":{}});
        sink.send_relay(payload.clone()).await.unwrap();
        match rx.recv().await.expect("command arrived") {
            HeartbeatCommand::Send(SharerFrame::Relay { payload: p }) => {
                assert_eq!(p, payload);
            }
            other => panic!("expected Send(Relay), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn adhoc_send_surfaces_closed_channel_as_err() {
        let (tx, rx) = mpsc::channel::<Outgoing>(1);
        drop(rx);
        let sink = OutboundSink::AdHoc(tx);
        let err = sink
            .send_relay(serde_json::json!({}))
            .await
            .expect_err("closed channel must Err");
        assert!(err.starts_with("adhoc relay send"));
    }

    #[tokio::test]
    async fn unattended_send_surfaces_closed_channel_as_err() {
        let (tx, rx) = mpsc::channel::<HeartbeatCommand>(1);
        drop(rx);
        let sink = OutboundSink::Unattended(tx);
        let err = sink
            .send_relay(serde_json::json!({}))
            .await
            .expect_err("closed channel must Err");
        assert!(err.starts_with("unattended relay send"));
    }
}
