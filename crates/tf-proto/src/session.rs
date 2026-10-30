//! Session view of one omp agent: transcript items, side panels, live session events.

use crate::model::{ContextUsage, CostInfo, GoalInfo, ModelRef, NeedsOption, OmpMode, QueueInfo, ThinkingLevel};
use crate::Millis;

wire_enum! {
    pub enum TodoStatus { Pending, InProgress, Completed, Abandoned, Blocked }
}

wire_struct! {
    pub struct TodoTask {
        pub content: String,
        pub status: TodoStatus,
        pub blocker: Option<String>,
    }
}

wire_struct! {
    pub struct TodoPhase {
        pub name: String,
        pub tasks: Vec<TodoTask>,
    }
}

wire_enum! {
    /// `Parked` is no longer produced: omp parking an idle subagent says it finished, not how, so
    /// the replica keeps its known outcome (`Done`/`Failed`/`Aborted`), else `Done`. Older hostds
    /// and session caches still carry it; clients show it as `Done`.
    pub enum SubagentStatus { Running, Done, Failed, Aborted, Parked }
}

wire_struct! {
    pub struct Subagent {
        pub id: String,
        pub name: String,
        pub description: Option<String>,
        pub status: SubagentStatus,
        pub started_at: Option<Millis>,
        pub ended_at: Option<Millis>,
        pub cost_usd: Option<f64>,
        pub tokens: Option<u64>,
        pub model: Option<String>,
        /// Latest activity line.
        pub line: Option<String>,
        /// The subagent's own estimate of how far along its task is, 0..=100. omp's completion probe
        /// asks the running subagent periodically (first after ~2 min); absent until it answers and
        /// once the subagent stops running. omp's TUI shows it as `· 40%` on the task row.
        pub completion_pct: Option<f32>,
        /// The subagent's own context-window usage (omp's TUI: `· 2.4%/272K`).
        pub context: Option<ContextUsage>,
        pub tool_count: Option<u32>,
        pub parent_id: Option<String>,
    }
}

wire_enum! {
    pub enum FileStatus { Modified, Added, Deleted, Renamed, Untracked }
}

wire_struct! {
    pub struct ChangedFile {
        pub path: String,
        pub added: u32,
        pub removed: u32,
        pub status: FileStatus,
        pub old_path: Option<String>,
    }
}

wire_enum! {
    pub enum TreeNodeKind { User, Assistant, Summary, Compaction, Other }
}

wire_struct! {
    pub struct TreeNode {
        /// Session entry id (usable with `agent.branch` / `agent.navigate` / `agent.fork`).
        pub id: String,
        pub parent_id: Option<String>,
        pub kind: TreeNodeKind,
        pub label: String,
        pub at: Millis,
        /// On the path from the root to the current leaf.
        pub on_path: bool,
        pub children: u32,
    }
}

wire_struct! {
    pub struct TreeInfo {
        pub nodes: Vec<TreeNode>,
        pub leaf_id: Option<String>,
    }
}

wire_struct! {
    /// Which controls are available for this session right now.
    pub struct Capabilities {
        pub prompt: bool,
        pub steer: bool,
        pub follow_up: bool,
        pub abort: bool,
        pub answer: bool,
        pub model: bool,
        pub thinking: bool,
        pub fast: bool,
        pub plan: bool,
        pub goal: bool,
        pub compact: bool,
        pub rename: bool,
        pub fork: bool,
        pub branch: bool,
        pub tree: bool,
        pub btw: bool,
        pub export: bool,
        pub handoff: bool,
        pub subagents: bool,
        /// Controls go through the companion extension (precise) instead of keystroke injection.
        pub bridge: bool,
        /// `agent.retry` works for the agent (omp's F5: retry the failed or stopped last turn).
        #[serde(default)]
        pub retry: bool,
        /// `agent.retry` works for its subagents (bridge ≥ 2.1.0 with omp's task internals).
        #[serde(default)]
        pub subagent_retry: bool,
    }
}

wire_struct! {
    pub struct SessionMeta {
        pub session_id: Option<String>,
        pub session_file: Option<String>,
        pub title: Option<String>,
        pub cwd: Option<String>,
        pub model: Option<ModelRef>,
        pub thinking: Option<ThinkingLevel>,
        pub fast: bool,
        pub mode: OmpMode,
        pub goal: Option<GoalInfo>,
        pub context: Option<ContextUsage>,
        pub cost: Option<CostInfo>,
        pub tps: Option<f32>,
        pub todos: Vec<TodoPhase>,
        pub subagents: Vec<Subagent>,
        pub files: Vec<ChangedFile>,
        pub queue: QueueInfo,
        pub tree: Option<TreeInfo>,
        pub caps: Capabilities,
        pub started_at: Option<Millis>,
    }
}

wire_struct! {
    pub struct ImageRef {
        pub mime: String,
        /// Base64 payload (inline images) …
        pub data: Option<String>,
        /// … or a URL the client can load …
        pub url: Option<String>,
        /// … or an omp blob (sha256 hex) holding the image omp kept: fetch it with `session.image`.
        /// None of the three: the payload was cut from a collab frame (entries are capped at 1 MiB)
        /// and the journal, which keeps it as a blob, has not caught up yet.
        pub blob: Option<String>,
        /// Full-resolution original on the host when the image above is omp's downscaled copy (omp
        /// resizes images it queues for the model, and TUI pastes): an absolute path, or a
        /// `local://` URL of the agent's omp session. Fetch it with `session.image` (`original`).
        pub original: Option<String>,
        pub width: Option<u32>,
        pub height: Option<u32>,
    }
}

wire_struct! {
    pub struct TokenUsage {
        pub input: u64,
        pub output: u64,
        pub cache_read: u64,
        pub cache_write: u64,
        pub cost_usd: f64,
    }
}

wire_struct! {
    pub struct UserItem {
        pub id: String,
        pub at: Millis,
        pub text: String,
        pub images: Vec<ImageRef>,
        /// Display name of the author when not the local user (collab guests, other TeleFlock clients).
        pub author: Option<String>,
        /// Sent while the agent was streaming (steer).
        pub steering: bool,
        /// Synthetic/system-originated user turn (todo reminders, async results, …).
        pub synthetic: bool,
    }
}

wire_struct! {
    /// A provider's refusal of a turn: omp's `stopDetails` of type `refusal` or `sensitive`
    /// (Anthropic's safety classifiers), without what the provider attached for omp's own use.
    pub struct Refusal {
        /// omp's `stopDetails.type`: `refusal` (the model declined) or `sensitive` (a safety filter
        /// flagged the content).
        pub kind: String,
        /// The policy area the provider named, e.g. `cyber`.
        pub category: Option<String>,
        /// The provider's explanation.
        pub explanation: Option<String>,
    }
}

wire_struct! {
    /// An assistant text row, or the error row of a message that failed without any text. A
    /// message's outcome (`stopReason` … `refusal`) is on its last text row (or its error row) only.
    pub struct AssistantItem {
        pub id: String,
        pub at: Millis,
        pub text: String,
        pub streaming: bool,
        pub model: Option<String>,
        pub usage: Option<TokenUsage>,
        pub stop_reason: Option<String>,
        /// What went wrong, as omp words it: a provider error, a refusal, or an abort's own reason
        /// (never a user interrupt).
        pub error: Option<String>,
        /// HTTP status the provider answered the failed request with (omp `errorStatus`).
        pub error_status: Option<u16>,
        /// The provider refused the turn (`error` holds omp's text for it).
        pub refusal: Option<Refusal>,
    }
}

wire_struct! {
    pub struct ThinkingItem {
        pub id: String,
        pub at: Millis,
        pub text: String,
        pub streaming: bool,
        pub duration_ms: Option<u64>,
        /// Provider returned encrypted/redacted thinking only.
        pub redacted: bool,
    }
}

wire_enum! {
    pub enum ToolStatus { Pending, Running, Ok, Error, Aborted, Denied }
}

wire_struct! {
    pub struct FileDiff {
        pub path: String,
        /// Unified diff text.
        pub patch: String,
        pub added: u32,
        pub removed: u32,
        pub status: FileStatus,
        pub lang: Option<String>,
    }
}

wire_struct! {
    pub struct DiffView {
        pub files: Vec<FileDiff>,
    }
}

wire_struct! {
    pub struct BashView {
        pub command: String,
        pub cwd: Option<String>,
        /// Output with ANSI escapes preserved (may be truncated, see `ToolItem.truncated`).
        pub output: String,
        pub exit_code: Option<i32>,
        pub background: bool,
        pub timed_out: bool,
    }
}

wire_struct! {
    pub struct ReadView {
        pub path: String,
        /// e.g. `1-88`.
        pub range: Option<String>,
        pub lines: Option<u32>,
        pub preview: Option<String>,
        pub lang: Option<String>,
    }
}

wire_struct! {
    pub struct SearchHit {
        pub path: String,
        pub line: Option<u32>,
        pub text: Option<String>,
    }
}

wire_struct! {
    pub struct SearchView {
        pub query: String,
        pub matches: u32,
        pub files: u32,
        pub hits: Vec<SearchHit>,
    }
}

wire_struct! {
    pub struct TodoView {
        pub phases: Vec<TodoPhase>,
    }
}

wire_struct! {
    pub struct TaskView {
        pub agents: Vec<Subagent>,
    }
}

wire_struct! {
    pub struct WebSource {
        pub title: String,
        pub url: String,
        pub snippet: Option<String>,
    }
}

wire_struct! {
    pub struct WebView {
        pub query: Option<String>,
        pub sources: Vec<WebSource>,
        pub answer: Option<String>,
    }
}

wire_struct! {
    pub struct ImageView {
        pub image: ImageRef,
        pub alt: Option<String>,
        /// Page URL for browser screenshots.
        pub url: Option<String>,
    }
}

wire_struct! {
    pub struct AskQuestion {
        pub question: String,
        pub options: Vec<String>,
        pub answer: Option<String>,
    }
}

wire_struct! {
    pub struct AskView {
        pub questions: Vec<AskQuestion>,
    }
}

wire_struct! {
    pub struct MarkdownView {
        pub text: String,
    }
}

wire_enum! {
    /// `in`: a peer's message delivered to this agent; `out`: this agent's send to a peer.
    pub enum IrcDirection { In, Out }
}

wire_struct! {
    /// Delivery outcome for one recipient of an outbound IRC send (omp `IrcDeliveryReceipt`).
    pub struct IrcReceipt {
        pub to: String,
        /// `injected` | `woken` | `revived` | `failed`.
        pub outcome: String,
        pub error: Option<String>,
    }
}

wire_struct! {
    /// One omp IRC (agent ↔ agent) message, seen from this agent: inbound from `peer`, or outbound
    /// to `peer`. Peers are omp agent ids (`Main`, subagent ids; `all` = broadcast send).
    pub struct IrcMessage {
        pub direction: IrcDirection,
        pub peer: String,
        /// Markdown body.
        pub text: String,
        /// omp message id (inbound).
        pub message_id: Option<String>,
        /// Message id this one answers.
        pub reply_to: Option<String>,
        /// One leg of an `agent://all` broadcast (or the broadcast send itself).
        pub broadcast: bool,
        /// omp relayed the peer's final output when its wake turn stopped (not a hand-written send).
        pub wake_relay: bool,
        /// Sent by this agent's parent.
        pub from_parent: bool,
        /// Outbound: per-recipient delivery outcomes once the send finished.
        pub receipts: Vec<IrcReceipt>,
        /// When omp sent the message (inbound). A row carried by a `wait` call is stamped with the
        /// call's start, so prefer this for display, ordering and unread.
        pub sent_at: Option<Millis>,
    }
}

/// Rich renderer hint for a tool item. Absent → generic args/output rendering.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ToolView {
    Diff(DiffView),
    Bash(BashView),
    Read(ReadView),
    Search(SearchView),
    Todo(TodoView),
    Task(TaskView),
    Web(WebView),
    Image(ImageView),
    Ask(AskView),
    Markdown(MarkdownView),
    /// Outbound IRC send (`write agent://<id>`) or a message consumed by `wait`.
    Irc(IrcMessage),
}

wire_struct! {
    pub struct ToolItem {
        pub id: String,
        pub at: Millis,
        pub call_id: String,
        /// Tool name as omp knows it (`bash`, `edit`, `read`, `task`, …).
        pub tool: String,
        /// One-line human title, e.g. `bun test src/board`.
        pub title: String,
        /// omp's stated intent for the call.
        pub intent: Option<String>,
        #[ts(type = "unknown")]
        pub args: serde_json::Value,
        pub status: ToolStatus,
        pub duration_ms: Option<u64>,
        /// Plain text output (ANSI preserved) when no richer view applies.
        pub output: Option<String>,
        pub truncated: bool,
        pub view: Option<ToolView>,
        pub error: Option<String>,
    }
}

wire_enum! {
    pub enum NoticeLevel { Info, Warn, Error }
}

wire_struct! {
    pub struct NoticeItem {
        pub id: String,
        pub at: Millis,
        pub level: NoticeLevel,
        pub text: String,
        pub source: Option<String>,
    }
}

wire_struct! {
    pub struct CompactionItem {
        pub id: String,
        pub at: Millis,
        pub summary: String,
        pub tokens_before: Option<u64>,
    }
}

wire_struct! {
    /// Model / thinking / mode change marker.
    pub struct ModeItem {
        pub id: String,
        pub at: Millis,
        pub text: String,
    }
}

wire_struct! {
    /// Inbound IRC message (omp `irc:incoming`, or a parent's `<irc from="parent">` steer).
    pub struct IrcItem {
        pub id: String,
        pub at: Millis,
        pub message: IrcMessage,
    }
}

/// One row of the transcript. Rows are keyed by `id` and updated in place.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum TranscriptItem {
    User(UserItem),
    Assistant(AssistantItem),
    Thinking(ThinkingItem),
    Tool(ToolItem),
    Notice(NoticeItem),
    Compaction(CompactionItem),
    Mode(ModeItem),
    Irc(IrcItem),
}

impl TranscriptItem {
    pub fn id(&self) -> &str {
        match self {
            Self::User(i) => &i.id,
            Self::Assistant(i) => &i.id,
            Self::Thinking(i) => &i.id,
            Self::Tool(i) => &i.id,
            Self::Notice(i) => &i.id,
            Self::Compaction(i) => &i.id,
            Self::Mode(i) => &i.id,
            Self::Irc(i) => &i.id,
        }
    }
}

wire_enum! {
    pub enum UiKind { Select, MultiSelect, Editor, Confirm, PlanReview, Input }
}

wire_struct! {
    pub struct PlanReview {
        pub title: Option<String>,
        /// Plan markdown.
        pub content: String,
        pub path: Option<String>,
    }
}

wire_struct! {
    /// A pending dialog in the omp session that TeleFlock can answer with `agent.answer`.
    pub struct UiRequest {
        pub id: String,
        pub kind: UiKind,
        pub title: String,
        pub message: Option<String>,
        pub options: Vec<NeedsOption>,
        pub allow_other: bool,
        pub allow_chat: bool,
        /// Prefilled text for editors.
        pub initial: Option<String>,
        pub plan: Option<PlanReview>,
        /// The tool call this dialog belongs to (ask tool / approval), when known.
        pub call_id: Option<String>,
    }
}

wire_struct! {
    pub struct SessionSnapshot {
        pub agent_id: String,
        pub meta: SessionMeta,
        /// Most recent transcript rows, oldest first (a delta snapshot: only the rows the client
        /// lacked or held stale, see [`SessionSync::delta`]).
        pub items: Vec<TranscriptItem>,
        pub has_more: bool,
        /// Pass to `session.history` to page older rows.
        pub cursor: Option<String>,
        pub ui: Option<UiRequest>,
        /// Present when the client passed `have` (`sessionSync` feature).
        pub sync: Option<SessionSync>,
    }
}

wire_struct! {
    /// One transcript row a client holds, with the hash the host gave it (`SessionSync::hashes`,
    /// `upsert.h`). Hashes are opaque: compare for equality only.
    pub struct RowDigest {
        pub id: String,
        pub h: String,
    }
}

wire_struct! {
    /// What a client already holds of an agent's session (`session.open { have }`), so the host
    /// ships only rows that are missing or stale.
    pub struct SessionHave {
        /// omp session id the cached rows belong to; another session gets a full snapshot.
        pub session_id: String,
        /// The cached window, newest first (at most 500 rows).
        pub rows: Vec<RowDigest>,
        /// [`SessionSync::meta_hash`] of the cached meta.
        pub meta_hash: Option<String>,
    }
}

wire_struct! {
    /// How a client applies a snapshot it asked for with `have`, and where the live stream starts.
    pub struct SessionSync {
        /// Seq of the last event folded into this snapshot; live `session` messages continue at
        /// `seq + 1` (a gap: re-open with `have`).
        pub seq: u64,
        /// `items` holds only the rows the client lacks or holds stale; `order` is the window.
        pub delta: bool,
        /// Every row id of the window, oldest first (delta snapshots). Cached rows of the window
        /// that are not listed are gone (another branch, a rewritten session).
        pub order: Option<Vec<String>>,
        /// Hash of each row in `items`.
        pub hashes: Vec<RowDigest>,
        /// Hash of the full meta (tree included).
        pub meta_hash: String,
        /// The client's cached meta is current: `meta` is a placeholder, keep the cached one.
        pub meta_same: bool,
    }
}

wire_enum! {
    pub enum AppendField { Text, Output }
}

/// Live update for an open session (`session.open` subscribes the client).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(tag = "k", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum SessionEvent {
    /// Replace everything (first open, resync, session rotation).
    Reset { snapshot: SessionSnapshot },
    /// Insert or replace a row by id (appends when new).
    Upsert {
        item: TranscriptItem,
        /// Row hash (`sessionSync` subscriptions).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        h: Option<String>,
    },
    /// Streaming append to a row's `text` (user/assistant/thinking) or `output` (tool).
    Append {
        id: String,
        field: AppendField,
        text: String,
        /// UTF-8 byte length of the field before this append (`sessionSync` subscriptions): a
        /// client holding another length missed something and re-opens with `have`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        at: Option<u64>,
    },
    Remove { id: String },
    Meta { meta: SessionMeta },
    /// `sessionSync` subscriptions only (the app core turns it into a full `meta` for the UI):
    /// JSON merge patch of the top-level [`SessionMeta`] fields except `tree` (`null` clears a
    /// field), and the hash of the full meta after it.
    MetaPatch {
        #[ts(type = "Record<string, unknown>")]
        set: serde_json::Map<String, serde_json::Value>,
        hash: String,
    },
    /// `sessionSync` subscriptions only: tree nodes added or changed, nodes removed, the new
    /// leaf, and the hash of the full meta after it.
    TreePatch {
        upsert: Vec<TreeNode>,
        remove: Vec<String>,
        leaf_id: Option<String>,
        hash: String,
    },
    /// Pending dialog changed (`null` = none).
    Ui { request: Option<UiRequest> },
    /// Side-question (`agent.btw`, or `/btw` asked in omp's TUI) answer stream, per turn of the
    /// conversation. `text` is appended; `question` comes with the turn's first event.
    Btw {
        btw_id: String,
        #[serde(default)]
        turn: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        question: Option<String>,
        text: String,
        done: bool,
    },
    /// The session ended or rotated (`/new`, `/resume`, `/fork`); re-open the agent.
    Ended { reason: String },
}

wire_struct! {
    pub struct HistoryPage {
        pub items: Vec<TranscriptItem>,
        pub has_more: bool,
        pub cursor: Option<String>,
    }
}
