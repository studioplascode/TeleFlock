//! Parser tests over the real captures in `docs/research/herdr-samples`.

use serde_json::Value;
use std::path::PathBuf;
use tf_herdr::*;

const SESSION_ID: &str = "01a15b4c-da1a-735a-94c6-af07601f04d1";

fn sample(name: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/research/herdr-samples").join(name);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn result(name: &str) -> Value {
    parse_response(sample(name).trim()).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn field<T: serde::de::DeserializeOwned>(v: &Value, key: &str) -> T {
    serde_json::from_value(v[key].clone()).unwrap_or_else(|e| panic!("{key}: {e}"))
}

fn whole<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

#[test]
fn agent_info_samples() {
    for (name, status, seq) in [
        ("agent-get.json", AgentStatus::Idle, 1),
        ("agent-get-blocked.json", AgentStatus::Blocked, 7),
        ("agent-prompt-blocked.json", AgentStatus::Blocked, 7),
        ("agent-prompt-wait.json", AgentStatus::Idle, 3),
        ("agent-rename.json", AgentStatus::Idle, 9),
    ] {
        let r = result(name);
        let a: AgentInfo = field(&r, "agent");
        assert_eq!(a.agent_status, status, "{name}");
        assert_eq!(a.state_change_seq, seq, "{name}");
        assert_eq!(a.pane_id, "w1:p1");
        assert_eq!(a.terminal_id, "term_65e4c9feaf5881");
        assert_eq!(a.agent.as_deref(), Some("omp"));
        assert!(a.interactive_ready && a.screen_detection_skipped);
        let s = a.agent_session.as_ref().unwrap();
        assert_eq!(s.kind, AgentSessionKind::Path);
        assert_eq!(s.session_id(), Some(SESSION_ID));
        assert!(s.path().unwrap().ends_with(".jsonl"));
    }
    let renamed: AgentInfo = field(&result("agent-rename.json"), "agent");
    assert_eq!(renamed.name.as_deref(), Some("labomp2"));
    assert_eq!(renamed.target(), "labomp2");
}

#[test]
fn agent_lists() {
    let a: Vec<AgentInfo> = field(&result("agent-list.json"), "agents");
    assert_eq!(a.len(), 1);
    assert_eq!(a[0].name.as_deref(), Some("labomp"));
    let raw: Vec<AgentInfo> = field(&result("raw-agent-list.json"), "agents");
    assert_eq!(raw[0].tokens.get("todos").map(String::as_str), Some("3/7"));
    assert_eq!(raw[0].tokens.get("ctx").map(String::as_str), Some("41%"));
    assert_eq!(raw[0].revision, 794);
}

#[test]
fn snapshot_sample() {
    let s: Snapshot = field(&result("api-snapshot.json"), "snapshot");
    assert_eq!(s.focused_pane_id.as_deref(), Some("w1:p1"));
    assert_eq!(s.agents.len(), 1);
    assert_eq!(s.workspaces.len(), 3);
    assert!(!s.panes.is_empty());
    assert_eq!(s.layouts.len(), 3);
    assert_eq!(s.layouts[0].area.width, 120);
    let omp = s.panes.iter().find(|p| p.pane_id == "w1:p1").unwrap();
    assert_eq!(omp.scroll.unwrap().max_offset_from_bottom, 23);
    let shell = s.panes.iter().find(|p| p.pane_id == "w2:p1").unwrap();
    assert_eq!(shell.agent, None);
    assert_eq!(shell.agent_status, AgentStatus::Unknown);
    let repo = s.workspaces.iter().find(|w| w.worktree.is_some()).unwrap();
    assert!(!repo.worktree.as_ref().unwrap().is_linked_worktree);
}

#[test]
fn workspace_samples() {
    let c: WorkspaceCreated = whole(result("workspace-create.json"));
    assert_eq!(c.workspace.workspace_id, "w2");
    assert_eq!(c.workspace.label, "lab-other");
    assert_eq!(c.tab.tab_id, "w2:t1");
    assert_eq!(c.root_pane.pane_id, "w2:p1");
    assert_eq!(c.root_pane.cwd.as_deref(), Some("/root"));

    let g: WorkspaceInfo = field(&result("workspace-get.json"), "workspace");
    let wt = g.worktree.unwrap();
    assert_eq!(wt.repo_key, "/tmp/tf-lab-repo/.git");
    assert_eq!(wt.repo_name, "tf-lab-repo");

    let l: Vec<WorkspaceInfo> = field(&result("workspace-list.json"), "workspaces");
    assert_eq!(l[0].agent_status, AgentStatus::Idle);
    assert_eq!(l[0].active_tab_id.as_deref(), Some("w1:t1"));
    let raw: Vec<WorkspaceInfo> = field(&result("raw-workspace-list.json"), "workspaces");
    assert_eq!(raw.len(), 3);
    assert_eq!(raw[1].pane_count, 3);
}

#[test]
fn tab_and_pane_samples() {
    let t: TabCreated = whole(result("tab-create.json"));
    assert_eq!(t.tab.label, "tabx");
    assert_eq!(t.root_pane.pane_id, "w2:p2");
    let tabs: Vec<TabInfo> = field(&result("tab-list.json"), "tabs");
    assert_eq!(tabs[0].tab_id, "w1:t1");

    let p: PaneInfo = field(&result("pane-get.json"), "pane");
    assert_eq!(p.scroll.unwrap().viewport_rows, 40);
    assert_eq!(p.agent_session.unwrap().session_id(), Some(SESSION_ID));
    let split: PaneInfo = field(&result("pane-split.json"), "pane");
    assert_eq!(split.pane_id, "w2:p3");

    let layout: PaneLayout = field(&result("pane-layout.json"), "layout");
    assert_eq!(layout.panes[0].rect.height, 40);
    assert!(!layout.zoomed);

    let pi: ProcessInfo = field(&result("pane-process-info.json"), "process_info");
    assert_eq!(pi.shell_pid, Some(158520));
    assert_eq!(pi.foreground_processes[0].pid, 161248);
    assert_eq!(pi.foreground_processes[0].argv, ["omp", "--model", "openai-codex/gpt-6-luna:low"]);

    let read: PaneRead = field(&result("raw-pane-read.json"), "read");
    assert_eq!(read.source, "recent");
    assert!(read.truncated);
    assert!(read.text.contains("ASK"));
    let waited: PaneRead = field(&result("pane-wait-output.json"), "read");
    assert_eq!(waited.source, "recent_unwrapped");

    assert_eq!(result("agent-send-keys.json")["type"], "ok");
    assert_eq!(result("raw-pane-send-input.json")["type"], "ok");
}

#[test]
fn worktree_samples() {
    let l: WorktreeList = whole(result("worktree-list.json"));
    assert_eq!(l.source.repo_root, "/tmp/tf-lab-repo");
    assert_eq!(l.source.source_workspace_id.as_deref(), Some("w3"));
    assert_eq!(l.worktrees.len(), 2);
    assert_eq!(l.worktrees[1].branch.as_deref(), Some("feat/y"));
    assert!(l.worktrees[1].is_linked_worktree);
    assert_eq!(l.worktrees[1].open_workspace_id.as_deref(), Some("w6"));

    let c: WorktreeCreated = whole(result("worktree-create.json"));
    assert_eq!(c.workspace.workspace_id, "w4");
    assert!(c.workspace.worktree.as_ref().unwrap().is_linked_worktree);
    assert_eq!(c.root_pane.pane_id, "w4:p1");

    let r: WorktreeRemoved = whole(result("worktree-remove.json"));
    assert!(r.forced);
    assert_eq!(r.workspace_id, "w4");
}

#[test]
fn ping_status_sessions() {
    let p: Pong = whole(result("raw-ping.json"));
    assert_eq!(p.version, "0.9.0");
    assert_eq!(p.protocol, 22);
    assert!(p.capabilities.unwrap().health_check);
    assert_eq!(parse_version(&p.version), Some((0, 9, 0)));

    let lab: Status = serde_json::from_str(&sample("status-lab.json")).unwrap();
    assert!(lab.server.running);
    assert_eq!(lab.server.socket.as_deref(), Some("/root/.config/herdr/sessions/tf-lab-herdr/herdr.sock"));
    assert_eq!(lab.client.binary.as_deref(), Some("/root/.local/bin/herdr"));
    let down: Status = serde_json::from_str(&sample("status-not-running.json")).unwrap();
    assert!(!down.server.running);
    assert_eq!(down.server.status, "not_running");
    assert_eq!(down.server.version, None);
    let server: ServerStatus = serde_json::from_str(&sample("status-server-lab.json")).unwrap();
    assert_eq!(server.compatible, Some(true));
    let client: ClientStatus = serde_json::from_str(&sample("status-client.json")).unwrap();
    assert_eq!(client.session.as_deref(), Some("tf-lab-herdr"));

    #[derive(serde::Deserialize)]
    struct L {
        sessions: Vec<SessionEntry>,
    }
    let s: L = serde_json::from_str(&sample("session-list.json")).unwrap();
    assert!(s.sessions.iter().any(|e| e.default && e.name == "default"));
    assert!(s.sessions.iter().any(|e| e.name == "tf-lab-herdr" && e.socket_path.ends_with("herdr.sock")));
}

#[test]
fn explain_sample() {
    let e: AgentExplain = serde_json::from_str(&sample("agent-explain.json")).unwrap();
    assert_eq!(e.state, Some(AgentStatus::Idle));
    assert_eq!(e.agent.as_deref(), Some("omp"));
}

#[test]
fn error_samples() {
    for (name, code_) in [
        ("error-agent-blocked.json", code::AGENT_BLOCKED),
        ("error-agent-start-busy.json", code::AGENT_PANE_BUSY),
        ("error-server-not-running.json", code::SERVER_NOT_RUNNING),
        ("error-wait-timeout.json", code::TIMEOUT),
        ("error-workspace-close-group.json", code::WORKSPACE_GROUP_CLOSE_REQUIRED),
        ("error-worktree-branch-in-use.json", code::WORKTREE_CREATE_FAILED),
        ("error-worktree-not-repo.json", code::NOT_GIT_WORKTREE),
        ("error-worktree-remove-dirty.json", code::DIRTY_WORKTREE_REQUIRES_FORCE),
        ("error-worktree-untrusted.json", code::WORKTREE_LIST_FAILED),
    ] {
        let e = parse_response(sample(name).trim()).unwrap_err();
        assert_eq!(e.code, code_, "{name}");
        assert!(!e.message.is_empty());
    }
    assert!(parse_response(sample("error-worktree-untrusted.json").trim()).unwrap_err().is_dubious_ownership());
    assert!(parse_response(sample("error-server-not-running.json").trim()).unwrap_err().is_server_not_running());
}

#[test]
fn error_envelope_versions() {
    // 0.9.0: id lost, unknown method reported as invalid_request.
    let old = r#"{"id":"","error":{"code":"invalid_request","message":"invalid request: unknown variant `pane.graphics.set`, expected one of `ping`"}}"#;
    assert_eq!(parse_response(old).unwrap_err().code, code::UNKNOWN_METHOD);
    // 0.9.2+: id kept, explicit code.
    let new = r#"{"id":"tf:x:1","error":{"code":"unknown_method","message":"unknown method pane.graphics.set"}}"#;
    assert_eq!(parse_response(new).unwrap_err().code, code::UNKNOWN_METHOD);
    // A real invalid_request stays as is.
    let bad = r#"{"id":"","error":{"code":"invalid_request","message":"missing field `pane_id`"}}"#;
    assert_eq!(parse_response(bad).unwrap_err().code, code::INVALID_REQUEST);
    assert_eq!(parse_response("not json").unwrap_err().code, code::PROTOCOL);
}

#[test]
fn event_log_sample() {
    let log = sample("events-subscribe-sample.log");
    let mut kinds = std::collections::BTreeMap::<&'static str, usize>::new();
    let mut acked = false;
    for raw in log.lines() {
        let Some((_, line)) = raw.split_once(' ') else { continue };
        if line == "EOF" {
            continue;
        }
        if line.contains("subscription_started") {
            assert_eq!(parse_response(line).unwrap()["type"], "subscription_started");
            acked = true;
            continue;
        }
        let ev = parse_event(line).unwrap().unwrap();
        let k = match &ev {
            HerdrEvent::PaneAgentDetected { agent, .. } => {
                assert_eq!(agent.as_deref(), Some("omp"));
                "agent_detected"
            }
            HerdrEvent::PaneUpdated(p) => {
                assert!(!p.pane_id.is_empty());
                "pane_updated"
            }
            HerdrEvent::AgentStatusChanged { pane_id, agent_status, .. } => {
                assert_eq!(pane_id, "w1:p1");
                assert_ne!(*agent_status, AgentStatus::Unknown);
                "status"
            }
            HerdrEvent::WorkspaceCreated(w) => {
                assert_eq!(w.workspace_id, "w2");
                "ws_created"
            }
            HerdrEvent::WorkspaceFocused { .. } => "ws_focused",
            HerdrEvent::TabCreated(_) => "tab_created",
            HerdrEvent::TabFocused { .. } => "tab_focused",
            HerdrEvent::PaneCreated(_) => "pane_created",
            HerdrEvent::PaneFocused { .. } => "pane_focused",
            HerdrEvent::LayoutUpdated(l) => {
                assert!(!l.tab_id.is_empty());
                "layout"
            }
            HerdrEvent::WorktreeCreated { worktree, .. } => {
                assert_eq!(worktree.branch.as_deref(), Some("feat/x"));
                "wt_created"
            }
            HerdrEvent::WorktreeOpened { already_open, .. } => {
                assert!(*already_open);
                "wt_opened"
            }
            HerdrEvent::WorktreeRemoved { workspace_id, forced, .. } => {
                assert_eq!(workspace_id, "w4");
                assert!(*forced);
                "wt_removed"
            }
            HerdrEvent::WorkspaceClosed { workspace_id, workspace } => {
                assert_eq!(workspace_id, "w4");
                assert!(workspace.is_some());
                "ws_closed"
            }
            HerdrEvent::Other { event, .. } => {
                assert_eq!(event, "pane.scroll_changed", "unexpected untyped event");
                "other"
            }
            other => panic!("unexpected {other:?}"),
        };
        *kinds.entry(k).or_default() += 1;
    }
    assert!(acked);
    for k in ["status", "pane_updated", "ws_created", "wt_created", "wt_removed", "ws_closed", "layout"] {
        assert!(kinds.contains_key(k), "missing {k}: {kinds:?}");
    }
}

#[test]
fn terminal_session_samples() {
    for name in ["terminal-session-control.jsonl", "terminal-session-observe.jsonl"] {
        let text = sample(name);
        let evs: Vec<_> = text.lines().filter_map(|l| parse_terminal_line(l).unwrap()).collect();
        let TerminalEvent::Frame(first) = &evs[0] else { panic!("{name}: first is not a frame") };
        assert!(first.full, "{name}: first frame must be full");
        assert!(first.cols > 0 && first.rows > 0);
        let bytes = first.decode().unwrap();
        assert!(bytes.starts_with(b"\x1b[?2026h"), "{name}: synchronized output prefix");
        let mut last_seq = 0;
        for ev in &evs {
            if let TerminalEvent::Frame(f) = ev {
                assert!(f.seq > last_seq || last_seq == 0);
                last_seq = f.seq;
                f.decode().unwrap();
            }
        }
        if name.contains("control") {
            assert_eq!(evs.last(), Some(&TerminalEvent::Closed { reason: "detached".into() }));
        }
    }
}
