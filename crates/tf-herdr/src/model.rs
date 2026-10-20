//! Typed herdr models. Every struct ignores unknown fields and defaults missing ones,
//! so newer herdr versions (or older ones lacking a field) still parse.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// herdr's agent state. Board mapping: Running = `Working`, Needs you = `Blocked`,
/// In review = `Done` (idle, unseen), Done = `Idle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
    #[default]
    #[serde(other)]
    Unknown,
}

impl AgentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionKind {
    Path,
    Id,
    #[default]
    #[serde(other)]
    Unknown,
}

/// `agent_session`: the agent's own session reference. For omp, `kind: path` and the
/// file name ends in `_<sessionId>.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentSession {
    pub source: String,
    pub agent: String,
    pub kind: AgentSessionKind,
    pub value: String,
}

impl AgentSession {
    /// The omp session id: the `_<id>.jsonl` suffix for `kind: path`, the value for `kind: id`.
    pub fn session_id(&self) -> Option<&str> {
        match self.kind {
            AgentSessionKind::Id => Some(self.value.as_str()).filter(|v| !v.is_empty()),
            AgentSessionKind::Path | AgentSessionKind::Unknown => {
                let file = self.value.rsplit(['/', '\\']).next()?;
                let stem = file.strip_suffix(".jsonl")?;
                let (_, id) = stem.rsplit_once('_')?;
                Some(id).filter(|v| !v.is_empty())
            }
        }
    }

    /// The session file path, when herdr reported one.
    pub fn path(&self) -> Option<&str> {
        (self.kind == AgentSessionKind::Path).then_some(self.value.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ScrollInfo {
    pub offset_from_bottom: u32,
    pub max_offset_from_bottom: u32,
    pub viewport_rows: u32,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PaneInfo {
    pub pane_id: String,
    pub terminal_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub focused: bool,
    /// Detected agent kind (`omp`, `claude`, ...), `None` for a plain shell.
    pub agent: Option<String>,
    pub agent_status: AgentStatus,
    pub agent_session: Option<AgentSession>,
    pub cwd: Option<String>,
    pub foreground_cwd: Option<String>,
    pub label: Option<String>,
    /// Bumps on every pane update (title spinner, output, ...).
    pub revision: u64,
    pub scroll: Option<ScrollInfo>,
    pub terminal_title: Option<String>,
    pub terminal_title_stripped: Option<String>,
    pub title: Option<String>,
    pub display_agent: Option<String>,
    /// `pane report-metadata --token` values (e.g. `todos=3/7`).
    pub tokens: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentInfo {
    pub pane_id: String,
    pub terminal_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    /// Unique agent name (usable as a target), if set.
    pub name: Option<String>,
    /// Agent kind (`omp`, `claude`, ...).
    pub agent: Option<String>,
    pub agent_status: AgentStatus,
    pub agent_session: Option<AgentSession>,
    pub focused: bool,
    pub cwd: Option<String>,
    pub foreground_cwd: Option<String>,
    pub revision: u64,
    /// Increments once per status transition; use it for client-side acks of `done`.
    pub state_change_seq: u64,
    pub interactive_ready: bool,
    pub launch_pending: bool,
    pub screen_detection_skipped: bool,
    pub terminal_title: Option<String>,
    pub terminal_title_stripped: Option<String>,
    pub title: Option<String>,
    pub display_agent: Option<String>,
    pub tokens: BTreeMap<String, String>,
}

impl AgentInfo {
    /// Best target string for agent calls: the name when set, else the pane id.
    pub fn target(&self) -> &str {
        self.name.as_deref().filter(|n| !n.is_empty()).unwrap_or(&self.pane_id)
    }
}

/// `workspace.worktree`: present when the workspace cwd is inside a git work tree.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceWorktree {
    pub checkout_path: String,
    pub is_linked_worktree: bool,
    /// Workspaces sharing `repo_key` form a group.
    pub repo_key: String,
    pub repo_name: String,
    pub repo_root: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceInfo {
    pub workspace_id: String,
    pub number: u32,
    pub label: String,
    pub focused: bool,
    pub active_tab_id: Option<String>,
    pub pane_count: u32,
    pub tab_count: u32,
    /// Max-attention rollup: blocked > done > working > idle > unknown.
    pub agent_status: AgentStatus,
    pub worktree: Option<WorkspaceWorktree>,
    pub tokens: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TabInfo {
    pub tab_id: String,
    pub workspace_id: String,
    pub number: u32,
    pub label: String,
    pub focused: bool,
    pub pane_count: u32,
    pub agent_status: AgentStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LayoutPane {
    pub pane_id: String,
    pub focused: bool,
    pub rect: Rect,
}

/// `PaneLayoutSnapshot`: the geometry of one tab.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PaneLayout {
    pub tab_id: String,
    pub workspace_id: String,
    pub area: Rect,
    pub focused_pane_id: Option<String>,
    pub panes: Vec<LayoutPane>,
    /// Split tree nodes, passed through untyped.
    pub splits: Vec<Value>,
    pub zoomed: bool,
}

/// `session.snapshot`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Snapshot {
    pub version: Option<String>,
    pub protocol: Option<u32>,
    pub focused_workspace_id: Option<String>,
    pub focused_tab_id: Option<String>,
    pub focused_pane_id: Option<String>,
    pub workspaces: Vec<WorkspaceInfo>,
    pub tabs: Vec<TabInfo>,
    pub panes: Vec<PaneInfo>,
    pub layouts: Vec<PaneLayout>,
    pub agents: Vec<AgentInfo>,
}

/// One entry of `worktree.list`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorktreeEntry {
    pub branch: Option<String>,
    pub path: String,
    pub label: Option<String>,
    pub is_linked_worktree: bool,
    pub is_bare: bool,
    pub is_detached: bool,
    pub is_prunable: bool,
    /// Workspace that already shows this checkout.
    pub open_workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorktreeSource {
    pub repo_key: String,
    pub repo_name: String,
    pub repo_root: String,
    pub source_checkout_path: String,
    pub source_workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorktreeList {
    pub source: WorktreeSource,
    pub worktrees: Vec<WorktreeEntry>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProcessEntry {
    pub pid: u32,
    pub name: String,
    pub argv: Vec<String>,
    pub cmdline: String,
    pub cwd: Option<String>,
}

/// `pane.process_info`: the pane's shell and foreground process group (omp pid lives here).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProcessInfo {
    pub pane_id: String,
    pub shell_pid: Option<u32>,
    pub foreground_process_group_id: Option<i64>,
    pub foreground_processes: Vec<ProcessEntry>,
}

/// `pane.read` / `agent.read` result.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PaneRead {
    pub pane_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub source: String,
    pub format: String,
    pub text: String,
    pub revision: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerCapabilities {
    pub live_handoff: bool,
    pub detached_server_daemon: bool,
    pub endpoint_protocol_generation: u32,
    pub surface_interest: bool,
    pub health_check: bool,
}

/// `ping` result. Describes the **running server**, not the binary on disk.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Pong {
    pub version: String,
    pub protocol: u32,
    pub capabilities: Option<ServerCapabilities>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ClientStatus {
    pub version: String,
    pub channel: Option<String>,
    pub protocol: Option<u32>,
    pub endpoint_protocol_generation: Option<u32>,
    pub endpoint_capabilities: Vec<String>,
    pub binary: Option<String>,
    pub session: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerStatus {
    /// `running` | `not_running` | ...
    pub status: String,
    pub running: bool,
    pub version: Option<String>,
    pub protocol: Option<u32>,
    pub capabilities: Option<ServerCapabilities>,
    pub compatible: Option<bool>,
    pub endpoint_compatible: Option<bool>,
    pub socket: Option<String>,
    pub session: Option<String>,
    pub restart_needed: bool,
    pub server_binary_stale: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdateStatus {
    pub restart_needed: bool,
    pub server_binary_stale: bool,
}

/// `herdr status --json`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Status {
    pub client: ClientStatus,
    pub server: ServerStatus,
    pub update: UpdateStatus,
}

/// One entry of `herdr session list --json`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionEntry {
    pub name: String,
    pub default: bool,
    pub running: bool,
    pub session_dir: String,
    pub socket_path: String,
}

/// `agent.explain`: how herdr derives the agent's state. Known fields are typed;
/// everything (including them) is kept in `raw` for display.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentExplain {
    pub agent: Option<String>,
    pub state: Option<AgentStatus>,
    pub screen_detection_skipped: bool,
    pub screen_detection_skip_reason: Option<String>,
    pub matched_rule: Option<Value>,
    pub fallback_reason: Option<String>,
    pub warning: Option<String>,
    pub visible_blocker: bool,
    pub visible_idle: bool,
    pub visible_working: bool,
    #[serde(skip)]
    pub raw: Value,
}

// ---- call results ----

/// `workspace.create` / `tab.create` / `worktree.*` results carry the new root pane.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceCreated {
    pub workspace: WorkspaceInfo,
    pub tab: TabInfo,
    pub root_pane: PaneInfo,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TabCreated {
    pub tab: TabInfo,
    pub root_pane: PaneInfo,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorktreeCreated {
    pub workspace: WorkspaceInfo,
    pub tab: TabInfo,
    pub root_pane: PaneInfo,
    pub worktree: WorktreeEntry,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorktreeOpened {
    pub already_open: bool,
    pub workspace: WorkspaceInfo,
    pub tab: Option<TabInfo>,
    pub root_pane: Option<PaneInfo>,
    pub worktree: WorktreeEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorktreeRemoved {
    pub workspace_id: String,
    pub path: String,
    pub forced: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentStarted {
    pub agent: AgentInfo,
    pub argv: Vec<String>,
}
