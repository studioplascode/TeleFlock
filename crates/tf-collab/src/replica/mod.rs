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
//! **Ids** are stable across snapshot and live frames: user `u<ts>`, assistant/thinking blocks
//! `a<ts>.<block>`, tools `t:<toolCallId>`, model/thinking markers `m<entryId>`, compaction
//! `c<entryId>`, notices `n<seq>`, retry streaks `r<seq>`.

mod tools;
mod ui;
mod util;

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use serde_json::Value;
use tf_proto::{
    ActiveTool, AppendField, AssistantItem, Capabilities, ChangedFile, CompactionItem, ContextUsage, CostInfo, FileStatus, HistoryPage,
    Liveness, Millis, ModeItem, ModelRef, NeedsYou, NoticeItem, NoticeLevel, OmpMode, PulseKind, QueueInfo,
    SessionEvent, SessionMeta, SessionSnapshot, Subagent, SubagentStatus, ThinkingItem, ThinkingLevel, TodoPhase,
    TokenUsage, ToolItem, ToolStatus, TranscriptItem, UiRequest, UserItem,
};

use crate::frame::{AgentSnapshot, HostFrame, SessionHeader, SessionState, UiRequestFrame};
use crate::guest::{EndReason, GuestEvent, Snapshot};
use util::{arr, b, clip, content_images, content_text, f, first_line, non_empty, s, ts, u};

pub use ui::UiReply;

/// Rows carried by the `reset` event; older rows page through [`Replica::history`].
pub const RESET_LIMIT: usize = 300;
/// Cap for a tool row's `output` (the tail is kept).
pub const OUTPUT_CAP: usize = 256 * 1024;
const TPS_WINDOW_MS: i64 = 3000;

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
    started: Option<Millis>,
    ended: bool,
}

#[derive(Debug, Clone, Default)]
struct SubState {
    snapshot: Option<AgentSnapshot>,
    progress: Option<Value>,
    lifecycle: Option<String>,
    description: Option<String>,
    parent_tool: Option<String>,
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
    retry: Option<RetryStreak>,
    counted: HashSet<String>,
    cost: Option<CostInfo>,
    subs: BTreeMap<String, SubState>,
    ui: ui::UiState,
    ended: bool,
    /// Files each successful edit/write call changed (call id → files), for `SessionMeta.files`.
    file_edits: Vec<(String, Vec<ChangedFile>)>,
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
            retry: None,
            counted: HashSet::new(),
            cost: None,
            subs: BTreeMap::new(),
            ui: ui::UiState::default(),
            ended: false,
            file_edits: Vec::new(),
        }
    }

    pub fn agent_id(&self) -> &str {
        &self.agent_id
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
        }
    }

    /// Rows older than `cursor` (an item id from a snapshot/page), newest `limit` of them.
    pub fn history(&self, cursor: Option<&str>, limit: usize) -> HistoryPage {
        let end = cursor.and_then(|c| self.order.iter().position(|id| id == c)).unwrap_or(self.order.len());
        let start = end.saturating_sub(limit);
        HistoryPage {
            items: self.order[start..end].iter().filter_map(|id| self.items.get(id).cloned()).collect(),
            has_more: start > 0,
            cursor: (start > 0).then(|| self.order[start].clone()),
        }
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

    pub fn usage(&self) -> Option<CostInfo> {
        self.cost.clone()
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
        let tps = self.tps(now);
        let k = self.live_key();
        Liveness {
            last_event_at: self.last_event_at,
            streaming: k.streaming,
            thinking: k.thinking,
            tool: self.active_tools.last().map(|(_, t)| t.clone()),
            tps,
            line: k.line,
        }
    }

    fn tps(&self, now: Millis) -> Option<f32> {
        if !self.running {
            return None;
        }
        let chars: u32 = self.rate.iter().filter(|(t, _)| now - t <= TPS_WINDOW_MS).map(|(_, n)| n).sum();
        (chars > 0).then(|| chars as f32 / 4.0 / (TPS_WINDOW_MS as f32 / 1000.0))
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
        let agent_id = std::mem::take(&mut self.agent_id);
        *self = Replica::new(agent_id);
        self.now = out_now(self.now, snap);
        self.emit = false;
        self.header = Some(snap.welcome.header.clone());
        self.read_only = snap.welcome.read_only;
        self.state = snap.welcome.state.clone();
        for agent in &snap.welcome.agents {
            self.subs.entry(agent.id.clone()).or_default().snapshot = Some(agent.clone());
        }
        let entries = supersede_retried(&snap.entries);
        for entry in entries {
            self.entry(entry, &mut Update::default());
        }
        // Rows from a durable snapshot are final.
        for id in &self.order {
            if let Some(item) = self.items.get_mut(id) {
                finalize(item);
            }
        }
        self.msgs.values_mut().for_each(|m| m.done = true);
        self.running = self.state.is_streaming;
        if self.running {
            self.phase = Phase::Waiting;
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
                            self.tool_result(msg, out);
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
                self.tool_finish(&call_id, &name, &result, b(ev, "isError"), out);
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
                RetryStreak { id: format!("r{}", self.seq), at: self.now }
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
        let id = format!("n{}", self.seq);
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
                        TranscriptItem::Thinking(ThinkingItem {
                            id: id.clone(),
                            at: t,
                            text: text.to_owned(),
                            streaming,
                            duration_ms: (block_done && self.emit).then(|| (self.now - started).max(0) as u64),
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
                    self.tool_call_block(&call_id, blk, t, fin || i < last_live, out);
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
                    out.events.push(SessionEvent::Append { id, field, text: delta });
                }
            }
            Some(shown) if !newly_done && new_text == shown => {}
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
        if (role == "custom" || custom_type.is_some()) && msg.get("display").and_then(Value::as_bool) == Some(false) {
            return;
        }
        let t = entry_ts.or_else(|| ts(msg)).unwrap_or(self.now);
        let id = format!("u{t}");
        let text = match custom_type {
            Some("advisor") => advisor_text(msg).unwrap_or_else(|| content_text(msg.get("content"))),
            _ => content_text(msg.get("content")),
        };
        let images = content_images(msg.get("content"));
        let (author, synthetic) = match (role, custom_type) {
            (_, Some("collab-prompt")) => (msg.get("details").and_then(|d| non_empty(d, "from")).map(str::to_owned), false),
            (_, Some(other)) => (Some(other.to_owned()), true),
            ("developer", _) => (None, true),
            _ => (None, b(msg, "synthetic")),
        };
        if text.is_empty() && images.is_empty() {
            return;
        }
        let steering = match self.items.get(&id) {
            Some(TranscriptItem::User(u)) => u.steering,
            _ => self.emit && self.running && self.turn_output,
        };
        let is_new = !self.items.contains_key(&id);
        let item = TranscriptItem::User(UserItem { id, at: t, text: text.clone(), images, author: author.clone(), steering, synthetic });
        self.upsert(item, out);
        if is_new && self.emit {
            out.signals.push(Signal::Prompted { text, author });
        }
    }

    // ── tools ──────────────────────────────────────────────────────────

    fn tool_call_block(&mut self, call_id: &str, blk: &Value, at: Millis, args_done: bool, out: &mut Update) {
        let id = tool_id(call_id);
        let name = s(blk, "name").unwrap_or("").to_owned();
        let mut args = blk.get("arguments").cloned().unwrap_or(Value::Null);
        let intent = non_empty(blk, "intent").map(str::to_owned).or_else(|| args.get("i").and_then(Value::as_str).map(str::to_owned));
        if let Value::Object(map) = &mut args {
            map.remove("i");
        }
        self.tools.entry(call_id.to_owned()).or_insert(ToolState { name: name.clone(), started: None, ended: false });
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
            Some(TranscriptItem::Tool(existing)) if args_done && existing.status == ToolStatus::Pending => {
                let mut t = existing.clone();
                if t.args != args || t.intent != intent {
                    t.title = tools::title(&name, &args);
                    t.args = args;
                    t.intent = intent.or(t.intent);
                    self.upsert(TranscriptItem::Tool(t), out);
                }
            }
            _ => {}
        }
    }

    fn ensure_tool(&mut self, call_id: &str, name: &str, args: Option<&Value>, intent: Option<&str>) -> ToolItem {
        let id = tool_id(call_id);
        match self.items.get(&id) {
            Some(TranscriptItem::Tool(t)) => t.clone(),
            _ => {
                let args = args.cloned().unwrap_or(Value::Null);
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
        let args = ev.get("args");
        let mut t = self.ensure_tool(&call_id, &name, args, non_empty(ev, "intent"));
        if let Some(a) = args.filter(|a| !a.is_null()) {
            t.args = a.clone();
            t.title = tools::title(&name, a);
        }
        if let Some(i) = non_empty(ev, "intent") {
            t.intent = Some(i.to_owned());
        }
        t.status = ToolStatus::Running;
        t.view = tools::view(&name, &t.args, None, None);
        let label = tools::label(&name, &t.args, &t.title);
        self.tools.insert(call_id.clone(), ToolState { name: name.clone(), started: Some(self.now), ended: false });
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
                out.events.push(SessionEvent::Append { id, field: AppendField::Output, text: delta });
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

    fn tool_finish(&mut self, call_id: &str, name: &str, result: &Value, is_error: bool, out: &mut Update) {
        let name = if name.is_empty() { self.tools.get(call_id).map(|t| t.name.clone()).unwrap_or_default() } else { name.to_owned() };
        let mut t = self.ensure_tool(call_id, &name, None, None);
        let text = content_text(result.get("content"));
        let details = result.get("details");
        let (o, trunc) = cap_output(&text);
        let already_final = matches!(t.status, ToolStatus::Ok | ToolStatus::Error | ToolStatus::Aborted | ToolStatus::Denied);
        t.status = tools::status(&name, &text, details, is_error);
        t.output = (!o.is_empty()).then_some(o);
        t.truncated = trunc;
        t.view = tools::view(&name, &t.args, Some(result), Some(is_error)).or(t.view.take());
        t.error = is_error.then(|| clip(first_line(&text), 300)).filter(|e| !e.is_empty());
        let started = self.tools.get(call_id).and_then(|s| s.started);
        if t.duration_ms.is_none() {
            t.duration_ms = started
                .map(|st| (self.now - st).max(0) as u64)
                .or_else(|| details.and_then(|d| f(d, "wallTimeMs")).map(|ms| ms as u64));
        }
        if let Some(phases) = tools::todo_phases(&name, details) {
            self.meta.todos = phases;
        }
        if !is_error {
            self.record_file_edits(call_id, t.view.as_ref());
        }
        self.tools
            .entry(call_id.to_owned())
            .and_modify(|s| s.ended = true)
            .or_insert(ToolState { name: name.clone(), started: None, ended: true });
        self.active_tools.retain(|(c, _)| c != call_id);
        out.pulse(PulseKind::Tool, 1);
        if is_error && !already_final && self.emit && t.status == ToolStatus::Error {
            out.signals.push(Signal::ToolError { tool: name.clone(), error: t.error.clone().unwrap_or_default() });
        }
        self.upsert(TranscriptItem::Tool(t), out);
    }

    /// Folds a diff view into `SessionMeta.files` (paths relative to the session cwd).
    fn record_file_edits(&mut self, call_id: &str, view: Option<&tf_proto::ToolView>) {
        let Some(tf_proto::ToolView::Diff(d)) = view else { return };
        let cwd = self.meta.cwd.as_deref().map(|c| format!("{}/", c.trim_end_matches('/')));
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

    fn tool_result(&mut self, msg: &Value, out: &mut Update) {
        let call_id = s(msg, "toolCallId").unwrap_or("").to_owned();
        if call_id.is_empty() {
            return;
        }
        let name = s(msg, "toolName").unwrap_or("").to_owned();
        let result = serde_json::json!({"content": msg.get("content").cloned().unwrap_or(Value::Null), "details": msg.get("details").cloned().unwrap_or(Value::Null)});
        if !self.emit {
            // Snapshot: durations from message timestamps.
            let end = ts(msg);
            let start = self.items.get(&tool_id(&call_id)).map(|i| match i {
                TranscriptItem::Tool(t) => t.at,
                _ => 0,
            });
            if let (Some(e), Some(st)) = (end, start) {
                self.tools.entry(call_id.clone()).or_insert(ToolState { name: name.clone(), started: None, ended: false }).started = Some(st);
                self.now = e;
            }
        }
        self.tool_finish(&call_id, &name, &result, b(msg, "isError"), out);
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
                        let skip = self.emit
                            && self.tools.get(s(msg, "toolCallId").unwrap_or("")).is_some_and(|t| t.ended);
                        if !skip {
                            self.tool_result(msg, out);
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
            _ => {}
        }
    }

    fn count_cost(&mut self, entry_id: &str, msg: &Value) {
        if entry_id.is_empty() || !self.counted.insert(entry_id.to_owned()) {
            return;
        }
        let Some(usage) = msg.get("usage") else { return };
        let c = self.cost.get_or_insert(CostInfo { usd: 0.0, input: 0, output: 0, cache_read: 0, cache_write: 0 });
        c.input += u(usage, "input").unwrap_or(0);
        c.output += u(usage, "output").unwrap_or(0);
        c.cache_read += u(usage, "cacheRead").unwrap_or(0);
        c.cache_write += u(usage, "cacheWrite").unwrap_or(0);
        c.usd += usage.get("cost").and_then(|c| f(c, "total")).unwrap_or(0.0);
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

    fn refresh_meta(&mut self) {
        let subagents = self.subagents();
        let st = &self.state;
        let m = &mut self.meta;
        m.session_id = self.header.as_ref().map(|h| h.id.clone()).filter(|s| !s.is_empty());
        m.title = st.session_name.clone().or_else(|| self.header.as_ref().and_then(|h| h.title.clone()));
        m.cwd = (!st.cwd.is_empty()).then(|| st.cwd.clone()).or_else(|| self.header.as_ref().map(|h| h.cwd.clone()));
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
        m.cost = self.cost.clone();
        // Average of the last finished turn; the live rate is in `Liveness.tps`.
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
        if self.state.queued_message_count == 0 {
            m.queue = QueueInfo { steering: Vec::new(), follow_up: Vec::new() };
        }
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
            out.events.push(SessionEvent::Upsert { item: item.clone() });
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

fn out_now(now: Millis, snap: &Snapshot) -> Millis {
    if now != 0 {
        return now;
    }
    util::parse_rfc3339(&snap.welcome.header.timestamp).unwrap_or(0)
}

fn tool_id(call_id: &str) -> String {
    format!("t:{call_id}")
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
    let ended = match status {
        SubagentStatus::Running => None,
        _ => snap.map(|a| a.last_activity).filter(|t| *t > 0),
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
        progress: None,
        tool_count: p.and_then(|p| u(p, "toolCount")).map(|n| n as u32),
        parent_id: snap.and_then(|a| a.parent_id.clone()).or_else(|| st.parent_tool.clone()),
    }
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
