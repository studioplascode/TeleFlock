//! How did an omp session stand when its process ended? Read from the session's files, for
//! sessions whose omp is gone (or did not say), and ported from omp 18.13.3:
//!
//! * the main session: `hasRestorableTurn` (session/exit-diagnostics.ts) over the file's current
//!   branch, the leaf picked as omp's loader picks it (`resolveSessionLeafId`: the last entry's
//!   `activeLeafId`, else its id; a leaf that no longer exists falls back to the newest entry that
//!   selects itself);
//! * its subagents (task/restore.ts `restoreSubagents`): every transcript under `<session>/`
//!   (`<AgentId>.jsonl`, nested `<AgentId>/…`; advisors and `.bak` files are not subagents) whose
//!   process left it mid-turn (`hasRestorableTurn` over its entries), that was not killed (no
//!   `<file>.tombstone`) and that can be revived (a `session_init` that is not `isolated`);
//! * for each, what going on would do ([`Turn`]): the tool calls omp's restore (its `retry()`,
//!   `toolReplayStart` in session/turn-recovery.ts) would run again, the calls that never
//!   returned, a reply cut off by a signal, and the exit omp recorded.
//!
//! omp records `session_exit {reason, kind, recordedAt, pendingToolCalls?}` when it ends: `normal`
//! for a clean exit (nothing left unfinished unless calls were pending), `signal` / `fatal` /
//! `process_exit` otherwise; a crash, SIGKILL or power loss records nothing. omp's restore assumes
//! the exit, as this does. A turn its process left unfinished is a branch whose last message is a
//! prompt or tool results the model never answered, or tool calls without results; a turn exit
//! recovery already closed (the interrupted-turn abort) counts until anything but that follows.

use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};

use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;

use tf_proto::Millis;

/// omp's abort record for a turn its process never finished (`INTERRUPTED_TURN_ERROR`).
pub const INTERRUPTED_TURN_ERROR: &str = "Previous OMP process exited before completing the turn.";
/// The start of the result exit recovery gives a tool call its process never finished
/// (`createInterruptedToolResults`, `process-exit`): the call may or may not have run.
pub const INTERRUPTED_RESULT: &str = "Previous OMP process exited before this tool returned";
/// Subagent transcripts deeper than this are not looked at (omp's own task depth is far lower).
const MAX_DEPTH: usize = 8;
/// Argument texts are kept this long (enough for a note's `<tool>: <short args>`).
const ARG_CHARS: usize = 240;

/// One tool call of an assistant message, as far as going on after a crash needs it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Call {
    pub id: Option<String>,
    pub name: String,
    /// What it works on, one line: its `command`, else `path`, `file_path`, `file`, `pattern`,
    /// `query`, `url`, `target`.
    pub what: Option<String>,
    /// Its `action` / `op` argument (`lsp`, `github`, …).
    pub action: Option<String>,
}

impl Call {
    /// `<tool>: <short args>` (`bash: sleep 30; echo done >> c.out`), or the tool alone.
    pub fn label(&self) -> String {
        let what = self.what.as_deref().or(self.action.as_deref()).map(|w| w.split_whitespace().collect::<Vec<_>>().join(" "));
        match what.filter(|w| !w.is_empty()) {
            Some(w) => crate::util::clip(&format!("{}: {w}", self.name), 100),
            None => self.name.clone(),
        }
    }
}

/// How a session (its current branch) or a subagent transcript stood when its process ended.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Turn {
    /// omp's `--restore` would go on with it (`hasRestorableTurn`).
    pub restorable: bool,
    /// It ends in an aborted reply (an assistant message without tool calls that is not exit
    /// recovery's abort): cut off while it was written, or stopped by the user. The transcript
    /// does not tell which: omp records no exit for a first reply cut off (its file is written
    /// with that reply), and a subagent's transcript none of its own. Whether the agent was busy
    /// when last seen does (`decide`).
    pub cut_reply: bool,
    /// The calls omp's restore (or retry) would run again (`toolReplayStart`): the last tool
    /// batch, when it was complete (`toolUse` / `stop`) and none of its calls has a result that
    /// is not an error (exit recovery gives the cut-off ones error results).
    pub replay: Vec<Call>,
    /// Calls of the last tool batch that never returned (no result, or exit recovery's "outcome
    /// unknown" one): they may or may not have run.
    pub pending: Vec<Call>,
    /// The last exit its process recorded on the branch.
    pub exit: Option<Exit>,
}

/// A `session_exit` record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exit {
    pub kind: ExitKind,
    /// omp's postmortem reason (`SIGHUP`, `SIGTERM`, `uncaughtException`, `dispose`, …).
    pub reason: String,
    pub at: Option<Millis>,
}

/// A session and the subagents omp's restore would revive.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ended {
    /// The session's id (its header), when the file has one.
    pub session_id: Option<String>,
    pub root: Turn,
    /// Subagents cut off mid-turn that omp can revive, parents before children.
    pub subagents: Vec<Sub>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Sub {
    /// Its agent id (the transcript's file name).
    pub id: String,
    pub turn: Turn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    User,
    Assistant,
    ToolResult,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Msg {
    role: Role,
    calls: Vec<Call>,
    stop: Option<String>,
    interrupted_abort: bool,
    tool_call_id: Option<String>,
    is_error: bool,
    /// A result exit recovery wrote for a call its process never finished ([`INTERRUPTED_RESULT`]).
    unknown_outcome: bool,
}

/// `session_exit.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitKind {
    Normal,
    Signal,
    Fatal,
    ProcessExit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    Message(Msg),
    Exit { kind: ExitKind, pending: bool, reason: String, at: Option<Millis> },
    /// A subagent's `session_init`.
    Init { isolated: bool },
    /// The file's header (`type: session`): not an entry of the tree.
    Header { id: Option<String> },
    Other,
}

/// How an entry moves the leaf on replay (`sessionEntryLeafId`).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Leaf {
    /// No `activeLeafId`: the entry itself.
    Own,
    /// `activeLeafId: <id>`.
    To(String),
    /// `activeLeafId: null`: no leaf (a cleared session).
    Cleared,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    id: Option<String>,
    parent: Option<String>,
    leaf: Leaf,
    kind: Kind,
}

// ───────────────────────────── parsing ─────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default, deserialize_with = "present")]
    active_leaf_id: Option<Option<String>>,
    #[serde(default)]
    custom_type: Option<String>,
    #[serde(default)]
    data: ExitData,
    #[serde(default)]
    message: Option<RawMsg>,
    #[serde(default)]
    isolated: Option<bool>,
}

/// `Some(None)` for an explicit `null`, `None` when the key is absent.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMsg {
    #[serde(default)]
    role: String,
    #[serde(default)]
    content: Content,
    #[serde(default)]
    stop_reason: Option<String>,
    #[serde(default)]
    error_message: Option<String>,
    #[serde(default)]
    tool_call_id: Option<String>,
    #[serde(default)]
    is_error: Option<bool>,
}

/// A message's content: its tool calls (omp's `isToolCallContent`: `{type: "toolCall"}` with a
/// string `name` or `id`) and the start of its first text part; a plain string is all text.
#[derive(Default)]
struct Content {
    calls: Vec<Call>,
    text: Option<String>,
}

fn head(s: &str) -> String {
    s.chars().take(ARG_CHARS).collect()
}

impl<'de> Deserialize<'de> for Content {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Content;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("message content")
            }
            fn visit_str<E: de::Error>(self, s: &str) -> Result<Content, E> {
                Ok(Content { calls: Vec::new(), text: Some(head(s)) })
            }
            fn visit_unit<E: de::Error>(self) -> Result<Content, E> {
                Ok(Content::default())
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Content, A::Error> {
                let mut out = Content::default();
                while let Some(part) = seq.next_element::<Part>()? {
                    match part {
                        Part::Call(c) => out.calls.push(c),
                        Part::Text(t) if out.text.is_none() => out.text = Some(t),
                        _ => {}
                    }
                }
                Ok(out)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Content, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Content::default())
            }
        }
        d.deserialize_any(V)
    }
}

/// One content part: a tool call, the start of a text part, or anything else.
#[derive(Default)]
enum Part {
    Call(Call),
    Text(String),
    #[default]
    Other,
}

impl<'de> Deserialize<'de> for Part {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Part;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a content part")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Part, A::Error> {
                let (mut kind, mut id, mut name, mut args, mut text) = (None::<String>, None::<String>, None::<String>, Args::default(), None::<String>);
                let string = |v: serde_json::Value| v.as_str().map(str::to_string);
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "type" => kind = map.next_value::<Option<String>>()?,
                        "id" => id = string(map.next_value()?),
                        "name" => name = string(map.next_value()?),
                        "arguments" => args = map.next_value::<Args>()?,
                        "text" => text = string(map.next_value()?).map(|t| head(&t)),
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(match kind.as_deref() {
                    Some("toolCall") if id.is_some() || name.is_some() => {
                        Part::Call(Call { id, name: name.unwrap_or_default(), what: args.what.map(|(_, w)| w), action: args.action })
                    }
                    Some("text") => text.map(Part::Text).unwrap_or_default(),
                    _ => Part::Other,
                })
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Part, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Part::Other)
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Part, E> {
                Ok(Part::Other)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Part, E> {
                Ok(Part::Other)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Part, E> {
                Ok(Part::Other)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Part, E> {
                Ok(Part::Other)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Part, E> {
                Ok(Part::Other)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Part, E> {
                Ok(Part::Other)
            }
        }
        d.deserialize_any(V)
    }
}

/// A tool call's arguments, read only as far as a label needs: the argument that says what it
/// works on (the best ranked of [`WHAT`]) and its `action` / `op`; everything else (file
/// contents of `write`, patches) is skipped without building it.
#[derive(Default)]
struct Args {
    what: Option<(usize, String)>,
    action: Option<String>,
}

/// Arguments that say what a call works on, best first.
const WHAT: &[&str] = &["command", "path", "file_path", "file", "pattern", "query", "url", "target"];

impl<'de> Deserialize<'de> for Args {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Args;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("tool call arguments")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Args, A::Error> {
                let mut out = Args::default();
                while let Some(key) = map.next_key::<String>()? {
                    if key == "action" || key == "op" {
                        let v: serde_json::Value = map.next_value()?;
                        if out.action.is_none() {
                            out.action = v.as_str().map(head);
                        }
                    } else if let Some(rank) = WHAT.iter().position(|k| *k == key) {
                        let v: serde_json::Value = map.next_value()?;
                        if let Some(s) = v.as_str().filter(|s| !s.trim().is_empty())
                            && out.what.as_ref().is_none_or(|(r, _)| rank < *r)
                        {
                            out.what = Some((rank, head(s)));
                        }
                    } else {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
                Ok(out)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Args, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Args::default())
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Args, E> {
                Ok(Args::default())
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Args, E> {
                Ok(Args::default())
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Args, E> {
                Ok(Args::default())
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Args, E> {
                Ok(Args::default())
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Args, E> {
                Ok(Args::default())
            }
            fn visit_unit<E: de::Error>(self) -> Result<Args, E> {
                Ok(Args::default())
            }
        }
        d.deserialize_any(V)
    }
}

/// A custom entry's `data`, read only as far as a `session_exit` needs (`readSessionExit`: string
/// `reason` and `recordedAt`, a known `kind`; `pendingToolCalls` all named): anything else is
/// skipped without building it.
#[derive(Default)]
struct ExitData {
    exit: Option<(ExitKind, bool, String, Option<Millis>)>,
}

impl<'de> Deserialize<'de> for ExitData {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = ExitData;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("custom entry data")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<ExitData, A::Error> {
                let (mut reason, mut recorded, mut kind, mut pending) = (None::<String>, None::<String>, None, None::<Option<usize>>);
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "reason" => reason = map.next_value::<serde_json::Value>()?.as_str().map(head),
                        "recordedAt" => recorded = map.next_value::<serde_json::Value>()?.as_str().map(str::to_string),
                        "kind" => {
                            kind = match map.next_value::<serde_json::Value>()?.as_str() {
                                Some("normal") => Some(ExitKind::Normal),
                                Some("signal") => Some(ExitKind::Signal),
                                Some("fatal") => Some(ExitKind::Fatal),
                                Some("process_exit") => Some(ExitKind::ProcessExit),
                                _ => None,
                            }
                        }
                        "pendingToolCalls" => pending = Some(map.next_value::<Pending>()?.0),
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                let exit = match (reason, recorded, kind) {
                    (Some(reason), Some(at), Some(kind)) => {
                        let at = chrono::DateTime::parse_from_rfc3339(&at).ok().map(|t| t.timestamp_millis());
                        Some((kind, pending.flatten().is_some_and(|n| n > 0), reason, at))
                    }
                    _ => None,
                };
                Ok(ExitData { exit })
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<ExitData, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(ExitData::default())
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<ExitData, E> {
                Ok(ExitData::default())
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<ExitData, E> {
                Ok(ExitData::default())
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<ExitData, E> {
                Ok(ExitData::default())
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<ExitData, E> {
                Ok(ExitData::default())
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<ExitData, E> {
                Ok(ExitData::default())
            }
            fn visit_unit<E: de::Error>(self) -> Result<ExitData, E> {
                Ok(ExitData::default())
            }
        }
        d.deserialize_any(V)
    }
}

/// `pendingToolCalls`: how many valid diagnostics (`readPendingToolCalls`: an array of objects
/// with a string `toolName`); `None` when it is not such an array (omp then reads none).
struct Pending(Option<usize>);

impl<'de> Deserialize<'de> for Pending {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        let Some(items) = v.as_array() else { return Ok(Pending(None)) };
        let valid = items.iter().all(|i| i.get("toolName").is_some_and(|n| n.is_string()));
        Ok(Pending(valid.then_some(items.len())))
    }
}

fn entry(line: &str) -> Option<Entry> {
    let raw: Raw = serde_json::from_str(line).ok()?;
    let kind = match raw.kind.as_str() {
        "session" => Kind::Header { id: raw.id.clone() },
        "message" => {
            let m = raw.message?;
            let role = match m.role.as_str() {
                "user" => Role::User,
                "assistant" => Role::Assistant,
                "toolResult" => Role::ToolResult,
                _ => Role::Other,
            };
            let interrupted_abort = role == Role::Assistant
                && m.stop_reason.as_deref() == Some("aborted")
                && m.error_message.as_deref() == Some(INTERRUPTED_TURN_ERROR);
            let is_error = m.is_error == Some(true);
            let unknown_outcome = role == Role::ToolResult && is_error && m.content.text.as_deref().is_some_and(|t| t.starts_with(INTERRUPTED_RESULT));
            Kind::Message(Msg {
                role,
                calls: if role == Role::Assistant { m.content.calls } else { Vec::new() },
                stop: m.stop_reason,
                interrupted_abort,
                tool_call_id: m.tool_call_id,
                is_error,
                unknown_outcome,
            })
        }
        "custom" if raw.custom_type.as_deref() == Some("session_exit") => match raw.data.exit {
            Some((kind, pending, reason, at)) => Kind::Exit { kind, pending, reason, at },
            None => Kind::Other,
        },
        "session_init" => Kind::Init { isolated: raw.isolated == Some(true) },
        _ => Kind::Other,
    };
    let leaf = match raw.active_leaf_id {
        None => Leaf::Own,
        Some(Some(id)) => Leaf::To(id),
        Some(None) => Leaf::Cleared,
    };
    Some(Entry { id: raw.id, parent: raw.parent_id, leaf, kind })
}

/// Entries of a session file in file order (the header and the title slot included as
/// non-tree entries; unreadable lines skipped, as omp's loader skips malformed records).
fn read_entries(path: &Path) -> std::io::Result<Vec<Entry>> {
    let file = std::fs::File::open(path)?;
    let mut out = Vec::new();
    for line in std::io::BufReader::new(file).split(b'\n') {
        let line = line?;
        let Ok(text) = std::str::from_utf8(&line) else { continue };
        if let Some(e) = entry(text.trim_end_matches('\r')) {
            out.push(e);
        }
    }
    Ok(out)
}

#[cfg(test)]
fn parse(text: &str) -> Vec<Entry> {
    text.lines().filter_map(entry).collect()
}

// ───────────────────────────── omp's rules ─────────────────────────────

fn tree(entries: &[Entry]) -> impl DoubleEndedIterator<Item = &Entry> {
    entries.iter().filter(|e| !matches!(e.kind, Kind::Header { .. }) && e.id.is_some())
}

fn leaf_of(e: &Entry) -> Option<&str> {
    match &e.leaf {
        Leaf::Own => e.id.as_deref(),
        Leaf::To(id) => Some(id),
        Leaf::Cleared => None,
    }
}

/// omp's `resolveSessionLeafId`.
fn resolve_leaf(entries: &[Entry]) -> Option<&str> {
    let last = tree(entries).last()?;
    let leaf = leaf_of(last)?;
    if Some(leaf) == last.id.as_deref() || tree(entries).any(|e| e.id.as_deref() == Some(leaf)) {
        return Some(leaf);
    }
    tree(entries).rev().find(|e| leaf_of(e) == e.id.as_deref()).and_then(|e| e.id.as_deref())
}

/// The current branch, root first (omp's `getBranch` from the resolved leaf).
fn branch(entries: &[Entry]) -> Vec<&Entry> {
    let Some(leaf) = resolve_leaf(entries) else { return Vec::new() };
    let by_id: std::collections::HashMap<&str, &Entry> = tree(entries).filter_map(|e| e.id.as_deref().map(|id| (id, e))).collect();
    let mut path = Vec::new();
    let mut cur = by_id.get(leaf).copied();
    while let Some(e) = cur {
        if path.len() > by_id.len() {
            break; // a parent cycle
        }
        path.push(e);
        cur = e.parent.as_deref().and_then(|p| by_id.get(p).copied());
    }
    path.reverse();
    path
}

/// omp's `findUnfinishedTurn` with `assumeExit` (what `--restore` assumes): a non-terminal message
/// tail after a recorded exit, or with none recorded after it.
fn unfinished(entries: &[&Entry]) -> bool {
    let exit = entries.iter().enumerate().rev().find_map(|(i, e)| match e.kind {
        Kind::Exit { kind, pending, .. } => Some((i, kind, pending)),
        _ => None,
    });
    let Some((tail_index, tail)) = entries.iter().enumerate().rev().find_map(|(i, e)| match &e.kind {
        Kind::Message(m) => Some((i, m)),
        _ => None,
    }) else {
        return false;
    };
    if let Some((exit_index, kind, pending)) = exit
        && tail_index < exit_index
        && kind == ExitKind::Normal
        && !pending
    {
        return false;
    }
    if tail.role == Role::Assistant && tail.calls.is_empty() {
        return false;
    }
    let previous_assistant = entries[..=tail_index].iter().rev().find_map(|e| match &e.kind {
        Kind::Message(m) if m.role == Role::Assistant => Some(m),
        _ => None,
    });
    !(tail.role == Role::ToolResult && previous_assistant.is_some_and(|a| matches!(a.stop.as_deref(), Some("error" | "aborted"))))
}

/// omp's `hasRestorableTurn` over `entries` (a branch, or a subagent's whole transcript).
fn restorable(entries: &[&Entry]) -> bool {
    for e in entries.iter().rev() {
        match &e.kind {
            Kind::Exit { kind: ExitKind::Normal, .. } => return false,
            Kind::Message(m) if m.interrupted_abort => return true,
            Kind::Message(_) => break,
            _ => {}
        }
    }
    unfinished(entries)
}

/// The main session's own turn (its current branch).
#[cfg(test)]
fn root_restorable(entries: &[Entry]) -> bool {
    restorable(&branch(entries))
}

/// A subagent transcript can be revived: its last `session_init` is not `isolated` (an isolated
/// run's worktree is gone).
fn revivable(all: &[&Entry]) -> bool {
    let init = all.iter().rev().find_map(|e| match e.kind {
        Kind::Init { isolated } => Some(isolated),
        _ => None,
    });
    init == Some(false)
}

/// A subagent transcript (`restoreSubagents` reads every entry, not a branch): cut off, revivable.
fn subagent_restorable(entries: &[Entry]) -> bool {
    let all: Vec<&Entry> = tree(entries).collect();
    revivable(&all) && restorable(&all)
}

fn header_id(entries: &[Entry]) -> Option<String> {
    entries.iter().find_map(|e| match &e.kind {
        Kind::Header { id } => id.clone(),
        _ => None,
    })
}

fn messages<'a>(entries: &[&'a Entry]) -> Vec<(usize, &'a Msg)> {
    entries
        .iter()
        .enumerate()
        .filter_map(|(i, e)| match &e.kind {
            Kind::Message(m) => Some((i, m)),
            _ => None,
        })
        .collect()
}

/// The last tool batch as omp's retry sees it after exit recovery closed the turn
/// (`toolReplayStart`): `(replay, pending)`, see [`Turn`].
fn last_batch(msgs: &[(usize, &Msg)]) -> (Vec<Call>, Vec<Call>) {
    let mut end = msgs.len();
    // An aborted or failed boundary without calls of its own (exit recovery's abort, a stopped
    // reply) after the batch's results.
    if let Some((_, m)) = msgs.last()
        && m.role == Role::Assistant
        && m.calls.is_empty()
        && matches!(m.stop.as_deref(), Some("aborted" | "error"))
    {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && msgs[start - 1].1.role == Role::ToolResult {
        start -= 1;
    }
    let Some(anchor) = start.checked_sub(1).map(|i| msgs[i].1).filter(|a| a.role == Role::Assistant && !a.calls.is_empty()) else {
        return (Vec::new(), Vec::new());
    };
    let results: HashMap<&str, &Msg> = msgs[start..end].iter().filter_map(|(_, m)| m.tool_call_id.as_deref().map(|id| (id, *m))).collect();
    let result = |c: &Call| c.id.as_deref().and_then(|id| results.get(id)).copied();
    let pending: Vec<Call> = anchor.calls.iter().filter(|c| result(c).is_none_or(|r| r.unknown_outcome)).cloned().collect();
    let complete = matches!(anchor.stop.as_deref(), Some("toolUse" | "stop"));
    let none_succeeded = anchor.calls.iter().all(|c| result(c).is_none_or(|r| r.is_error));
    let replay = if complete && none_succeeded { anchor.calls.clone() } else { Vec::new() };
    (replay, pending)
}

/// How `entries` (a branch, or a subagent transcript) stood when its process ended.
fn turn_of(entries: &[&Entry]) -> Turn {
    let msgs = messages(entries);
    let (replay, pending) = last_batch(&msgs);
    let exit = entries.iter().rev().find_map(|e| match &e.kind {
        Kind::Exit { kind, reason, at, .. } => Some(Exit { kind: *kind, reason: reason.clone(), at: *at }),
        _ => None,
    });
    let cut_reply = matches!(msgs.last(), Some((_, m)) if m.role == Role::Assistant && m.calls.is_empty() && m.stop.as_deref() == Some("aborted") && !m.interrupted_abort);
    Turn { restorable: restorable(entries), cut_reply, replay, pending, exit }
}

// ───────────────────────────── files ─────────────────────────────

/// How the session in `file` and its subagents stood when their process ended (see the module
/// docs). Blocking: run it on the blocking pool. A missing main file is an error; unreadable
/// subagent transcripts are skipped.
pub fn ended(file: &Path) -> std::io::Result<Ended> {
    let entries = read_entries(file)?;
    let mut subagents = Vec::new();
    if let Some(dir) = file.to_str().and_then(|f| f.strip_suffix(".jsonl")).map(PathBuf::from) {
        collect_subagents(&dir, 0, &mut subagents);
    }
    Ok(Ended { session_id: header_id(&entries), root: turn_of(&branch(&entries)), subagents })
}

/// Subagent transcripts under `dir` that can go on (omp's `collectSubSessionsFromDir`, in name
/// order, parents before their children): not killed, revivable (a `session_init` that is not
/// `isolated`), and cut off mid-turn (omp's restore revives these) or in a reply (omp's retry).
fn collect_subagents(dir: &Path, depth: usize, out: &mut Vec<Sub>) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut files = Vec::new();
    let mut dirs = std::collections::HashSet::new();
    for d in read.flatten() {
        let Ok(t) = d.file_type() else { continue };
        let name = d.file_name().to_string_lossy().into_owned();
        if t.is_file() {
            files.push(name);
        } else if t.is_dir() {
            dirs.insert(name);
        }
    }
    files.sort();
    let names: std::collections::HashSet<&str> = files.iter().map(String::as_str).collect();
    for name in &files {
        let Some(agent) = name.strip_suffix(".jsonl") else { continue };
        if name.contains(".bak") || name == "__advisor.jsonl" || name.starts_with("__advisor.") {
            continue;
        }
        let tombstoned = names.contains(format!("{name}.tombstone").as_str());
        if !tombstoned && let Ok(entries) = read_entries(&dir.join(name)) {
            let all: Vec<&Entry> = tree(&entries).collect();
            let b = branch(&entries);
            let turn = if b.is_empty() { turn_of(&all) } else { turn_of(&b) };
            if subagent_restorable(&entries) || (revivable(&all) && turn.cut_reply) {
                out.push(Sub { id: agent.to_string(), turn });
            }
        }
        if dirs.contains(agent) {
            collect_subagents(&dir.join(agent), depth + 1, out);
        }
    }
}

#[cfg(test)]
mod tests;
