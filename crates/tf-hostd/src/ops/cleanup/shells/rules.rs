//! Which herdr panes are idle shells (architecture §3.17 "Idle shells"); pure.
//!
//! A pane is an idle shell when all of these hold, checked in this order (the board's facts
//! first, then what the host says about the pane's processes, see `probe`):
//! 1. no agent runs in it (a board agent, of any kind),
//! 2. its workspace holds no agent: none runs in another of its panes, and no parked or ended card
//!    belongs there (by the workspace it was parked from, by its linked worktree, or by folder for
//!    records older than workspace ids),
//! 3. nobody may be looking at it: no TeleFlock terminal shows it, and it is not in herdr's
//!    focused workspace while a herdr window is (or may be) open (herdr's API does not say which
//!    workspace each window shows),
//! 4. its own process is a shell that holds the terminal's foreground (nothing runs in front of
//!    it), with no background jobs and no other process on its terminal, and not one that runs
//!    background jobs inside itself (nu, elvish, xonsh, PowerShell: no process shows those),
//! 5. no input or output for the threshold, counting time the host was awake. Unknown counts as
//!    recent.
//!
//! herdr closes a primary checkout's linked worktree workspaces together with it, so closing the
//! last pane of a workspace that leads such a group would take the group down: of a group
//! leader's panes at least one always stays.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use tf_proto::{Agent, Millis, Workspace};

use crate::herdr_health::idle::{is_shell, runs_jobs_inside};
use crate::state::parked::leads_worktree_group;
use crate::state::persist::ParkedRecord;

/// Why a pane is not an idle shell (or not closed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keep {
    Agent,
    WorkspaceAgent,
    Attached,
    OnScreen,
    LeadsGroup,
    Unknown,
    NotShell,
    Busy,
    Jobs,
    Used,
}

impl Keep {
    /// Why, in words (`cleanup.idleShellsClose`'s `kept`).
    pub fn reason(self) -> &'static str {
        match self {
            Keep::Agent => "an agent runs in it",
            Keep::WorkspaceAgent => "its workspace has an agent (running, done or ended)",
            Keep::Attached => "a TeleFlock terminal shows it",
            Keep::OnScreen => "it is in herdr's focused workspace while a herdr window is open",
            Keep::LeadsGroup => "it is the last pane of a workspace that linked worktrees are grouped under: closing it would close them all",
            Keep::Unknown => "what runs in it can't be told",
            Keep::NotShell => "it runs a program, not a shell",
            Keep::Busy => "a command runs in it",
            Keep::Jobs => "it has background jobs",
            Keep::Used => "it had input or output within the idle time",
        }
    }
}

/// One pane as the rules see it.
#[derive(Debug, Clone, PartialEq)]
pub struct PaneFacts {
    pub id: String,
    pub terminal_id: String,
    pub cwd: Option<String>,
    /// A board agent runs in it.
    pub agent: bool,
    /// A TeleFlock terminal shows it.
    pub attached: bool,
}

/// One herdr workspace as the rules see it.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceFacts {
    pub id: String,
    pub label: String,
    pub cwd: String,
    /// An agent runs in one of its panes, or a parked or ended card belongs to it.
    pub agent: bool,
    /// Linked worktree workspaces are grouped under it (herdr closes them with it).
    pub leads_group: bool,
    /// herdr's focused workspace while a herdr window is (or may be) open.
    pub on_screen: bool,
    /// In tab order.
    pub panes: Vec<PaneFacts>,
}

/// What the host says about a pane's shell (`probe`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Probe {
    /// The pane's own process: `bash`.
    pub shell: Option<String>,
    /// That process holds the terminal's foreground: nothing runs in front of it.
    pub at_prompt: Option<bool>,
    /// It has background jobs, or another process uses its terminal.
    pub jobs: Option<bool>,
    /// The last input or output on its terminal: the kernel's record, else since when hostd
    /// sees its screen unchanged; moved past the time the host slept since (no idle time).
    pub quiet_since: Option<Millis>,
}

fn same_path(a: &str, b: &str) -> bool {
    let trim = |s: &str| if s.len() > 1 { s.trim_end_matches(['/', '\\']).to_string() } else { s.to_string() };
    !a.is_empty() && Path::new(&trim(a)) == Path::new(&trim(b))
}

/// A parked or ended card belongs to `ws`.
fn holds(r: &ParkedRecord, ws: &Workspace) -> bool {
    r.workspace_id.as_deref() == Some(ws.id.as_str())
        || r.worktree.as_ref().is_some_and(|w| same_path(&w.path, &ws.cwd))
        || (r.workspace_id.is_none() && r.workspace_cwd.as_deref().or(r.cwd.as_deref()).is_some_and(|c| same_path(c, &ws.cwd)))
}

/// The board as the rules see it: `agents` and `workspaces` as published (`HostState`), the
/// parked and ended records (their cards lose the workspace), the panes TeleFlock terminals show,
/// and whether a herdr window is (or may be) open on the session.
pub fn facts(workspaces: &[Workspace], agents: &[Agent], parked: &[ParkedRecord], attached: &HashSet<String>, herdr_window: bool) -> Vec<WorkspaceFacts> {
    let live: Vec<&Agent> = agents.iter().filter(|a| a.parked.is_none()).collect();
    workspaces
        .iter()
        .map(|ws| {
            let panes: Vec<PaneFacts> = ws
                .tabs
                .iter()
                .flat_map(|t| t.panes.iter())
                .map(|p| PaneFacts {
                    id: p.id.clone(),
                    terminal_id: p.terminal_id.clone().unwrap_or_default(),
                    cwd: p.cwd.clone(),
                    agent: p.agent_id.is_some() || live.iter().any(|a| a.pane_id == p.id),
                    attached: attached.contains(&p.id),
                })
                .collect();
            let focused = ws.tabs.iter().flat_map(|t| t.panes.iter()).any(|p| p.focused);
            WorkspaceFacts {
                id: ws.id.clone(),
                label: ws.label.clone(),
                cwd: ws.cwd.clone(),
                agent: panes.iter().any(|p| p.agent) || live.iter().any(|a| a.workspace_id == ws.id) || parked.iter().any(|r| holds(r, ws)),
                leads_group: leads_worktree_group(ws, workspaces),
                on_screen: herdr_window && focused,
                panes,
            }
        })
        .collect()
}

/// The board's reasons to keep a pane, before anything is asked about its processes.
pub fn screen(ws: &WorkspaceFacts, pane: &PaneFacts) -> Result<(), Keep> {
    if pane.agent {
        return Err(Keep::Agent);
    }
    if ws.agent {
        return Err(Keep::WorkspaceAgent);
    }
    if pane.attached {
        return Err(Keep::Attached);
    }
    if ws.on_screen {
        return Err(Keep::OnScreen);
    }
    Ok(())
}

/// One pane's verdict, without the group rule: `Ok(idle since)`.
pub fn verdict(ws: &WorkspaceFacts, pane: &PaneFacts, probe: Option<&Probe>, now: Millis, minutes: u32) -> Result<Millis, Keep> {
    screen(ws, pane)?;
    let p = probe.ok_or(Keep::Unknown)?;
    let shell = p.shell.as_deref().ok_or(Keep::Unknown)?;
    if !is_shell(shell) {
        return Err(Keep::NotShell);
    }
    match p.at_prompt {
        None => return Err(Keep::Unknown),
        Some(false) => return Err(Keep::Busy),
        Some(true) => {}
    }
    match p.jobs {
        None => return Err(Keep::Unknown),
        Some(true) => return Err(Keep::Jobs),
        Some(false) => {}
    }
    // Background jobs that run on the shell's own threads show in no process fact.
    if runs_jobs_inside(shell) {
        return Err(Keep::Unknown);
    }
    let since = p.quiet_since.ok_or(Keep::Used)?;
    if now - since < i64::from(minutes) * 60_000 {
        return Err(Keep::Used);
    }
    Ok(since)
}

/// Every pane's verdict, `(workspace index, pane index, verdict)`. Of a group leader whose panes
/// are all idle shells, the first stays (closing them all would close the group).
pub fn assess(all: &[WorkspaceFacts], probes: &HashMap<String, Probe>, now: Millis, minutes: u32) -> Vec<(usize, usize, Result<Millis, Keep>)> {
    let mut out = Vec::new();
    for (wi, ws) in all.iter().enumerate() {
        let start = out.len();
        for (pi, pane) in ws.panes.iter().enumerate() {
            out.push((wi, pi, verdict(ws, pane, probes.get(&pane.id), now, minutes)));
        }
        if ws.leads_group && !ws.panes.is_empty() && out[start..].iter().all(|(_, _, v)| v.is_ok()) {
            out[start].2 = Err(Keep::LeadsGroup);
        }
    }
    out
}

/// Right before closing one pane: its verdict, and not the last pane (`panes_left`, as herdr
/// counts its workspace's panes now) of a group leader.
pub fn close_check(ws: &WorkspaceFacts, pane: &PaneFacts, probe: Option<&Probe>, now: Millis, minutes: u32, panes_left: usize) -> Result<Millis, Keep> {
    let since = verdict(ws, pane, probe, now, minutes)?;
    if ws.leads_group && panes_left <= 1 {
        return Err(Keep::LeadsGroup);
    }
    Ok(since)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const H: Millis = 3_600_000;
    const NOW: Millis = 100 * H;
    const DAY: u32 = 24 * 60;

    /// A workspace of `panes` (`(pane id, agent id)`), one tab; `primary`: the linked worktree's
    /// primary workspace.
    fn ws(id: &str, cwd: &str, panes: &[(&str, Option<&str>)], primary: Option<&str>) -> Workspace {
        let panes: Vec<_> = panes.iter().map(|(p, a)| json!({ "id": p, "terminalId": format!("t-{p}"), "cwd": cwd, "agentId": a, "focused": false })).collect();
        let mut v = json!({ "id": id, "label": id, "cwd": cwd, "tabs": [{ "id": format!("{id}:t1"), "label": "1", "panes": panes }], "rollup": "idle", "order": 0 });
        if let Some(p) = primary {
            v["worktree"] = json!({ "path": cwd, "primaryWorkspaceId": p });
        }
        serde_json::from_value(v).unwrap()
    }

    fn agent(id: &str, pane: &str, ws: &str, kind: &str) -> Agent {
        serde_json::from_value(json!({
            "id": id, "name": id, "kind": kind, "paneId": pane, "tabId": "", "workspaceId": ws,
            "state": "idle", "stateSince": 1, "column": "done", "archived": false, "turns": 1, "title": id,
            "live": { "streaming": false, "thinking": false },
        }))
        .unwrap()
    }

    fn idle_shell() -> Probe {
        Probe { shell: Some("bash".into()), at_prompt: Some(true), jobs: Some(false), quiet_since: Some(NOW - 30 * H) }
    }

    fn probes(ids: &[&str], p: Probe) -> HashMap<String, Probe> {
        ids.iter().map(|id| (id.to_string(), p.clone())).collect()
    }

    fn verdicts(all: &[WorkspaceFacts], probes: &HashMap<String, Probe>, minutes: u32) -> Vec<(String, Result<Millis, Keep>)> {
        assess(all, probes, NOW, minutes).into_iter().map(|(w, p, v)| (all[w].panes[p].id.clone(), v)).collect()
    }

    #[test]
    fn a_plain_shell_is_idle_after_the_threshold() {
        let all = facts(&[ws("w1", "/r/a", &[("w1:p1", None)], None)], &[], &[], &HashSet::new(), false);
        let p = probes(&["w1:p1"], idle_shell());
        assert_eq!(verdicts(&all, &p, DAY), [("w1:p1".to_string(), Ok(NOW - 30 * H))]);
        // 30 h quiet is not idle for a 48 h threshold; 24 h exactly is.
        assert_eq!(verdicts(&all, &p, 48 * 60)[0].1, Err(Keep::Used));
        let exactly = probes(&["w1:p1"], Probe { quiet_since: Some(NOW - 24 * H), ..idle_shell() });
        assert!(verdicts(&all, &exactly, DAY)[0].1.is_ok());
        let recent = probes(&["w1:p1"], Probe { quiet_since: Some(NOW - 24 * H + 1), ..idle_shell() });
        assert_eq!(verdicts(&all, &recent, DAY)[0].1, Err(Keep::Used));
        // Activity not known (hostd just started, nothing observed yet) counts as recent.
        let unknown = probes(&["w1:p1"], Probe { quiet_since: None, ..idle_shell() });
        assert_eq!(verdicts(&all, &unknown, DAY)[0].1, Err(Keep::Used));
    }

    #[test]
    fn never_an_agent_or_its_workspace() {
        let workspaces = [
            ws("w1", "/r/tf", &[("w1:p1", Some("omp-1")), ("w1:p2", None)], None),
            ws("w2", "/r/claude", &[("w2:p1", None), ("w2:p2", None)], None),
        ];
        // A claude agent the board knows by its pane, not by the pane's agent id.
        let agents = [agent("omp-1", "w1:p1", "w1", "omp"), agent("cl-1", "w2:p1", "w2", "claude")];
        let all = facts(&workspaces, &agents, &[], &HashSet::new(), false);
        let p = probes(&["w1:p1", "w1:p2", "w2:p1", "w2:p2"], idle_shell());
        let v = verdicts(&all, &p, DAY);
        assert_eq!(v[0].1, Err(Keep::Agent));
        assert_eq!(v[1].1, Err(Keep::WorkspaceAgent));
        assert_eq!(v[2].1, Err(Keep::Agent));
        assert_eq!(v[3].1, Err(Keep::WorkspaceAgent));
    }

    #[test]
    fn parked_and_ended_cards_keep_their_workspace() {
        let workspaces = [
            ws("w1", "/r/a", &[("w1:p1", None)], None),
            ws("w2", "/r/b-wt", &[("w2:p1", None)], Some("w9")),
            ws("w3", "/r/c", &[("w3:p1", None)], None),
            ws("w4", "/r/d", &[("w4:p1", None)], None),
            ws("w5", "/r/e", &[("w5:p1", None)], None),
        ];
        let parked = [
            // Marked done in w1.
            ParkedRecord { agent_id: "a1".into(), workspace_id: Some("w1".into()), cwd: Some("/elsewhere".into()), ..Default::default() },
            // Ran in the linked worktree w2 shows (resume reopens it there).
            ParkedRecord {
                agent_id: "a2".into(),
                workspace_id: Some("w-gone".into()),
                worktree: Some(crate::state::persist::ParkedWorktree { path: "/r/b-wt/".into(), repo_root: "/r/b".into() }),
                ..Default::default()
            },
            // An older record without a workspace id, by folder; an ended one.
            ParkedRecord {
                agent_id: "a3".into(),
                cwd: Some("/r/c".into()),
                ended: Some(serde_json::from_value(json!({ "at": 1, "cause": "herdrStopped", "reason": "herdr stopped", "turn": "idle" })).unwrap()),
                ..Default::default()
            },
            // Parked from a workspace that is gone: a later workspace in its folder is not its
            // (resume opens a new one, as it adds a tab only to the workspace it left).
            ParkedRecord { agent_id: "a4".into(), workspace_id: Some("w-old".into()), workspace_cwd: Some("/r/d".into()), cwd: Some("/r/d".into()), ..Default::default() },
        ];
        let all = facts(&workspaces, &[], &parked, &HashSet::new(), false);
        let p = probes(&["w1:p1", "w2:p1", "w3:p1", "w4:p1", "w5:p1"], idle_shell());
        let v = verdicts(&all, &p, DAY);
        assert_eq!(v[0].1, Err(Keep::WorkspaceAgent));
        assert_eq!(v[1].1, Err(Keep::WorkspaceAgent));
        assert_eq!(v[2].1, Err(Keep::WorkspaceAgent));
        assert!(v[3].1.is_ok(), "{v:?}");
        assert!(v[4].1.is_ok());
    }

    #[test]
    fn never_what_someone_may_be_looking_at() {
        let mut focused = ws("w2", "/r/b", &[("w2:p1", None)], None);
        focused.tabs[0].panes[0].focused = true;
        let workspaces = [ws("w1", "/r/a", &[("w1:p1", None)], None), focused];
        let attached = HashSet::from(["w1:p1".to_string()]);
        let p = probes(&["w1:p1", "w2:p1"], idle_shell());
        let all = facts(&workspaces, &[], &[], &attached, true);
        let v = verdicts(&all, &p, DAY);
        assert_eq!(v[0].1, Err(Keep::Attached));
        assert_eq!(v[1].1, Err(Keep::OnScreen));
        // No herdr window open: herdr's focused workspace is on no screen.
        let all = facts(&workspaces, &[], &[], &HashSet::new(), false);
        assert!(verdicts(&all, &p, DAY).iter().all(|(_, v)| v.is_ok()));
    }

    #[test]
    fn never_a_pane_running_anything() {
        let all = facts(&[ws("w1", "/r/a", &[("w1:p1", None)], None)], &[], &[], &HashSet::new(), false);
        let one = |p: Probe| verdicts(&all, &probes(&["w1:p1"], p), DAY)[0].1;
        // `sleep 1000` in front of the shell; vim; htop as the pane's own program.
        assert_eq!(one(Probe { at_prompt: Some(false), ..idle_shell() }), Err(Keep::Busy));
        assert_eq!(one(Probe { shell: Some("htop".into()), ..idle_shell() }), Err(Keep::NotShell));
        // `sleep 1000 &`, or another process on its terminal.
        assert_eq!(one(Probe { jobs: Some(true), ..idle_shell() }), Err(Keep::Jobs));
        // Whatever can't be told keeps it.
        assert_eq!(one(Probe { jobs: None, ..idle_shell() }), Err(Keep::Unknown));
        assert_eq!(one(Probe { at_prompt: None, ..idle_shell() }), Err(Keep::Unknown));
        assert_eq!(one(Probe { shell: None, ..idle_shell() }), Err(Keep::Unknown));
        assert_eq!(verdicts(&all, &HashMap::new(), DAY)[0].1, Err(Keep::Unknown));
        // Login shells (`-bash`) and other shells count.
        assert!(one(Probe { shell: Some("-zsh".into()), ..idle_shell() }).is_ok());
        assert!(one(Probe { shell: Some("fish".into()), ..idle_shell() }).is_ok());
    }

    /// nushell's `job spawn`, PowerShell's `Start-ThreadJob`, elvish's and xonsh's background
    /// functions run on threads of the shell itself: no child process, nothing else on the
    /// terminal and nothing in front of the prompt shows them.
    #[test]
    fn a_shell_that_runs_jobs_inside_itself_can_not_be_told_idle() {
        let all = facts(&[ws("w1", "/r/a", &[("w1:p1", None)], None)], &[], &[], &HashSet::new(), false);
        let one = |shell: &str| verdicts(&all, &probes(&["w1:p1"], Probe { shell: Some(shell.into()), ..idle_shell() }), DAY)[0].1;
        for shell in ["nu", "-nu", "elvish", "xonsh", "pwsh", "/usr/bin/pwsh", "powershell", "pwsh.exe"] {
            assert_eq!(one(shell), Err(Keep::Unknown), "{shell}");
            assert!(is_shell(shell), "{shell} at its prompt stays a shell for herdr's restart check");
        }
        assert!(one("bash").is_ok());
    }

    #[test]
    fn a_group_leader_keeps_a_pane() {
        // `w1` is the primary checkout that the linked worktree `w2` is grouped under.
        let workspaces = [
            ws("w1", "/r/ordista", &[("w1:p1", None)], None),
            ws("w2", "/r/ordista-wt", &[("w2:p1", None)], Some("w1")),
            ws("w3", "/r/two", &[("w3:p1", None), ("w3:p2", None)], None),
            ws("w4", "/r/two-wt", &[("w4:p1", Some("omp-4"))], Some("w3")),
        ];
        let all = facts(&workspaces, &[agent("omp-4", "w4:p1", "w4", "omp")], &[], &HashSet::new(), false);
        assert!(all[0].leads_group && !all[1].leads_group && all[2].leads_group);
        let p = probes(&["w1:p1", "w2:p1", "w3:p1", "w3:p2"], idle_shell());
        let v = verdicts(&all, &p, DAY);
        assert_eq!(v[0].1, Err(Keep::LeadsGroup));
        // The linked worktree's own shell closes only its workspace.
        assert!(v[1].1.is_ok());
        // Of two idle shells one goes, the other keeps the workspace (and its group) open.
        assert_eq!(v[2].1, Err(Keep::LeadsGroup));
        assert!(v[3].1.is_ok());
        // Right before closing, herdr's count decides.
        let (w3, p2) = (&all[2], &all[2].panes[1]);
        assert!(close_check(w3, p2, p.get("w3:p2"), NOW, DAY, 2).is_ok());
        assert_eq!(close_check(w3, p2, p.get("w3:p2"), NOW, DAY, 1), Err(Keep::LeadsGroup));
        assert!(close_check(&all[1], &all[1].panes[0], p.get("w2:p1"), NOW, DAY, 1).is_ok());
    }

    #[test]
    fn paths_match_without_trailing_separators() {
        assert!(same_path("/r/a/", "/r/a"));
        assert!(same_path("/", "/"));
        assert!(!same_path("/r/a", "/r/ab"));
        assert!(!same_path("", ""));
    }
}
