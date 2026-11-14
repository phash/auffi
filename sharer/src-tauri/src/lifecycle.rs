//! What the sharer does on its own at launch and at exit.
//!
//! Launch: the autostart entry passes [`MINIMIZED_FLAG`]; in unattended mode
//! that keeps the window hidden so the sharer sits in the tray. Exit (tray
//! "Beenden", last window closed, Windows log-off, SIGTERM on Linux):
//! [`run_shutdown_jobs`] tells a live viewer the session ended and closes the
//! heartbeat WSS cleanly before the process goes away.

use std::time::Duration;

use tokio::sync::Mutex;

use crate::heartbeat::{HeartbeatCommand, HeartbeatCommands, SharerFrame};
use crate::outbound::OutboundSink;
use crate::SessionMetrics;

/// Argument the autostart entry launches the sharer with.
pub(crate) const MINIMIZED_FLAG: &str = "--minimized";

/// Upper bound for [`run_shutdown_jobs`]. Exit must never hang on a dead
/// network; Windows also only grants a short window at log-off.
pub(crate) const SHUTDOWN_BUDGET: Duration = Duration::from_millis(800);

/// Time the `bye` relay gets to leave the socket before the process exits —
/// the same flush pause `disconnect_streaming` uses.
const BYE_FLUSH: Duration = Duration::from_millis(80);

/// Start without showing the window: only an autostart launch in unattended
/// mode. Ad-hoc has nothing to do without the window, and the tray icon is
/// not guaranteed on every Linux desktop (GNOME without AppIndicator), so a
/// hidden ad-hoc sharer would be unreachable.
pub(crate) fn starts_hidden(mut args: impl Iterator<Item = String>, mode: Option<&str>) -> bool {
    crate::unattended_cmd::resumes_on_launch(mode) && args.any(|a| a == MINIMIZED_FLAG)
}

/// Exit jobs, in order: for a live session the `connection-ended` telemetry
/// (unattended only; otherwise the backend closes the log row with 0 relayed
/// bytes) and a `bye` to the viewer (otherwise it sees an ICE drop and shows
/// "Verbindung verloren"), then a clean close of the heartbeat WSS.
///
/// The lock waits run inside [`SHUTDOWN_BUDGET`] too: `disconnect_streaming`
/// holds the peer lock across `peer.close()` and `start_heartbeat` holds the
/// heartbeat lock across a keyring read that can sit in an unlock prompt.
/// Waiting on either outside the budget would block the main thread at exit.
/// Returns whether every job finished within the budget.
pub(crate) async fn run_shutdown_jobs<P>(
    rtc: &Mutex<Option<P>>,
    sink: &Mutex<Option<OutboundSink>>,
    heartbeat: &Mutex<Option<HeartbeatCommands>>,
    metrics: &SessionMetrics,
) -> bool {
    tokio::time::timeout(SHUTDOWN_BUDGET, async {
        let session_live = rtc.lock().await.is_some();
        if session_live {
            let sink = sink.lock().await.clone();
            if let Some(sink) = sink {
                end_session(&sink, metrics).await;
            }
        }
        let heartbeat = heartbeat.lock().await.take();
        if let Some(cmds) = heartbeat {
            if cmds.send(HeartbeatCommand::Shutdown).await.is_ok() {
                cmds.closed().await;
            }
        }
    })
    .await
    .is_ok()
}

async fn end_session(sink: &OutboundSink, metrics: &SessionMetrics) {
    if let Err(e) = sink
        .send_telemetry(SharerFrame::ConnectionEnded {
            bytes_relayed: metrics.take_relay_bytes(),
        })
        .await
    {
        crate::dbg_log(&format!("[exit] telemetry end: {e}"));
    }
    if sink
        .send_relay(serde_json::json!({ "kind": "bye" }))
        .await
        .is_ok()
    {
        tokio::time::sleep(BYE_FLUSH).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Outgoing;
    use tokio::sync::mpsc;

    fn args(list: &[&str]) -> impl Iterator<Item = String> {
        list.iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn autostart_launch_in_unattended_mode_starts_hidden() {
        assert!(starts_hidden(
            args(&["auffi", "--minimized"]),
            Some("unattended\n")
        ));
    }

    #[test]
    fn manual_launch_shows_the_window() {
        assert!(!starts_hidden(args(&["auffi"]), Some("unattended")));
    }

    #[test]
    fn adhoc_mode_never_starts_hidden() {
        assert!(!starts_hidden(
            args(&["auffi", "--minimized"]),
            Some("adhoc")
        ));
        assert!(!starts_hidden(args(&["auffi", "--minimized"]), None));
    }

    const LIVE: Option<()> = Some(());

    fn locked<T>(value: T) -> Mutex<T> {
        Mutex::new(value)
    }

    /// Fake heartbeat task: records commands until `Shutdown`, then drops
    /// its receiver like the real one does after writing the Close frame.
    fn fake_heartbeat() -> (
        HeartbeatCommands,
        tokio::task::JoinHandle<Vec<HeartbeatCommand>>,
    ) {
        let (tx, mut rx) = mpsc::channel::<HeartbeatCommand>(8);
        let task = tokio::spawn(async move {
            let mut seen = Vec::new();
            while let Some(cmd) = rx.recv().await {
                let shutdown = matches!(cmd, HeartbeatCommand::Shutdown);
                seen.push(cmd);
                if shutdown {
                    break;
                }
            }
            seen
        });
        (tx, task)
    }

    /// Generous slack over the budget for a loaded CI host.
    const EXIT_DEADLINE: Duration = Duration::from_millis(1_500);

    #[tokio::test]
    async fn live_adhoc_session_gets_a_bye() {
        let (tx, mut rx) = mpsc::channel(4);
        let finished = run_shutdown_jobs(
            &locked(LIVE),
            &locked(Some(OutboundSink::AdHoc(tx))),
            &locked(None),
            &SessionMetrics::default(),
        )
        .await;
        assert!(finished);
        match rx.try_recv() {
            Ok(Outgoing::Relay { payload }) => assert_eq!(payload["kind"], "bye"),
            _ => panic!("expected a bye relay"),
        }
        assert!(rx.try_recv().is_err(), "ad-hoc gets no telemetry frame");
    }

    #[tokio::test]
    async fn no_bye_without_a_live_session() {
        let (tx, mut rx) = mpsc::channel(4);
        run_shutdown_jobs(
            &locked(None::<()>),
            &locked(Some(OutboundSink::AdHoc(tx))),
            &locked(None),
            &SessionMetrics::default(),
        )
        .await;
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn heartbeat_gets_end_telemetry_bye_then_shutdown_and_jobs_wait_for_its_close() {
        use std::sync::atomic::Ordering;
        let (tx, heartbeat) = fake_heartbeat();
        let metrics = SessionMetrics::default();
        metrics.bytes.store(41_231_872, Ordering::Relaxed);
        metrics.is_relay.store(true, Ordering::Relaxed);
        let finished = run_shutdown_jobs(
            &locked(LIVE),
            &locked(Some(OutboundSink::Unattended(tx.clone()))),
            &locked(Some(tx)),
            &metrics,
        )
        .await;
        assert!(finished, "jobs must return once the heartbeat task is gone");
        let seen = heartbeat.await.expect("heartbeat task");
        assert_eq!(seen.len(), 3);
        match &seen[0] {
            HeartbeatCommand::Send(SharerFrame::ConnectionEnded { bytes_relayed }) => {
                assert_eq!(*bytes_relayed, 41_231_872)
            }
            _ => panic!("first command must be the connection-ended telemetry"),
        }
        match &seen[1] {
            HeartbeatCommand::Send(SharerFrame::Relay { payload }) => {
                assert_eq!(payload["kind"], "bye")
            }
            _ => panic!("second command must be the bye relay"),
        }
        assert!(matches!(seen[2], HeartbeatCommand::Shutdown));
        assert_eq!(
            metrics.bytes.load(Ordering::Relaxed),
            0,
            "reported bytes are reset so a later teardown cannot report them twice"
        );
    }

    #[tokio::test]
    async fn dead_heartbeat_does_not_block_exit() {
        let (tx, rx) = mpsc::channel::<HeartbeatCommand>(4);
        drop(rx);
        let finished = run_shutdown_jobs(
            &locked(None::<()>),
            &locked(None),
            &locked(Some(tx)),
            &SessionMetrics::default(),
        )
        .await;
        assert!(finished, "a gone heartbeat must not stall exit");
    }

    #[tokio::test]
    async fn held_heartbeat_lock_is_bounded_by_the_budget_and_the_bye_still_goes_out() {
        let (tx, mut rx) = mpsc::channel(4);
        let heartbeat = locked(None::<HeartbeatCommands>);
        let _start_in_progress = heartbeat.lock().await;
        let started = std::time::Instant::now();
        let finished = tokio::time::timeout(
            EXIT_DEADLINE,
            run_shutdown_jobs(
                &locked(LIVE),
                &locked(Some(OutboundSink::AdHoc(tx))),
                &heartbeat,
                &SessionMetrics::default(),
            ),
        )
        .await
        .expect("a held heartbeat lock must not stall exit past the budget");
        assert!(!finished);
        assert!(started.elapsed() >= SHUTDOWN_BUDGET);
        assert!(matches!(rx.try_recv(), Ok(Outgoing::Relay { .. })));
    }

    #[tokio::test]
    async fn held_peer_lock_is_bounded_by_the_budget() {
        let rtc = locked(LIVE);
        let _closing_peer = rtc.lock().await;
        let finished = tokio::time::timeout(
            EXIT_DEADLINE,
            run_shutdown_jobs(
                &rtc,
                &locked(None),
                &locked(None),
                &SessionMetrics::default(),
            ),
        )
        .await
        .expect("a held peer lock must not stall exit past the budget");
        assert!(!finished);
    }

    #[tokio::test]
    async fn held_sink_lock_is_bounded_by_the_budget() {
        let sink = locked(None::<OutboundSink>);
        let _installing = sink.lock().await;
        let finished = tokio::time::timeout(
            EXIT_DEADLINE,
            run_shutdown_jobs(
                &locked(LIVE),
                &sink,
                &locked(None),
                &SessionMetrics::default(),
            ),
        )
        .await
        .expect("a held sink lock must not stall exit past the budget");
        assert!(!finished);
    }
}
