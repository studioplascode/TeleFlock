//! Session replica: omp collab frames → tf-proto session model.
//!
//! One [`Replica`] per hosted omp session. Feed it every [`GuestEvent`]; it keeps the transcript
//! rows, side-panel meta, liveness and the pending dialog, and returns the **compacted** stream
//! of [`SessionEvent`]s for clients.
//!
//! **Delta compaction.** omp's `message_update` repeats the whole message (twice). The replica
//! diffs each content block of the message against what it already emitted and sends only the
//! suffix as `append`. It never trusts `assistantMessageEvent.delta` alone: the host serializes
//! the (mutable) message lazily, so `message` may already be ahead of the delta (observed in
//! samples 01/02/11). Prefix-diffing is exact in both cases and makes mid-turn joins work too.
//!
//! **Ids** are stable across snapshot and live frames: user (and inbound IRC) `u<ts>`,
//! assistant/thinking blocks `a<ts>.<block>`, tools `t:<toolCallId>`, model/thinking markers
//! `m<entryId>`, compaction `c<entryId>`, notices `n<epoch>.<seq>`, retry streaks `r<epoch>.<seq>`
//! (`epoch`: the replica's lifetime, so a later replica of the session never reuses them).
//!
//! **Rows end as the session file has them.** A row's final content depends only on the session's
//! entries (collab's, or omp's session file that tf-hostd reads for bridge-served sessions) and on
//! what was noted of it live that the file does not keep ([`RowNote`]: the device that sent a
//! prompt, a steer, how long the model thought; tf-hostd persists notes and hands them back with
//! [`Replica::keep_notes`]). Live events build the row first; once its entry lands it is computed
//! again exactly as a snapshot computes it (a tool's arguments from the recorded call, durations
//! from omp's own timestamps), so a row built live and the same row rebuilt from the file after a
//! resync or a tf-hostd restart are equal field for field, and clients that cache rows by hash
//! keep them. Live-only: notices (`n…`, `r…`) and progress a tool reports after its result (async
//! `task` calls of omp < 18.13, whose late updates refresh the row's view).

mod irc;
mod spend;
mod tools;
mod ui;
mod util;

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tf_proto::{
    ActiveTool, AppendField, AssistantItem, Capabilities, ChangedFile, CompactionItem, ContextUsage, CostInfo, CostSplit, FileStatus,
    HistoryPage, ImageRef, Liveness, Millis, ModeItem, ModelRef, NeedsYou, NoticeItem, NoticeLevel, OmpMode, PulseKind, QueueInfo,
    SessionEvent, SessionMeta, SessionSnapshot, Subagent, SubagentStatus, ThinkingItem, ThinkingLevel, TodoPhase, TpsSplit,
    TokenUsage, ToolItem, ToolStatus, TranscriptItem, UiRequest, UserItem, GoalInfo, IrcItem,
};

use crate::frame::{AgentSnapshot, HostFrame, SessionHeader, SessionState, UiRequestFrame};
use crate::guest::{EndReason, GuestEvent, Snapshot};
use util::{arr, b, clip, content_images, content_text, f, first_line, non_empty, s, shown_sha256, ts, u};

pub use spend::{ArtifactCall, ArtifactKind, ArtifactLedger, Spend};
pub use ui::UiReply;
use spend::Playback;

/// Rows carried by the `reset` event; older rows page through [`Replica::history`].
pub const RESET_LIMIT: usize = 300;
/// Cap for a tool row's `output` (the tail is kept).
pub const OUTPUT_CAP: usize = 256 * 1024;
const TPS_WINDOW_MS: i64 = 3000;
/// `customType` of omp's hidden companion to a TUI-pasted image (`details: {index, path}`, sharing
/// the user row's timestamp): `path` is the file as pasted, before omp downscaled it.
const IMAGE_ATTACHMENT: &str = "image-attachment";

/// A full-resolution copy tf-hostd kept of an image it sent ([`Replica::expect_originals`]).
#[derive(Debug, Clone, PartialEq)]
pub struct KeptOriginal {
    /// sha256 hex of the original's bytes (equal to the row's image when omp kept it as is).
    pub sha256: String,
    /// Where tf-hostd stored it (→ `ImageRef.original`).
    pub path: String,
}

/// What was seen of a row live that omp's session file does not keep, so the row rebuilt from the
/// file comes out as it was built live. Each field is set once (the first observation stands) and
/// never cleared, so notes merge in any order ([`RowNote::merge`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RowNote {
    /// The TeleFlock device that sent this prompt (user rows): every device shares one collab
    /// guest, and prompts through the bridge carry no sender at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// The prompt arrived while the agent was producing this turn's output (user rows: a steer).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub steering: bool,
    /// How long the model thought (thinking rows), measured while the block streamed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_ms: Option<u64>,
}

impl RowNote {
    /// Takes the fields of `other` this note does not have yet; true when anything changed.
    pub fn merge(&mut self, other: &RowNote) -> bool {
        let before = self.clone();
        if self.author.is_none() {
            self.author.clone_from(&other.author);
        }
        self.steering |= other.steering;
        if self.thought_ms.is_none() {
            self.thought_ms = other.thought_ms;
        }
        *self != before
    }
}

/// A prompt TeleFlock queued while omp streamed ([`Replica::expect_queued`]).
#[derive(Debug, Clone)]
struct QueuedSent {
    text: String,
    follow_up: bool,
    /// When it was sent (host epoch ms): only a user row from then on can be its echo.
    at: Millis,
}

/// Comparison key of a queued message: omp's queue chips flatten line breaks (` ↵ `) and the
/// bridge reads them back from the rendered band, so whitespace and `↵` don't count.
pub fn queue_key(text: &str) -> String {
    text.split(|c: char| c.is_whitespace() || c == '↵').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

/// `primary` (omp's own queue, read by the bridge) plus every message of `extra` (prompts
/// TeleFlock queued) it does not list yet, compared by [`queue_key`] across both lists.
pub fn merge_queue(primary: &QueueInfo, extra: &QueueInfo) -> QueueInfo {
    let mut out = primary.clone();
    let mut listed: Vec<String> = primary.steering.iter().chain(&primary.follow_up).map(|t| queue_key(t)).collect();
    for (texts, follow_up) in [(&extra.steering, false), (&extra.follow_up, true)] {
        for t in texts {
            let key = queue_key(t);
            if let Some(i) = listed.iter().position(|k| *k == key) {
                listed.swap_remove(i);
            } else if follow_up {
                out.follow_up.push(t.clone());
            } else {
                out.steering.push(t.clone());
            }
        }
    }
    out
}

/// Discrete things that happened, for activity feeds and notifications.
#[derive(Debug, Clone, PartialEq)]
pub enum Signal {
    TurnStarted,
    TurnEnded { aborted: bool, error: Option<String> },
    /// A user (or guest, or synthetic) message entered the conversation.
    Prompted { text: String, author: Option<String> },
    Asked { request_id: String },
    UiSettled { request_id: String },
    Notice { level: NoticeLevel, text: String },
    ToolError { tool: String, error: String },
    ModelChanged { model: ModelRef },
    ThinkingChanged { level: ThinkingLevel },
    Compacted { tokens_before: Option<u64> },
    Retry { attempt: u32, max: u32, error: String },
    Ended { reason: String },
    /// A user row's images got originals tf-hostd kept ([`Replica::expect_originals`]), one slot
    /// per image; tf-hostd persists them and hands them back with [`Replica::keep_originals`].
    OriginalsKept { id: String, originals: Vec<Option<String>> },
    /// Row `id` got a note ([`RowNote`], the row's notes so far): tf-hostd persists it and hands
    /// it back with [`Replica::keep_notes`] before the session's next snapshot.
    Noted { id: String, note: RowNote },
}

/// Result of [`Replica::apply`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Update {
    pub events: Vec<SessionEvent>,
    /// ui-responses the replica wants sent (multi-select loops, "Other" → editor text).
    pub replies: Vec<UiReply>,
    pub pulses: Vec<(PulseKind, u32)>,
    pub signals: Vec<Signal>,
    pub meta_changed: bool,
    pub liveness_changed: bool,
}

impl Update {
    fn pulse(&mut self, kind: PulseKind, n: u32) {
        if n == 0 {
            return;
        }
        match self.pulses.iter_mut().find(|(k, _)| *k == kind) {
            Some((_, m)) => *m += n,
            None => self.pulses.push((kind, n)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Turn running, no token yet.
    Waiting,
    Thinking,
    Text,
    /// Tool call arguments streaming.
    ToolArgs,
}

#[derive(Debug, Clone)]
struct BlockState {
    started: Millis,
    done: bool,
}

#[derive(Debug, Clone, Default)]
struct MsgState {
    blocks: Vec<Option<BlockState>>,
    done: bool,
}

#[derive(Debug, Clone)]
struct ToolState {
    name: String,
    /// When `tool_execution_start` arrived (live): the duration shown until the result lands.
    started: Option<Millis>,
    ended: bool,
    /// The call's `toolCall` block was seen: the row's arguments and intent are the recorded ones,
    /// and `tool_execution_start`'s (omp's validated copy) does not replace them.
    block: bool,
    /// When omp finished the assistant message that made the call (`completedAt`).
    completed_at: Option<Millis>,
}

impl ToolState {
    fn new(name: &str) -> ToolState {
        ToolState { name: name.to_owned(), started: None, ended: false, block: false, completed_at: None }
    }
}

#[derive(Debug, Clone, Default)]
struct SubState {
    snapshot: Option<AgentSnapshot>,
    progress: Option<Value>,
    lifecycle: Option<String>,
    description: Option<String>,
    parent_tool: Option<String>,
    /// Transcript file named by omp's lifecycle frames (`sessionFile`).
    session_file: Option<String>,
}

/// What the main session journal says that collab does not mirror (`mode_change`, `custom`,
/// `model_usage`), plus the full images of user rows.
#[derive(Debug, Clone)]
struct Journal {
    /// Next byte offset of the main session JSONL to read.
    offset: u64,
    goal: Option<GoalInfo>,
    mode: OmpMode,
    /// Latest `/todo` edit by the user (`custom user_todo_edit`), until a newer todo tool result.
    todo_edit: Option<Vec<TodoPhase>>,
    /// The main agent's side calls (`model_usage`: judges, title, compaction helpers…).
    side: Spend,
    /// User rows' images as the journal keeps them (omp blobs), by row id (`u<ts>`). They stand in
    /// for payloads collab cut from entries over 1 MiB, whichever of the two arrives first.
    images: HashMap<String, Vec<ImageRef>>,
}

impl Default for Journal {
    fn default() -> Self {
        Journal { offset: 0, goal: None, mode: OmpMode::Normal, todo_edit: None, side: Spend::default(), images: HashMap::new() }
    }
}

/// Spend tf-hostd read from the session's artifacts dir ([`ArtifactLedger`]).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Artifacts {
    subagents: Spend,
    advisor: Spend,
}

/// omp `Goal` (`mode_change.data.goal`) → `GoalInfo`; `None` once complete.
fn goal_info(g: &Value, paused: bool) -> Option<GoalInfo> {
    let objective = s(g, "objective")?.to_owned();
    let status = match s(g, "status").unwrap_or("active") {
        "complete" | "completed" | "dropped" => return None,
        _ if paused => "paused".to_owned(),
        other => other.to_owned(),
    };
    Some(GoalInfo { objective, status, tokens_used: u(g, "tokensUsed"), budget: u(g, "tokenBudget") })
}

#[derive(Debug, Clone)]
struct RetryStreak {
    id: String,
    at: Millis,
}

#[derive(Debug, Clone, PartialEq)]
struct LiveKey {
    streaming: bool,
    thinking: bool,
    tool: Option<(String, String)>,
    line: Option<String>,
}

/// The session replica. See the module docs.
pub struct Replica {
    agent_id: String,
    order: Vec<String>,
    items: HashMap<String, TranscriptItem>,
    msgs: HashMap<Millis, MsgState>,
    tools: HashMap<String, ToolState>,
    header: Option<SessionHeader>,
    state: SessionState,
    meta: SessionMeta,
    read_only: bool,
    // live
    emit: bool,
    now: Millis,
    running: bool,
    phase: Phase,
    turn_output: bool,
    last_stop: Option<String>,
    last_error: Option<String>,
    last_event_at: Option<Millis>,
    turn_started_at: Option<Millis>,
    /// Streamed chars this turn (for the per-turn average `SessionMeta.tps`).
    turn_chars: u64,
    turn_tps: Option<f32>,
    turn_ended_at: Option<Millis>,
    last_line: Option<String>,
    status_line: Option<String>,
    rate: VecDeque<(Millis, u32)>,
    active_tools: Vec<(String, ActiveTool)>,
    // bookkeeping
    seq: u64,
    /// This replica's lifetime in notice and retry ids ([`new_epoch`]): clients keep rows across
    /// tf-hostd restarts, so a new replica of the session must never reuse an earlier one's ids.
    epoch: String,
    retry: Option<RetryStreak>,
    counted: HashSet<String>,
    /// The main agent's assistant turns (`None` until the first usage record).
    main_spend: Option<Spend>,
    /// Completed `task` results (`details.usage`): the floor of the subagent spend.
    task_spend: Spend,
    /// Artifact transcripts (subagent tree, advisor), kept across resyncs of the same session.
    artifacts: Option<Artifacts>,
    /// Subagent/advisor replies being replayed for `Liveness.tps`.
    playback: Vec<Playback>,
    subs: BTreeMap<String, SubState>,
    ui: ui::UiState,
    ended: bool,
    /// Files each successful edit/write call changed (call id → files), for `SessionMeta.files`.
    file_edits: Vec<(String, Vec<ChangedFile>)>,
    /// Prompts we sent, awaiting their echo: (trimmed text, author device).
    expected_authors: VecDeque<(String, String)>,
    /// Prompts TeleFlock sent while omp was streaming, listed in `meta.queue` until their
    /// user row lands (or omp goes idle with nothing queued: aborted, dequeued, dropped).
    queued_sent: VecDeque<QueuedSent>,
    /// What was noted of rows live that the session file does not keep (row id → note), kept
    /// across snapshot reloads and handed back by tf-hostd after a restart.
    notes: HashMap<String, RowNote>,
    /// Full-resolution originals of user rows' images (row id → one slot per image): TUI pastes'
    /// source files and copies tf-hostd kept. Kept across snapshot reloads.
    originals: HashMap<String, Vec<Option<String>>>,
    /// Prompts with images we sent, awaiting their echo: (trimmed text, kept originals).
    expected_originals: VecDeque<(String, Vec<KeptOriginal>)>,
    /// State read from the main session journal (entries collab does not mirror).
    journal: Journal,
}

impl Replica {
    pub fn new(agent_id: impl Into<String>) -> Replica {
        Replica {
            agent_id: agent_id.into(),
            order: Vec::new(),
            items: HashMap::new(),
            msgs: HashMap::new(),
            tools: HashMap::new(),
            header: None,
            state: SessionState::default(),
            meta: empty_meta(),
            read_only: false,
            emit: true,
            now: 0,
            running: false,
            phase: Phase::Waiting,
            turn_output: false,
            last_stop: None,
            last_error: None,
            last_event_at: None,
            turn_started_at: None,
            turn_chars: 0,
            turn_tps: None,
            turn_ended_at: None,
            last_line: None,
            status_line: None,
            rate: VecDeque::new(),
            active_tools: Vec::new(),
            seq: 0,
            epoch: new_epoch(),
            retry: None,
            counted: HashSet::new(),
            main_spend: None,
            task_spend: Spend::default(),
            artifacts: None,
            playback: Vec::new(),
            subs: BTreeMap::new(),
            ui: ui::UiState::default(),
            ended: false,
            file_edits: Vec::new(),
            expected_authors: VecDeque::new(),
            queued_sent: VecDeque::new(),
            notes: HashMap::new(),
            originals: HashMap::new(),
            expected_originals: VecDeque::new(),
            journal: Journal::default(),
        }
    }

    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    /// Attributes the next echo of `text` (a collab prompt, or a plain user message for
    /// prompts that went through herdr/the bridge) to `author`, the sending device. All
    /// devices share TeleFlock's single guest, so omp's `details.from` can't tell them apart.
    pub fn expect_prompt(&mut self, text: &str, author: &str) {
        if self.expected_authors.len() >= 32 {
            self.expected_authors.pop_front();
        }
        self.expected_authors.push_back((text.trim().to_owned(), author.to_owned()));
    }

    /// Links the next echo of `text` to the originals tf-hostd kept of its images (one per image,
    /// in order). The row's images that are not byte-identical to theirs get `ImageRef.original`.
    pub fn expect_originals(&mut self, text: &str, originals: Vec<KeptOriginal>) {
        if originals.is_empty() {
            return;
        }
        if self.expected_originals.len() >= 32 {
            self.expected_originals.pop_front();
        }
        self.expected_originals.push_back((text.trim().to_owned(), originals));
    }

    /// Restores originals linked earlier (persisted from [`Signal::OriginalsKept`]).
    pub fn keep_originals(&mut self, id: &str, originals: Vec<Option<String>>) {
        self.originals.insert(id.to_owned(), originals);
    }

    /// Restores notes taken earlier (persisted from [`Signal::Noted`]), merged into those taken
    /// since. Call it before the session's next snapshot so the rows it rebuilds have them.
    pub fn keep_notes(&mut self, notes: impl IntoIterator<Item = (String, RowNote)>) {
        for (id, note) in notes {
            self.notes.entry(id).or_default().merge(&note);
        }
    }

    /// The notes taken of rows so far (row id → note).
    pub fn notes(&self) -> &HashMap<String, RowNote> {
        &self.notes
    }

    /// Notes `add` on row `id`; a change goes out as [`Signal::Noted`] (also while a snapshot
    /// loads: what was noted then must be kept too).
    fn note(&mut self, id: &str, add: RowNote, out: &mut Update) {
        let note = self.notes.entry(id.to_owned()).or_default();
        if note.merge(&add) {
            out.signals.push(Signal::Noted { id: id.to_owned(), note: note.clone() });
        }
    }

    /// Lists `text` in `meta.queue` (as a steer, or a follow-up) until its user row lands. Ignored
    /// while omp is idle (the prompt starts a turn instead of queuing). Returns whether meta changed.
    pub fn expect_queued(&mut self, text: &str, follow_up: bool, now: Millis) -> bool {
        let text = text.trim();
        if text.is_empty() || self.ended || !(self.running || self.state.is_streaming) {
            return false;
        }
        if self.queued_sent.len() >= 32 {
            self.queued_sent.pop_front();
        }
        self.queued_sent.push_back(QueuedSent { text: text.to_owned(), follow_up, at: now });
        self.refresh_meta();
        true
    }

    /// Drops the newest queued prompt matching `text` (pulled back out of omp's queue). Returns
    /// whether meta changed.
    pub fn forget_queued(&mut self, text: &str) -> bool {
        let key = queue_key(text);
        let Some(i) = self.queued_sent.iter().rposition(|q| queue_key(&q.text) == key) else { return false };
        self.queued_sent.remove(i);
        self.refresh_meta();
        true
    }

    // ── public reads ───────────────────────────────────────────────────

    /// Newest `limit` rows plus meta and the pending dialog.
    pub fn snapshot(&self, limit: usize) -> SessionSnapshot {
        let start = self.order.len().saturating_sub(limit);
        let items: Vec<TranscriptItem> = self.order[start..].iter().filter_map(|id| self.items.get(id).cloned()).collect();
        SessionSnapshot {
            agent_id: self.agent_id.clone(),
            meta: self.meta.clone(),
            has_more: start > 0,
            cursor: (start > 0).then(|| self.order[start].clone()),
            items,
            ui: self.ui.current().cloned(),
            sync: None,
        }
    }

    /// Rows older than `cursor` (an item id from a snapshot/page), newest `limit` of them;
    /// `None` when there is no row `cursor` (one a client kept from an earlier replica).
    pub fn history(&self, cursor: Option<&str>, limit: usize) -> Option<HistoryPage> {
        let end = match cursor {
            Some(c) => self.order.iter().position(|id| id == c)?,
            None => self.order.len(),
        };
        let start = end.saturating_sub(limit);
        Some(HistoryPage {
            items: self.order[start..end].iter().filter_map(|id| self.items.get(id).cloned()).collect(),
            has_more: start > 0,
            cursor: (start > 0).then(|| self.order[start].clone()),
        })
    }

    pub fn item(&self, id: &str) -> Option<&TranscriptItem> {
        self.items.get(id)
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    pub fn meta(&self) -> &SessionMeta {
        &self.meta
    }

    /// Latest host footer state.
    pub fn state(&self) -> &SessionState {
        &self.state
    }

    pub fn header(&self) -> Option<&SessionHeader> {
        self.header.as_ref()
    }

    pub fn is_streaming(&self) -> bool {
        self.running
    }

    pub fn read_only(&self) -> bool {
        self.read_only
    }

    pub fn ended(&self) -> bool {
        self.ended
    }

    pub fn turn_started_at(&self) -> Option<Millis> {
        self.turn_started_at.filter(|_| self.running)
    }

    /// Session spend as omp's status line totals it: main (assistant turns + journal
    /// `model_usage`) + subagents (`max` of task results, artifact tree, live progress) +
    /// advisor. `None` until anything was billed. See [`spend`] for the sources.
    pub fn usage(&self) -> Option<CostInfo> {
        let mut main = self.main_spend.unwrap_or_default();
        main.add(&self.journal.side);
        let subagents = self.subagent_spend();
        let advisor = self.artifacts.map(|a| a.advisor).unwrap_or_default();
        if self.main_spend.is_none() && main.is_empty() && subagents.is_empty() && advisor.is_empty() {
            return None;
        }
        let mut total = main;
        total.add(&subagents);
        total.add(&advisor);
        Some(CostInfo {
            usd: total.usd,
            input: total.input,
            output: total.output,
            cache_read: total.cache_read,
            cache_write: total.cache_write,
            split: Some(CostSplit { main: main.usd, subagents: subagents.usd, advisor: advisor.usd }),
        })
    }

    /// omp: `max(subagent tree, completed task results)`. Without artifact access (tests, a
    /// remote omp) the live `progress.cost` sum stands in for the tree; with it, progress still
    /// covers a subagent whose transcript is not on disk yet. Progress has no token split. Every
    /// sum is added up in a fixed order (progress by agent id: `subs` is ordered; the tree: see
    /// [`ArtifactLedger`]), so a rebuilt replica bills exactly what the live one did.
    fn subagent_spend(&self) -> Spend {
        let progress = Spend { usd: self.subs.values().filter_map(|s| s.progress.as_ref().and_then(|p| f(p, "cost"))).filter(|c| c.is_finite()).sum(), ..Spend::default() };
        let tree = self.artifacts.map(|a| a.subagents).unwrap_or_default();
        [self.task_spend, tree, progress].into_iter().fold(Spend::default(), |best, s| if s.usd > best.usd { s } else { best })
    }

    /// Folds what tf-hostd read from the session's artifacts dir: the ledger's running totals and
    /// the calls that just completed (replayed for throughput when recent).
    pub fn apply_artifacts(&mut self, ledger: &ArtifactLedger, calls: &[ArtifactCall], now: Millis) -> Update {
        let mut out = Update::default();
        let before = self.meta.clone();
        self.artifacts = Some(Artifacts { subagents: ledger.subagents(), advisor: ledger.advisor() });
        self.playback.retain(|p| p.end > now);
        self.playback.extend(calls.iter().filter_map(|c| Playback::of(c, now)));
        self.refresh_meta();
        if self.meta != before {
            out.meta_changed = true;
            out.events.push(SessionEvent::Meta { meta: self.meta.clone() });
        }
        out
    }

    /// The replica's artifact totals differ from `ledger`'s (first scan, a resync of another
    /// session, a rewritten transcript).
    pub fn artifacts_stale(&self, ledger: &ArtifactLedger) -> bool {
        self.artifacts != Some(Artifacts { subagents: ledger.subagents(), advisor: ledger.advisor() })
    }

    /// A subagent/advisor reply is still being replayed into `Liveness.tps` at `now`.
    pub fn replaying(&self, now: Millis) -> bool {
        self.playback.iter().any(|p| p.end > now)
    }

    pub fn ui(&self) -> Option<&UiRequest> {
        self.ui.current()
    }

    /// Board "needs you" for the pending dialog.
    pub fn needs(&self) -> Option<NeedsYou> {
        self.ui.needs(!self.read_only)
    }

    /// Map a tf-proto [`tf_proto::Answer`] to ui-responses (exact labels).
    pub fn answer(&mut self, request_id: &str, answer: &tf_proto::Answer) -> Result<Vec<UiReply>, tf_proto::ApiError> {
        if self.read_only {
            return Err(tf_proto::ApiError::new("permission_denied", "this collab link is read-only"));
        }
        self.ui.answer(request_id, answer)
    }

    pub fn liveness(&self, now: Millis) -> Liveness {
        let k = self.live_key();
        let split = self.tps_split(now);
        let total = split.main + split.subagents + split.advisor;
        Liveness {
            last_event_at: self.last_event_at,
            streaming: k.streaming,
            thinking: k.thinking,
            tool: self.active_tools.last().map(|(_, t)| t.clone()),
            tps: (total > 0.0).then_some(total),
            tps_split: (total > 0.0).then_some(split),
            line: k.line,
        }
    }

    /// Output tok/s per spender at `now`: the main agent's streamed deltas over the last 3 s
    /// (chars / 4), plus every subagent/advisor reply being replayed.
    fn tps_split(&self, now: Millis) -> TpsSplit {
        let main = if self.running {
            let chars: u32 = self.rate.iter().filter(|(t, _)| now - t <= TPS_WINDOW_MS).map(|(_, n)| n).sum();
            chars as f32 / 4.0 / (TPS_WINDOW_MS as f32 / 1000.0)
        } else {
            0.0
        };
        let mut split = TpsSplit { main, subagents: 0.0, advisor: 0.0 };
        for p in self.playback.iter().filter(|p| p.start <= now && now < p.end) {
            match p.kind {
                ArtifactKind::Subagent => split.subagents += p.rate,
                ArtifactKind::Advisor => split.advisor += p.rate,
            }
        }
        split
    }

    fn live_key(&self) -> LiveKey {
        let tool = self.active_tools.last().map(|(_, t)| (t.name.clone(), t.label.clone()));
        let running = self.running;
        let line = if let Some((_, label)) = &tool {
            Some(label.clone())
        } else if running {
            self.status_line.clone().or_else(|| match self.phase {
                Phase::Text => self.last_line.clone(),
                Phase::Thinking => Some("Thinking…".into()),
                Phase::ToolArgs => self.last_line.clone().or_else(|| Some("Preparing tool call…".into())),
                Phase::Waiting => Some("Working…".into()),
            })
        } else {
            self.last_line.clone()
        };
        LiveKey {
            streaming: running && self.phase == Phase::Text && tool.is_none(),
            thinking: running && tool.is_none() && matches!(self.phase, Phase::Thinking | Phase::Waiting),
            tool,
            line,
        }
    }

    // ── apply ──────────────────────────────────────────────────────────

    /// Apply one guest event at time `now` (epoch ms).
    pub fn apply(&mut self, ev: &GuestEvent, now: Millis) -> Update {
        let mut out = Update::default();
        let live_before = self.live_key();
        let meta_before = self.meta.clone();
        let ui_before = self.ui.current().map(|r| r.id.clone());
        self.now = now;
        match ev {
            GuestEvent::Snapshot(snap) => self.load_snapshot(snap, &mut out),
            GuestEvent::Frame(frame) => {
                self.last_event_at = Some(now);
                self.frame(frame, &mut out);
            }
            GuestEvent::Reconnecting { .. } => {}
            GuestEvent::Ended(reason) => {
                let reason = match reason {
                    EndReason::Bye(r) => r.clone(),
                    EndReason::RoomGone => "collab room closed".into(),
                    EndReason::Rejected(m) | EndReason::Fatal(m) => m.clone(),
                    EndReason::Closed => "left".into(),
                };
                self.end(reason, &mut out);
            }
        }
        self.refresh_meta();
        if self.meta != meta_before {
            out.meta_changed = true;
            if !matches!(ev, GuestEvent::Snapshot(_)) {
                out.events.push(SessionEvent::Meta { meta: self.meta.clone() });
            }
        }
        let ui_after = self.ui.current().map(|r| r.id.clone());
        if ui_after != ui_before && !matches!(ev, GuestEvent::Snapshot(_)) {
            out.events.push(SessionEvent::Ui { request: self.ui.current().cloned() });
            if let Some(id) = ui_before {
                out.signals.push(Signal::UiSettled { request_id: id });
            }
            if let Some(id) = ui_after {
                out.signals.push(Signal::Asked { request_id: id });
            }
        }
        out.replies.extend(self.ui.take_replies());
        out.liveness_changed = self.live_key() != live_before;
        out
    }

    fn end(&mut self, reason: String, out: &mut Update) {
        if self.ended {
            return;
        }
        self.ended = true;
        self.running = false;
        self.active_tools.clear();
        self.ui.clear();
        out.events.push(SessionEvent::Ended { reason: reason.clone() });
        out.signals.push(Signal::Ended { reason });
    }

    fn load_snapshot(&mut self, snap: &Snapshot, out: &mut Update) {
        let was_running = self.running;
        let agent_id = std::mem::take(&mut self.agent_id);
        let notes = std::mem::take(&mut self.notes);
        let expected = std::mem::take(&mut self.expected_authors);
        let originals = std::mem::take(&mut self.originals);
        let expected_originals = std::mem::take(&mut self.expected_originals);
        // Journal state survives a resync of the same session (not a rotation), and so does what
        // tf-hostd read before the first snapshot: the artifacts dir, and the session file it
        // reads itself for bridge-backed sessions (journal first, then the snapshot).
        let same_session = self.header.as_ref().is_some_and(|h| h.id == snap.welcome.header.id);
        let keep_artifacts = same_session || self.header.is_none();
        let journal = if keep_artifacts { std::mem::take(&mut self.journal) } else { Journal::default() };
        let artifacts = if keep_artifacts { self.artifacts.take() } else { None };
        let playback = if keep_artifacts { std::mem::take(&mut self.playback) } else { Vec::new() };
        let queued_sent = if same_session { std::mem::take(&mut self.queued_sent) } else { VecDeque::new() };
        // Notice and retry ids (`n<epoch>.<seq>`, `r<epoch>.<seq>`) never repeat with other content
        // after a reload.
        let (seq, epoch) = (self.seq, std::mem::take(&mut self.epoch));
        *self = Replica::new(agent_id);
        self.seq = seq;
        self.epoch = epoch;
        self.notes = notes;
        self.expected_authors = expected;
        self.originals = originals;
        self.expected_originals = expected_originals;
        self.queued_sent = queued_sent;
        self.journal = journal;
        self.artifacts = artifacts;
        self.playback = playback;
        self.meta.goal = self.journal.goal.clone();
        self.meta.mode = self.journal.mode;
        self.now = out_now(self.now, snap);
        self.emit = false;
        self.header = Some(snap.welcome.header.clone());
        self.read_only = snap.welcome.read_only;
        self.state = snap.welcome.state.clone();
        for agent in &snap.welcome.agents {
            self.subs.entry(agent.id.clone()).or_default().snapshot = Some(agent.clone());
        }
        let entries = supersede_retried(&snap.entries);
        let mut scratch = Update::default();
        for entry in entries {
            self.entry(entry, &mut scratch);
        }
        // What a reload links or notes (a prompt echoed only in the snapshot) must be kept too.
        out.signals.extend(scratch.signals.into_iter().filter(|s| matches!(s, Signal::Noted { .. } | Signal::OriginalsKept { .. })));
        // Rows from a durable snapshot are final.
        for id in &self.order {
            if let Some(item) = self.items.get_mut(id) {
                finalize(item);
            }
        }
        self.msgs.values_mut().for_each(|m| m.done = true);
        if let Some(todos) = self.journal.todo_edit.clone() {
            self.meta.todos = todos;
        }
        self.running = self.state.is_streaming;
        if self.running {
            self.phase = Phase::Waiting;
            // A turn in progress (joined mid-turn, a resync, tf-hostd restarted): from here on it
            // is this replica's turn, and its end counts like any other (`TurnEnded`).
            self.turn_started_at = Some(self.now);
            if !was_running {
                out.signals.push(Signal::TurnStarted);
            }
        }
        self.emit = true;
        self.refresh_meta();
        out.meta_changed = true;
        out.liveness_changed = true;
        out.events.push(SessionEvent::Reset { snapshot: self.snapshot(RESET_LIMIT) });
    }

    fn frame(&mut self, frame: &HostFrame, out: &mut Update) {
        match frame {
            HostFrame::Event { event } => self.event(event, out),
            HostFrame::Entry { entry } => self.entry(entry, out),
            HostFrame::State { state } => {
                out.pulse(PulseKind::State, 1);
                // `state` is debounced (100 ms): a stale `isStreaming: true` can trail `agent_end`.
                // Adopt it only for mid-turn joins, never right after a turn ended.
                let quiet = self.turn_ended_at.is_none_or(|t| self.now - t > 2000);
                if state.is_streaming && !self.running && quiet {
                    self.running = true;
                    self.phase = Phase::Waiting;
                    self.turn_started_at.get_or_insert(self.now);
                }
                self.state = state.clone();
            }
            HostFrame::Agents { agents } => {
                let ids: HashSet<&str> = agents.iter().map(|a| a.id.as_str()).collect();
                for (id, sub) in self.subs.iter_mut() {
                    if !ids.contains(id.as_str()) {
                        sub.snapshot = None;
                    }
                }
                for a in agents {
                    self.subs.entry(a.id.clone()).or_default().snapshot = Some(a.clone());
                }
                self.subs.retain(|_, s| s.snapshot.is_some() || s.progress.is_some() || s.lifecycle.is_some());
                out.pulse(PulseKind::Event, 1);
            }
            HostFrame::Bus { channel, data } => {
                self.bus(channel, data);
                out.pulse(PulseKind::Event, 1);
            }
            HostFrame::UiRequest { request } => {
                let call_id = self.call_for_request(request);
                self.ui.request(request, call_id, self.now);
            }
            HostFrame::UiRequestEnd { req_id } => self.ui.end(*req_id),
            HostFrame::Bye { reason } => self.end(reason.clone(), out),
            HostFrame::Error { message } => {
                let level = NoticeLevel::Warn;
                self.notice(level, message.clone(), Some("collab".into()), out);
            }
            HostFrame::Welcome(_) | HostFrame::SnapshotChunk(_) | HostFrame::Transcript(_) | HostFrame::Unknown(_) => {}
        }
    }

    // ── events ─────────────────────────────────────────────────────────

    fn event(&mut self, ev: &Value, out: &mut Update) {
        let ty = s(ev, "type").unwrap_or("");
        match ty {
            "agent_start" => {
                if !self.running {
                    out.signals.push(Signal::TurnStarted);
                    self.turn_started_at = Some(self.now);
                    self.turn_chars = 0;
                    self.last_line = None;
                }
                self.running = true;
                self.phase = Phase::Waiting;
                self.status_line = None;
                out.pulse(PulseKind::Event, 1);
            }
            "agent_end" => {
                self.finish_turn(out);
                out.pulse(PulseKind::Event, 1);
            }
            "turn_start" => {
                self.turn_output = false;
                out.pulse(PulseKind::Event, 1);
            }
            "turn_end" => out.pulse(PulseKind::Event, 1),
            "message_start" | "message_update" | "message_end" => {
                let msg = ev.get("message").or_else(|| ev.get("assistantMessageEvent").and_then(|a| a.get("partial")));
                let Some(msg) = msg else { return };
                let fin = ty == "message_end";
                match s(msg, "role") {
                    Some("assistant") => {
                        if let Some(ame) = ev.get("assistantMessageEvent") {
                            self.phase = match s(ame, "type").unwrap_or("") {
                                t if t.starts_with("thinking") => Phase::Thinking,
                                t if t.starts_with("toolcall") => Phase::ToolArgs,
                                t if t.starts_with("text") => Phase::Text,
                                _ => self.phase,
                            };
                        }
                        self.assistant(msg, fin, out);
                        if fin {
                            self.last_stop = s(msg, "stopReason").map(str::to_owned);
                            self.last_error = non_empty(msg, "errorMessage").map(str::to_owned);
                        }
                    }
                    Some("toolResult") => {
                        if fin {
                            self.tool_result(msg, true, out);
                        }
                    }
                    Some(_) => {
                        if ty == "message_start" || fin {
                            self.user_message(msg, None, out);
                        }
                    }
                    None => {}
                }
            }
            "tool_execution_start" => self.tool_start(ev, out),
            "tool_execution_update" => self.tool_update(ev, out),
            "tool_execution_end" => {
                let call_id = s(ev, "toolCallId").unwrap_or("").to_owned();
                let name = s(ev, "toolName").unwrap_or("").to_owned();
                let result = ev.get("result").cloned().unwrap_or(Value::Null);
                self.tool_finish(&call_id, &name, &result, b(ev, "isError"), None, true, out);
            }
            "notice" => {
                let level = match s(ev, "level") {
                    Some("error") => NoticeLevel::Error,
                    Some("warning" | "warn") => NoticeLevel::Warn,
                    _ => NoticeLevel::Info,
                };
                let text = s(ev, "message").unwrap_or("").to_owned();
                let source = s(ev, "source").map(str::to_owned);
                // Presence churn (our own joins/leaves on every resync) is not transcript-worthy.
                let presence = source.as_deref() == Some("collab")
                    && (text.ends_with("joined the collab session")
                        || text.ends_with("joined the collab session (read-only)")
                        || text.ends_with("left the collab session"));
                if presence {
                    out.signals.push(Signal::Notice { level, text });
                } else {
                    self.notice(level, text, source, out);
                }
            }
            "auto_compaction_start" => {
                self.status_line = Some("Compacting context…".into());
                out.pulse(PulseKind::Event, 1);
            }
            "auto_compaction_end" => {
                self.status_line = None;
                if let Some(err) = non_empty(ev, "errorMessage") {
                    self.notice(NoticeLevel::Error, format!("Compaction failed: {err}"), Some("compaction".into()), out);
                }
            }
            "auto_retry_start" => self.retry_start(ev, out),
            "auto_retry_end" => self.retry_end(ev, out),
            "thinking_level_changed" => {
                if let Some(level) = s(ev, "thinkingLevel").and_then(parse_thinking) {
                    self.state.thinking_level = s(ev, "thinkingLevel").map(str::to_owned);
                    out.signals.push(Signal::ThinkingChanged { level });
                }
            }
            _ => out.pulse(PulseKind::Event, 1),
        }
    }

    fn finish_turn(&mut self, out: &mut Update) {
        let aborted = self.last_stop.as_deref() == Some("aborted");
        // Close anything still marked live.
        let streaming_ids: Vec<String> = self
            .order
            .iter()
            .filter(|id| match self.items.get(*id) {
                Some(TranscriptItem::Assistant(a)) => a.streaming,
                Some(TranscriptItem::Thinking(t)) => t.streaming,
                _ => false,
            })
            .cloned()
            .collect();
        for id in streaming_ids {
            if let Some(mut item) = self.items.get(&id).cloned() {
                finalize(&mut item);
                self.upsert(item, out);
            }
        }
        let open: Vec<String> = self
            .tools
            .iter()
            .filter(|(_, t)| !t.ended)
            .map(|(id, _)| id.clone())
            .collect();
        for call in open {
            let id = tool_id(&call);
            if let Some(TranscriptItem::Tool(mut t)) = self.items.get(&id).cloned() {
                if matches!(t.status, ToolStatus::Running | ToolStatus::Pending) {
                    t.status = if aborted { ToolStatus::Aborted } else { ToolStatus::Error };
                    if t.status == ToolStatus::Error && t.error.is_none() {
                        t.error = Some("tool did not complete".into());
                    }
                    self.upsert(TranscriptItem::Tool(t), out);
                }
            }
            if let Some(ts) = self.tools.get_mut(&call) {
                ts.ended = true;
            }
        }
        self.active_tools.clear();
        let was = self.running;
        self.turn_ended_at = Some(self.now);
        if let (true, Some(start)) = (was, self.turn_started_at) {
            let secs = (self.now - start) as f32 / 1000.0;
            if secs > 0.2 && self.turn_chars > 0 {
                self.turn_tps = Some(self.turn_chars as f32 / 4.0 / secs);
            }
        }
        self.running = false;
        // Nothing is being produced once the run is over. A bridge-served session reads omp's file
        // ahead of the live frames, so the next run's prompt can land between its `agent_start`
        // and `turn_start`: this run's output must not make that prompt a steer.
        self.turn_output = false;
        self.status_line = None;
        if was {
            let error = if aborted { None } else { self.last_error.clone().filter(|_| self.last_stop.as_deref() == Some("error")) };
            out.signals.push(Signal::TurnEnded { aborted, error });
        }
    }

    fn retry_start(&mut self, ev: &Value, out: &mut Update) {
        let attempt = u(ev, "attempt").unwrap_or(1) as u32;
        let max = u(ev, "maxAttempts").unwrap_or(0) as u32;
        let error = s(ev, "errorMessage").unwrap_or("").to_owned();
        let delay = f(ev, "delayMs").unwrap_or(0.0) / 1000.0;
        // The failed attempt's empty error row is superseded by the retry notice.
        let failed: Vec<String> = self
            .order
            .iter()
            .rev()
            .take(3)
            .filter(|id| matches!(self.items.get(*id), Some(TranscriptItem::Assistant(a)) if a.text.is_empty() && a.error.is_some()))
            .cloned()
            .collect();
        for id in failed {
            self.remove(&id, out);
        }
        let streak = match &self.retry {
            Some(r) if attempt > 1 => r.clone(),
            _ => {
                self.seq += 1;
                RetryStreak { id: format!("r{}.{}", self.epoch, self.seq), at: self.now }
            }
        };
        let text = format!("Retrying ({attempt}/{max}) in {delay:.1}s: {}", clip(&error, 160));
        self.status_line = Some(format!("Retrying ({attempt}/{max})…"));
        let item = TranscriptItem::Notice(NoticeItem {
            id: streak.id.clone(),
            at: streak.at,
            level: NoticeLevel::Warn,
            text,
            source: Some("retry".into()),
        });
        self.upsert(item, out);
        self.retry = Some(streak);
        out.signals.push(Signal::Retry { attempt, max, error });
    }

    fn retry_end(&mut self, ev: &Value, out: &mut Update) {
        self.status_line = None;
        let Some(streak) = self.retry.take() else { return };
        let attempt = u(ev, "attempt").unwrap_or(0);
        let (level, text) = if b(ev, "success") {
            (NoticeLevel::Info, format!("Recovered after {attempt} {}", if attempt == 1 { "retry" } else { "retries" }))
        } else {
            let err = s(ev, "finalError").unwrap_or("retries exhausted");
            (NoticeLevel::Error, format!("Gave up after {attempt} retries: {}", clip(err, 160)))
        };
        self.upsert(
            TranscriptItem::Notice(NoticeItem { id: streak.id, at: streak.at, level, text, source: Some("retry".into()) }),
            out,
        );
    }

    fn notice(&mut self, level: NoticeLevel, text: String, source: Option<String>, out: &mut Update) {
        self.seq += 1;
        let id = format!("n{}.{}", self.epoch, self.seq);
        out.signals.push(Signal::Notice { level, text: text.clone() });
        self.upsert(TranscriptItem::Notice(NoticeItem { id, at: self.now, level, text, source }), out);
    }

    // ── messages ───────────────────────────────────────────────────────

    fn msg_ts(&mut self, msg: &Value) -> Millis {
        ts(msg).unwrap_or(self.now)
    }

    /// Diff an assistant message (any of start/update/end/entry) into rows.
    fn assistant(&mut self, msg: &Value, fin: bool, out: &mut Update) {
        let t = self.msg_ts(msg);
        let content = arr(msg, "content");
        let mut state = self.msgs.remove(&t).unwrap_or_default();
        if state.blocks.len() < content.len() {
            state.blocks.resize(content.len(), None);
        }
        let model = s(msg, "model").map(str::to_owned);
        let usage = msg.get("usage").map(token_usage);
        let stop = s(msg, "stopReason").map(str::to_owned);
        let error = non_empty(msg, "errorMessage").map(str::to_owned);
        // omp stamps it when the message ended (omp ≥ 18.13): its tool calls start then.
        let completed_at = u(msg, "completedAt").map(|c| c as Millis);
        let last_live = content.len().saturating_sub(1);
        for (i, blk) in content.iter().enumerate() {
            let kind = s(blk, "type").unwrap_or("");
            match kind {
                "text" | "thinking" | "redactedThinking" => {
                    let id = format!("a{t}.{i}");
                    let text = match kind {
                        "text" => s(blk, "text").unwrap_or(""),
                        "thinking" => s(blk, "thinking").unwrap_or(""),
                        _ => "",
                    };
                    let bs = state.blocks[i].get_or_insert_with(|| BlockState { started: self.now, done: false });
                    let started = bs.started;
                    let block_done = fin || i < last_live;
                    let newly_done = block_done && !bs.done;
                    bs.done = block_done;
                    let streaming = !block_done;
                    // Providers open empty text blocks; a row appears with the first character.
                    if kind == "text" && text.is_empty() && !self.items.contains_key(&id) {
                        continue;
                    }
                    if kind == "text" && !text.is_empty() {
                        self.turn_output = true;
                        if let Some(frag) = last_sentence(text) {
                            self.last_line = Some(frag);
                        }
                    }
                    let item = if kind == "text" {
                        TranscriptItem::Assistant(AssistantItem {
                            id: id.clone(),
                            at: t,
                            text: text.to_owned(),
                            streaming,
                            model: if fin { model.clone() } else { None },
                            usage: if fin { usage.clone() } else { None },
                            stop_reason: if fin { stop.clone() } else { None },
                            error: if fin { error.clone() } else { None },
                        })
                    } else {
                        // Seen streaming before it finished: how long the model thought. Only the
                        // live stream shows that, so it is noted for rows rebuilt from the file.
                        if newly_done && self.emit && self.now > started {
                            self.note(&id, RowNote { thought_ms: Some((self.now - started) as u64), ..RowNote::default() }, out);
                        }
                        TranscriptItem::Thinking(ThinkingItem {
                            id: id.clone(),
                            at: t,
                            text: text.to_owned(),
                            streaming,
                            duration_ms: self.notes.get(&id).and_then(|n| n.thought_ms),
                            redacted: kind == "redactedThinking"
                                || (text.is_empty() && blk.get("thinkingSignature").is_some() && block_done),
                        })
                    };
                    self.stream_text(item, newly_done, out);
                }
                "toolCall" => {
                    let call_id = s(blk, "id").unwrap_or("").to_owned();
                    if call_id.is_empty() {
                        continue;
                    }
                    state.blocks[i].get_or_insert_with(|| BlockState { started: self.now, done: false });
                    self.turn_output = true;
                    self.tool_call_block(&call_id, blk, t, completed_at, fin || i < last_live, out);
                }
                _ => {}
            }
        }
        // Provider failures arrive as an assistant message without content. (An empty aborted
        // message is not an error: the interrupt notice covers it.)
        let aborted = stop.as_deref() == Some("aborted");
        if fin && content.is_empty() && !aborted && (error.is_some() || stop.as_deref() == Some("error")) {
            let item = TranscriptItem::Assistant(AssistantItem {
                id: format!("a{t}.0"),
                at: t,
                text: String::new(),
                streaming: false,
                model,
                usage,
                stop_reason: stop,
                error: error.or_else(|| Some("provider error".into())),
            });
            self.upsert(item, out);
        }
        state.done = fin;
        self.msgs.insert(t, state);
    }

    /// Upsert or append a text/thinking row, preferring `append` deltas.
    fn stream_text(&mut self, item: TranscriptItem, newly_done: bool, out: &mut Update) {
        let id = item.id().to_owned();
        let (new_text, field) = match &item {
            TranscriptItem::Assistant(a) => (a.text.as_str(), AppendField::Text),
            TranscriptItem::Thinking(t) => (t.text.as_str(), AppendField::Text),
            _ => return self.upsert(item, out),
        };
        let shown = match self.items.get(&id) {
            Some(TranscriptItem::Assistant(a)) => Some(a.text.as_str()),
            Some(TranscriptItem::Thinking(t)) => Some(t.text.as_str()),
            _ => None,
        };
        let pulse_kind = if matches!(item, TranscriptItem::Thinking(_)) { PulseKind::Thinking } else { PulseKind::Token };
        match shown {
            Some(shown) if !newly_done && new_text.len() > shown.len() && new_text.starts_with(shown) => {
                let delta = new_text[shown.len()..].to_owned();
                let n = delta.chars().count() as u32;
                self.rate.push_back((self.now, n));
                self.turn_chars += n as u64;
                while self.rate.front().is_some_and(|(t, _)| self.now - t > TPS_WINDOW_MS) {
                    self.rate.pop_front();
                }
                out.pulse(pulse_kind, (n / 16).max(1));
                match self.items.get_mut(&id) {
                    Some(TranscriptItem::Assistant(a)) => a.text.push_str(&delta),
                    Some(TranscriptItem::Thinking(t)) => t.text.push_str(&delta),
                    _ => {}
                }
                if self.emit {
                    out.events.push(SessionEvent::Append { id, field, text: delta, at: None });
                }
            }
            _ => {
                if shown.is_none() {
                    let n = new_text.chars().count() as u32;
                    if n > 0 {
                        self.rate.push_back((self.now, n));
                        if self.emit {
                            self.turn_chars += n as u64;
                        }
                        out.pulse(pulse_kind, (n / 16).max(1));
                    }
                }
                self.upsert(item, out);
            }
        }
    }

    fn user_message(&mut self, msg: &Value, entry_ts: Option<Millis>, out: &mut Update) {
        let role = s(msg, "role").unwrap_or("");
        let custom_type = s(msg, "customType");
        let t = entry_ts.or_else(|| ts(msg)).unwrap_or(self.now);
        let id = format!("u{t}");
        if custom_type == Some(IMAGE_ATTACHMENT) {
            self.attachment_source(id, msg, out);
            return;
        }
        if (role == "custom" || custom_type.is_some()) && msg.get("display").and_then(Value::as_bool) == Some(false) {
            return;
        }
        if let Some(message) = irc::incoming(role, custom_type, msg) {
            let is_new = !self.items.contains_key(&id);
            let (text, peer) = (message.text.clone(), message.peer.clone());
            self.upsert(TranscriptItem::Irc(IrcItem { id, at: t, message }), out);
            if is_new && self.emit {
                out.signals.push(Signal::Prompted { text, author: Some(format!("{peer} via IRC")) });
            }
            return;
        }
        let text = match custom_type {
            Some("advisor") => advisor_text(msg).unwrap_or_else(|| content_text(msg.get("content"))),
            _ => content_text(msg.get("content")),
        };
        let mut images = content_images(msg.get("content"));
        if let Some(full) = self.journal.images.get(&id) {
            fill_cut_images(&mut images, full);
        }
        if text.is_empty() && images.is_empty() {
            return;
        }
        if !images.is_empty() && !self.originals.contains_key(&id) {
            self.link_kept_originals(&id, text.trim(), &images, out);
        }
        if let Some(slots) = self.originals.get(&id) {
            apply_originals(&mut images, slots);
        }
        let is_new = !self.items.contains_key(&id);
        // Arrived while the agent was producing this turn's output: a steer. The session file
        // can't tell, so it is noted for rows rebuilt from it.
        if is_new && self.emit && self.running && self.turn_output {
            self.note(&id, RowNote { steering: true, ..RowNote::default() }, out);
        }
        let (mut author, synthetic) = match (role, custom_type) {
            (_, Some("collab-prompt")) => (msg.get("details").and_then(|d| non_empty(d, "from")).map(str::to_owned), false),
            (_, Some(other)) => (Some(other.to_owned()), true),
            ("developer", _) => (None, true),
            _ => (None, b(msg, "synthetic")),
        };
        if !synthetic {
            if let Some(a) = self.notes.get(&id).and_then(|n| n.author.clone()) {
                author = Some(a);
            } else if let Some(i) = self.expected_authors.iter().position(|(t, _)| t == text.trim()) {
                let (_, a) = self.expected_authors.remove(i).expect("position is in range");
                self.note(&id, RowNote { author: Some(a.clone()), ..RowNote::default() }, out);
                author = Some(a);
            }
        }
        if is_new && !synthetic && !self.queued_sent.is_empty() {
            // A snapshot replays old rows too: only one at or after the send can be the echo.
            let key = queue_key(&text);
            if let Some(i) = self.queued_sent.iter().position(|q| t + 5_000 >= q.at && queue_key(&q.text) == key) {
                self.queued_sent.remove(i);
            }
        }
        let steering = self.notes.get(&id).is_some_and(|n| n.steering);
        let item = TranscriptItem::User(UserItem { id, at: t, text: text.clone(), images, author: author.clone(), steering, synthetic });
        self.upsert(item, out);
        if is_new && self.emit {
            out.signals.push(Signal::Prompted { text, author });
        }
    }

    /// The echo of a prompt whose originals tf-hostd kept: link those its images don't already show.
    fn link_kept_originals(&mut self, id: &str, text: &str, images: &[ImageRef], out: &mut Update) {
        let Some(i) = self.expected_originals.iter().position(|(t, kept)| t == text && kept.len() == images.len()) else { return };
        let (_, kept) = self.expected_originals.remove(i).expect("position is in range");
        let slots: Vec<Option<String>> =
            images.iter().zip(kept).map(|(img, k)| (shown_sha256(img).as_deref() != Some(k.sha256.as_str())).then_some(k.path)).collect();
        if slots.iter().any(Option::is_some) {
            out.signals.push(Signal::OriginalsKept { id: id.to_owned(), originals: slots.clone() });
            self.originals.insert(id.to_owned(), slots);
        }
    }

    /// omp's hidden `image-attachment` companion of a TUI-pasted image: the pasted file is the
    /// original of image `details.index` (1-based) of the user row sharing its timestamp.
    fn attachment_source(&mut self, id: String, msg: &Value, out: &mut Update) {
        let Some(details) = msg.get("details") else { return };
        let (Some(index), Some(path)) = (u(details, "index"), non_empty(details, "path")) else { return };
        let Some(slot) = (index as usize).checked_sub(1).filter(|i| *i < 64) else { return };
        let slots = self.originals.entry(id.clone()).or_default();
        if slots.get(slot).is_some_and(|o| o.as_deref() == Some(path)) {
            return;
        }
        if slots.len() <= slot {
            slots.resize(slot + 1, None);
        }
        slots[slot] = Some(path.to_owned());
        let patched = match (self.items.get(&id), self.originals.get(&id)) {
            (Some(TranscriptItem::User(u)), Some(slots)) => {
                let mut item = u.clone();
                apply_originals(&mut item.images, slots).then_some(item)
            }
            _ => None,
        };
        if let Some(item) = patched {
            self.upsert(TranscriptItem::User(item), out);
        }
    }

    // ── tools ──────────────────────────────────────────────────────────

    /// A `toolCall` block of an assistant message (streaming, ended, or its entry). Complete, its
    /// arguments as the session file records them ([`tool_args`]) are the row's for good: that is
    /// what a rebuild from the file shows, whatever `tool_execution_start` carried.
    fn tool_call_block(&mut self, call_id: &str, blk: &Value, at: Millis, completed_at: Option<Millis>, args_done: bool, out: &mut Update) {
        let id = tool_id(call_id);
        let name = s(blk, "name").unwrap_or("").to_owned();
        let raw = blk.get("arguments").unwrap_or(&Value::Null);
        let intent = non_empty(blk, "intent").or_else(|| non_empty(raw, "i")).map(str::to_owned);
        let args = tool_args(raw);
        let state = self.tools.entry(call_id.to_owned()).or_insert_with(|| ToolState::new(&name));
        state.block = true;
        state.completed_at = completed_at.or(state.completed_at);
        match self.items.get(&id) {
            None => {
                let item = ToolItem {
                    id,
                    at,
                    call_id: call_id.to_owned(),
                    title: tools::title(&name, &args),
                    tool: name,
                    intent,
                    args,
                    status: ToolStatus::Pending,
                    duration_ms: None,
                    output: None,
                    truncated: false,
                    view: None,
                    error: None,
                };
                self.upsert(TranscriptItem::Tool(item), out);
            }
            Some(TranscriptItem::Tool(existing)) if args_done => {
                let mut t = existing.clone();
                if !name.is_empty() {
                    t.tool = name;
                }
                t.at = at;
                t.title = tools::title(&t.tool, &args);
                t.args = args;
                t.intent = intent;
                self.upsert(TranscriptItem::Tool(t), out);
            }
            _ => {}
        }
    }

    fn ensure_tool(&mut self, call_id: &str, name: &str, args: Option<&Value>, intent: Option<&str>) -> ToolItem {
        let id = tool_id(call_id);
        match self.items.get(&id) {
            Some(TranscriptItem::Tool(t)) => t.clone(),
            _ => {
                let args = args.map(tool_args).unwrap_or(Value::Null);
                ToolItem {
                    id,
                    at: self.now,
                    call_id: call_id.to_owned(),
                    title: tools::title(name, &args),
                    tool: name.to_owned(),
                    intent: intent.map(str::to_owned),
                    args,
                    status: ToolStatus::Pending,
                    duration_ms: None,
                    output: None,
                    truncated: false,
                    view: None,
                    error: None,
                }
            }
        }
    }

    fn tool_start(&mut self, ev: &Value, out: &mut Update) {
        let call_id = s(ev, "toolCallId").unwrap_or("").to_owned();
        let name = s(ev, "toolName").unwrap_or("").to_owned();
        let args = ev.get("args").filter(|a| !a.is_null());
        let intent = non_empty(ev, "intent");
        let mut t = self.ensure_tool(&call_id, &name, args, intent);
        // The event carries omp's validated copy of the arguments: it stands in only until the
        // call's own block lands (a join mid-call), as the file never records it.
        if !self.tools.get(&call_id).is_some_and(|st| st.block) {
            if let Some(a) = args {
                t.args = tool_args(a);
                t.title = tools::title(&name, &t.args);
            }
            if let Some(i) = intent {
                t.intent = Some(i.to_owned());
            }
        }
        t.status = ToolStatus::Running;
        t.view = tools::view(&name, &t.args, None, None);
        let label = tools::label(&name, &t.args, &t.title);
        let now = self.now;
        let state = self.tools.entry(call_id.clone()).or_insert_with(|| ToolState::new(&name));
        state.name.clone_from(&name);
        state.started = Some(now);
        state.ended = false;
        self.active_tools.retain(|(c, _)| c != &call_id);
        self.active_tools.push((call_id, ActiveTool { name, label, started_at: self.now }));
        self.turn_output = true;
        out.pulse(PulseKind::Tool, 1);
        self.upsert(TranscriptItem::Tool(t), out);
    }

    fn tool_update(&mut self, ev: &Value, out: &mut Update) {
        let call_id = s(ev, "toolCallId").unwrap_or("");
        let name = s(ev, "toolName").unwrap_or("").to_owned();
        let Some(partial) = ev.get("partialResult") else { return };
        out.pulse(PulseKind::Tool, 1);
        let id = tool_id(call_id);
        let Some(TranscriptItem::Tool(current)) = self.items.get(&id).cloned() else {
            let mut t = self.ensure_tool(call_id, &name, ev.get("args"), None);
            t.status = ToolStatus::Running;
            t.output = Some(cap_output(&content_text(partial.get("content"))).0);
            t.view = tools::view(&name, &t.args, Some(partial), None);
            return self.upsert(TranscriptItem::Tool(t), out);
        };
        let text = content_text(partial.get("content"));
        let shown = current.output.clone().unwrap_or_default();
        let new_view = tools::view(&name, &current.args, Some(partial), None);
        let view_changed = new_view.is_some() && new_view != current.view && !tools::streams_output(&name);
        if !view_changed && text.len() > shown.len() && text.starts_with(&shown) && text.len() <= OUTPUT_CAP {
            let delta = text[shown.len()..].to_owned();
            if let Some(TranscriptItem::Tool(t)) = self.items.get_mut(&id) {
                t.output = Some(text.clone());
            }
            if self.emit {
                out.events.push(SessionEvent::Append { id, field: AppendField::Output, text: delta, at: None });
            }
        } else if view_changed || text != shown {
            let mut t = current;
            let (o, trunc) = cap_output(&text);
            t.output = Some(o);
            t.truncated = trunc;
            if new_view.is_some() {
                t.view = new_view;
            }
            self.upsert(TranscriptItem::Tool(t), out);
        }
    }

    /// A call's result: `tool_execution_end` (`ended_at` none: its result message follows), or
    /// its result message (`ended_at`: the message's timestamp), live or as an entry. With the
    /// message the row is exactly what a rebuild from the file shows. `effects`: also fold the
    /// result into meta and liveness (not when an entry only settles a row its events finished).
    #[expect(clippy::too_many_arguments, reason = "the end event and the result message each supply these from their own fields")]
    fn tool_finish(&mut self, call_id: &str, name: &str, result: &Value, is_error: bool, ended_at: Option<Millis>, effects: bool, out: &mut Update) {
        let name = if name.is_empty() { self.tools.get(call_id).map(|t| t.name.clone()).unwrap_or_default() } else { name.to_owned() };
        let mut t = self.ensure_tool(call_id, &name, None, None);
        let text = content_text(result.get("content"));
        let details = result.get("details");
        let (o, trunc) = cap_output(&text);
        let already_final = matches!(t.status, ToolStatus::Ok | ToolStatus::Error | ToolStatus::Aborted | ToolStatus::Denied);
        t.status = tools::status(&name, &text, details, is_error);
        t.output = (!o.is_empty()).then_some(o);
        t.truncated = trunc;
        t.view = tools::view(&name, &t.args, Some(result), Some(is_error));
        t.error = is_error.then(|| clip(first_line(&text), 300)).filter(|e| !e.is_empty());
        // From omp's own records, so a rebuild finds the same: the tool's wall time (bash), else
        // from the call's start (its message ended) to its result. Until that result lands, what
        // the live events measured.
        let state = self.tools.get(call_id);
        let start = state.and_then(|st| st.completed_at).unwrap_or(t.at);
        let measured = state.and_then(|st| st.started).map(|st| (self.now - st).max(0) as u64);
        t.duration_ms = details
            .and_then(|d| f(d, "wallTimeMs"))
            .map(|ms| ms as u64)
            .or_else(|| ended_at.map(|end| (end - start).max(0) as u64))
            .or(measured)
            .or(t.duration_ms);
        if effects {
            if let Some(phases) = tools::todo_phases(&name, details) {
                self.meta.todos = phases;
                if self.emit {
                    self.journal.todo_edit = None;
                }
            }
            if !is_error {
                self.record_file_edits(call_id, t.view.as_ref());
            }
            self.active_tools.retain(|(c, _)| c != call_id);
            out.pulse(PulseKind::Tool, 1);
            if is_error && !already_final && self.emit && t.status == ToolStatus::Error {
                out.signals.push(Signal::ToolError { tool: name.clone(), error: t.error.clone().unwrap_or_default() });
            }
        }
        self.tools.entry(call_id.to_owned()).or_insert_with(|| ToolState::new(&name)).ended = true;
        self.upsert(TranscriptItem::Tool(t), out);
    }

    /// Folds a diff view into `SessionMeta.files` (paths relative to the session cwd).
    fn record_file_edits(&mut self, call_id: &str, view: Option<&tf_proto::ToolView>) {
        let Some(tf_proto::ToolView::Diff(d)) = view else { return };
        // `meta.cwd` is only refreshed after a snapshot replay, so read the source directly.
        let cwd = self.session_cwd().map(|c| format!("{}/", c.trim_end_matches('/')));
        let files: Vec<ChangedFile> = d
            .files
            .iter()
            .map(|f| ChangedFile {
                path: cwd.as_deref().and_then(|c| f.path.strip_prefix(c)).unwrap_or(&f.path).to_owned(),
                added: f.added,
                removed: f.removed,
                status: f.status,
                old_path: None,
            })
            .collect();
        match self.file_edits.iter_mut().find(|(c, _)| c == call_id) {
            Some(e) => e.1 = files,
            None => self.file_edits.push((call_id.to_owned(), files)),
        }
        let mut agg: Vec<ChangedFile> = Vec::new();
        for f in self.file_edits.iter().flat_map(|(_, fs)| fs) {
            match agg.iter_mut().find(|a| a.path == f.path) {
                Some(a) => {
                    a.added += f.added;
                    a.removed += f.removed;
                    if f.status == FileStatus::Deleted {
                        a.status = FileStatus::Deleted;
                    }
                }
                None => agg.push(f.clone()),
            }
        }
        self.meta.files = agg;
    }

    fn tool_result(&mut self, msg: &Value, effects: bool, out: &mut Update) {
        let call_id = s(msg, "toolCallId").unwrap_or("").to_owned();
        if call_id.is_empty() {
            return;
        }
        let name = s(msg, "toolName").unwrap_or("").to_owned();
        let result = serde_json::json!({"content": msg.get("content").cloned().unwrap_or(Value::Null), "details": msg.get("details").cloned().unwrap_or(Value::Null)});
        let ended_at = ts(msg);
        if !self.emit
            && let Some(end) = ended_at
        {
            // A snapshot's clock follows the file.
            self.now = end;
        }
        self.tool_finish(&call_id, &name, &result, b(msg, "isError"), ended_at, effects, out);
    }

    /// Which tool call a ui-request belongs to (ask tool / approval).
    fn call_for_request(&self, req: &UiRequestFrame) -> Option<String> {
        let title = req.title();
        if let Some(rest) = title.strip_prefix("Allow tool: ") {
            let tool = first_line(rest);
            return self
                .active_tools
                .iter()
                .rev()
                .find(|(c, a)| a.name == tool || self.tools.get(c).is_some_and(|t| t.name == tool))
                .map(|(c, _)| c.clone())
                .or_else(|| self.open_tool_named(tool));
        }
        let q = title.strip_prefix("Custom answer: ").unwrap_or(title);
        self.order.iter().rev().take(40).find_map(|id| match self.items.get(id) {
            Some(TranscriptItem::Tool(t))
                if t.tool == "ask"
                    && matches!(t.status, ToolStatus::Pending | ToolStatus::Running)
                    && arr(&t.args, "questions").iter().any(|qq| s(qq, "question") == Some(q)) =>
            {
                Some(t.call_id.clone())
            }
            _ => None,
        })
    }

    fn open_tool_named(&self, tool: &str) -> Option<String> {
        self.order.iter().rev().take(40).find_map(|id| match self.items.get(id) {
            Some(TranscriptItem::Tool(t)) if t.tool == tool && matches!(t.status, ToolStatus::Pending | ToolStatus::Running) => {
                Some(t.call_id.clone())
            }
            _ => None,
        })
    }

    // ── entries ────────────────────────────────────────────────────────

    fn entry(&mut self, entry: &Value, out: &mut Update) {
        let entry_id = s(entry, "id").unwrap_or("").to_owned();
        let at = ts(entry).unwrap_or(self.now);
        match s(entry, "type").unwrap_or("") {
            "message" => {
                let Some(msg) = entry.get("message") else { return };
                match s(msg, "role") {
                    Some("assistant") => {
                        if self.emit {
                            // Live: the row already streamed; reconcile only.
                            self.assistant(msg, true, out);
                        } else {
                            self.now = ts(msg).unwrap_or(at);
                            self.assistant(msg, true, out);
                        }
                        self.count_cost(&entry_id, msg);
                    }
                    Some("toolResult") => {
                        // Live, the call's events already finished it: the entry only settles the
                        // row as the file keeps it (what a rebuild shows); meta took the result then.
                        let settled = self.emit && self.tools.get(s(msg, "toolCallId").unwrap_or("")).is_some_and(|t| t.ended);
                        self.tool_result(msg, !settled, out);
                        if s(msg, "toolName") == Some("task") {
                            self.count_task_cost(&entry_id, msg);
                        }
                    }
                    Some(_) => self.user_message(msg, None, out),
                    None => {}
                }
            }
            "custom_message" => self.user_message(entry, Some(at), out),
            "model_change" => {
                let model = s(entry, "model").unwrap_or("").to_owned();
                self.upsert(TranscriptItem::Mode(ModeItem { id: format!("m{entry_id}"), at, text: format!("Model: {model}") }), out);
                if self.emit {
                    if let Some((provider, id)) = model.split_once('/') {
                        let r = ModelRef { provider: provider.into(), id: id.into(), label: None };
                        out.signals.push(Signal::ModelChanged { model: r });
                    }
                }
            }
            "thinking_level_change" => {
                let level = s(entry, "thinkingLevel").unwrap_or("off");
                self.upsert(TranscriptItem::Mode(ModeItem { id: format!("m{entry_id}"), at, text: format!("Thinking: {level}") }), out);
            }
            "compaction" => {
                let tokens_before = u(entry, "tokensBefore");
                let summary = non_empty(entry, "shortSummary").or_else(|| s(entry, "summary")).unwrap_or("").to_owned();
                self.upsert(TranscriptItem::Compaction(CompactionItem { id: format!("c{entry_id}"), at, summary, tokens_before }), out);
                if self.emit {
                    out.signals.push(Signal::Compacted { tokens_before });
                }
            }
            "branch_summary" => {
                let summary = s(entry, "summary").unwrap_or("").to_owned();
                self.upsert(TranscriptItem::Compaction(CompactionItem { id: format!("c{entry_id}"), at, summary, tokens_before: None }), out);
            }
            "mode_change" | "custom" => {
                self.journal_entry(entry);
            }
            _ => {}
        }
    }

    // ── journal (entries collab does not mirror) ───────────────────────

    /// The main agent's id (`AgentSnapshot.kind == "main"`, usually `Main`): pass it to
    /// [`crate::Guest::fetch_transcript`] to read the session journal.
    pub fn main_agent_id(&self) -> Option<&str> {
        self.subs.values().filter_map(|s| s.snapshot.as_ref()).find(|a| a.kind == "main").map(|a| a.id.as_str())
    }

    /// Byte offset of the main session journal read so far (`from_byte` for the next fetch).
    pub fn journal_offset(&self) -> u64 {
        self.journal.offset
    }

    /// Ingest a slice of the main session's JSONL journal (a `fetch_transcript(main, journal_offset())`
    /// reply). omp's collab host mirrors neither `mode_change`, `custom` nor `model_usage` entries,
    /// so goal and plan mode (`meta.goal`, `meta.mode`), user `/todo` edits and the main agent's
    /// side-call spend come from here. Keep fetching while the reply's text is non-empty (replies
    /// are capped at 4 MiB).
    pub fn apply_journal(&mut self, chunk: &crate::guest::TranscriptChunk) -> Update {
        if chunk.error.is_some() {
            return Update::default();
        }
        let entries: Vec<Value> = chunk.text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect();
        self.apply_journal_entries(&entries, chunk.new_size)
    }

    /// [`Self::apply_journal`] for entries already parsed (tf-hostd reads the session file itself
    /// for bridge-backed sessions). `new_size` is the journal offset after them; one below the
    /// current offset means the file was replaced, and the journal state starts over. Entries the
    /// journal does not cover (assistant turns, tool results, …) are skipped.
    pub fn apply_journal_entries(&mut self, entries: &[Value], new_size: u64) -> Update {
        let mut out = Update::default();
        let before = self.meta.clone();
        if new_size < self.journal.offset {
            // File replaced/truncated: the slice starts over.
            self.journal = Journal { offset: 0, ..Journal::default() };
        }
        for entry in entries {
            match s(entry, "type") {
                Some("mode_change" | "custom") => self.journal_entry(entry),
                // Side calls billed to the main agent (omp `entryUsage`); collab never mirrors them.
                Some("model_usage") => {
                    if let Some(usage) = entry.get("usage") {
                        self.journal.side.add_usage(usage);
                    }
                }
                // Same timestamps as `entry` uses for the row id.
                Some("custom_message") if s(entry, "customType") == Some(IMAGE_ATTACHMENT) => {
                    if let Some(t) = ts(entry) {
                        self.attachment_source(format!("u{t}"), entry, &mut out);
                    }
                }
                Some("custom_message") => self.journal_images(entry, ts(entry), &mut out),
                Some("message") => {
                    if let Some(msg) = entry.get("message").filter(|m| !matches!(s(m, "role"), Some("assistant" | "toolResult"))) {
                        self.journal_images(msg, None, &mut out);
                    }
                }
                _ => {}
            }
        }
        self.journal.offset = new_size;
        self.meta.cost = self.usage();
        if self.meta != before {
            out.meta_changed = true;
            out.events.push(SessionEvent::Meta { meta: self.meta.clone() });
        }
        out
    }

    /// Forgets what the journal said (goal, plan mode, todo edits, side-call spend, user images),
    /// before tf-hostd re-reads a session file from its start. The rows and meta stay until the
    /// re-read replaces them.
    pub fn reset_journal(&mut self) {
        self.journal = Journal::default();
    }

    /// The transcript file of agent `id` (a subagent): from TeleFlock's bridge roster, else from
    /// omp's lifecycle frames.
    pub fn agent_session_file(&self, id: &str) -> Option<&str> {
        let sub = self.subs.get(id)?;
        sub.snapshot.as_ref().and_then(|a| a.session_file.as_deref()).or(sub.session_file.as_deref()).filter(|f| !f.is_empty())
    }

    fn journal_entry(&mut self, entry: &Value) {
        match s(entry, "type") {
            Some("mode_change") => {
                let mode = s(entry, "mode").unwrap_or("none");
                let data = entry.get("data");
                self.journal.mode = match mode {
                    "plan" => OmpMode::Plan,
                    "plan_paused" => OmpMode::PlanPaused,
                    _ => OmpMode::Normal,
                };
                self.journal.goal = match mode {
                    "goal" | "goal_paused" => data.and_then(|d| d.get("goal")).and_then(|g| goal_info(g, mode == "goal_paused")),
                    _ => None,
                };
            }
            Some("custom") => match s(entry, "customType") {
                Some("goal-completed") => self.journal.goal = None,
                Some("user_todo_edit") => {
                    if let Some(phases) = tools::todo_phases("todo", entry.get("data")) {
                        self.journal.todo_edit = Some(phases);
                    }
                }
                _ => return,
            },
            _ => return,
        }
        self.meta.goal = self.journal.goal.clone();
        self.meta.mode = self.journal.mode;
        if let Some(t) = &self.journal.todo_edit {
            self.meta.todos = t.clone();
        }
    }

    /// A journal user row: remember its blobs and fill in a transcript row whose payloads collab cut.
    fn journal_images(&mut self, msg: &Value, entry_ts: Option<Millis>, out: &mut Update) {
        let Some(t) = entry_ts.or_else(|| ts(msg)) else { return };
        let full = content_images(msg.get("content"));
        if !full.iter().any(|i| i.blob.is_some()) {
            return;
        }
        let id = format!("u{t}");
        if let Some(TranscriptItem::User(u)) = self.items.get(&id) {
            let mut item = u.clone();
            if fill_cut_images(&mut item.images, &full) {
                self.upsert(TranscriptItem::User(item), out);
            }
        }
        self.journal.images.insert(id, full);
    }

    fn count_cost(&mut self, entry_id: &str, msg: &Value) {
        if entry_id.is_empty() || !self.counted.insert(entry_id.to_owned()) {
            return;
        }
        let Some(usage) = msg.get("usage") else { return };
        self.main_spend.get_or_insert_default().add_usage(usage);
    }

    /// A completed `task` result carries its children's spend (`details.usage`; absent for async
    /// spawns, whose children only show up in the artifact tree and `progress`).
    fn count_task_cost(&mut self, entry_id: &str, msg: &Value) {
        let Some(usage) = msg.get("details").and_then(|d| d.get("usage")).filter(|u| u.is_object()) else { return };
        if entry_id.is_empty() || !self.counted.insert(entry_id.to_owned()) {
            return;
        }
        self.task_spend.add_usage(usage);
    }

    // ── subagents ──────────────────────────────────────────────────────

    fn bus(&mut self, channel: &str, data: &Value) {
        match channel {
            "task:subagent:progress" => {
                let Some(progress) = data.get("progress") else { return };
                let Some(id) = s(progress, "id") else { return };
                let sub = self.subs.entry(id.to_owned()).or_default();
                sub.progress = Some(progress.clone());
                sub.description = non_empty(data, "assignment").or_else(|| non_empty(progress, "description")).map(str::to_owned);
                sub.parent_tool = s(data, "parentToolCallId").map(str::to_owned);
            }
            "task:subagent:lifecycle" => {
                let Some(id) = s(data, "id") else { return };
                let sub = self.subs.entry(id.to_owned()).or_default();
                sub.lifecycle = s(data, "status").map(str::to_owned);
                if sub.description.is_none() {
                    sub.description = non_empty(data, "description").map(str::to_owned);
                }
                sub.parent_tool = s(data, "parentToolCallId").map(str::to_owned).or(sub.parent_tool.take());
                if let Some(file) = non_empty(data, "sessionFile") {
                    sub.session_file = Some(file.to_owned());
                }
            }
            _ => {}
        }
    }

    fn subagents(&self) -> Vec<Subagent> {
        self.subs
            .iter()
            .filter(|(_, s)| s.snapshot.as_ref().is_none_or(|a| a.kind != "main"))
            .map(|(id, st)| subagent_view(id, st))
            .collect()
    }

    // ── meta ───────────────────────────────────────────────────────────

    /// Session working directory: live state first, then the session header.
    fn session_cwd(&self) -> Option<String> {
        (!self.state.cwd.is_empty()).then(|| self.state.cwd.clone()).or_else(|| self.header.as_ref().map(|h| h.cwd.clone()))
    }

    fn refresh_meta(&mut self) {
        let cwd = self.session_cwd();
        let subagents = self.subagents();
        let cost = self.usage();
        let st = &self.state;
        let m = &mut self.meta;
        m.session_id = self.header.as_ref().map(|h| h.id.clone()).filter(|s| !s.is_empty());
        m.title = st.session_name.clone().or_else(|| self.header.as_ref().and_then(|h| h.title.clone()));
        m.cwd = cwd;
        m.model = st.model.as_ref().and_then(|mv| {
            Some(ModelRef {
                provider: s(mv, "provider")?.to_owned(),
                id: s(mv, "id")?.to_owned(),
                label: s(mv, "name").map(str::to_owned),
            })
        });
        m.thinking = st.thinking_level.as_deref().and_then(parse_thinking);
        m.context = st.context_usage.as_ref().and_then(|c| {
            let window = c.context_window.or_else(|| st.model.as_ref().and_then(|mv| f(mv, "contextWindow")))?;
            let tokens = c.tokens?;
            let pct = c.percent.unwrap_or(if window > 0.0 { tokens / window * 100.0 } else { 0.0 });
            Some(ContextUsage { tokens: tokens as u64, window: window as u64, pct: pct as f32 })
        });
        m.cost = cost;
        // Average of the main agent's last finished turn; the live rate is in `Liveness.tps`.
        m.tps = self.turn_tps;
        m.subagents = subagents;
        m.started_at = self.header.as_ref().and_then(|h| util::parse_rfc3339(&h.timestamp));
        let w = !self.read_only && !self.ended;
        m.caps = Capabilities {
            prompt: w,
            steer: w,
            follow_up: false,
            abort: w,
            answer: w,
            model: false,
            thinking: false,
            fast: false,
            plan: false,
            goal: false,
            compact: false,
            rename: false,
            fork: false,
            branch: false,
            tree: false,
            btw: false,
            export: false,
            handoff: false,
            subagents: w,
            bridge: false,
        };
        // omp idle with nothing queued: what we listed was delivered, aborted or dropped.
        if self.ended || (!self.running && !st.is_streaming && st.queued_message_count == 0) {
            self.queued_sent.clear();
        }
        let listed = |follow_up: bool| self.queued_sent.iter().filter(|q| q.follow_up == follow_up).map(|q| q.text.clone()).collect();
        m.queue = QueueInfo { steering: listed(false), follow_up: listed(true) };
    }

    // ── row store ──────────────────────────────────────────────────────

    fn upsert(&mut self, item: TranscriptItem, out: &mut Update) {
        let id = item.id().to_owned();
        match self.items.get(&id) {
            Some(existing) if *existing == item => return,
            Some(_) => {}
            None => self.order.push(id.clone()),
        }
        if self.emit {
            out.events.push(SessionEvent::Upsert { item: item.clone(), h: None });
        }
        self.items.insert(id, item);
    }

    fn remove(&mut self, id: &str, out: &mut Update) {
        if self.items.remove(id).is_some() {
            self.order.retain(|x| x != id);
            if self.emit {
                out.events.push(SessionEvent::Remove { id: id.to_owned() });
            }
        }
    }
}

/// Images collab cut (no payload, url or blob left) take the journal's copy of the same row
/// (keeping their `original`). Returns whether anything changed.
fn fill_cut_images(images: &mut [ImageRef], full: &[ImageRef]) -> bool {
    if images.len() != full.len() {
        return false;
    }
    let mut changed = false;
    for (img, j) in images.iter_mut().zip(full) {
        if img.data.is_none() && img.url.is_none() && img.blob.is_none() && j.blob.is_some() {
            *img = ImageRef { original: img.original.take(), ..j.clone() };
            changed = true;
        }
    }
    changed
}

/// Sets each image's `original` from its slot. Returns whether anything changed.
fn apply_originals(images: &mut [ImageRef], originals: &[Option<String>]) -> bool {
    let mut changed = false;
    for (img, original) in images.iter_mut().zip(originals) {
        if original.is_some() && img.original != *original {
            img.original = original.clone();
            changed = true;
        }
    }
    changed
}

fn out_now(now: Millis, snap: &Snapshot) -> Millis {
    if now != 0 {
        return now;
    }
    util::parse_rfc3339(&snap.welcome.header.timestamp).unwrap_or(0)
}

fn tool_id(call_id: &str) -> String {
    format!("t:{call_id}")
}

/// A call's arguments as its row shows them: the recorded `toolCall` arguments without omp's
/// intent field (`i`, shown as the row's `intent`) and without null members (strict-schema
/// providers send every optional field, as null; omp drops them before the tool runs, which is
/// the copy `tool_execution_start` carries).
fn tool_args(raw: &Value) -> Value {
    fn strip(v: &Value) -> Value {
        match v {
            Value::Object(map) => Value::Object(map.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), strip(v))).collect()),
            Value::Array(items) => Value::Array(items.iter().map(strip).collect()),
            other => other.clone(),
        }
    }
    let mut args = strip(raw);
    if let Value::Object(map) = &mut args {
        map.remove("i");
    }
    args
}

fn finalize(item: &mut TranscriptItem) {
    match item {
        TranscriptItem::Assistant(a) => a.streaming = false,
        TranscriptItem::Thinking(t) => t.streaming = false,
        _ => {}
    }
}

fn cap_output(text: &str) -> (String, bool) {
    if text.len() <= OUTPUT_CAP {
        return (text.to_owned(), false);
    }
    let cut = text.len() - OUTPUT_CAP;
    let mut i = cut;
    while !text.is_char_boundary(i) {
        i += 1;
    }
    (text[i..].to_owned(), true)
}

fn token_usage(u_: &Value) -> TokenUsage {
    TokenUsage {
        input: u(u_, "input").unwrap_or(0),
        output: u(u_, "output").unwrap_or(0),
        cache_read: u(u_, "cacheRead").unwrap_or(0),
        cache_write: u(u_, "cacheWrite").unwrap_or(0),
        cost_usd: u_.get("cost").and_then(|c| f(c, "total")).unwrap_or(0.0),
    }
}

pub(crate) fn parse_thinking(level: &str) -> Option<ThinkingLevel> {
    Some(match level {
        "off" | "none" => ThinkingLevel::Off,
        "minimal" => ThinkingLevel::Minimal,
        "low" => ThinkingLevel::Low,
        "medium" | "med" => ThinkingLevel::Medium,
        "high" => ThinkingLevel::High,
        "xhigh" => ThinkingLevel::Xhigh,
        "max" => ThinkingLevel::Max,
        "auto" => ThinkingLevel::Auto,
        _ => return None,
    })
}

/// omp advisor notes (`customType: "advisor"`) carry the readable notes in `details.notes`;
/// `content` is the `<advisory …>` envelope meant for the model.
fn advisor_text(msg: &Value) -> Option<String> {
    let notes: Vec<String> = arr(msg.get("details")?, "notes")
        .iter()
        .filter_map(|n| {
            let note = non_empty(n, "note")?;
            Some(match non_empty(n, "severity") {
                Some(sev) => format!("{sev}: {note}"),
                None => note.to_owned(),
            })
        })
        .collect();
    (!notes.is_empty()).then(|| notes.join("\n"))
}

/// Last sentence fragment of streamed text, ≤ 80 chars, for `Liveness.line`.
fn last_sentence(text: &str) -> Option<String> {
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    let line = trimmed.lines().rev().map(str::trim).find(|l| !l.is_empty())?;
    // A sentence ends at `.`/`!`/`?` followed by whitespace, so `README.md` or `v1.2` stay whole.
    let mut cut = 0;
    let mut prev: Option<(usize, char)> = None;
    for (i, c) in line.char_indices() {
        if c.is_whitespace()
            && let Some((pi, pc)) = prev
            && matches!(pc, '.' | '!' | '?')
        {
            cut = pi + pc.len_utf8();
        }
        prev = Some((i, c));
    }
    let frag = line[cut..].trim();
    let frag = if frag.is_empty() { line } else { frag };
    let n = frag.chars().count();
    Some(if n > 80 { format!("…{}", frag.chars().skip(n - 79).collect::<String>()) } else { frag.to_owned() })
}

/// Drop provider-error assistant entries (empty content) that a later assistant message superseded
/// before the next user turn: omp's auto-retry keeps them in the log.
fn supersede_retried(entries: &[Value]) -> Vec<&Value> {
    let is_error_only = |e: &Value| {
        let m = e.get("message");
        s(e, "type") == Some("message")
            && m.and_then(|m| s(m, "role")) == Some("assistant")
            && m.is_some_and(|m| arr(m, "content").is_empty() && s(m, "stopReason") == Some("error"))
    };
    let mut out = Vec::with_capacity(entries.len());
    for (i, e) in entries.iter().enumerate() {
        if is_error_only(e) {
            let superseded = entries[i + 1..]
                .iter()
                .take_while(|n| {
                    let role = n.get("message").and_then(|m| s(m, "role"));
                    s(n, "type") != Some("custom_message") && !matches!(role, Some("user" | "developer"))
                })
                .any(|n| n.get("message").and_then(|m| s(m, "role")) == Some("assistant"));
            if superseded {
                continue;
            }
        }
        out.push(e);
    }
    out
}

fn subagent_view(id: &str, st: &SubState) -> Subagent {
    let p = st.progress.as_ref();
    let snap = st.snapshot.as_ref();
    let status = match (st.lifecycle.as_deref(), p.and_then(|p| s(p, "status")), snap.map(|a| a.status.as_str())) {
        (_, _, Some("parked")) => SubagentStatus::Parked,
        (Some("failed"), ..) | (_, Some("failed"), _) => SubagentStatus::Failed,
        (Some("aborted"), ..) | (_, Some("aborted"), _) | (_, _, Some("aborted")) => SubagentStatus::Aborted,
        (Some("completed"), ..) | (_, Some("completed"), _) => SubagentStatus::Done,
        (_, _, Some("idle")) => SubagentStatus::Done,
        _ => SubagentStatus::Running,
    };
    let line = p.and_then(|p| {
        non_empty(p, "currentToolIntent")
            .or_else(|| non_empty(p, "lastIntent"))
            .map(str::to_owned)
            .or_else(|| non_empty(p, "currentTool").map(|t| format!("{t} {}", s(p, "currentToolArgs").unwrap_or("")).trim().to_owned()))
            .or_else(|| arr(p, "recentOutput").last().and_then(Value::as_str).map(|o| clip(o, 120)))
    });
    let started = snap.map(|a| a.created_at).filter(|t| *t > 0);
    // A finished run ends where omp's own measure of it says (`durationMs`, final with its last
    // progress; omp's TUI shows the same): the roster's `lastActivity` moves when omp parks the
    // idle agent minutes later (a 2 s run would read 7:02). It also comes back the same from the
    // bridge's resync, so a rebuilt replica shows what the live one did. Without progress (an
    // agent omp restored from disk), its last activity is when its transcript was last written.
    let ran = p.and_then(|p| f(p, "durationMs")).filter(|d| d.is_finite() && *d > 0.0).map(|d| d.round() as Millis);
    let ended = match status {
        SubagentStatus::Running => None,
        _ => started.zip(ran).map(|(at, ms)| at + ms).or_else(|| snap.map(|a| a.last_activity).filter(|t| *t > 0)),
    };
    Subagent {
        id: id.to_owned(),
        name: snap
            .map(|a| a.id.clone())
            .unwrap_or_else(|| id.to_owned()),
        description: st.description.clone(),
        status,
        started_at: started,
        ended_at: ended,
        cost_usd: p.and_then(|p| f(p, "cost")),
        tokens: p.and_then(|p| u(p, "tokens")),
        model: p.and_then(|p| non_empty(p, "resolvedModel")).map(str::to_owned),
        line,
        completion_pct: p.and_then(|p| tools::completion_pct(p, status)),
        context: p.and_then(tools::subagent_context),
        tool_count: p.and_then(|p| u(p, "toolCount")).map(|n| n as u32),
        parent_id: snap.and_then(|a| a.parent_id.clone()).or_else(|| st.parent_tool.clone()),
    }
}

/// A new replica lifetime ([`Replica`]'s `epoch`): microseconds since the Unix epoch in base 36,
/// strictly increasing within the process. A tf-hostd restart takes far longer than a
/// microsecond per replica the previous process created, so a later process never repeats one.
fn new_epoch() -> String {
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_micros() as u64);
    let mut last = LAST.load(Ordering::Relaxed);
    let mut v = loop {
        let next = now.max(last + 1);
        match LAST.compare_exchange_weak(last, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break next,
            Err(seen) => last = seen,
        }
    };
    let mut digits = Vec::new();
    loop {
        digits.push(char::from_digit((v % 36) as u32, 36).expect("a base-36 digit"));
        v /= 36;
        if v == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

fn empty_meta() -> SessionMeta {
    SessionMeta {
        session_id: None,
        session_file: None,
        title: None,
        cwd: None,
        model: None,
        thinking: None,
        fast: false,
        mode: OmpMode::Normal,
        goal: None,
        context: None,
        cost: None,
        tps: None,
        todos: Vec::<TodoPhase>::new(),
        subagents: Vec::new(),
        files: Vec::new(),
        queue: QueueInfo { steering: Vec::new(), follow_up: Vec::new() },
        tree: None,
        caps: Capabilities {
            prompt: false,
            steer: false,
            follow_up: false,
            abort: false,
            answer: false,
            model: false,
            thinking: false,
            fast: false,
            plan: false,
            goal: false,
            compact: false,
            rename: false,
            fork: false,
            branch: false,
            tree: false,
            btw: false,
            export: false,
            handoff: false,
            subagents: false,
            bridge: false,
        },
        started_at: None,
    }
}

/// Render a subagent transcript (JSONL session file slice from `fetch-transcript`) with the same
/// row mapping as the live replica. Unknown / header lines are skipped.
pub fn transcript_page(jsonl: &str) -> HistoryPage {
    let mut r = Replica::new("");
    r.emit = false;
    let entries: Vec<Value> = jsonl.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect();
    for e in supersede_retried(&entries) {
        r.entry(e, &mut Update::default());
    }
    for id in &r.order {
        if let Some(item) = r.items.get_mut(id) {
            finalize(item);
        }
    }
    HistoryPage {
        items: r.order.iter().filter_map(|id| r.items.get(id).cloned()).collect(),
        has_more: false,
        cursor: None,
    }
}

#[cfg(test)]
mod golden;

#[cfg(test)]
mod sentence_tests {
    use super::last_sentence;

    #[test]
    fn last_sentence_keeps_dotted_words() {
        assert_eq!(
            last_sentence("README.md describes this repo.").as_deref(),
            Some("README.md describes this repo.")
        );
        assert_eq!(last_sentence("Done. Bumped to v1.2 now").as_deref(), Some("Bumped to v1.2 now"));
        assert_eq!(last_sentence("First! Second?").as_deref(), Some("Second?"));
    }
}
