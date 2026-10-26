//! What the sharer does on its own at launch and at exit.
//!
//! Launch: the autostart entry passes [`MINIMIZED_FLAG`]; in unattended mode
//! that keeps the window hidden so the sharer sits in the tray. Exit (tray
//! "Beenden", last window closed, Windows log-off, SIGTERM on Linux):
//! [`run_shutdown_jobs`] tells a live viewer the session ended and closes the
//! heartbeat WSS cleanly before the process goes away.

use std::time::Duration;

use crate::heartbeat::{HeartbeatCommand, HeartbeatCommands};
use crate::outbound::OutboundSink;

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

/// Exit jobs, in order: `bye` to the viewer of a live session (otherwise it
/// sees an ICE drop and shows "Verbindung verloren"), then a clean close of
/// the heartbeat WSS. Returns once the heartbeat task has written its Close
/// frame and dropped its receiver; callers bound it with [`SHUTDOWN_BUDGET`].
pub(crate) async fn run_shutdown_jobs(
    session_live: bool,
    sink: Option<OutboundSink>,
    heartbeat: Option<HeartbeatCommands>,
) {
    if session_live {
        if let Some(sink) = sink {
            if sink
                .send_relay(serde_json::json!({ "kind": "bye" }))
                .await
                .is_ok()
            {
                tokio::time::sleep(BYE_FLUSH).await;
            }
        }
    }
    if let Some(cmds) = heartbeat {
        if cmds.send(HeartbeatCommand::Shutdown).await.is_ok() {
            cmds.closed().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::heartbeat::SharerFrame;
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

    #[tokio::test]
    async fn live_adhoc_session_gets_a_bye() {
        let (tx, mut rx) = mpsc::channel(4);
        run_shutdown_jobs(true, Some(OutboundSink::AdHoc(tx)), None).await;
        match rx.try_recv() {
            Ok(Outgoing::Relay { payload }) => assert_eq!(payload["kind"], "bye"),
            _ => panic!("expected a bye relay"),
        }
    }

    #[tokio::test]
    async fn no_bye_without_a_live_session() {
        let (tx, mut rx) = mpsc::channel(4);
        run_shutdown_jobs(false, Some(OutboundSink::AdHoc(tx)), None).await;
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn heartbeat_gets_bye_then_shutdown_and_jobs_wait_for_its_close() {
        let (tx, mut rx) = mpsc::channel::<HeartbeatCommand>(4);
        let heartbeat = tokio::spawn(async move {
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
        tokio::time::timeout(
            SHUTDOWN_BUDGET,
            run_shutdown_jobs(true, Some(OutboundSink::Unattended(tx.clone())), Some(tx)),
        )
        .await
        .expect("jobs must return once the heartbeat task is gone");
        let seen = heartbeat.await.expect("heartbeat task");
        assert_eq!(seen.len(), 2);
        match &seen[0] {
            HeartbeatCommand::Send(SharerFrame::Relay { payload }) => {
                assert_eq!(payload["kind"], "bye")
            }
            _ => panic!("first command must be the bye relay"),
        }
        assert!(matches!(seen[1], HeartbeatCommand::Shutdown));
    }

    #[tokio::test]
    async fn dead_heartbeat_does_not_block_exit() {
        let (tx, rx) = mpsc::channel::<HeartbeatCommand>(4);
        drop(rx);
        tokio::time::timeout(SHUTDOWN_BUDGET, run_shutdown_jobs(false, None, Some(tx)))
            .await
            .expect("a gone heartbeat must not stall exit");
    }
}
