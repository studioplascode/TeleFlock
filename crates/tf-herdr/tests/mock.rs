//! Transport, subscription, reconnect and `agent_start` busy-shell behaviour against an
//! in-process fake herdr socket.
#![cfg(unix)]

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tf_herdr::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;

fn sock_path(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("tf-herdr-mock-{tag}-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&p);
    p
}

fn pane(rev: u64, status: &str) -> Value {
    json!({"event":"pane_updated","data":{"type":"pane_updated","pane":{"pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","agent":"omp","agent_status":status,"revision":rev,"terminal_title":"π ⠧ tmp"}}})
}

/// How long a fake pane's shell stays busy (`agent_pane_busy`) after the first `agent.start` there.
const SHELL_STARTUP: Duration = Duration::from_millis(300);

/// Fake server. The first `events.subscribe` connection floods and then drops; later ones
/// stay open. A status subscription naming `w9:p9` is rejected with `pane_not_found`.
/// `agent.start` answers `agent_pane_busy` for [`SHELL_STARTUP`] per pane, then launches an agent
/// that `agent.get` reports idle and interactive at once.
async fn serve(listener: UnixListener, subs: Arc<AtomicUsize>) {
    let first_start: Arc<Mutex<HashMap<String, Instant>>> = Arc::default();
    loop {
        let Ok((stream, _)) = listener.accept().await else { return };
        let subs = subs.clone();
        let first_start = first_start.clone();
        tokio::spawn(async move {
            let (r, mut w) = stream.into_split();
            let mut lines = BufReader::new(r).lines();
            let Ok(Some(line)) = lines.next_line().await else { return };
            let req: Value = serde_json::from_str(&line).unwrap();
            let id = req["id"].clone();
            let send = |v: Value| format!("{v}\n");
            match req["method"].as_str().unwrap() {
                "ping" => {
                    let _ = w.write_all(send(json!({"id":id,"result":{"type":"pong","version":"0.9.0","protocol":22}})).as_bytes()).await;
                }
                "session.snapshot" => {
                    let _ = w.write_all(send(json!({"id":id,"result":{"type":"session_snapshot","snapshot":{"version":"0.9.0","workspaces":[{"workspace_id":"w1","number":1,"label":"x","future_field":{"a":1}}],"panes":[],"agents":[]}}})).as_bytes()).await;
                }
                "pane.list" => {
                    let _ = w.write_all(send(json!({"id":id,"result":{"type":"pane_list","panes":[{"pane_id":"w1:p1"}]}})).as_bytes()).await;
                }
                "slow" => {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
                "agent.start" => {
                    let (pane, name) = (req["params"]["pane_id"].as_str().unwrap(), req["params"]["name"].as_str().unwrap());
                    let since = *first_start.lock().unwrap().entry(pane.to_string()).or_insert_with(Instant::now);
                    let reply = if since.elapsed() < SHELL_STARTUP {
                        json!({"id":id,"error":{"code":"agent_pane_busy","message":format!("agent target pane {pane} is not an available shell")}})
                    } else {
                        json!({"id":id,"result":{"type":"agent_started","agent":{"pane_id":pane,"terminal_id":format!("t-{name}"),"name":name,"agent":"omp","agent_status":"unknown","launch_pending":true},"argv":["omp"]}})
                    };
                    let _ = w.write_all(send(reply).as_bytes()).await;
                }
                "agent.get" => {
                    let name = req["params"]["target"].as_str().unwrap();
                    let agent = json!({"pane_id":"w1:p1","terminal_id":format!("t-{name}"),"name":name,"agent":"omp","agent_status":"idle","interactive_ready":true});
                    let _ = w.write_all(send(json!({"id":id,"result":{"type":"agent_info","agent":agent}})).as_bytes()).await;
                }
                "events.subscribe" => {
                    let list = req["params"]["subscriptions"].as_array().unwrap().clone();
                    let per_pane = list.iter().any(|s| s.get("pane_id").is_some());
                    if per_pane {
                        if list.iter().any(|s| s["pane_id"] == "w9:p9") {
                            let _ = w.write_all(send(json!({"id":id,"error":{"code":"pane_not_found","message":"pane w9:p9 not found"}})).as_bytes()).await;
                            return;
                        }
                        let _ = w.write_all(send(json!({"id":id,"result":{"type":"subscription_started"}})).as_bytes()).await;
                        let _ = w.write_all(send(json!({"event":"pane.agent_status_changed","data":{"agent":"omp","agent_status":"blocked","pane_id":"w1:p1","workspace_id":"w1"}})).as_bytes()).await;
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    let n = subs.fetch_add(1, Ordering::SeqCst);
                    let _ = w.write_all(send(json!({"id":id,"result":{"type":"subscription_started"}})).as_bytes()).await;
                    if n == 0 {
                        // Spinner flood at ~100 Hz, then a status change, then drop the connection.
                        for rev in 1..=10 {
                            let _ = w.write_all(send(pane(rev, "working")).as_bytes()).await;
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                        let _ = w.write_all(send(pane(11, "idle")).as_bytes()).await;
                        for rev in 12..=14 {
                            let _ = w.write_all(send(pane(rev, "idle")).as_bytes()).await;
                        }
                        let _ = w.write_all(send(json!({"event":"pane_exited","data":{"type":"pane_exited","pane_id":"w2:p1","workspace_id":"w2"}})).as_bytes()).await;
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    } else {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                }
                other => {
                    let _ = w.write_all(send(json!({"id":"","error":{"code":"invalid_request","message":format!("invalid request: unknown variant `{other}`, expected one of `ping`")}})).as_bytes()).await;
                }
            }
        });
    }
}

async fn setup(tag: &str, timeout: Duration) -> (HerdrClient, Arc<AtomicUsize>) {
    let path = sock_path(tag);
    let listener = UnixListener::bind(&path).unwrap();
    let subs = Arc::new(AtomicUsize::new(0));
    tokio::spawn(serve(listener, subs.clone()));
    let client = HerdrClient::discover_with(
        Some("tf-lab-mock"),
        DiscoverOptions { bin: Some("/bin/false".into()), socket: Some(path), request_timeout: timeout },
    )
    .await
    .unwrap();
    (client, subs)
}

async fn next(es: &mut EventStream) -> HerdrEvent {
    tokio::time::timeout(Duration::from_secs(5), es.recv()).await.expect("event timeout").expect("stream ended")
}

#[tokio::test]
async fn request_errors_and_timeouts() {
    let (client, _) = setup("req", Duration::from_millis(300)).await;
    assert_eq!(client.server().unwrap().version, "0.9.0");
    assert!(client.server_at_least((0, 9, 0)) && !client.server_at_least((0, 9, 2)));
    let snap = client.snapshot().await.unwrap();
    assert_eq!(snap.workspaces[0].label, "x");
    let e = client.request::<Value>("bogus.method", json!({})).await.unwrap_err();
    assert_eq!(e.code, code::UNKNOWN_METHOD);
    let e = client.request::<Value>("slow", json!({})).await.unwrap_err();
    assert_eq!(e.code, code::TIMEOUT);

    let gone = HerdrClient::discover_with(
        Some("tf-lab-missing"),
        DiscoverOptions { bin: Some("/bin/false".into()), socket: Some(sock_path("missing")), ..Default::default() },
    )
    .await
    .unwrap();
    assert!(gone.server().is_none());
    assert!(gone.ping().await.unwrap_err().is_server_not_running());
}

#[tokio::test]
async fn subscribe_coalesces_and_resyncs() {
    let (client, subs) = setup("sub", Duration::from_secs(2)).await;
    let mut es = client.subscribe(SubscribeOptions::default());
    assert_eq!(next(&mut es).await, HerdrEvent::Resync);
    // First update passes, the flood is parked, the status change passes immediately.
    let HerdrEvent::PaneUpdated(p) = next(&mut es).await else { panic!() };
    assert_eq!(p.revision, 1);
    let HerdrEvent::PaneUpdated(p) = next(&mut es).await else { panic!() };
    assert_eq!((p.revision, p.agent_status), (11, AgentStatus::Idle));
    // Parked 12..14 collapse into the latest, flushed before the next lifecycle event.
    let HerdrEvent::PaneUpdated(p) = next(&mut es).await else { panic!() };
    assert_eq!(p.revision, 14);
    assert!(matches!(next(&mut es).await, HerdrEvent::PaneExited { .. }));
    // Connection drops: Disconnected, then Resync after reconnect.
    let HerdrEvent::Disconnected { error } = next(&mut es).await else { panic!() };
    assert!(error.is_transient());
    assert_eq!(next(&mut es).await, HerdrEvent::Resync);
    assert_eq!(subs.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn status_subscription_prunes_unknown_panes() {
    let (client, _) = setup("status", Duration::from_secs(2)).await;
    let mut es = client.subscribe(SubscribeOptions {
        status_panes: vec!["w1:p1".into(), "w9:p9".into()],
        ..Default::default()
    });
    assert_eq!(next(&mut es).await, HerdrEvent::Resync);
    loop {
        match next(&mut es).await {
            HerdrEvent::SubscriptionError { error, dropped_panes } => {
                assert_eq!(error.code, code::PANE_NOT_FOUND);
                assert_eq!(dropped_panes, vec!["w9:p9".to_string()]);
                break;
            }
            HerdrEvent::PaneUpdated(_) | HerdrEvent::PaneExited { .. } => {}
            other => panic!("unexpected {other:?}"),
        }
    }
    loop {
        if let HerdrEvent::AgentStatusChanged { pane_id, agent_status, .. } = next(&mut es).await {
            assert_eq!((pane_id.as_str(), agent_status), ("w1:p1", AgentStatus::Blocked));
            break;
        }
    }
}

#[tokio::test]
async fn agent_start_waits_for_a_starting_shell_within_the_window() {
    let (client, _) = setup("agent", Duration::from_secs(2)).await;
    let start = |name: &str, pane: &str| AgentStart {
        name: name.into(),
        kind: "omp".into(),
        pane_id: pane.into(),
        timeout_ms: Some(5_000),
        ..Default::default()
    };
    // No window: the first busy answer is the result.
    let e = client.agent_start(&start("a1", "w1:p1"), Duration::ZERO).await.unwrap_err();
    assert_eq!(e.code, code::AGENT_PANE_BUSY);
    // A window shorter than the shell's startup: busy once it has passed.
    let t0 = Instant::now();
    let e = client.agent_start(&start("a2", "w1:p2"), Duration::from_millis(150)).await.unwrap_err();
    assert_eq!(e.code, code::AGENT_PANE_BUSY);
    assert!(t0.elapsed() >= Duration::from_millis(150), "gave up early: {:?}", t0.elapsed());
    // A longer window: launched once the shell is up.
    let t0 = Instant::now();
    let started = client.agent_start(&start("a3", "w1:p3"), Duration::from_secs(2)).await.unwrap();
    assert!(t0.elapsed() >= SHELL_STARTUP, "started before the shell was up: {:?}", t0.elapsed());
    assert_eq!((started.agent.name.as_deref(), started.agent.interactive_ready), (Some("a3"), true));
}
