//! Live end-to-end run against a real herdr lab session `tf-lab-hh` (started and stopped
//! by the test). Never touches the default session.
//!
//! `cargo test -p tf-herdr --test lab -- --ignored --nocapture`

use std::time::{Duration, Instant};
use tf_herdr::*;

const SESSION: &str = "tf-lab-hh";
const MODEL_ARGS: &[&str] = &["--model", "openai-codex/gpt-6-luna", "--thinking", "low"];

/// Stops and deletes the lab session however the test ends.
struct LabGuard(std::path::PathBuf);

impl Drop for LabGuard {
    fn drop(&mut self) {
        for args in [["session", "stop", SESSION, "--json"], ["session", "delete", SESSION, "--json"]] {
            let out = std::process::Command::new(&self.0).args(args).env_remove("HERDR_SOCKET_PATH").output();
            if let Ok(o) = out {
                println!("[cleanup] herdr {} -> {}", args[..2].join(" "), String::from_utf8_lossy(&o.stdout).trim());
            }
        }
    }
}

async fn next_event(es: &mut EventStream, deadline: Instant) -> Option<HerdrEvent> {
    let left = deadline.checked_duration_since(Instant::now())?;
    tokio::time::timeout(left, es.recv()).await.ok().flatten()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs herdr + omp on this host; starts lab session tf-lab-hh"]
async fn lab_end_to_end() {
    let client = HerdrClient::discover(Some(SESSION)).await.expect("discover");
    let _guard = LabGuard(client.binary().to_path_buf());
    println!("[discover] bin={} socket={} server={:?}", client.binary().display(), client.endpoint().socket.display(), client.server());
    assert!(client.endpoint().socket.ends_with(format!("sessions/{SESSION}/herdr.sock")));

    let pong = client.ensure_server().await.expect("ensure_server");
    println!("[ensure_server] herdr {} protocol {}", pong.version, pong.protocol);
    let status = client.status().await.expect("status");
    assert!(status.server.running);

    let snap = client.snapshot().await.expect("snapshot");
    println!("[snapshot] version={:?} workspaces={} panes={} agents={}", snap.version, snap.workspaces.len(), snap.panes.len(), snap.agents.len());

    let mut events = client.subscribe(SubscribeOptions::default());
    assert_eq!(events.recv().await, Some(HerdrEvent::Resync));
    println!("[subscribe] Resync received");

    // ---- workspace -------------------------------------------------------
    let ws = client
        .workspace_create(&WorkspaceCreate { cwd: Some("/tmp".into()), label: Some("hh-lab".into()), ..Default::default() })
        .await
        .expect("workspace_create");
    let root = ws.root_pane.pane_id.clone();
    println!("[workspace_create] {} root_pane={} cwd={:?}", ws.workspace.workspace_id, root, ws.root_pane.cwd);
    client.workspace_rename(&ws.workspace.workspace_id, "hh-lab-renamed").await.expect("rename");
    assert_eq!(client.workspace_get(&ws.workspace.workspace_id).await.unwrap().label, "hh-lab-renamed");
    let wt_err = client.worktree_list(&WorktreeScope::Cwd("/tmp".into()), false).await.unwrap_err();
    println!("[worktree_list /tmp] {wt_err}");
    assert_eq!(wt_err.code, code::NOT_GIT_WORKTREE);

    // ---- agent -----------------------------------------------------------
    let started = client
        .agent_start(
            &AgentStart {
                name: "hhomp".into(),
                kind: "omp".into(),
                pane_id: root.clone(),
                args: MODEL_ARGS.iter().map(|s| s.to_string()).collect(),
                timeout_ms: Some(90_000),
            },
            // The workspace was just created: its shell may still be starting.
            Duration::from_secs(45),
        )
        .await
        .expect("agent_start");
    println!("[agent_start] argv={:?} status={:?}", started.argv, started.agent.agent_status);
    events.set_status_panes(vec![root.clone()]);
    let pi = client.pane_process_info(&root).await.expect("process_info");
    println!("[process_info] shell_pid={:?} fg={:?}", pi.shell_pid, pi.foreground_processes.iter().map(|p| (p.pid, &p.name)).collect::<Vec<_>>());

    // Let omp settle to idle before prompting.
    let ready = client
        .agent_wait("hhomp", AgentWait { until: vec![AgentStatus::Idle, AgentStatus::Done], timeout_ms: Some(60_000) })
        .await
        .expect("agent ready");
    println!("[agent_wait] {:?} session_id={:?}", ready.agent_status, ready.agent_session.as_ref().and_then(|s| s.session_id()));
    let explain = client.agent_explain("hhomp").await.expect("explain");
    println!("[agent_explain] state={:?} skip_reason={:?}", explain.state, explain.screen_detection_skip_reason);

    client.agent_prompt("hhomp", "Reply with just the word ok.", None).await.expect("prompt");
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut transitions: Vec<String> = Vec::new();
    let (mut pane_updates, mut saw_working, mut saw_finished) = (0usize, false, false);
    while let Some(ev) = next_event(&mut events, deadline).await {
        let st = match &ev {
            HerdrEvent::AgentStatusChanged { pane_id, agent_status, .. } if *pane_id == root => {
                transitions.push(format!("status_changed:{}", agent_status.as_str()));
                Some(*agent_status)
            }
            HerdrEvent::PaneUpdated(p) if p.pane_id == root => {
                pane_updates += 1;
                if transitions.last().map(|t| t.ends_with(p.agent_status.as_str())) != Some(true) {
                    transitions.push(format!("pane_updated:{}", p.agent_status.as_str()));
                }
                Some(p.agent_status)
            }
            _ => None,
        };
        match st {
            Some(AgentStatus::Working) => saw_working = true,
            Some(AgentStatus::Idle | AgentStatus::Done) if saw_working => saw_finished = true,
            _ => {}
        }
        if saw_finished {
            break;
        }
    }
    println!("[subscribe] transitions={transitions:?} coalesced pane_updated for agent pane={pane_updates}");
    assert!(saw_working && saw_finished, "expected working -> idle/done, got {transitions:?}");
    let read = client.agent_read("hhomp", ReadOptions::new(ReadSource::Detection)).await.expect("agent_read");
    println!("[agent_read detection] {} chars, truncated={}", read.text.len(), read.truncated);

    // ---- terminal --------------------------------------------------------
    let shell = client
        .pane_split(&PaneSplit { target_pane_id: Some(root.clone()), direction: SplitDirection::Down, cwd: Some("/tmp".into()), ..Default::default() })
        .await
        .expect("pane_split");
    println!("[pane_split] {}", shell.pane_id);
    tokio::time::sleep(Duration::from_millis(800)).await; // shell prompt

    let term = client
        .terminal_session(TerminalOptions::new(&shell.pane_id, TerminalMode::Control, 80, 24))
        .await
        .expect("terminal_session");
    let (mut frames, input) = term.split();
    let TerminalEvent::Frame(first) = frames.recv().await.unwrap() else { panic!("no first frame") };
    println!("[terminal] first frame seq={} full={} {}x{} {}B", first.seq, first.full, first.cols, first.rows, first.bytes.len());
    assert!(first.full);

    // A second controller without takeover must be refused.
    let conflict = client.terminal_session(TerminalOptions::new(&shell.pane_id, TerminalMode::Control, 80, 24)).await;
    println!("[terminal] second control w/o takeover -> {:?}", conflict.as_ref().err());
    assert!(conflict.is_err());
    // Observers coexist and reject input.
    let observe = client.terminal_session(TerminalOptions::new(&root, TerminalMode::Observe, 60, 10)).await.expect("observe");
    assert!(observe.input.input("x").is_err());
    drop(observe);

    input.input("echo tf-hh-echo-$((6*7))\r").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut echoed = false;
    let mut nframes = 0;
    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(2), frames.recv()).await {
            Ok(Some(TerminalEvent::Frame(f))) => {
                nframes += 1;
                if String::from_utf8_lossy(&f.decode().unwrap()).contains("tf-hh-echo-42") {
                    println!("[terminal] echo seen in frame seq={} full={} after {} frames", f.seq, f.full, nframes);
                    echoed = true;
                    break;
                }
            }
            Ok(Some(TerminalEvent::Closed { reason })) => panic!("closed early: {reason}"),
            _ => {}
        }
    }
    assert!(echoed, "input echo not observed");
    input.resize(90, 20).unwrap();
    input.scroll(ScrollDirection::Up, 1).unwrap();
    input.release().unwrap();
    let mut reason = None;
    while let Some(ev) = tokio::time::timeout(Duration::from_secs(5), frames.recv()).await.ok().flatten() {
        if let TerminalEvent::Closed { reason: r } = ev {
            reason = Some(r);
            break;
        }
    }
    println!("[terminal] closed reason={reason:?}");
    assert_eq!(reason.as_deref(), Some("detached"));
    let sz = client.pane_read(&shell.pane_id, ReadOptions::new(ReadSource::Recent).lines(20)).await.unwrap();
    assert!(sz.text.contains("tf-hh-echo-42"));

    // ---- tabs / cleanup within the session ------------------------------------
    let tab = client.tab_create(&TabCreate { workspace_id: Some(ws.workspace.workspace_id.clone()), label: Some("t2".into()), ..Default::default() }).await.expect("tab_create");
    assert!(client.tab_list(Some(&ws.workspace.workspace_id)).await.unwrap().iter().any(|t| t.tab_id == tab.tab.tab_id));
    client.tab_close(&tab.tab.tab_id).await.expect("tab_close");
    client.pane_close(&shell.pane_id).await.expect("pane_close");
    client.workspace_close(&ws.workspace.workspace_id, false).await.expect("workspace_close");
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut closed_seen = false;
    while let Some(ev) = next_event(&mut events, deadline).await {
        if let HerdrEvent::WorkspaceClosed { workspace_id, .. } = &ev
            && *workspace_id == ws.workspace.workspace_id
        {
            closed_seen = true;
            break;
        }
    }
    println!("[events] workspace_closed seen={closed_seen}");
    assert!(closed_seen);
}
