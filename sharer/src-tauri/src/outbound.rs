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
    /// True for the ad-hoc (browser-viewer WS) variant. Teardown paths
    /// use this for compare-and-clear: the ad-hoc stream lifecycle owns
    /// an AdHoc sink, but an Unattended sink belongs to the heartbeat
    /// lifecycle and must survive stream teardowns.
    pub fn is_adhoc(&self) -> bool {
        matches!(self, Self::AdHoc(_))
    }

    /// True iff this is the Unattended variant AND it feeds the same
    /// heartbeat command channel as `tx`. Lets a (possibly stale)
    /// forwarder/stop path clear only its OWN registration instead of
    /// blindly nulling whatever a newer session installed.
    pub fn is_unattended_channel(&self, tx: &mpsc::Sender<HeartbeatCommand>) -> bool {
        match self {
            Self::Unattended(own) => own.same_channel(tx),
            Self::AdHoc(_) => false,
        }
    }

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

    #[test]
    fn is_adhoc_distinguishes_the_variants() {
        let (adhoc_tx, _rx1) = mpsc::channel::<Outgoing>(1);
        let (hb_tx, _rx2) = mpsc::channel::<HeartbeatCommand>(1);
        assert!(OutboundSink::AdHoc(adhoc_tx).is_adhoc());
        assert!(!OutboundSink::Unattended(hb_tx).is_adhoc());
    }

    #[test]
    fn is_unattended_channel_matches_only_the_same_heartbeat() {
        let (hb_a, _rx_a) = mpsc::channel::<HeartbeatCommand>(1);
        let (hb_b, _rx_b) = mpsc::channel::<HeartbeatCommand>(1);
        let sink = OutboundSink::Unattended(hb_a.clone());
        assert!(sink.is_unattended_channel(&hb_a));
        assert!(
            !sink.is_unattended_channel(&hb_b),
            "a different heartbeat's sender must not match — that is the \
             stale-forwarder-clears-new-session bug"
        );
        let (adhoc_tx, _rx3) = mpsc::channel::<Outgoing>(1);
        assert!(!OutboundSink::AdHoc(adhoc_tx).is_unattended_channel(&hb_a));
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
