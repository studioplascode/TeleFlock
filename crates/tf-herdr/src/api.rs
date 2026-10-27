//! Typed helpers for every herdr call TeleFlock uses.

use crate::client::{HerdrClient, WAIT_SLACK};
use crate::error::{HerdrError, Result, code};
use crate::model::*;
use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Duration;

/// Floor for requests that create a workspace, tab or pane (herdr spawns the shell before answering;
/// slow WSL laptops need more than the default request timeout). Reads keep the default.
const CREATE_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Parameter types
// ---------------------------------------------------------------------------

/// `pane.read` / `agent.read` source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadSource {
    /// The current screen.
    #[default]
    Visible,
    /// Scrollback, soft-wrapped (default 80 lines).
    Recent,
    /// Scrollback with soft wraps joined.
    RecentUnwrapped,
    /// The bottom buffer herdr uses for screen detection (composer/overlay checks).
    Detection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadFormat {
    #[default]
    Text,
    /// Keeps SGR colours.
    Ansi,
}

/// Options for `pane.read` / `agent.read`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReadOptions {
    pub source: ReadSource,
    pub format: ReadFormat,
    /// Capped at 1000 by herdr.
    pub lines: Option<u32>,
}

impl ReadOptions {
    pub fn new(source: ReadSource) -> Self {
        Self { source, ..Default::default() }
    }
    pub fn ansi(mut self) -> Self {
        self.format = ReadFormat::Ansi;
        self
    }
    pub fn lines(mut self, n: u32) -> Self {
        self.lines = Some(n.min(1000));
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitDirection {
    #[default]
    Right,
    Down,
}

/// `workspace.create`. herdr silently falls back to `$HOME` for a non-existent `cwd`;
/// validate the path before calling.
#[derive(Debug, Clone, Default, Serialize)]
pub struct WorkspaceCreate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Never focus on the user's behalf unless asked (it moves their herdr view).
    pub focus: bool,
}

/// `tab.create`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct TabCreate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    pub focus: bool,
}

/// `pane.split`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PaneSplit {
    /// Pane to split; `None` = focused pane of `workspace_id` (or of the session).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub direction: SplitDirection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ratio: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    pub focus: bool,
}

/// Which repository a worktree call addresses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreeScope {
    /// A path inside the repository.
    Cwd(String),
    /// A workspace whose checkout belongs to the repository.
    Workspace(String),
}

impl WorktreeScope {
    fn write(&self, obj: &mut serde_json::Map<String, Value>) {
        match self {
            Self::Cwd(c) => obj.insert("cwd".into(), json!(c)),
            Self::Workspace(w) => obj.insert("workspace_id".into(), json!(w)),
        };
    }
}

/// `worktree.create`. Without `branch`, herdr generates one; an existing local branch is
/// checked out, otherwise it is created from `base` (or HEAD).
#[derive(Debug, Clone)]
pub struct WorktreeCreate {
    pub scope: WorktreeScope,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub path: Option<String>,
    pub label: Option<String>,
    pub focus: bool,
    /// Pass `-c safe.directory=<root>` per git command (for "dubious ownership" repos).
    pub trust_repository: bool,
}

impl WorktreeCreate {
    pub fn new(scope: WorktreeScope) -> Self {
        Self { scope, branch: None, base: None, path: None, label: None, focus: false, trust_repository: false }
    }
}

/// What `worktree.open` opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreeTarget {
    Branch(String),
    Path(String),
}

/// `worktree.open`.
#[derive(Debug, Clone)]
pub struct WorktreeOpen {
    pub scope: WorktreeScope,
    pub target: WorktreeTarget,
    pub label: Option<String>,
    pub focus: bool,
    pub trust_repository: bool,
}

/// `agent.start`: launches `kind` in an idle shell pane (`agent_pane_busy` otherwise).
#[derive(Debug, Clone, Default, Serialize)]
pub struct AgentStart {
    /// Unique agent name; usable as a target afterwards.
    pub name: String,
    /// `omp`, `claude`, `codex`, ...
    pub kind: String,
    pub pane_id: String,
    /// Arguments after `--` (e.g. `--model`, `--config`, `-e`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// Startup timeout; herdr accepts 3001..=300000 ms (default 30 s).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// Wait options for `agent.prompt` / `agent.wait`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AgentWait {
    /// States that end the wait; empty = herdr default (idle, done, blocked).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub until: Vec<AgentStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl AgentWait {
    fn deadline(&self, base: Duration) -> Duration {
        match self.timeout_ms {
            Some(ms) => Duration::from_millis(ms) + WAIT_SLACK,
            // herdr's own default wait has no documented bound; allow a long one.
            None => base.max(Duration::from_secs(600)),
        }
    }
}

/// `terminal.scroll` / `pane.scroll` direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
}

// ---------------------------------------------------------------------------
// Result wrappers (the `result` object minus `type`)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AgentOne {
    agent: AgentInfo,
}
#[derive(Deserialize)]
struct AgentMany {
    #[serde(default)]
    agents: Vec<AgentInfo>,
}
#[derive(Deserialize)]
struct PaneOne {
    pane: PaneInfo,
}
#[derive(Deserialize)]
struct PaneMany {
    #[serde(default)]
    panes: Vec<PaneInfo>,
}
#[derive(Deserialize)]
struct ReadOne {
    read: PaneRead,
}
#[derive(Deserialize)]
struct WorkspaceOne {
    workspace: WorkspaceInfo,
}
#[derive(Deserialize)]
struct WorkspaceMany {
    #[serde(default)]
    workspaces: Vec<WorkspaceInfo>,
}
#[derive(Deserialize)]
struct TabMany {
    #[serde(default)]
    tabs: Vec<TabInfo>,
}
#[derive(Deserialize)]
struct TabOne {
    tab: TabInfo,
}
#[derive(Deserialize)]
struct SnapshotOne {
    snapshot: Snapshot,
}
#[derive(Deserialize)]
struct ProcessOne {
    process_info: ProcessInfo,
}
#[derive(Deserialize)]
struct LayoutOne {
    layout: PaneLayout,
}

fn read_params(target_key: &str, target: &str, o: ReadOptions) -> Value {
    let mut p = json!({ target_key: target, "source": o.source, "format": o.format, "strip_ansi": o.format == ReadFormat::Text });
    if let Some(n) = o.lines {
        p["lines"] = json!(n);
    }
    p
}

impl HerdrClient {
    // ---- session -----------------------------------------------------------

    /// `session.snapshot`: workspaces, tabs, panes, layouts and agents in one call.
    pub async fn snapshot(&self) -> Result<Snapshot> {
        Ok(self.request::<SnapshotOne>("session.snapshot", json!({})).await?.snapshot)
    }

    // ---- agent -------------------------------------------------------------

    pub async fn agent_list(&self) -> Result<Vec<AgentInfo>> {
        Ok(self.request::<AgentMany>("agent.list", json!({})).await?.agents)
    }

    /// `target`: a unique agent name or a pane id.
    pub async fn agent_get(&self, target: &str) -> Result<AgentInfo> {
        Ok(self.request::<AgentOne>("agent.get", json!({ "target": target })).await?.agent)
    }

    pub async fn agent_read(&self, target: &str, opts: ReadOptions) -> Result<PaneRead> {
        Ok(self.request::<ReadOne>("agent.read", read_params("target", target, opts)).await?.read)
    }

    /// Keys: printable chars, `enter`, `esc`, `tab`, `up`, `ctrl+c`, `shift+tab`, `f1`, ...
    pub async fn agent_send_keys(&self, target: &str, keys: &[&str]) -> Result<()> {
        self.request::<IgnoredAny>("agent.send_keys", json!({ "target": target, "keys": keys })).await?;
        Ok(())
    }

    /// Paste `text` and press Enter. Rejected with `agent_blocked` while blocked.
    /// With `wait`, the call holds until a matching state (`agent_prompt_stalled` if the
    /// agent does not start within 5 s). Returns the agent as of the response.
    pub async fn agent_prompt(&self, target: &str, text: &str, wait: Option<AgentWait>) -> Result<AgentInfo> {
        let timeout = wait.as_ref().map_or(self.inner.timeout, |w| w.deadline(self.inner.timeout));
        let mut p = json!({ "target": target, "text": text });
        if let Some(w) = &wait {
            p["wait"] = serde_json::to_value(w).unwrap_or_default();
        }
        Ok(self.request_with_timeout::<AgentOne>("agent.prompt", p, timeout).await?.agent)
    }

    /// Wait until the agent's status matches (the current state counts).
    pub async fn agent_wait(&self, target: &str, wait: AgentWait) -> Result<AgentInfo> {
        let timeout = wait.deadline(self.inner.timeout);
        let mut p = serde_json::to_value(&wait).unwrap_or_else(|_| json!({}));
        p["target"] = json!(target);
        Ok(self.request_with_timeout::<AgentOne>("agent.wait", p, timeout).await?.agent)
    }

    /// Set (`Some`) or clear (`None`) the agent's unique name.
    pub async fn agent_rename(&self, target: &str, name: Option<&str>) -> Result<AgentInfo> {
        Ok(self.request::<AgentOne>("agent.rename", json!({ "target": target, "name": name })).await?.agent)
    }

    /// Start an agent and wait until it is interactive, mirroring `herdr agent start`:
    /// the API call returns while the launch is still pending, so this polls `agent.get`
    /// (100 ms) until the agent is idle/done and `interactive_ready` (within `timeout_ms`).
    /// `agent_pane_busy` (the pane's foreground job is not its bare shell: a fresh shell
    /// still running its startup files, or a command running in it) is retried every 100 ms
    /// until `shell_wait` has passed, then returned as is (`Duration::ZERO`: no retry).
    /// Errors: `agent_pane_busy`, `agent_not_ready` (blocked during startup), `agent_start_failed`
    /// (exited before becoming interactive), `agent_kind_mismatch`, `agent_name_not_found`, `timeout`.
    pub async fn agent_start(&self, start: &AgentStart, shell_wait: Duration) -> Result<AgentStarted> {
        const POLL: Duration = Duration::from_millis(100);
        let startup = Duration::from_millis(start.timeout_ms.unwrap_or(30_000));
        let busy_deadline = tokio::time::Instant::now() + shell_wait;
        let mut started = loop {
            match self.request::<AgentStarted>("agent.start", start).await {
                Err(e) if e.is(code::AGENT_PANE_BUSY) => {
                    let left = busy_deadline.saturating_duration_since(tokio::time::Instant::now());
                    if left.is_zero() {
                        return Err(e);
                    }
                    tokio::time::sleep(POLL.min(left)).await;
                }
                other => break other?,
            }
        };
        let terminal_id = started.agent.terminal_id.clone();
        let deadline = tokio::time::Instant::now() + startup;
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(HerdrError::new(code::TIMEOUT, format!("agent {} did not become interactive in time", start.name)));
            }
            let polled = match self.agent_get(&start.name).await {
                Ok(a) => Ok(a),
                Err(_) => self.agent_get(&start.pane_id).await,
            };
            if let Ok(a) = polled {
                if !terminal_id.is_empty() && a.terminal_id != terminal_id || a.name.as_deref() != Some(start.name.as_str()) {
                    return Err(HerdrError::new(
                        "agent_name_not_found",
                        format!("named agent {} no longer owns the target terminal", start.name),
                    ));
                }
                if let Some(kind) = a.agent.as_deref().filter(|k| *k != start.kind) {
                    return Err(HerdrError::new("agent_kind_mismatch", format!("expected {}, detected {kind}", start.kind)));
                }
                match a.agent_status {
                    AgentStatus::Blocked => {
                        return Err(HerdrError::new(
                            "agent_not_ready",
                            format!("agent {} is blocked during startup and is not ready for prompts", start.name),
                        ));
                    }
                    AgentStatus::Idle | AgentStatus::Done if a.interactive_ready => {
                        started.agent = a;
                        return Ok(started);
                    }
                    AgentStatus::Idle | AgentStatus::Done if !a.launch_pending => {
                        return Err(HerdrError::new(
                            code::AGENT_START_FAILED,
                            "agent process exited before becoming interactive",
                        ));
                    }
                    _ => {}
                }
            }
            tokio::time::sleep(POLL).await;
        }
    }

    pub async fn agent_explain(&self, target: &str) -> Result<AgentExplain> {
        let raw: Value = self.request("agent.explain", json!({ "target": target })).await?;
        Ok(parse_explain(raw))
    }

    // ---- workspace ---------------------------------------------------------

    /// Creating a workspace, tab or pane spawns a shell; slow hosts get [`CREATE_TIMEOUT`].
    pub async fn workspace_create(&self, p: &WorkspaceCreate) -> Result<WorkspaceCreated> {
        self.request_with_timeout("workspace.create", p, self.inner.timeout.max(CREATE_TIMEOUT)).await
    }

    pub async fn workspace_list(&self) -> Result<Vec<WorkspaceInfo>> {
        Ok(self.request::<WorkspaceMany>("workspace.list", json!({})).await?.workspaces)
    }

    pub async fn workspace_get(&self, workspace_id: &str) -> Result<WorkspaceInfo> {
        Ok(self.request::<WorkspaceOne>("workspace.get", json!({ "workspace_id": workspace_id })).await?.workspace)
    }

    pub async fn workspace_rename(&self, workspace_id: &str, label: &str) -> Result<()> {
        self.request::<IgnoredAny>("workspace.rename", json!({ "workspace_id": workspace_id, "label": label })).await?;
        Ok(())
    }

    /// Close a workspace. A primary with linked worktree workspaces needs `group: true`
    /// (else `workspace_group_close_required`). Kills the panes' processes.
    pub async fn workspace_close(&self, workspace_id: &str, group: bool) -> Result<()> {
        let mut p = json!({ "workspace_id": workspace_id });
        if group {
            p["close_group"] = json!(true);
        }
        self.request::<IgnoredAny>("workspace.close", p).await?;
        Ok(())
    }

    // ---- worktree ----------------------------------------------------------

    pub async fn worktree_list(&self, scope: &WorktreeScope, trust_repository: bool) -> Result<WorktreeList> {
        let mut p = serde_json::Map::new();
        scope.write(&mut p);
        if trust_repository {
            p.insert("trust_repository".into(), json!(true));
        }
        self.request("worktree.list", Value::Object(p)).await
    }

    pub async fn worktree_create(&self, c: &WorktreeCreate) -> Result<WorktreeCreated> {
        let mut p = serde_json::Map::new();
        c.scope.write(&mut p);
        for (k, v) in [("branch", &c.branch), ("base", &c.base), ("path", &c.path), ("label", &c.label)] {
            if let Some(v) = v {
                p.insert(k.into(), json!(v));
            }
        }
        p.insert("focus".into(), json!(c.focus));
        if c.trust_repository {
            p.insert("trust_repository".into(), json!(true));
        }
        // git checkouts can be slow on big repos.
        self.request_with_timeout("worktree.create", Value::Object(p), self.inner.timeout.max(Duration::from_secs(120))).await
    }

    pub async fn worktree_open(&self, o: &WorktreeOpen) -> Result<WorktreeOpened> {
        let mut p = serde_json::Map::new();
        o.scope.write(&mut p);
        match &o.target {
            WorktreeTarget::Branch(b) => p.insert("branch".into(), json!(b)),
            WorktreeTarget::Path(x) => p.insert("path".into(), json!(x)),
        };
        if let Some(l) = &o.label {
            p.insert("label".into(), json!(l));
        }
        p.insert("focus".into(), json!(o.focus));
        if o.trust_repository {
            p.insert("trust_repository".into(), json!(true));
        }
        self.request_with_timeout("worktree.open", Value::Object(p), self.inner.timeout.max(Duration::from_secs(60))).await
    }

    /// Remove a linked worktree and close its workspace. Never deletes the branch.
    /// A dirty checkout needs `force` (`dirty_worktree_requires_force`).
    pub async fn worktree_remove(&self, workspace_id: &str, force: bool, trust_repository: bool) -> Result<WorktreeRemoved> {
        let mut p = json!({ "workspace_id": workspace_id, "force": force });
        if trust_repository {
            p["trust_repository"] = json!(true);
        }
        self.request_with_timeout("worktree.remove", p, self.inner.timeout.max(Duration::from_secs(60))).await
    }

    // ---- tab ---------------------------------------------------------------

    pub async fn tab_create(&self, p: &TabCreate) -> Result<TabCreated> {
        self.request_with_timeout("tab.create", p, self.inner.timeout.max(CREATE_TIMEOUT)).await
    }

    /// Tabs of one workspace, or of all workspaces with `None`.
    pub async fn tab_list(&self, workspace_id: Option<&str>) -> Result<Vec<TabInfo>> {
        Ok(self.request::<TabMany>("tab.list", json!({ "workspace_id": workspace_id })).await?.tabs)
    }

    pub async fn tab_get(&self, tab_id: &str) -> Result<TabInfo> {
        Ok(self.request::<TabOne>("tab.get", json!({ "tab_id": tab_id })).await?.tab)
    }

    pub async fn tab_rename(&self, tab_id: &str, label: &str) -> Result<()> {
        self.request::<IgnoredAny>("tab.rename", json!({ "tab_id": tab_id, "label": label })).await?;
        Ok(())
    }

    pub async fn tab_close(&self, tab_id: &str) -> Result<()> {
        self.request::<IgnoredAny>("tab.close", json!({ "tab_id": tab_id })).await?;
        Ok(())
    }

    // ---- pane --------------------------------------------------------------

    pub async fn pane_list(&self, workspace_id: Option<&str>) -> Result<Vec<PaneInfo>> {
        Ok(self.request::<PaneMany>("pane.list", json!({ "workspace_id": workspace_id })).await?.panes)
    }

    pub async fn pane_get(&self, pane_id: &str) -> Result<PaneInfo> {
        Ok(self.request::<PaneOne>("pane.get", json!({ "pane_id": pane_id })).await?.pane)
    }

    pub async fn pane_layout(&self, pane_id: Option<&str>) -> Result<PaneLayout> {
        Ok(self.request::<LayoutOne>("pane.layout", json!({ "pane_id": pane_id })).await?.layout)
    }

    /// Split a pane; returns the new pane.
    pub async fn pane_split(&self, p: &PaneSplit) -> Result<PaneInfo> {
        Ok(self.request_with_timeout::<PaneOne>("pane.split", p, self.inner.timeout.max(CREATE_TIMEOUT)).await?.pane)
    }

    /// Close a pane (kills its process).
    pub async fn pane_close(&self, pane_id: &str) -> Result<()> {
        self.request::<IgnoredAny>("pane.close", json!({ "pane_id": pane_id })).await?;
        Ok(())
    }

    pub async fn pane_read(&self, pane_id: &str, opts: ReadOptions) -> Result<PaneRead> {
        Ok(self.request::<ReadOne>("pane.read", read_params("pane_id", pane_id, opts)).await?.read)
    }

    /// Literal text (bracketed paste if the app enabled it). No Enter.
    pub async fn pane_send_text(&self, pane_id: &str, text: &str) -> Result<()> {
        self.request::<IgnoredAny>("pane.send_text", json!({ "pane_id": pane_id, "text": text })).await?;
        Ok(())
    }

    pub async fn pane_send_keys(&self, pane_id: &str, keys: &[&str]) -> Result<()> {
        self.request::<IgnoredAny>("pane.send_keys", json!({ "pane_id": pane_id, "keys": keys })).await?;
        Ok(())
    }

    /// Text, then keys, in one call.
    pub async fn pane_send_input(&self, pane_id: &str, text: &str, keys: &[&str]) -> Result<()> {
        self.request::<IgnoredAny>("pane.send_input", json!({ "pane_id": pane_id, "text": text, "keys": keys })).await?;
        Ok(())
    }

    /// `herdr pane run`: the command text followed by Enter.
    pub async fn pane_run(&self, pane_id: &str, command: &str) -> Result<()> {
        self.pane_send_input(pane_id, command, &["Enter"]).await
    }

    /// Shell pid and foreground processes (the omp pid lives here).
    pub async fn pane_process_info(&self, pane_id: &str) -> Result<ProcessInfo> {
        Ok(self.request::<ProcessOne>("pane.process_info", json!({ "pane_id": pane_id })).await?.process_info)
    }
}

/// `agent.explain` comes back either flat or wrapped (`{"type":…,"explain":{…}}`).
fn parse_explain(raw: Value) -> AgentExplain {
    let body = match raw.get("explain") {
        Some(inner) if inner.is_object() => inner.clone(),
        _ => raw,
    };
    let mut out: AgentExplain = serde_json::from_value(body.clone()).unwrap_or_default();
    out.raw = body;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_params_shape() {
        let p = read_params("pane_id", "w1:p1", ReadOptions::new(ReadSource::RecentUnwrapped).ansi().lines(5000));
        assert_eq!(p, json!({"pane_id":"w1:p1","source":"recent_unwrapped","format":"ansi","strip_ansi":false,"lines":1000}));
    }

    #[test]
    fn split_params_shape() {
        let p = serde_json::to_value(PaneSplit { target_pane_id: Some("w1:p1".into()), direction: SplitDirection::Down, ..Default::default() }).unwrap();
        assert_eq!(p, json!({"target_pane_id":"w1:p1","direction":"down","focus":false}));
    }

    #[test]
    fn explain_flat_and_wrapped() {
        let flat: Value = serde_json::from_str(include_str!("../../../docs/research/herdr-samples/agent-explain.json")).unwrap();
        let e = parse_explain(flat.clone());
        assert_eq!(e.state, Some(AgentStatus::Idle));
        assert!(e.screen_detection_skipped);
        assert_eq!(e.screen_detection_skip_reason.as_deref(), Some("full_lifecycle_hook_authority"));
        let wrapped = parse_explain(json!({"type":"agent_explain","explain": flat}));
        assert_eq!(wrapped.agent.as_deref(), Some("omp"));
    }
}
