//! When a newer installed herdr may replace the running server (architecture §3.29): what keeps a
//! session busy (pure, from the board and the panes' processes), how the server is replaced, and
//! when the idle window is over.

use tf_proto::{Agent, AutoResumeStatus, Column, HerdrState, HerdrUpdateMode, HerdrUpdateState, Millis};

/// Shells whose idle prompt is fine to lose on a restart (`comm` names; Linux truncates them to
/// 15 bytes).
const SHELLS: &[&str] = &[
    "bash", "zsh", "fish", "sh", "dash", "ash", "ksh", "mksh", "oksh", "pdksh", "yash", "tcsh", "csh", "nu", "elvish", "xonsh",
    "pwsh", "powershell", "powershell.exe", "pwsh.exe", "cmd.exe", "bash.exe", "zsh.exe", "fish.exe", "busybox",
];

/// Of [`SHELLS`], those that run background jobs inside their own process: nushell's `job spawn`,
/// PowerShell's `Start-ThreadJob`, elvish's and xonsh's background functions run on the shell's
/// threads, with no process of their own.
const IN_PROCESS_JOBS: &[&str] = &["nu", "elvish", "xonsh", "pwsh", "powershell", "pwsh.exe", "powershell.exe"];

/// `bash` of `-bash`, `/bin/bash`; `bash.exe` of `C:\…\bash.exe`.
fn program(process: &str) -> &str {
    let name = process.trim().trim_start_matches('-');
    name.rsplit(['/', '\\']).next().unwrap_or(name)
}

pub fn is_shell(process: &str) -> bool {
    let name = program(process);
    SHELLS.iter().any(|s| s.eq_ignore_ascii_case(name))
}

/// A shell whose background jobs no process shows ([`IN_PROCESS_JOBS`]): at its prompt it may
/// still be running one.
pub fn runs_jobs_inside(process: &str) -> bool {
    let name = program(process);
    IN_PROCESS_JOBS.iter().any(|s| s.eq_ignore_ascii_case(name))
}

/// One herdr pane as the gate sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneFacts {
    pub pane_id: String,
    /// The board agent occupying it.
    pub agent_id: Option<String>,
    /// Its foreground program (`PaneInfo.process`); `None` when unknown.
    pub process: Option<String>,
    /// Its shell has child processes (jobs started with `&`, `nohup`, …).
    pub background: bool,
}

/// How the running server gets the installed herdr: a live handoff keeps every pane process
/// (herdr ≥ 0.9.4 servers on Unix announce it in `ping`'s capabilities), otherwise it restarts.
pub fn mode(live_handoff: bool) -> HerdrUpdateMode {
    if cfg!(unix) && live_handoff { HerdrUpdateMode::Handoff } else { HerdrUpdateMode::Restart }
}

/// What the plan for a pending load says. Only a live handoff (it keeps every pane process) is
/// ever loaded by itself; when the server can only be stopped and started, the load is `ready`
/// and waits for the user, however idle the session is.
pub fn update_state(failed: bool, idle_update: bool, mode: HerdrUpdateMode) -> HerdrUpdateState {
    match (failed, idle_update, mode) {
        (true, ..) => HerdrUpdateState::Failed,
        (false, false, _) => HerdrUpdateState::Manual,
        (false, true, HerdrUpdateMode::Restart) => HerdrUpdateState::Ready,
        (false, true, HerdrUpdateMode::Handoff) => HerdrUpdateState::Waiting,
    }
}

/// The installed herdr is a newer build than the running server: a higher version, or the same
/// version further along (`0.9.6-preview.12` → `0.9.6-preview.13` → `0.9.6`). Never a downgrade.
pub fn newer(installed: &str, running: &str) -> bool {
    cmp_versions(installed, running) == Some(std::cmp::Ordering::Greater)
}

/// Orders herdr versions: `x.y.z`, then a release above its pre-releases, pre-release identifiers
/// compared numerically where both are numbers (`preview.9` < `preview.10`).
pub fn cmp_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    let split = |v: &str| {
        let v = v.trim().trim_start_matches('v');
        let v = v.split('+').next().unwrap_or(v);
        let (core, pre) = v.split_once('-').map_or((v, None), |(c, p)| (c, Some(p.to_string())));
        Some((tf_herdr::parse_version(core)?, pre))
    };
    let ((ca, pa), (cb, pb)) = (split(a)?, split(b)?);
    Some(ca.cmp(&cb).then_with(|| match (pa, pb) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => {
            let (xs, ys): (Vec<&str>, Vec<&str>) = (x.split('.').collect(), y.split('.').collect());
            for (p, q) in xs.iter().zip(&ys) {
                let o = match (p.parse::<u64>(), q.parse::<u64>()) {
                    (Ok(m), Ok(n)) => m.cmp(&n),
                    _ => p.cmp(q),
                };
                if o != Ordering::Equal {
                    return o;
                }
            }
            xs.len().cmp(&ys.len())
        }
    }))
}

/// An idle shell has children of its own: background jobs (`cmd &`, `nohup`) that a restart
/// would end. Prompt helpers that live as long as the shell (powerlevel10k's gitstatusd) don't
/// count, nor jobs that already exited (a shell like dash reaps them only at its next prompt); a
/// child that can't be read does.
pub fn has_background_jobs(shell_pid: u32) -> bool {
    background_jobs(shell_pid) == Some(true)
}

/// [`has_background_jobs`], `None` where the shell's children can't be read (not Linux, or not
/// our process).
pub fn background_jobs(shell_pid: u32) -> Option<bool> {
    let kids = children(shell_pid)?;
    Some(any_job(&kids, |c| std::fs::read_to_string(format!("/proc/{c}/stat")).ok()))
}

/// One of `kids` runs, by its `/proc/<pid>/stat` line (`stat`). A child whose line can't be read
/// or parsed (another user's `sudo … &` under `/proc` mounted `hidepid=2`) may run anything: it
/// counts.
fn any_job(kids: &[u32], stat: impl Fn(u32) -> Option<String>) -> bool {
    kids.iter().any(|&c| stat(c).as_deref().and_then(crate::state::procs::parse_stat).is_none_or(|s| !s.exited() && !s.comm.starts_with("gitstatusd")))
}

/// When the idle window ends.
pub fn due_at(idle_since: Millis, idle_minutes: u32) -> Millis {
    idle_since + i64::from(idle_minutes.clamp(1, 1440)) * 60_000
}

fn count(n: usize, one: &str, many: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {many}") }
}

fn list(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [a] => a.clone(),
        [a, b] => format!("{a} and {b}"),
        [a, b, rest @ ..] => format!("{a}, {b} and {} more", rest.len()),
    }
}

/// What keeps the session busy, one short phrase each; empty when the server may be replaced.
/// `attached`: TeleFlock terminals attached in control mode.
pub fn blockers(agents: &[Agent], panes: &[PaneFacts], attached: usize, mode: HerdrUpdateMode) -> Vec<String> {
    let live: Vec<&Agent> = agents.iter().filter(|a| a.parked.is_none() && !a.pane_id.is_empty()).collect();
    let mut out = Vec::new();
    // herdr's state, and TeleFlock's own view of the omp session (a turn running, a tool open,
    // output streaming): herdr reports omp states only with its omp integration installed.
    let working = live
        .iter()
        .filter(|a| {
            a.state == HerdrState::Working
                || a.column == Column::Running
                || a.live.streaming
                || a.live.tool.is_some()
                || a.omp.as_ref().is_some_and(|o| o.turn_started_at.is_some())
        })
        .count();
    if working > 0 {
        out.push(format!("{} working", count(working, "agent", "agents")));
    }
    let waiting = live.iter().filter(|a| a.needs.is_some() || a.state == HerdrState::Blocked || a.column == Column::Needs).count();
    if waiting > 0 {
        out.push(format!("{} for you", count(waiting, "agent waits", "agents wait")));
    }
    let jobs = live.iter().filter(|a| a.omp.as_ref().and_then(|o| o.jobs.as_ref()).is_some_and(|j| j.running > 0 || j.waiting)).count();
    if jobs > 0 {
        out.push(format!("background jobs run in {}", count(jobs, "agent", "agents")));
    }
    let subagents = live
        .iter()
        .filter(|a| a.state != HerdrState::Working && a.omp.as_ref().and_then(|o| o.subagents.as_ref()).is_some_and(|s| s.live > 0))
        .count();
    if subagents > 0 {
        out.push(format!("subagents run in {}", count(subagents, "agent", "agents")));
    }
    let resuming = agents
        .iter()
        .filter(|a| a.auto_resume.as_ref().is_some_and(|r| matches!(r.status, AutoResumeStatus::Checking | AutoResumeStatus::Resuming)))
        .count();
    if resuming > 0 {
        out.push(format!("{} resuming", count(resuming, "agent is", "agents are")));
    }
    if mode == HerdrUpdateMode::Restart {
        // TeleFlock brings omp agents back after a restart; other agents would just end.
        let mut others: Vec<String> = live.iter().filter(|a| a.kind != "omp").map(|a| a.kind.clone()).collect();
        others.sort();
        others.dedup();
        if !others.is_empty() {
            out.push(format!("{} open in a pane", list(&others)));
        }
    }
    let agent_panes: Vec<&str> = live.iter().map(|a| a.pane_id.as_str()).collect();
    let mut programs: Vec<String> = Vec::new();
    let mut unknown = 0;
    let mut background = 0;
    for p in panes.iter().filter(|p| p.agent_id.is_none() && !agent_panes.contains(&p.pane_id.as_str())) {
        match p.process.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            None => unknown += 1,
            Some(name) if is_shell(name) => background += usize::from(p.background),
            Some(name) => programs.push(name.to_string()),
        }
    }
    programs.sort();
    programs.dedup();
    if !programs.is_empty() {
        out.push(format!("{} {}", if programs.len() == 1 { "a terminal runs" } else { "terminals run" }, list(&programs)));
    }
    if background > 0 {
        out.push(format!("{} background jobs", if background == 1 { "a terminal has".to_string() } else { format!("{background} terminals have") }));
    }
    if unknown > 0 {
        out.push(format!("{} not known yet", if unknown == 1 { "a terminal's program is".to_string() } else { format!("{unknown} terminals' programs are") }));
    }
    if attached > 0 {
        out.push(if attached == 1 { "a TeleFlock terminal is attached".to_string() } else { format!("{attached} TeleFlock terminals are attached") });
    }
    out
}

/// The herdr session or socket a herdr command line attaches a window to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Session(String),
    Socket(String),
}

fn session_name(name: &str) -> String {
    if name.is_empty() { "default".to_string() } else { name.to_string() }
}

/// A herdr command line (program first) as its `--session` and its other arguments; `None` when
/// `--session` lacks its value.
fn split_session(args: &[String]) -> Option<(Option<String>, Vec<&str>)> {
    let mut session = None;
    let mut rest: Vec<&str> = Vec::new();
    let mut i = 1;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--session" {
            session = Some(args.get(i + 1)?.clone());
            i += 2;
            continue;
        }
        if let Some(v) = a.strip_prefix("--session=") {
            session = Some(v.to_string());
        } else {
            rest.push(a);
        }
        i += 1;
    }
    Some((session, rest))
}

/// Where a herdr command with `--session` `session` attaches: that session, else herdr takes
/// `HERDR_SOCKET_PATH`, then `HERDR_SESSION`.
fn target_of(session: Option<String>, env_session: Option<&str>, env_socket: Option<&str>) -> Target {
    match (session, env_socket.filter(|s| !s.is_empty()), env_session) {
        (Some(s), _, _) => Target::Session(session_name(&s)),
        (None, Some(sock), _) => Target::Socket(sock.to_string()),
        (None, None, Some(s)) => Target::Session(session_name(s)),
        (None, None, None) => Target::Session("default".into()),
    }
}

/// What `args` (a herdr process's command line, program first) attaches to when it is a herdr TUI
/// window: plain `herdr`, `herdr client`, `herdr session attach <name>`, each with an optional
/// `--session`. Every other command (the server, the CLI, `terminal session`, `update`, …) is
/// `None`. Without `--session`, herdr takes `HERDR_SOCKET_PATH`, then `HERDR_SESSION`.
pub fn tui_target(args: &[String], env_session: Option<&str>, env_socket: Option<&str>) -> Option<Target> {
    if args.get(1).map(String::as_str) == Some("session") && args.get(2).map(String::as_str) == Some("attach") {
        return (args.len() == 4).then(|| Target::Session(session_name(&args[3])));
    }
    let (session, rest) = split_session(args)?;
    (rest.is_empty() || rest == ["client"]).then(|| target_of(session, env_session, env_socket))
}

/// What `args` attaches to when it is the bridge of a herdr window on another computer: `herdr
/// remote-api-bridge` with an optional `--session`, which `herdr --remote` and saved machines run
/// over SSH while their window is open; not the `--check` they probe with first.
pub fn remote_target(args: &[String], env_session: Option<&str>, env_socket: Option<&str>) -> Option<Target> {
    let (session, rest) = split_session(args)?;
    (rest == ["remote-api-bridge"]).then(|| target_of(session, env_session, env_socket))
}

/// herdr processes on this host that `target` says attach to `session`'s server (Linux); `None`
/// where that cannot be told.
#[cfg(target_os = "linux")]
fn attached(session: &str, socket: &std::path::Path, target: impl Fn(&[String], Option<&str>, Option<&str>) -> Option<Target>) -> Option<usize> {
    let mut n = 0;
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) else { continue };
        let args: Vec<String> = raw.split(|b| *b == 0).filter(|a| !a.is_empty()).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
        if args.is_empty() || !args[0].rsplit('/').next().is_some_and(|n| n.starts_with("herdr")) {
            continue;
        }
        let env_session = tf_herdr::lifecycle::process_env(pid, "HERDR_SESSION");
        let env_socket = tf_herdr::lifecycle::process_env(pid, "HERDR_SOCKET_PATH");
        match target(&args, env_session.as_deref(), env_socket.as_deref()) {
            Some(Target::Session(s)) if s == session => n += 1,
            Some(Target::Socket(p)) if std::path::Path::new(&p) == socket => n += 1,
            _ => {}
        }
    }
    Some(n)
}

#[cfg(not(target_os = "linux"))]
fn attached(_session: &str, _socket: &std::path::Path, _target: impl Fn(&[String], Option<&str>, Option<&str>) -> Option<Target>) -> Option<usize> {
    None
}

/// herdr TUI windows attached to `session`'s server (processes on this host; Linux). `None` where
/// that cannot be told.
pub fn tui_clients(session: &str, socket: &std::path::Path) -> Option<usize> {
    attached(session, socket, tui_target)
}

/// herdr windows that may show `session`: its TUI windows on this host and the bridges of herdr
/// windows on other computers ([`remote_target`]); Linux. `None` where that cannot be told.
pub fn windows(session: &str, socket: &std::path::Path) -> Option<usize> {
    attached(session, socket, |args, env_session, env_socket| tui_target(args, env_session, env_socket).or_else(|| remote_target(args, env_session, env_socket)))
}

/// "a herdr window is open": a person looks at the session through herdr's own interface.
pub fn tui_blocker(n: usize) -> Option<String> {
    match n {
        0 => None,
        1 => Some("a herdr window is open".to_string()),
        n => Some(format!("{n} herdr windows are open")),
    }
}

/// Children of `pid` (Linux `/proc/<pid>/task/<pid>/children`); `None` where that cannot be read.
pub fn children(pid: u32) -> Option<Vec<u32>> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")).ok()?;
    Some(text.split_whitespace().filter_map(|p| p.parse().ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::{AutoResume, AutoResumeKind, JobsSummary, NeedsKind, NeedsYou, OmpInfo, Parked, SubagentSummary};

    fn agent(id: &str, pane: &str, state: HerdrState, column: Column) -> Agent {
        let mut a: Agent = serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "kind": "omp", "paneId": pane, "tabId": "w1:t1", "workspaceId": "w1",
            "state": "idle", "stateSince": 0, "column": "review", "archived": false, "turns": 0, "title": "",
            "live": {"streaming": false, "thinking": false}
        }))
        .unwrap();
        a.state = state;
        a.column = column;
        a
    }

    fn idle(id: &str, pane: &str) -> Agent {
        agent(id, pane, HerdrState::Idle, Column::Review)
    }

    fn shell(pane: &str) -> PaneFacts {
        PaneFacts { pane_id: pane.into(), agent_id: None, process: Some("bash".into()), background: false }
    }

    fn omp() -> OmpInfo {
        serde_json::from_value(serde_json::json!({"link": "live", "bridge": true, "fast": false, "mode": "normal", "queue": {"steering": [], "followUp": []}})).unwrap()
    }

    const H: HerdrUpdateMode = HerdrUpdateMode::Handoff;
    const R: HerdrUpdateMode = HerdrUpdateMode::Restart;

    #[test]
    fn an_idle_session_has_no_blockers() {
        let agents = [idle("a", "w1:p1"), idle("b", "w1:p2")];
        let panes = [
            PaneFacts { pane_id: "w1:p1".into(), agent_id: Some("a".into()), process: Some("omp".into()), background: false },
            shell("w1:p3"),
            PaneFacts { pane_id: "w1:p4".into(), agent_id: None, process: Some("-zsh".into()), background: false },
        ];
        assert!(blockers(&agents, &panes, 0, H).is_empty());
        assert!(blockers(&agents, &panes, 0, R).is_empty());
        // A parked agent has no pane and blocks nothing, even with a stale working state.
        let mut parked = agent("p", "", HerdrState::Working, Column::Done);
        parked.parked = Some(Parked { at: 0, session_file: "/s.jsonl".into(), worktree: None, moved: None, ended: None });
        assert!(blockers(&[parked], &[], 0, R).is_empty());
    }

    #[test]
    fn each_blocker() {
        let working = agent("w", "w1:p1", HerdrState::Working, Column::Running);
        assert_eq!(blockers(&[working.clone(), working.clone()], &[], 0, H), ["2 agents working"]);
        // herdr says idle (no omp integration), TeleFlock's replica sees the turn.
        let mut turn = idle("t", "w1:p7");
        let mut o = omp();
        o.turn_started_at = Some(1);
        turn.omp = Some(o);
        assert_eq!(blockers(&[turn], &[], 0, H), ["1 agent working"]);
        let mut needs = idle("n", "w1:p2");
        needs.needs = Some(
            serde_json::from_value::<NeedsYou>(serde_json::json!({
                "kind": "ask", "requestId": "r", "title": "Q", "question": "?", "options": [], "since": 0,
                "multi": false, "allowOther": false, "allowChat": false, "answerable": true
            }))
            .unwrap(),
        );
        assert_eq!(needs.needs.as_ref().map(|n| n.kind), Some(NeedsKind::Ask));
        assert_eq!(blockers(&[needs], &[], 0, H), ["1 agent waits for you"]);
        let mut jobs = idle("j", "w1:p3");
        let mut o = omp();
        o.jobs = Some(JobsSummary { running: 0, recent: 1, waiting: true, glance: None, glance_job: None });
        jobs.omp = Some(o);
        assert_eq!(blockers(&[jobs], &[], 0, H), ["background jobs run in 1 agent"]);
        let mut subs = idle("s", "w1:p4");
        let mut o = omp();
        o.subagents = Some(SubagentSummary { live: 2, total: 3, completion_pct: None });
        subs.omp = Some(o);
        assert_eq!(blockers(&[subs], &[], 0, H), ["subagents run in 1 agent"]);
        let mut resuming = idle("r", "w1:p5");
        resuming.auto_resume = Some(
            serde_json::from_value::<AutoResume>(serde_json::json!({
                "status": "resuming", "kind": "restart", "reason": "", "since": 0, "attempts": 1, "root": true, "subagentIds": []
            }))
            .unwrap(),
        );
        assert_eq!(resuming.auto_resume.as_ref().map(|r| r.kind), Some(AutoResumeKind::Restart));
        assert_eq!(blockers(&[resuming], &[], 0, H), ["1 agent is resuming"]);
        let mut claude = idle("c", "w1:p6");
        claude.kind = "claude".into();
        assert!(blockers(std::slice::from_ref(&claude), &[], 0, H).is_empty(), "a live handoff keeps it running");
        assert_eq!(blockers(&[claude], &[], 0, R), ["claude open in a pane"]);
        let vim = PaneFacts { pane_id: "w2:p1".into(), agent_id: None, process: Some("vim".into()), background: false };
        let make = PaneFacts { pane_id: "w2:p2".into(), agent_id: None, process: Some("make".into()), background: false };
        assert_eq!(blockers(&[], std::slice::from_ref(&vim), 0, H), ["a terminal runs vim"]);
        assert_eq!(blockers(&[], &[vim.clone(), make, vim], 0, H), ["terminals run make and vim"]);
        let bg = PaneFacts { background: true, ..shell("w2:p3") };
        assert_eq!(blockers(&[], &[bg], 0, H), ["a terminal has background jobs"]);
        let unknown = PaneFacts { process: None, ..shell("w2:p4") };
        assert_eq!(blockers(&[], &[unknown], 0, H), ["a terminal's program is not known yet"]);
        assert_eq!(blockers(&[], &[], 1, H), ["a TeleFlock terminal is attached"]);
        assert_eq!(blockers(&[], &[], 2, H), ["2 TeleFlock terminals are attached"]);
    }

    #[test]
    fn an_agent_pane_is_judged_by_its_agent_not_its_process() {
        let a = idle("a", "w1:p1");
        let pane = PaneFacts { pane_id: "w1:p1".into(), agent_id: None, process: Some("bun".into()), background: true };
        assert!(blockers(&[a], &[pane], 0, R).is_empty());
    }

    #[test]
    fn versions_modes_and_windows() {
        assert!(newer("0.9.6", "0.9.5"));
        assert!(newer("0.10.0", "0.9.5"));
        assert!(!newer("0.9.5", "0.9.5"));
        assert!(!newer("0.9.4", "0.9.5"), "never a downgrade");
        assert!(!newer("0.9.5-preview.3", "0.9.5"), "a pre-release comes before its release");
        assert!(newer("0.9.6-preview.13", "0.9.6-preview.12"));
        assert!(newer("0.9.6-preview.10", "0.9.6-preview.9"));
        assert!(newer("0.9.6", "0.9.6-preview.13"));
        assert!(newer("v0.9.6", "0.9.5"));
        assert!(!newer("garbage", "0.9.5"));
        assert_eq!(mode(false), HerdrUpdateMode::Restart);
        assert_eq!(mode(true), if cfg!(unix) { HerdrUpdateMode::Handoff } else { HerdrUpdateMode::Restart });
        assert_eq!(due_at(1_000, 20), 1_000 + 20 * 60_000);
        assert_eq!(due_at(0, 0), 60_000, "at least a minute");
        assert!(is_shell("bash") && is_shell("-zsh") && is_shell("/usr/bin/fish") && is_shell("pwsh.exe"));
        assert!(!is_shell("vim") && !is_shell("omp") && !is_shell("bashtop"));
    }

    #[test]
    fn only_herdr_tui_windows_are_clients() {
        let args = |s: &str| s.split_whitespace().map(str::to_string).collect::<Vec<_>>();
        let sess = |n: &str| Some(Target::Session(n.to_string()));
        assert_eq!(tui_target(&args("herdr"), None, None), sess("default"));
        assert_eq!(tui_target(&args("herdr client"), None, None), sess("default"));
        assert_eq!(tui_target(&args("/usr/bin/herdr --session work"), None, None), sess("work"));
        assert_eq!(tui_target(&args("herdr --session=work client"), None, None), sess("work"));
        assert_eq!(tui_target(&args("herdr session attach work"), None, None), sess("work"));
        assert_eq!(tui_target(&args("herdr"), Some("lab"), None), sess("lab"));
        assert_eq!(tui_target(&args("herdr"), Some(""), None), sess("default"));
        assert_eq!(tui_target(&args("herdr --session work"), Some("lab"), Some("/x/herdr.sock")), sess("work"), "the flag wins");
        assert_eq!(tui_target(&args("herdr"), Some("lab"), Some("/x/herdr.sock")), Some(Target::Socket("/x/herdr.sock".into())));
        // Not windows: the server, the CLI, TeleFlock's terminals, updates.
        for other in ["herdr server", "herdr --session work server", "herdr terminal session x", "herdr update", "herdr pane list", "herdr status", "herdr session list", "herdr --remote box", "herdr --session"] {
            assert_eq!(tui_target(&args(other), None, None), None, "{other}");
        }
        assert_eq!(tui_blocker(0), None);
        assert_eq!(tui_blocker(1).as_deref(), Some("a herdr window is open"));
        assert_eq!(tui_blocker(3).as_deref(), Some("3 herdr windows are open"));
    }

    /// `herdr --remote` and saved machines on another computer reach this host's server through
    /// `herdr --session <name> remote-api-bridge`, run over SSH while their window is open.
    #[test]
    fn windows_on_other_computers_come_through_the_api_bridge() {
        let args = |s: &str| s.split_whitespace().map(str::to_string).collect::<Vec<_>>();
        let sess = |n: &str| Some(Target::Session(n.to_string()));
        assert_eq!(remote_target(&args("/home/ada/.local/bin/herdr --session work remote-api-bridge"), None, None), sess("work"));
        assert_eq!(remote_target(&args("herdr remote-api-bridge"), Some("lab"), None), sess("lab"));
        // The probe before attaching is no window, nor is any other command.
        for other in ["herdr --session work remote-api-bridge --check", "herdr --session work", "herdr --session work server", "herdr --session"] {
            assert_eq!(remote_target(&args(other), None, None), None, "{other}");
        }
        // herdr's update gate still counts the TUI windows on this host only.
        assert_eq!(tui_target(&args("herdr --session work remote-api-bridge"), None, None), None);
    }

    /// A child the host can't read (`sudo … &` under `/proc` mounted `hidepid=2`: listed among the
    /// shell's children, its own entry hidden) may run anything: a restart or a close would end it.
    #[test]
    fn a_child_that_can_not_be_read_counts_as_a_job() {
        let stat = |line: &'static str| move |_: u32| Some(line.to_string());
        assert!(any_job(&[7], stat("7 (sleep) S 10 7 10 34817 10 0")));
        assert!(!any_job(&[7], stat("7 (gitstatusd-linux) S 10 7 10 34817 10 0")), "a prompt helper");
        assert!(!any_job(&[7], stat("7 (sleep) Z 10 7 10 34817 -1 0")), "exited, not reaped yet");
        assert!(any_job(&[7], |_| None));
        assert!(!any_job(&[], |_| None));
    }

    #[test]
    fn only_a_live_handoff_loads_by_itself() {
        use HerdrUpdateState::*;
        assert_eq!(update_state(false, true, H), Waiting);
        assert_eq!(update_state(false, true, R), Ready, "a restart waits for the user, however idle the session is");
        assert_eq!(update_state(false, false, H), Manual);
        assert_eq!(update_state(false, false, R), Manual);
        assert_eq!(update_state(true, true, R), Failed);
        assert_eq!(update_state(true, false, H), Failed);
    }
}
