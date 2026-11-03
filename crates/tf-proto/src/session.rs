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
        /// The subagent this one runs under (omp's agent registry `parentId`; without a roster
        /// entry omp's naming, `A.B.C` under `A.B`); absent for the main agent's own subagents.
        /// Hosts before 0.9.0 sent `Main` for those, and the spawning tool call's id until omp's
        /// roster listed the subagent.
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
        /// `agent.refusalRetry` works ("Retry with <model>" after a provider refusal) and the host's
        /// refusal fallback rules apply to this session: TeleFlock's bridge ≥ 2.3.0 serves it.
        #[serde(default)]
        pub refusal_retry: bool,
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
        /// The session's agent chat log (hosts ≥ 0.9.0): every omp IRC message exchanged inside
        /// its agent tree. Fetch the messages with `session.agentChat`; absent from older hosts
        /// (the app then shows the IRC rows of the session's own transcript).
        pub agent_chat: Option<AgentChatInfo>,
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

wire_struct! {
    /// What a session's agent chat log holds now (`SessionMeta::agent_chat`): enough to know when
    /// to fetch (`session.agentChat`) and what.
    pub struct AgentChatInfo {
        /// Names this log's message ids and revisions: when it changes (tf-hostd restarted and
        /// rebuilt the log), drop what was fetched before and fetch from scratch.
        pub epoch: String,
        /// Revision of the last change (a message added or updated).
        pub rev: u64,
        pub count: u32,
        /// The session's bridge reports each message as it is sent (bridge ≥ 2.3.0,
        /// `caps.agentChat`): `rev` moves by itself. Otherwise the log is read from the session's
        /// transcript files on every `session.agentChat`, so fetch again while it is shown.
        pub live: bool,
    }
}

wire_struct! {
    /// One message of a session's agent chat: an omp IRC message between two agents of the
    /// session's tree (the main agent, subagents at any depth), a broadcast, or what the user sent
    /// an agent from the message board.
    pub struct AgentChatMessage {
        /// Stable within the log's epoch.
        pub id: String,
        /// omp agent id of the sender (`Main`, subagent ids such as `Orchestrator.WorkerA`), or
        /// `user`: the user, from TeleFlock.
        pub from: String,
        /// Recipients by agent id. A broadcast (`agent://all`) lists the agents it went to as far
        /// as known.
        pub to: Vec<String>,
        pub broadcast: bool,
        /// Markdown body.
        pub text: String,
        /// When it was sent.
        pub at: Millis,
        /// `id` (in this log) of the message this one answers, when that message is in the log.
        pub reply_to: Option<String>,
        /// omp relayed the recipient's turn output when its wake turn ended (not a hand-written send).
        pub wake_relay: bool,
        /// A progress note: the sender promises a reply later.
        pub progress: bool,
        /// Per recipient: `pending` (in flight), `injected` / `woken` / `revived` (omp's delivery
        /// outcomes), `received` (the recipient's transcript has it), `failed` (with `error`).
        pub receipts: Vec<IrcReceipt>,
        /// Log revision of its last change (`session.agentChat {after}`).
        pub rev: u64,
    }
}

wire_struct! {
    /// A page of a session's agent chat log (`session.agentChat`), oldest first.
    pub struct AgentChatLog {
        pub epoch: String,
        pub rev: u64,
        /// Everything changed after the asked revision, or the whole log (`reset`).
        pub messages: Vec<AgentChatMessage>,
        /// `messages` is the whole log: the asked `epoch` is gone (or none was asked).
        pub reset: bool,
        /// The log keeps the newest messages only; older ones were dropped.
        pub truncated: bool,
        /// See [`AgentChatInfo::live`].
        pub live: bool,
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
        /// A finished `present` call (bridge ≥ 2.3.0): the document the agent showed the user.
        /// Apps before 0.9.0 ignore it and show the call as a generic tool row.
        pub artifact: Option<crate::artifacts::PresentedArtifact>,
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
        /// Ask dialogs (hosts ≥ 0.8.0): what the agent wrote before asking, as Markdown: the text
        /// of the assistant message that carries the ask call, else its latest text since the
        /// last prompt; never thinking. At most about 4 KB: a longer text keeps its end, cut at a
        /// paragraph and led by `…`. Empty when the agent wrote nothing; absent for other dialogs
        /// and from older hosts.
        pub context: Option<String>,
        /// Multi-question asks (bridge ≥ 2.2.0): this question's place, Back, and the answer it
        /// already has. Absent for single questions, older bridges and collab-only sessions.
        pub step: Option<AskStep>,
    }
}

wire_struct! {
    /// One question of a multi-question ask: where it stands and what it was answered before.
    pub struct AskStep {
        /// 0-based position of the question.
        pub index: u32,
        /// Questions in the ask.
        pub total: u32,
        /// `Answer.back` reopens the previous question.
        pub can_back: bool,
        /// The answer it already has (Back brought it up again): option ids to show picked …
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[ts(as = "Option<Vec<String>>", optional)]
        pub choices: Vec<String>,
        /// … and the "Other" text.
        pub text: Option<String>,
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

wire_struct! {
    /// One of the user's prompts in a [`SessionDigest`].
    pub struct DigestPrompt {
        /// Its place among the session's prompts, from 1.
        pub n: u32,
        /// The prompt as sent; a longer one keeps its start and its end around ` … `.
        pub text: String,
    }
}

wire_struct! {
    /// A subagent in a [`SessionDigest`].
    pub struct DigestSubagent {
        /// Its omp name, e.g. `RenderCore`.
        pub name: String,
        /// What it works on, in one line: omp's label for it, else the first line of its assignment.
        pub task: Option<String>,
        pub running: bool,
    }
}

wire_struct! {
    /// `session.digest` (hosts ≥ 0.9.1): what an omp session is about as a whole, bounded for a small
    /// model; "Name it again" names the agent from it. Built from every row tf-hostd holds of the
    /// session (all of it since it started), else from its session file.
    pub struct SessionDigest {
        /// The user's prompts in order, steers included (omp's own reminders and results are not
        /// prompts): the first and the newest up to 4,000 chars each, the ones between up to 400
        /// chars each and at most 40 of them, spread over the session when there are more (very
        /// short ones such as "yes" are left out first).
        pub prompts: Vec<DigestPrompt>,
        /// How many prompts the session has.
        pub prompt_count: u32,
        /// omp's compaction summaries, oldest first: the newest 3, up to 2,000 chars each.
        pub summaries: Vec<String>,
        /// The todo list: up to 12 phases of up to 20 items, each item up to 120 chars.
        pub todos: Vec<TodoPhase>,
        /// The subagents it started, in the order they started: the first 8 and the newest 32 when
        /// there are more.
        pub subagents: Vec<DigestSubagent>,
        /// How many subagents it started.
        pub subagent_count: u32,
    }
}
