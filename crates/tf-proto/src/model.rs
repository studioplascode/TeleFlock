//! Board-level domain model: host, workspaces, agents, liveness, needs-you.

use crate::Millis;

wire_enum! {
    /// herdr agent lifecycle state (`done` = idle and not yet seen by a herdr client).
    pub enum HerdrState { Working, Blocked, Idle, Done, Unknown }
}

wire_enum! {
    /// Kanban lane.
    ///
    /// * `running`: herdr `working`.
    /// * `needs`: herdr `blocked`, or a pending omp dialog TeleFlock can see (ask, approval,
    ///   plan review, confirm).
    /// * `review`: finished (idle/done) and not archived.
    /// * `done`: archived by the user. An archived agent that starts working again is
    ///   un-archived automatically.
    pub enum Column { Running, Needs, Review, Done }
}

wire_enum! {
    pub enum ThinkingLevel { Off, Minimal, Low, Medium, High, Xhigh, Max, Auto }
}

wire_enum! {
    /// omp interaction mode (`/plan` is a 3-state toggle: on → paused → off).
    pub enum OmpMode { Normal, Plan, PlanPaused }
}

wire_enum! {
    /// State of TeleFlock's structured link (collab guest) to an omp session.
    ///
    /// * `live`: joined; transcript and controls available.
    /// * `connecting`: discovered, joining or resyncing.
    /// * `notShared`: omp runs but does not host a collab room on the TeleFlock relay
    ///   (e.g. started outside TeleFlock, or restored by herdr). `agent.connect` fixes it.
    /// * `unsupported`: omp version or protocol mismatch.
    /// * `error`: link failed; see `OmpInfo.linkError`.
    pub enum LinkState { Live, Connecting, NotShared, Unsupported, Error }
}

wire_enum! {
    pub enum Severity { Info, Warn, Error }
}

wire_struct! {
    pub struct VersionInfo {
        pub version: String,
        /// Absolute path of the binary that was probed.
        pub path: String,
        /// Meets TeleFlock's minimum version and protocol requirements.
        pub ok: bool,
        pub note: Option<String>,
    }
}

wire_struct! {
    pub struct SetupIssue {
        /// Stable id, also the fix id accepted by `host.setupApply`
        /// (e.g. `install-herdr-integration`, `enable-global-sharing`, `install-global-bridge`).
        pub id: String,
        pub severity: Severity,
        pub title: String,
        pub detail: String,
        /// Whether `host.setupApply` can fix it.
        pub fixable: bool,
        pub recommended: bool,
    }
}

wire_struct! {
    pub struct SetupStatus {
        /// herdr's omp integration is installed (herdr state tracking for omp).
        pub herdr_integration: bool,
        /// omp global config shares every session on the TeleFlock relay
        /// (`collab.autoStart: control` + `collab.relayUrl: ws://127.0.0.1:<port>`).
        pub global_sharing: bool,
        /// The TeleFlock companion extension is installed in `~/.omp/agent/extensions`.
        pub global_bridge: bool,
        /// The relay embedded in tf-hostd is listening.
        pub relay: bool,
        pub issues: Vec<SetupIssue>,
    }
}

wire_struct! {
    pub struct HostInfo {
        pub hostname: String,
        /// `linux` | `macos` | `windows`.
        pub os: String,
        pub arch: String,
        pub home: String,
        pub hostd_version: String,
        pub herdr: Option<VersionInfo>,
        pub omp: Option<VersionInfo>,
        /// herdr session this client is attached to (`default` unless configured).
        pub herdr_session: String,
        pub herdr_sessions: Vec<String>,
        pub relay_port: u16,
        pub setup: SetupStatus,
    }
}

wire_struct! {
    pub struct HostHealth {
        pub at: Millis,
        pub cpu_pct: f32,
        pub cores: u32,
        pub load1: f32,
        pub mem_used: u64,
        pub mem_total: u64,
        pub disk_free: u64,
        pub disk_total: u64,
        pub uptime_s: u64,
    }
}

wire_struct! {
    pub struct RepoInfo {
        /// Repository root (main worktree root for linked worktrees).
        pub root: String,
        pub name: String,
        pub branch: Option<String>,
        pub head: Option<String>,
        /// Number of changed files (staged + unstaged + untracked).
        pub dirty: Option<u32>,
        pub ahead: Option<u32>,
        pub behind: Option<u32>,
        pub remote_url: Option<String>,
    }
}

wire_struct! {
    pub struct WorktreeInfo {
        pub path: String,
        pub branch: Option<String>,
        /// Primary (repo) workspace this linked worktree is grouped under.
        pub primary_workspace_id: Option<String>,
    }
}

wire_struct! {
    pub struct PaneInfo {
        /// herdr pane id, e.g. `w1:p1`.
        pub id: String,
        pub terminal_id: Option<String>,
        pub title: Option<String>,
        pub cwd: Option<String>,
        /// Agent occupying this pane, if any.
        pub agent_id: Option<String>,
        pub focused: bool,
    }
}

wire_struct! {
    pub struct Tab {
        /// herdr tab id, e.g. `w1:t1`.
        pub id: String,
        pub label: String,
        pub panes: Vec<PaneInfo>,
    }
}

wire_struct! {
    pub struct Workspace {
        /// herdr workspace id, e.g. `w1`.
        pub id: String,
        pub label: String,
        pub cwd: String,
        pub repo: Option<RepoInfo>,
        /// Present for linked-worktree workspaces.
        pub worktree: Option<WorktreeInfo>,
        pub tabs: Vec<Tab>,
        /// herdr rollup state of the workspace.
        pub rollup: HerdrState,
        /// Display order index from herdr.
        pub order: u32,
    }
}

wire_struct! {
    pub struct ModelRef {
        pub provider: String,
        pub id: String,
        /// Short display label, e.g. `opus-5.5`.
        pub label: Option<String>,
    }
}

wire_struct! {
    pub struct ContextUsage {
        pub tokens: u64,
        pub window: u64,
        /// 0..=100.
        pub pct: f32,
    }
}

wire_struct! {
    pub struct CostInfo {
        pub usd: f64,
        pub input: u64,
        pub output: u64,
        pub cache_read: u64,
        pub cache_write: u64,
    }
}

wire_struct! {
    pub struct TodoSummary {
        pub done: u32,
        pub total: u32,
        /// Content of the in-progress task.
        pub current: Option<String>,
    }
}

wire_struct! {
    pub struct SubagentSummary {
        pub live: u32,
        pub total: u32,
    }
}

wire_struct! {
    pub struct QueueInfo {
        pub steering: Vec<String>,
        pub follow_up: Vec<String>,
    }
}

wire_struct! {
    pub struct GoalInfo {
        pub objective: String,
        /// `active` | `paused`.
        pub status: String,
        pub tokens_used: Option<u64>,
        pub budget: Option<u64>,
    }
}

wire_struct! {
    pub struct DiffStat {
        pub added: u32,
        pub removed: u32,
        pub files: u32,
    }
}

wire_struct! {
    /// omp-specific facts about an agent (present when the agent is omp).
    pub struct OmpInfo {
        pub session_id: Option<String>,
        pub session_file: Option<String>,
        pub pid: Option<u32>,
        pub version: Option<String>,
        pub link: LinkState,
        pub link_error: Option<String>,
        /// The TeleFlock companion extension is loaded in this omp process.
        pub bridge: bool,
        pub model: Option<ModelRef>,
        pub thinking: Option<ThinkingLevel>,
        pub fast: bool,
        pub mode: OmpMode,
        pub goal: Option<GoalInfo>,
        pub context: Option<ContextUsage>,
        pub cost: Option<CostInfo>,
        pub todos: Option<TodoSummary>,
        pub subagents: Option<SubagentSummary>,
        pub queue: QueueInfo,
        pub turn_started_at: Option<Millis>,
        pub last_turn_ended_at: Option<Millis>,
    }
}

wire_struct! {
    pub struct ActiveTool {
        pub name: String,
        /// Human label, e.g. `bun test src/board` or `edit src/App.tsx`.
        pub label: String,
        pub started_at: Millis,
    }
}

wire_struct! {
    /// What the agent is doing right now. Drives every "is it alive?" animation.
    pub struct Liveness {
        /// Last structured event (collab) or terminal activity (non-omp) for this agent.
        pub last_event_at: Option<Millis>,
        /// Assistant text tokens are streaming.
        pub streaming: bool,
        /// Thinking tokens are streaming (or waiting for the first token of a turn).
        pub thinking: bool,
        pub tool: Option<ActiveTool>,
        /// Rolling output tokens per second.
        pub tps: Option<f32>,
        /// One-line summary of current activity (tool label, last assistant sentence, …).
        pub line: Option<String>,
    }
}

wire_enum! {
    pub enum NeedsKind { Ask, Approval, PlanReview, Confirm, Input, Blocked, Error }
}

wire_enum! {
    pub enum OptionTone { Primary, Neutral, Danger }
}

wire_struct! {
    pub struct NeedsOption {
        /// Value to send back in `Answer.choices` (for collab selects: the exact option label).
        pub id: String,
        pub label: String,
        pub description: Option<String>,
        pub recommended: bool,
        pub tone: OptionTone,
    }
}

wire_struct! {
    /// Why an agent is in the Needs-you lane and how to answer it.
    pub struct NeedsYou {
        pub kind: NeedsKind,
        /// Request id to pass to `agent.answer` (absent when not answerable in-app).
        pub request_id: Option<String>,
        pub since: Millis,
        /// Short title, e.g. `Question`, `Allow bash?`, `Review plan`.
        pub title: String,
        pub question: String,
        pub detail: Option<String>,
        pub options: Vec<NeedsOption>,
        pub multi: bool,
        /// Free-text answer allowed ("Other").
        pub allow_other: bool,
        /// "Chat about this" allowed (ask tool).
        pub allow_chat: bool,
        /// Command awaiting approval (approvals).
        pub command: Option<String>,
        /// False when the dialog can only be answered in the terminal.
        pub answerable: bool,
    }
}

wire_struct! {
    pub struct Agent {
        /// Stable id for the lifetime of the hosting pane's terminal (herdr terminal id,
        /// falling back to the pane id). Survives pane moves.
        pub id: String,
        /// herdr agent name (unique among live agents) or derived label.
        pub name: String,
        /// herdr agent kind: `omp`, `claude`, `codex`, …
        pub kind: String,
        pub pane_id: String,
        pub tab_id: String,
        pub workspace_id: String,
        pub state: HerdrState,
        pub state_since: Millis,
        pub column: Column,
        pub archived: bool,
        /// Completed turns observed since TeleFlock started tracking this agent.
        pub turns: u32,
        /// Task title: omp session title, else first prompt, else herdr label.
        pub title: String,
        pub cwd: Option<String>,
        pub repo: Option<String>,
        pub branch: Option<String>,
        pub started_at: Option<Millis>,
        pub omp: Option<OmpInfo>,
        pub live: Liveness,
        pub needs: Option<NeedsYou>,
        pub diff: Option<DiffStat>,
    }
}

wire_struct! {
    pub struct UsageTotals {
        pub cost_usd: f64,
        pub tokens: u64,
        pub input: u64,
        pub output: u64,
    }
}

wire_struct! {
    /// Full board state of one host (one herdr session).
    pub struct HostState {
        pub info: HostInfo,
        pub health: Option<HostHealth>,
        pub workspaces: Vec<Workspace>,
        pub agents: Vec<Agent>,
        /// Today's usage (host local day).
        pub usage: UsageTotals,
    }
}

/// Incremental change to [`HostState`]. Entities are replaced whole; `value: null` deletes.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum StatePatch {
    Info { info: HostInfo },
    Health { health: HostHealth },
    Workspace { id: String, value: Option<Workspace> },
    Agent { id: String, value: Option<Agent> },
    Usage { usage: UsageTotals },
}

wire_enum! {
    pub enum PulseKind { Token, Thinking, Tool, Event, State }
}

wire_struct! {
    /// Heartbeat tick for one agent within one pulse window (~100 ms).
    pub struct Pulse {
        pub agent_id: String,
        pub kind: PulseKind,
        /// Intensity: number of events (or streamed chars / 16) in the window.
        pub n: u32,
    }
}

wire_enum! {
    pub enum NotifyKind { Needs, Finished, Error, Quiet, Info }
}

wire_struct! {
    pub struct Answer {
        /// Selected option ids (exact labels for collab selects). Empty for free text.
        pub choices: Vec<String>,
        /// Free-text answer ("Other…" or editor dialogs).
        pub text: Option<String>,
        /// Dismiss / deny the dialog.
        #[serde(default)]
        pub cancel: bool,
        /// Ask tool: "Chat about this".
        #[serde(default)]
        pub chat: bool,
    }
}

wire_struct! {
    pub struct NotifyAction {
        pub id: String,
        pub label: String,
        /// When set, choosing this action answers the pending request directly.
        pub answer: Option<Answer>,
    }
}

wire_struct! {
    pub struct Notification {
        pub id: String,
        pub at: Millis,
        pub kind: NotifyKind,
        pub agent_id: String,
        pub title: String,
        pub body: String,
        pub request_id: Option<String>,
        pub actions: Vec<NotifyAction>,
    }
}

wire_enum! {
    pub enum ActivityKind {
        Started, Prompted, Finished, Asked, Answered, Approved, Denied, Error, ToolError,
        Archived, Unarchived, Stopped, Committed, Compacted, ModelChanged
    }
}

wire_struct! {
    pub struct ActivityEvent {
        pub id: String,
        pub at: Millis,
        pub agent_id: String,
        pub agent_name: String,
        pub kind: ActivityKind,
        pub title: String,
        pub detail: Option<String>,
    }
}
