use std::time::Duration;

use crate::protocol::{Incoming, Outgoing};
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message};

/// Keepalive tuning, mirroring the unattended heartbeat (heartbeat.rs):
/// ping every 30 s, declare the link dead when no pong arrived for 90 s.
/// Without this, a NAT/proxy dropping the idle mapping during the
/// up-to-10-minute code wait leaves the sharer showing a code whose
/// signaling path is dead — the viewer's join never arrives.
const PING_INTERVAL: Duration = Duration::from_secs(30);
const PONG_TIMEOUT: Duration = Duration::from_secs(90);

/// Handle to the ad-hoc signaling WS task.
///
/// Dropping every sender clone of `tx` (the handle itself plus the
/// `OutboundSink::AdHoc` clone held in `OutboundSinkState`) makes the task
/// close the WebSocket and exit — the command channel doubles as the
/// shutdown signal. That is what releases the 9-digit code server-side on
/// teardown.
pub struct Signaling {
    pub tx: mpsc::Sender<Outgoing>,
}

pub async fn run(app: AppHandle, url: String) -> Signaling {
    let (tx, rx) = mpsc::channel::<Outgoing>(16);

    tauri::async_runtime::spawn(async move {
        let emit = move |event: &str, payload: serde_json::Value| {
            let _ = app.emit(event, payload);
        };
        connect_and_run(url, rx, PING_INTERVAL, PONG_TIMEOUT, emit).await;
    });

    Signaling { tx }
}

/// Connect to the backend, register as sharer, and drive the socket until it
/// dies or every command sender is dropped.
///
/// Event delivery goes through the `emit` closure (production: `app.emit`)
/// so the loop is unit-testable against a local WS server without an
/// `AppHandle`. Exit semantics:
///
/// - command channel closed (handle dropped) → send a WS Close and return
///   silently — that is the deliberate-teardown path, no "disconnected".
/// - read error / EOF / server Close / send failure / pong timeout →
///   emit a final `"disconnected"` event, then return. The select arms match
///   irrefutably: the previous `Some(Ok(msg)) = read.next()` pattern silently
///   DISABLED the branch on `Some(Err)`/`None` (tokio::select! semantics),
///   parking the task forever with the UI stuck on a dead code.
async fn connect_and_run<E>(
    url: String,
    mut rx: mpsc::Receiver<Outgoing>,
    ping_interval: Duration,
    pong_timeout: Duration,
    emit: E,
) where
    E: Fn(&str, serde_json::Value),
{
    // The backend's `verifyClient` rejects connections whose Origin is not in
    // `ALLOWED_ORIGINS`; native clients have no Origin by default, so we
    // supply the backend's own origin explicitly.
    let origin = crate::backend_urls::origin_from_ws(&url);
    let request = match url.as_str().into_client_request() {
        Ok(mut r) => {
            match origin.parse() {
                Ok(v) => {
                    r.headers_mut().insert("Origin", v);
                }
                Err(e) => {
                    emit(
                        "disconnected",
                        serde_json::json!({ "reason": format!("invalid origin {origin:?}: {e}") }),
                    );
                    return;
                }
            }
            r
        }
        Err(e) => {
            emit(
                "disconnected",
                serde_json::json!({ "reason": format!("invalid signaling url: {e}") }),
            );
            return;
        }
    };
    // Merged trust anchors — see src/tls_roots.rs.
    let (ws, _) = match connect_async_tls_with_config(
        request,
        None,
        false,
        Some(crate::tls_roots::connector()),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            emit(
                "disconnected",
                serde_json::json!({ "reason": format!("connect failed: {e}") }),
            );
            return;
        }
    };
    let (mut write, mut read) = ws.split();

    let register = Outgoing::Register { role: "sharer" };
    match serde_json::to_string(&register) {
        Ok(txt) => {
            if write.send(Message::Text(txt.into())).await.is_err() {
                emit(
                    "disconnected",
                    serde_json::json!({ "reason": "send failed on register" }),
                );
                return;
            }
        }
        Err(e) => {
            emit(
                "disconnected",
                serde_json::json!({ "reason": format!("serialize error: {e}") }),
            );
            return;
        }
    }

    let mut ping_timer = tokio::time::interval(ping_interval);
    ping_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick fires immediately; skip it so we don't burn a ping on a
    // freshly-opened socket.
    ping_timer.tick().await;
    let mut last_pong = tokio::time::Instant::now();

    loop {
        tokio::select! {
            // biased: poll the command channel first so a dropped handle is
            // observed as clean teardown before a racing server Close (e.g.
            // right after a reject) can masquerade as a network error.
            biased;
            out = rx.recv() => {
                match out {
                    Some(out) => {
                        match serde_json::to_string(&out) {
                            Ok(txt) => {
                                if write.send(Message::Text(txt.into())).await.is_err() {
                                    emit(
                                        "disconnected",
                                        serde_json::json!({ "reason": "send failed" }),
                                    );
                                    return;
                                }
                            }
                            Err(e) => {
                                emit(
                                    "disconnected",
                                    serde_json::json!({ "reason": format!("serialize error: {e}") }),
                                );
                                return;
                            }
                        }
                    }
                    None => {
                        // All handles dropped — deliberate teardown. Close the
                        // socket so the backend detaches the sharer and the
                        // ad-hoc code is released instead of staying claimable
                        // until its TTL.
                        let _ = write.send(Message::Close(None)).await;
                        return;
                    }
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(t))) => {
                        handle_incoming(t.as_str(), &emit);
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        // Tungstenite auto-pongs while the read half is polled,
                        // but reply explicitly to stay resilient against
                        // runtime-version drift (same rationale as heartbeat.rs).
                        let _ = write.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {
                        last_pong = tokio::time::Instant::now();
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let reason = frame
                            .map(|f| format!("close code={} reason={:?}", u16::from(f.code), f.reason))
                            .unwrap_or_else(|| "close without frame".to_string());
                        emit("disconnected", serde_json::json!({ "reason": reason }));
                        return;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        emit(
                            "disconnected",
                            serde_json::json!({ "reason": format!("read: {e}") }),
                        );
                        return;
                    }
                    None => {
                        emit(
                            "disconnected",
                            serde_json::json!({ "reason": "socket EOF" }),
                        );
                        return;
                    }
                }
            }
            _ = ping_timer.tick() => {
                if last_pong.elapsed() > pong_timeout {
                    emit(
                        "disconnected",
                        serde_json::json!({
                            "reason": format!("no pong for {:.0}s", last_pong.elapsed().as_secs_f64())
                        }),
                    );
                    return;
                }
                if write.send(Message::Ping(Vec::new().into())).await.is_err() {
                    emit(
                        "disconnected",
                        serde_json::json!({ "reason": "write half closed during ping" }),
                    );
                    return;
                }
            }
        }
    }
}

/// Parse one text frame from the backend and forward it as a webview event.
/// Unknown/malformed frames are ignored (forward-compatibility with newer
/// backends).
fn handle_incoming<E>(txt: &str, emit: &E)
where
    E: Fn(&str, serde_json::Value),
{
    let Ok(parsed) = serde_json::from_str::<Incoming>(txt) else {
        return;
    };
    match parsed {
        Incoming::CodeAssigned {
            code,
            expires_in_sec,
        } => {
            emit(
                "code-assigned",
                serde_json::json!({ "code": code, "expiresInSec": expires_in_sec }),
            );
        }
        Incoming::PeerJoined { viewer_info } => {
            emit(
                "peer-joined",
                serde_json::json!({
                    "ipPrefix": viewer_info.ip_prefix,
                    "country": viewer_info.country,
                }),
            );
        }
        Incoming::Relay { payload } => {
            emit("relay", serde_json::json!({ "payload": payload }));
        }
        Incoming::Error { code, message } => {
            emit(
                "disconnected",
                serde_json::json!({ "reason": format!("{code}: {message}") }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    // The Origin scheme mapping is security-relevant (the backend's WS
    // verifyClient + TURN gate match against the allow-list); its tests
    // live with the shared helper in `backend_urls.rs`.

    // ── Loop lifecycle (2026-08 review) ─────────────────────────────────
    // The old select! used refutable patterns (`Some(Ok(msg)) = read.next()`,
    // `Some(out) = rx.recv()`): a read error / EOF silently DISABLED the read
    // branch and the task parked forever with no "disconnected" event, and a
    // dropped handle left the WS task (and the 9-digit code) alive until the
    // code TTL. These tests pin the fixed semantics against a real local WS
    // server, mirroring the heartbeat.rs test approach.

    type Emitted = (String, serde_json::Value);

    fn channel_emitter() -> (
        tokio::sync::mpsc::UnboundedReceiver<Emitted>,
        impl Fn(&str, serde_json::Value),
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Emitted>();
        (rx, move |event: &str, payload: serde_json::Value| {
            let _ = tx.send((event.to_string(), payload));
        })
    }

    async fn recv_event(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Emitted>) -> Emitted {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("event within 5 s")
            .expect("emit channel open")
    }

    /// Accept one WS connection and hand it to `server_behaviour`.
    async fn bind_test_server() -> (std::net::SocketAddr, tokio::net::TcpListener) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        (addr, listener)
    }

    #[tokio::test]
    async fn read_error_or_eof_emits_disconnected_and_exits() {
        let (addr, listener) = bind_test_server().await;
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.expect("accept");
            let mut ws = tokio_tungstenite::accept_async(sock).await.expect("ws");
            // Consume the register frame, then close the connection.
            let _ = ws.next().await;
            let _ = ws.close(None).await;
        });

        let (mut events, emit) = channel_emitter();
        let (_tx, rx) = mpsc::channel::<Outgoing>(16);
        let task = tokio::spawn(connect_and_run(
            format!("ws://{addr}/signal"),
            rx,
            Duration::from_secs(30),
            Duration::from_secs(90),
            emit,
        ));

        let (event, _payload) = recv_event(&mut events).await;
        assert_eq!(
            event, "disconnected",
            "server-side close must surface as a disconnected event"
        );
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("task must exit after the socket dies")
            .expect("task must not panic");
    }

    #[tokio::test]
    async fn dropping_all_senders_closes_the_ws_and_ends_the_task_silently() {
        let (addr, listener) = bind_test_server().await;
        let server = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.expect("accept");
            let mut ws = tokio_tungstenite::accept_async(sock).await.expect("ws");
            // register frame first.
            let first = ws.next().await.expect("register frame").expect("ok");
            assert!(
                first.to_text().is_ok_and(|t| t.contains("register")),
                "first frame must be the register: {first:?}"
            );
            // Then the client must CLOSE the socket (not just vanish): the
            // backend releases the ad-hoc code in its close handler.
            loop {
                match ws.next().await {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        });

        let (mut events, emit) = channel_emitter();
        let (tx, rx) = mpsc::channel::<Outgoing>(16);
        let task = tokio::spawn(connect_and_run(
            format!("ws://{addr}/signal"),
            rx,
            Duration::from_secs(30),
            Duration::from_secs(90),
            emit,
        ));

        // Give the task a moment to connect, then drop the only handle —
        // the canonical teardown from disconnect_streaming.
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(tx);

        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("task must exit when every sender is dropped")
            .expect("task must not panic");
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("server must observe the close")
            .expect("server must not panic");
        assert!(
            events.try_recv().is_err(),
            "deliberate teardown must NOT emit a disconnected event"
        );
    }

    #[tokio::test]
    async fn outgoing_commands_are_forwarded_over_the_ws() {
        let (addr, listener) = bind_test_server().await;
        let server = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.expect("accept");
            let mut ws = tokio_tungstenite::accept_async(sock).await.expect("ws");
            let _register = ws.next().await;
            let confirm = ws
                .next()
                .await
                .expect("confirm frame")
                .expect("ok")
                .into_text()
                .expect("text");
            confirm.to_string()
        });

        let (_events, emit) = channel_emitter();
        let (tx, rx) = mpsc::channel::<Outgoing>(16);
        tokio::spawn(connect_and_run(
            format!("ws://{addr}/signal"),
            rx,
            Duration::from_secs(30),
            Duration::from_secs(90),
            emit,
        ));

        tx.send(Outgoing::Confirm { accepted: true })
            .await
            .expect("send confirm");
        let received = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("server sees the frame")
            .expect("server task");
        assert!(
            received.contains("confirm"),
            "expected a confirm frame on the wire, got: {received}"
        );
    }

    #[tokio::test]
    async fn incoming_code_assigned_is_forwarded_as_event() {
        let (addr, listener) = bind_test_server().await;
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.expect("accept");
            let mut ws = tokio_tungstenite::accept_async(sock).await.expect("ws");
            let _register = ws.next().await;
            ws.send(Message::Text(
                r#"{"type":"code-assigned","code":"123456789","expiresInSec":600}"#
                    .to_string()
                    .into(),
            ))
            .await
            .expect("send code-assigned");
            // Keep the socket open until the client is done.
            let _ = ws.next().await;
        });

        let (mut events, emit) = channel_emitter();
        let (_tx, rx) = mpsc::channel::<Outgoing>(16);
        tokio::spawn(connect_and_run(
            format!("ws://{addr}/signal"),
            rx,
            Duration::from_secs(30),
            Duration::from_secs(90),
            emit,
        ));

        let (event, payload) = recv_event(&mut events).await;
        assert_eq!(event, "code-assigned");
        assert_eq!(payload["code"], "123456789");
        assert_eq!(payload["expiresInSec"], 600);
    }

    /// Keepalive: with a server that never reads (so never pongs), the loop
    /// must declare the link dead after the pong timeout instead of waiting
    /// forever behind a NAT mapping that silently died.
    #[tokio::test]
    async fn missing_pongs_surface_as_disconnected() {
        let (addr, listener) = bind_test_server().await;
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.expect("accept");
            let _ws = tokio_tungstenite::accept_async(sock).await.expect("ws");
            // Hold the socket without polling the read half: tungstenite's
            // auto-pong never runs, simulating a dead upstream path.
            tokio::time::sleep(Duration::from_secs(30)).await;
        });

        let (mut events, emit) = channel_emitter();
        let (_tx, rx) = mpsc::channel::<Outgoing>(16);
        let task = tokio::spawn(connect_and_run(
            format!("ws://{addr}/signal"),
            rx,
            Duration::from_millis(50),
            Duration::from_millis(200),
            emit,
        ));

        let (event, payload) = recv_event(&mut events).await;
        assert_eq!(event, "disconnected");
        let reason = payload["reason"].as_str().unwrap_or_default();
        assert!(
            reason.contains("pong"),
            "reason should mention the missing pong, got: {reason}"
        );
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("task must exit after pong timeout")
            .expect("task must not panic");
    }

    /// A live server that polls its read half auto-pongs our pings — the
    /// keepalive must NOT tear down a healthy-but-quiet connection.
    #[tokio::test]
    async fn healthy_quiet_connection_survives_multiple_ping_windows() {
        let (addr, listener) = bind_test_server().await;
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.expect("accept");
            let mut ws = tokio_tungstenite::accept_async(sock).await.expect("ws");
            // Poll the read half so tungstenite answers pings with pongs.
            while let Some(Ok(_)) = ws.next().await {}
        });

        let (mut events, emit) = channel_emitter();
        let (_tx, rx) = mpsc::channel::<Outgoing>(16);
        tokio::spawn(connect_and_run(
            format!("ws://{addr}/signal"),
            rx,
            Duration::from_millis(50),
            Duration::from_millis(200),
            emit,
        ));

        // 500 ms ≈ ten ping intervals and > two pong windows: a broken
        // last_pong refresh would have fired "disconnected" by now.
        let quiet = tokio::time::timeout(Duration::from_millis(500), events.recv()).await;
        assert!(
            quiet.is_err(),
            "healthy connection must not emit events, got: {quiet:?}"
        );
    }
}
