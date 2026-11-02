//! A session's agent chat log (architecture §3.34): every omp IRC message exchanged inside the
//! session's agent tree (the main agent and its subagents at any depth), for the app's message
//! board (`session.agentChat`, `SessionMeta::agent_chat`).
//!
//! Sources, merged into one message each:
//! - **The bridge's tap** (bridge ≥ 2.3.0, `caps.agentChat`): omp's IRC bus is process-wide, and
//!   the bridge reports every delivery leg it starts (`irc` event) and again once it settled, with
//!   omp's outcome ([`IrcLeg`]).
//! - **The session's transcript files**: omp's session file and every subagent transcript under
//!   its artifacts dir (`<session>/<Id>.jsonl`, nested `<Id>/<Id>.<Child>.jsonl`), read
//!   incrementally ([`tf_collab::replica::IrcFileScan`]): a sender's `write agent://…` call with
//!   its result (receipts), a recipient's `irc:incoming`, a parent's steer, a `wait` that consumed
//!   one, a subagent's prompt from the user. They rebuild the log after tf-hostd restarts, add
//!   what the tap could not see (sent while no hostd was connected, wake relays' omp ids, what
//!   reached a recipient) and are the whole source for older bridges and collab-served sessions.
//! - **The user**: what the app sent a subagent (`agent.subagent` chat), from `user`. omp writes it
//!   into the subagent's transcript as a prompt attributed to the user, which cannot tell one
//!   subagent's message from one of a message to every running subagent: a broadcast rebuilt from
//!   the transcripts alone is one message to every subagent that got the same text within the
//!   broadcast window.
//!
//! One message shows up to once per side and recipient (tap, sender's file, recipient's file, the
//! user's request). Observations merge by their own key (a tap leg's id, a file and tool call or
//! entry: the same observation read again), by omp's message id, else into the closest message
//! from the same sender with the same text, broadcast-ness and recipient within the time window
//! whose leg for that recipient has not been seen from that side yet. omp sends a broadcast as
//! one message per peer: its legs merge into one message to all of them.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tf_collab::replica::{may_hold_irc, IrcFileScan, IrcRecord, IRC_USER};
use tf_proto::methods::AgentChatParams;
use tf_proto::session::{AgentChatInfo, AgentChatLog, AgentChatMessage, IrcDirection, IrcReceipt};
use tf_proto::{ApiError, Millis};
use tracing::debug;

use crate::ops::Ctx;

/// Messages a log keeps; the oldest go first.
const MAX_MESSAGES: usize = 2_000;
/// Text a log keeps, all messages together.
const MAX_TEXT: usize = 16 << 20;
/// Longest message body kept (omp's wake relays carry a subagent's whole answer).
const MAX_BODY: usize = 256 << 10;
/// Clock slack between sources when matching one message's observations.
const SLACK: Millis = 3_000;
/// The legs of one broadcast arrive this far apart at most (the user's: one request per subagent).
const BROADCAST_SLACK: Millis = 30_000;
/// A recipient's row can be written this long after the message was sent (omp before 18.14 stamps
/// an `irc:incoming` row with when it was written, and a busy recipient takes it in at its next step).
const LATE_IN: Millis = 10 * 60_000;
/// Sessions whose logs are kept (least recently used ones go; they are rebuilt from their files).
const MAX_LOGS: usize = 64;
/// How deep subagent transcripts are looked for under the artifacts dir.
const MAX_DEPTH: usize = 6;
/// Folder entries one read of a session's files looks at, at most (the artifacts dir also holds
/// every tool output of the session).
const MAX_ENTRIES: usize = 20_000;
/// The session's `local://` root in its artifacts dir: the agents' and the user's own files.
const LOCAL_DIR: &str = "local";
/// Longest transcript line read. IRC rows are far shorter (a body is cut at [`MAX_BODY`]); a
/// longer line (an inline image, a tool's output) is skipped, and no more of an unfinished one is
/// held.
const MAX_LINE: usize = 16 << 20;
/// Bytes read from a transcript file at a time.
const READ_CHUNK: usize = 1 << 20;
/// A fetch reads the transcript files again only this long after the last read.
const SCAN_EVERY: Duration = Duration::from_millis(750);
/// The sender of what the user sent an agent from TeleFlock (or from omp's agent hub).
pub const USER: &str = IRC_USER;
/// omp's id of the main agent (`MAIN_AGENT_ID`).
pub const MAIN_AGENT: &str = "Main";

/// One delivery leg of omp's IRC bus as the bridge reports it (`irc` event, bridge ≥ 2.3.0): when
/// the send starts (no `outcome`) and again when it settled. A broadcast is one leg per peer.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IrcLeg {
    /// The bridge's id of the leg, unique in the omp process.
    pub id: String,
    pub from: String,
    pub to: String,
    pub body: String,
    /// When the send started (omp's clock).
    pub ts: Millis,
    /// omp's id of the message this one answers (wake relays).
    pub reply_to: Option<String>,
    pub broadcast: bool,
    pub wake_relay: bool,
    pub progress: bool,
    /// Once settled: `injected`, `woken`, `revived` or `failed`.
    pub outcome: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Side {
    /// The bridge's tap.
    Tap = 0,
    /// The sender's transcript (`write agent://…` and its result).
    Out = 1,
    /// The recipient's transcript.
    In = 2,
    /// The user's request.
    User = 3,
}

/// One sighting of a message.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Obs {
    pub side: Side,
    /// The same sighting again (a re-read, the tap's second event) carries the same key.
    pub key: String,
    pub from: String,
    /// The recipients it covers (a sender's broadcast: every peer its receipts name).
    pub to: Vec<String>,
    pub broadcast: bool,
    pub text: String,
    /// It was sent at or after `lo` and at or before `hi` (`lo == hi`: exactly then).
    pub lo: Millis,
    pub hi: Millis,
    pub omp_id: Option<String>,
    pub reply_to: Option<String>,
    pub wake_relay: bool,
    pub progress: bool,
    pub receipts: Vec<IrcReceipt>,
}

impl Obs {
    pub(crate) fn from_leg(leg: IrcLeg) -> Obs {
        let receipts = leg.outcome.map(|outcome| IrcReceipt { to: leg.to.clone(), outcome, error: leg.error }).into_iter().collect();
        Obs {
            side: Side::Tap,
            key: format!("tap:{}", leg.id),
            from: leg.from,
            to: vec![leg.to],
            broadcast: leg.broadcast,
            text: leg.body,
            lo: leg.ts,
            hi: leg.ts,
            omp_id: None,
            reply_to: leg.reply_to,
            wake_relay: leg.wake_relay,
            progress: leg.progress,
            receipts,
        }
    }

    /// A record of the transcript file of agent `file_agent`; `None` without a time.
    pub(crate) fn from_record(file_agent: &str, r: IrcRecord) -> Option<Obs> {
        let at = r.at?;
        let (side, to, lo, hi) = match r.direction {
            IrcDirection::Out if r.to == "all" => (Side::Out, r.receipts.iter().map(|x| x.to.clone()).collect(), at, r.until.unwrap_or(at).max(at)),
            IrcDirection::Out => (Side::Out, vec![r.to], at, r.until.unwrap_or(at).max(at)),
            // omp stamps a prompt with when it was sent, whenever the subagent takes it in.
            IrcDirection::In if r.from == USER => (Side::In, vec![r.to], at, at),
            IrcDirection::In => (Side::In, vec![r.to], at - LATE_IN, at),
        };
        let tag = if side == Side::Out { "out" } else { "in" };
        Some(Obs {
            side,
            key: format!("{tag}:{file_agent}:{}", r.key),
            from: r.from,
            to,
            broadcast: r.broadcast,
            text: r.text,
            lo,
            hi,
            omp_id: r.omp_id,
            reply_to: r.reply_to,
            wake_relay: r.wake_relay,
            progress: r.progress,
            receipts: r.receipts,
        })
    }

    /// What the user sent subagent `to` from TeleFlock, as the request tells it (see
    /// [`on_user_chat`]).
    pub(crate) fn from_user(to: &str, text: &str, broadcast: bool, error: Option<&str>, sent: Millis) -> Obs {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let outcome = if error.is_some() { "failed" } else { "injected" };
        Obs {
            side: Side::User,
            key: format!("user:{}", SEQ.fetch_add(1, Ordering::Relaxed)),
            from: USER.to_owned(),
            to: vec![to.to_owned()],
            broadcast,
            text: text.to_owned(),
            lo: sent,
            hi: sent,
            omp_id: None,
            reply_to: None,
            wake_relay: false,
            progress: false,
            receipts: vec![IrcReceipt { to: to.to_owned(), outcome: outcome.into(), error: error.map(str::to_owned) }],
        }
    }
}

#[derive(Debug, Clone, Default)]
struct Leg {
    to: String,
    omp: Option<String>,
    /// Seen from each [`Side`].
    seen: [bool; 4],
    outcome: Option<String>,
    error: Option<String>,
}

impl Leg {
    fn takes(&self, obs: &Obs) -> bool {
        !self.seen[obs.side as usize] && !matches!((&self.omp, &obs.omp_id), (Some(a), Some(b)) if a != b)
    }

    fn receipt(&self) -> IrcReceipt {
        let outcome = match &self.outcome {
            Some(o) => o.clone(),
            None if self.seen[Side::In as usize] => "received".into(),
            None => "pending".into(),
        };
        IrcReceipt { to: self.to.clone(), outcome, error: self.error.clone() }
    }
}

#[derive(Debug, Clone)]
struct Msg {
    n: u64,
    keys: Vec<String>,
    from: String,
    text: String,
    lo: Millis,
    hi: Millis,
    broadcast: bool,
    wake_relay: bool,
    progress: bool,
    /// omp's id of the message it answers.
    reply_to: Option<String>,
    legs: Vec<Leg>,
    rev: u64,
}

impl Msg {
    fn id(&self) -> String {
        format!("m{}", self.n)
    }

    /// When it was sent, as near as known: the latest time it was sent by.
    fn at(&self) -> Millis {
        self.hi
    }

    fn fits(&self, obs: &Obs) -> bool {
        if self.from != obs.from || self.text.trim() != obs.text.trim() {
            return false;
        }
        // A subagent's prompt from the user does not tell whether the user sent every running
        // subagent the same message at once: it joins either. The request hostd saw tells, so a
        // message sent to one subagent alone takes no other recipient.
        let user_row = obs.side == Side::In && obs.from == USER;
        if self.broadcast != obs.broadcast && !user_row {
            return false;
        }
        let slack = if self.broadcast || obs.broadcast || user_row { BROADCAST_SLACK } else { SLACK };
        if obs.lo > self.hi + slack || obs.hi + slack < self.lo {
            return false;
        }
        let one_recipient = !self.broadcast && (!user_row || self.legs.iter().any(|l| l.seen[Side::User as usize]));
        if one_recipient {
            return match (self.legs.first(), obs.to.first()) {
                (Some(leg), Some(to)) => leg.to == *to && leg.takes(obs),
                _ => false,
            };
        }
        obs.to.iter().all(|to| self.legs.iter().find(|l| l.to == *to).is_none_or(|l| l.takes(obs)))
    }

    /// Folds `obs` in; `true` when anything the app sees changed. `learned`: omp ids it learned.
    fn merge(&mut self, obs: Obs, learned: &mut Vec<String>) -> bool {
        let mut changed = false;
        if !self.keys.contains(&obs.key) {
            self.keys.push(obs.key.clone());
        }
        // The narrowest time both agree on (a sighting that disagrees keeps what is known).
        let (lo, hi) = (self.lo.max(obs.lo), self.hi.min(obs.hi));
        if lo <= hi && (lo, hi) != (self.lo, self.hi) {
            (self.lo, self.hi) = (lo, hi);
            changed = true;
        }
        for (flag, more) in [(&mut self.wake_relay, obs.wake_relay), (&mut self.progress, obs.progress)] {
            if more && !*flag {
                *flag = true;
                changed = true;
            }
        }
        if self.reply_to.is_none() && obs.reply_to.is_some() {
            self.reply_to = obs.reply_to.clone();
            changed = true;
        }
        for to in &obs.to {
            let i = match self.legs.iter().position(|l| l.to == *to) {
                Some(i) => i,
                None => {
                    self.legs.push(Leg { to: to.clone(), ..Leg::default() });
                    changed = true;
                    self.legs.len() - 1
                }
            };
            let leg = &mut self.legs[i];
            if !leg.seen[obs.side as usize] {
                leg.seen[obs.side as usize] = true;
                // Only an inbound sighting changes what the app shows (`received`).
                changed |= obs.side == Side::In && leg.outcome.is_none();
            }
            if leg.omp.is_none() && obs.omp_id.is_some() {
                leg.omp = obs.omp_id.clone();
                learned.extend(obs.omp_id.clone());
            }
            if let Some(r) = obs.receipts.iter().find(|r| r.to == *to)
                && (leg.outcome.as_deref() != Some(r.outcome.as_str()) || leg.error != r.error)
                && !r.outcome.is_empty()
            {
                leg.outcome = Some(r.outcome.clone());
                leg.error = r.error.clone();
                changed = true;
            }
        }
        // What the user sent several subagents, rebuilt from their prompts, is one message to all.
        if self.from == USER && !self.broadcast && self.legs.len() > 1 {
            self.broadcast = true;
            changed = true;
        }
        changed
    }
}

/// The messages of one session's agent tree.
#[derive(Debug)]
pub(crate) struct Log {
    epoch: String,
    rev: u64,
    next: u64,
    msgs: Vec<Msg>,
    text: usize,
    truncated: bool,
}

impl Log {
    pub(crate) fn new() -> Log {
        Log { epoch: new_epoch(), rev: 0, next: 1, msgs: Vec::new(), text: 0, truncated: false }
    }

    #[cfg(test)]
    pub(crate) fn rev(&self) -> u64 {
        self.rev
    }

    /// Folds one sighting in; `true` when the log changed.
    pub(crate) fn absorb(&mut self, mut obs: Obs) -> bool {
        if obs.to.is_empty() && !obs.broadcast {
            return false;
        }
        if obs.text.len() > MAX_BODY {
            let mut cut = MAX_BODY;
            while !obs.text.is_char_boundary(cut) {
                cut -= 1;
            }
            obs.text.truncate(cut);
            obs.text.push_str("\n\n…");
        }
        let mut learned = Vec::new();
        let mut changed = match self.find(&obs) {
            Some(i) => self.msgs[i].merge(obs, &mut learned) && self.bump(i),
            None => {
                let n = self.next;
                self.next += 1;
                self.text += obs.text.len();
                let mut msg = Msg {
                    n,
                    keys: Vec::new(),
                    from: obs.from.clone(),
                    text: obs.text.clone(),
                    lo: obs.lo,
                    hi: obs.hi,
                    broadcast: obs.broadcast,
                    wake_relay: false,
                    progress: false,
                    reply_to: None,
                    legs: Vec::new(),
                    rev: 0,
                };
                msg.merge(obs, &mut learned);
                self.msgs.push(msg);
                let i = self.msgs.len() - 1;
                self.bump(i);
                self.bound();
                true
            }
        };
        // A message that answers one whose omp id just became known now links to it: a change.
        for id in learned {
            for i in 0..self.msgs.len() {
                if self.msgs[i].reply_to.as_deref() == Some(id.as_str()) {
                    changed |= self.bump(i);
                }
            }
        }
        changed
    }

    fn bump(&mut self, i: usize) -> bool {
        self.rev += 1;
        self.msgs[i].rev = self.rev;
        true
    }

    fn find(&self, obs: &Obs) -> Option<usize> {
        if let Some(i) = self.msgs.iter().rposition(|m| m.keys.contains(&obs.key)) {
            return Some(i);
        }
        if let Some(id) = &obs.omp_id
            && let Some(i) = self.msgs.iter().rposition(|m| m.legs.iter().any(|l| l.omp.as_ref() == Some(id)))
        {
            return Some(i);
        }
        // The oldest of the nearest: identical messages pair up in order.
        self.msgs.iter().enumerate().filter(|(_, m)| m.fits(obs)).min_by_key(|(_, m)| (m.hi - obs.hi).abs()).map(|(i, _)| i)
    }

    /// Drops the oldest messages beyond [`MAX_MESSAGES`] / [`MAX_TEXT`].
    fn bound(&mut self) {
        while self.msgs.len() > MAX_MESSAGES || (self.text > MAX_TEXT && self.msgs.len() > 1) {
            let Some((i, _)) = self.msgs.iter().enumerate().min_by_key(|(_, m)| (m.at(), m.n)) else { return };
            let gone = self.msgs.remove(i);
            self.text = self.text.saturating_sub(gone.text.len());
            self.truncated = true;
        }
    }

    pub(crate) fn info(&self, live: bool) -> AgentChatInfo {
        AgentChatInfo { epoch: self.epoch.clone(), rev: self.rev, count: self.msgs.len() as u32, live }
    }

    /// Everything changed after `after` in epoch `epoch`, else the whole log.
    pub(crate) fn page(&self, epoch: Option<&str>, after: Option<u64>, live: bool) -> AgentChatLog {
        let since = after.filter(|_| epoch == Some(self.epoch.as_str()));
        let mut picked: Vec<&Msg> = self.msgs.iter().filter(|m| since.is_none_or(|a| m.rev > a)).collect();
        picked.sort_by_key(|m| (m.at(), m.n));
        AgentChatLog {
            epoch: self.epoch.clone(),
            rev: self.rev,
            messages: picked.into_iter().map(|m| self.export(m)).collect(),
            reset: since.is_none(),
            truncated: self.truncated,
            live,
        }
    }

    fn export(&self, m: &Msg) -> AgentChatMessage {
        AgentChatMessage {
            id: m.id(),
            from: m.from.clone(),
            to: m.legs.iter().map(|l| l.to.clone()).collect(),
            broadcast: m.broadcast,
            text: m.text.clone(),
            at: m.at(),
            reply_to: self.answered(m),
            wake_relay: m.wake_relay,
            progress: m.progress,
            receipts: m.legs.iter().map(Leg::receipt).collect(),
            rev: m.rev,
        }
    }

    /// The message `m` answers (omp's wake relays name it by omp id): by that id, else the latest
    /// message from `m`'s recipient to its sender before it.
    fn answered(&self, m: &Msg) -> Option<String> {
        let omp = m.reply_to.as_ref()?;
        if let Some(t) = self.msgs.iter().find(|x| x.legs.iter().any(|l| l.omp.as_ref() == Some(omp))) {
            return Some(t.id());
        }
        let to = &m.legs.first()?.to;
        self.msgs
            .iter()
            .filter(|x| x.n != m.n && x.from == *to && x.legs.iter().any(|l| l.to == m.from) && x.at() <= m.at())
            .max_by_key(|x| (x.at(), x.n))
            .map(Msg::id)
    }
}

/// A log's epoch: unique within this process and later processes (microseconds since 1970, one
/// more than the last one when the clock has not moved; base 36).
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
    let mut s = Vec::new();
    loop {
        s.push(char::from_digit((v % 36) as u32, 36).unwrap_or('0'));
        v /= 36;
        if v == 0 {
            return s.into_iter().rev().collect();
        }
    }
}

// ───────────────────────────── transcript files ─────────────────────────────

/// How far one transcript file was read.
#[derive(Debug)]
struct Cursor {
    offset: u64,
    /// An unfinished last line (omp is writing it), at most [`MAX_LINE`] bytes.
    tail: Vec<u8>,
    /// In a line longer than [`MAX_LINE`]: the rest of it, up to its newline, is skipped.
    skipping: bool,
    scan: IrcFileScan,
}

/// The transcript files of a session's agent tree, read incrementally.
#[derive(Debug, Default)]
pub(crate) struct Files {
    cursors: HashMap<PathBuf, Cursor>,
    last: Option<Instant>,
}

impl Files {
    /// Reads what was appended to the session's files since the last read: the main session file
    /// (agent `main_agent`) and every subagent transcript under its artifacts dir. Blocking.
    pub(crate) fn read(&mut self, main: &Path, main_agent: &str) -> Vec<Obs> {
        self.last = Some(Instant::now());
        let mut files = vec![(main.to_path_buf(), main_agent.to_owned())];
        let mut budget = MAX_ENTRIES;
        subagent_files(&crate::artifacts::artifacts_dir(main), 0, &mut budget, &mut files);
        let mut out = Vec::new();
        for (path, agent) in files {
            let cursor = self.cursors.entry(path.clone()).or_insert_with(|| Cursor { offset: 0, tail: Vec::new(), skipping: false, scan: IrcFileScan::new(&agent, path == main) });
            if let Err(e) = read_more(&path, cursor, &mut out) {
                debug!(file = %path.display(), "agent chat: {e}");
            }
        }
        out
    }

    fn due(&self) -> bool {
        self.last.is_none_or(|t| t.elapsed() >= SCAN_EVERY)
    }
}

/// Subagent transcripts under `dir`, a session's artifacts dir: `<Id>.jsonl` (regular files;
/// advisors' `__…` excluded), and nested ones in the folder of the subagent that started them,
/// beside its transcript (`<Id>/<Id>.<Child>.jsonl`). No other folder is entered: not the
/// session's `local://` root, not omp's other artifact folders. Looks at `budget` folder entries
/// at most. The agent id is the file's stem.
fn subagent_files(dir: &Path, depth: usize, budget: &mut usize, out: &mut Vec<(PathBuf, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let first = out.len();
    let mut folders = Vec::new();
    for e in entries.flatten() {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        let Ok(kind) = e.file_type() else { continue };
        let path = e.path();
        if kind.is_dir() {
            if depth < MAX_DEPTH && !(depth == 0 && e.file_name() == LOCAL_DIR) {
                folders.push(path);
            }
        } else if kind.is_file()
            && path.extension().is_some_and(|x| x == "jsonl")
            && let Some(stem) = path.file_stem().and_then(|s| s.to_str())
            && !stem.starts_with("__")
            && !stem.is_empty()
        {
            let stem = stem.to_owned();
            out.push((path, stem));
        }
    }
    let here = out.len();
    for folder in folders {
        let beside = folder.file_name().and_then(|n| n.to_str()).is_some_and(|n| out[first..here].iter().any(|(_, id)| id == n));
        if beside {
            subagent_files(&folder, depth + 1, budget, out);
        }
    }
}

/// Reads what was appended to `path` since `cursor`, a chunk at a time: complete lines are
/// scanned, an unfinished last one waits in `cursor.tail`; a line longer than [`MAX_LINE`] is
/// skipped up to its newline.
fn read_more(path: &Path, cursor: &mut Cursor, out: &mut Vec<Obs>) -> std::io::Result<()> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    if len < cursor.offset {
        // Rewritten: read it again (sightings already in the log merge by their keys).
        cursor.offset = 0;
        cursor.tail = Vec::new();
        cursor.skipping = false;
        cursor.scan.reset();
    }
    if len == cursor.offset {
        return Ok(());
    }
    f.seek(SeekFrom::Start(cursor.offset))?;
    let new = len - cursor.offset;
    let mut f = f.take(new);
    let mut buf = vec![0; usize::try_from(new).map_or(READ_CHUNK, |n| n.min(READ_CHUNK))];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        cursor.offset += n as u64;
        let mut rest = &buf[..n];
        while let Some(i) = memchr::memchr(b'\n', rest) {
            let line = &rest[..i];
            rest = &rest[i + 1..];
            if std::mem::take(&mut cursor.skipping) {
                continue;
            }
            if cursor.tail.is_empty() {
                scan_line(&mut cursor.scan, line, out);
            } else if cursor.tail.len() + line.len() <= MAX_LINE {
                let mut whole = std::mem::take(&mut cursor.tail);
                whole.extend_from_slice(line);
                scan_line(&mut cursor.scan, &whole, out);
            } else {
                cursor.tail = Vec::new();
            }
        }
        if cursor.skipping {
            continue;
        }
        if cursor.tail.len() + rest.len() > MAX_LINE {
            cursor.tail = Vec::new();
            cursor.skipping = true;
        } else {
            cursor.tail.extend_from_slice(rest);
        }
    }
}

/// One complete line of `scan`'s file: the sighting it completes, if any.
fn scan_line(scan: &mut IrcFileScan, line: &[u8], out: &mut Vec<Obs>) {
    if line.is_empty() || !may_hold_irc(&String::from_utf8_lossy(line)) {
        return;
    }
    let Ok(entry) = tf_collab::lossy_json::from_slice::<serde_json::Value>(line) else { return };
    if let Some(obs) = scan.entry(&entry).and_then(|r| Obs::from_record(scan.agent(), r)) {
        out.push(obs);
    }
}

// ───────────────────────────── the logs ─────────────────────────────

/// One session's log and the reading of its files.
#[derive(Debug)]
pub(crate) struct Chat {
    log: Mutex<Log>,
    /// Held while the files are read (on the blocking pool), so one read runs at a time.
    files: Mutex<Files>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Chat {
    fn new() -> Chat {
        Chat { log: Mutex::new(Log::new()), files: Mutex::new(Files::default()) }
    }

    /// Folds sightings in; `true` when the log changed.
    pub(crate) fn absorb(&self, obs: impl IntoIterator<Item = Obs>) -> bool {
        let mut log = lock(&self.log);
        obs.into_iter().fold(false, |changed, o| log.absorb(o) | changed)
    }

    /// Reads the session's files (when the last read is older than [`SCAN_EVERY`], or `force`)
    /// and folds what they add in; `true` when the log changed. Blocking.
    pub(crate) fn read_files(&self, main: &Path, main_agent: &str, force: bool) -> bool {
        let mut files = lock(&self.files);
        if !force && !files.due() {
            return false;
        }
        let obs = files.read(main, main_agent);
        drop(files);
        self.absorb(obs)
    }

    pub(crate) fn info(&self, live: bool) -> AgentChatInfo {
        lock(&self.log).info(live)
    }

    pub(crate) fn page(&self, epoch: Option<&str>, after: Option<u64>, live: bool) -> AgentChatLog {
        lock(&self.log).page(epoch, after, live)
    }
}

#[derive(Default)]
struct Logs {
    map: HashMap<String, Arc<Chat>>,
    /// Least recently used first.
    order: VecDeque<String>,
}

static LOGS: LazyLock<Mutex<Logs>> = LazyLock::new(Default::default);

/// The log of omp session `key` (its id, else its file), created empty when there is none.
pub(crate) fn chat(key: &str) -> Arc<Chat> {
    let mut logs = lock(&LOGS);
    if let Some(i) = logs.order.iter().position(|k| k == key) {
        let k = logs.order.remove(i).unwrap_or_default();
        logs.order.push_back(k);
    } else {
        logs.order.push_back(key.to_owned());
    }
    let chat = logs.map.entry(key.to_owned()).or_insert_with(|| Arc::new(Chat::new())).clone();
    while logs.order.len() > MAX_LOGS {
        if let Some(old) = logs.order.pop_front() {
            logs.map.remove(&old);
        }
    }
    chat
}

// ───────────────────────────── hostd glue ─────────────────────────────

/// Where a live session's log reads from: its session file and main agent id.
fn source(ctx: &Ctx, agent_id: &str, session_id: &str) -> (Option<PathBuf>, String) {
    let from_session = ctx.omp.session(session_id).map(|s| s.chat_source());
    let file = from_session.as_ref().and_then(|(f, _)| f.clone()).or_else(|| {
        let a = ctx.state.agent(agent_id)?;
        a.omp?.session_file.map(PathBuf::from)
    });
    let main = from_session.map(|(_, m)| m).unwrap_or_else(|| MAIN_AGENT.to_owned());
    (file, main)
}

/// The session's bridge reports its IRC bus (`caps.agentChat`).
fn tapped(ctx: &Ctx, session_id: &str) -> bool {
    ctx.bridge.by_session(session_id).is_some_and(|b| b.caps.agent_chat)
}

/// Tells the session's subscribers what its log holds now (`SessionMeta::agent_chat`).
fn announce(ctx: &Ctx, session_id: &str, chat: &Chat) {
    if let Some(s) = ctx.omp.session(session_id) {
        s.set_agent_chat(chat.info(tapped(ctx, session_id)));
    }
}

/// `session.open` of a live session: its meta names the log; the files are read in the background
/// (the log's first read rebuilds what was said before).
pub(crate) fn open(ctx: &Ctx, agent_id: &str, session_id: &str) {
    let chat = chat(session_id);
    announce(ctx, session_id, &chat);
    let (Some(file), main) = source(ctx, agent_id, session_id) else { return };
    let ctx = ctx.arc();
    let sid = session_id.to_owned();
    tokio::spawn(async move {
        let reader = chat.clone();
        let changed = tokio::task::spawn_blocking(move || reader.read_files(&file, &main, false)).await.unwrap_or(false);
        if changed {
            announce(&ctx, &sid, &chat);
        }
    });
}

/// `session.agentChat` of a live session.
pub(crate) async fn fetch(ctx: &Ctx, agent_id: &str, session_id: &str, p: AgentChatParams) -> Result<AgentChatLog, ApiError> {
    let chat = chat(session_id);
    let (file, main) = source(ctx, agent_id, session_id);
    if let Some(file) = file {
        let reader = chat.clone();
        let changed = tokio::task::spawn_blocking(move || reader.read_files(&file, &main, false))
            .await
            .map_err(|e| ApiError::new("internal", e.to_string()))?;
        if changed {
            announce(ctx, session_id, &chat);
        }
    }
    Ok(chat.page(p.epoch.as_deref(), p.after, tapped(ctx, session_id)))
}

/// `session.agentChat` of a parked agent: its files only.
pub(crate) async fn fetch_parked(session_id: Option<String>, session_file: String, p: AgentChatParams) -> Result<AgentChatLog, ApiError> {
    let chat = chat(session_id.as_deref().unwrap_or(&session_file));
    let reader = chat.clone();
    tokio::task::spawn_blocking(move || reader.read_files(Path::new(&session_file), MAIN_AGENT, false))
        .await
        .map_err(|e| ApiError::new("internal", e.to_string()))?;
    Ok(chat.page(p.epoch.as_deref(), p.after, false))
}

/// The meta of a parked agent's session names its log.
pub(crate) fn parked_info(session_id: Option<&str>, session_file: &str) -> AgentChatInfo {
    chat(session_id.unwrap_or(session_file)).info(false)
}

/// The bridge's tap reported a leg (`irc` event).
pub(crate) fn on_leg(ctx: &Ctx, session_id: &str, leg: IrcLeg) {
    let chat = chat(session_id);
    if chat.absorb([Obs::from_leg(leg)]) {
        announce(ctx, session_id, &chat);
    }
}

/// The user sent subagent `to` a message from TeleFlock (`agent.subagent` chat; `broadcast`: one of
/// a message to every running subagent) when the request went out at `sent`. `error`: why it was
/// not delivered.
pub(crate) fn on_user_chat(ctx: &Ctx, session_id: &str, to: &str, text: &str, broadcast: bool, error: Option<&str>, sent: Millis) {
    let chat = chat(session_id);
    if chat.absorb([Obs::from_user(to, text, broadcast, error, sent)]) {
        announce(ctx, session_id, &chat);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn leg(id: &str, from: &str, to: &str, body: &str, ts: Millis) -> IrcLeg {
        IrcLeg { id: id.into(), from: from.into(), to: to.into(), body: body.into(), ts, ..IrcLeg::default() }
    }

    fn record(file_agent: &str, line: serde_json::Value, scan: &mut IrcFileScan) -> Option<Obs> {
        scan.entry(&line).and_then(|r| Obs::from_record(file_agent, r))
    }

    fn outcomes(m: &AgentChatMessage) -> Vec<(String, String)> {
        m.receipts.iter().map(|r| (r.to.clone(), r.outcome.clone())).collect()
    }

    /// A worker's send seen by the tap (start and end), in its own transcript and in the
    /// recipient's: one message, delivered and received.
    #[test]
    fn one_message_from_every_side() {
        let mut log = Log::new();
        let t = 1_793_568_124_829;
        assert!(log.absorb(Obs::from_leg(leg("p1", "Orch.A", "Orch.B", "Which port?", t + 1))));
        let mut end = leg("p1", "Orch.A", "Orch.B", "Which port?", t + 1);
        end.outcome = Some("injected".into());
        assert!(log.absorb(Obs::from_leg(end.clone())));
        assert!(!log.absorb(Obs::from_leg(end)), "the same event again changes nothing");
        let mut sender = IrcFileScan::new("Orch.A", false);
        let call = json!({"type": "message", "id": "e1", "message": {"role": "assistant", "timestamp": t - 4_000, "content": [{"type": "toolCall", "id": "c1", "name": "write", "arguments": {"path": "agent://Orch.B", "content": "Which port?"}}]}});
        assert!(record("Orch.A", call, &mut sender).is_none());
        let result = json!({"type": "message", "id": "e2", "message": {"role": "toolResult", "toolCallId": "c1", "toolName": "write", "timestamp": t + 5,
            "details": {"message": {"op": "send", "from": "Orch.A", "to": "Orch.B", "receipts": [{"to": "Orch.B", "outcome": "injected"}]}}}});
        log.absorb(record("Orch.A", result, &mut sender).unwrap());
        let mut recipient = IrcFileScan::new("Orch.B", false);
        let inbound = json!({"type": "custom_message", "id": "e9", "customType": "irc:incoming", "timestamp": t + 1, "details": {"id": "omp1", "from": "Orch.A", "message": "Which port?"}});
        log.absorb(record("Orch.B", inbound, &mut recipient).unwrap());
        let page = log.page(None, None, true);
        assert_eq!(page.messages.len(), 1, "{:#?}", page.messages);
        let m = &page.messages[0];
        assert_eq!((m.from.as_str(), m.to.clone(), m.at), ("Orch.A", vec!["Orch.B".to_owned()], t + 1));
        assert_eq!(outcomes(m), vec![("Orch.B".into(), "injected".into())]);
    }

    /// The same text sent twice is two messages, each paired with its own other side, in order.
    #[test]
    fn repeated_texts_stay_apart() {
        let mut log = Log::new();
        for (i, ts) in [1_000_000, 1_020_000].into_iter().enumerate() {
            log.absorb(Obs::from_leg(leg(&format!("p{i}"), "Orch.A", "Orch", "done?", ts)));
        }
        let mut recipient = IrcFileScan::new("Orch", false);
        for (i, ts) in [1_000_000, 1_020_000].into_iter().enumerate() {
            let line = json!({"type": "custom_message", "id": format!("e{i}"), "customType": "irc:incoming", "timestamp": ts, "details": {"id": format!("o{i}"), "from": "Orch.A", "message": "done?"}});
            log.absorb(record("Orch", line, &mut recipient).unwrap());
        }
        let page = log.page(None, None, true);
        assert_eq!(page.messages.iter().map(|m| m.at).collect::<Vec<_>>(), vec![1_000_000, 1_020_000]);
        assert!(page.messages.iter().all(|m| m.receipts[0].outcome == "received"), "taps that did not settle yet, rows that arrived");
    }

    /// omp sends a broadcast as one message per peer: one message to all of them, whichever side
    /// saw which leg.
    #[test]
    fn broadcast_legs_are_one_message() {
        let mut log = Log::new();
        let t = 5_000_000;
        for (i, to) in ["Main", "Orch.B"].into_iter().enumerate() {
            let mut l = leg(&format!("b{i}"), "Orch.A", to, "Heads up: I own src/api.", t);
            l.broadcast = true;
            l.outcome = Some("injected".into());
            log.absorb(Obs::from_leg(l));
        }
        let mut sender = IrcFileScan::new("Orch.A", false);
        record("Orch.A", json!({"type": "message", "id": "e1", "message": {"role": "assistant", "timestamp": t - 2_000, "content": [{"type": "toolCall", "id": "c1", "name": "write", "arguments": {"path": "agent://all", "content": "Heads up: I own src/api."}}]}}), &mut sender);
        let out = record("Orch.A", json!({"type": "message", "id": "e2", "message": {"role": "toolResult", "toolCallId": "c1", "toolName": "write", "timestamp": t + 3,
            "details": {"message": {"op": "send", "from": "Orch.A", "to": "all", "receipts": [{"to": "Main", "outcome": "injected"}, {"to": "Orch.B", "outcome": "injected"}, {"to": "Orch", "outcome": "failed", "error": "busy"}]}}}}), &mut sender);
        log.absorb(out.unwrap());
        let page = log.page(None, None, true);
        assert_eq!(page.messages.len(), 1, "{:#?}", page.messages);
        let m = &page.messages[0];
        assert!(m.broadcast);
        assert_eq!(outcomes(m), vec![("Main".into(), "injected".into()), ("Orch.B".into(), "injected".into()), ("Orch".into(), "failed".into())]);
    }

    /// After a restart only the files tell: a nested orchestrator's message to its child (seen in
    /// both transcripts) and the child's wake relay back, which names it by omp id.
    #[test]
    fn rebuilt_from_files_links_replies() {
        let mut log = Log::new();
        let mut orch = IrcFileScan::new("Orch", false);
        let mut child = IrcFileScan::new("Orch.A", false);
        let t = 9_000_000;
        let call = json!({"type": "message", "id": "o1", "message": {"role": "assistant", "timestamp": t, "content": [{"type": "toolCall", "id": "c1", "name": "write", "arguments": {"path": "agent://Orch.A", "content": "Status?"}}]}});
        assert!(record("Orch", call, &mut orch).is_none());
        let out = record("Orch", json!({"type": "message", "id": "o2", "message": {"role": "toolResult", "toolCallId": "c1", "toolName": "write", "timestamp": t + 40,
            "details": {"message": {"op": "send", "from": "Orch", "to": "Orch.A", "receipts": [{"to": "Orch.A", "outcome": "woken"}]}}}}), &mut orch).unwrap();
        let inbound = record("Orch.A", json!({"type": "custom_message", "id": "a1", "customType": "irc:incoming", "timestamp": t + 20, "details": {"id": "omp-7", "from": "Orch", "message": "Status?", "fromParent": true}}), &mut child).unwrap();
        let relay = record("Orch", json!({"type": "custom_message", "id": "o3", "customType": "irc:incoming", "timestamp": t + 9_000, "details": {"id": "omp-8", "from": "Orch.A", "message": "Tests pass.", "replyTo": "omp-7", "wakeRelay": true}}), &mut orch).unwrap();
        // Any order: the relay first, then the inbound row that names omp-7.
        log.absorb(relay.clone());
        log.absorb(out);
        let before = log.rev();
        log.absorb(inbound);
        let page = log.page(None, None, false);
        assert_eq!(page.messages.len(), 2, "{:#?}", page.messages);
        let (ask, answer) = (&page.messages[0], &page.messages[1]);
        assert_eq!((ask.text.as_str(), ask.at), ("Status?", t + 20));
        assert_eq!(outcomes(ask), vec![("Orch.A".into(), "woken".into())]);
        assert_eq!((answer.reply_to.as_deref(), answer.wake_relay), (Some(ask.id.as_str()), true));
        let changed = log.page(Some(&page.epoch), Some(before), false);
        assert!(changed.messages.iter().any(|m| m.id == answer.id), "the reply's link changed with the id it learned");
        assert!(!log.absorb(relay), "a re-read adds nothing");
    }

    /// A recipient's row that only teaches the log omp's id of a message whose delivery is known
    /// already changes the reply that names that id (it links to that message now): the log says
    /// it changed, so the change is announced and apps fetch it.
    #[test]
    fn a_learned_id_that_relinks_a_reply_is_a_change() {
        let mut log = Log::new();
        let t = 9_000_000;
        // Orch asks Orch.A twice; the tap saw both delivered.
        for (id, text, ts) in [("p1", "Status?", t), ("p2", "Run lint too.", t + 5_000)] {
            let mut l = leg(id, "Orch", "Orch.A", text, ts);
            l.outcome = Some("injected".into());
            log.absorb(Obs::from_leg(l));
        }
        // Orch.A's wake relay answers the first ask by an omp id nothing named yet: the latest ask
        // before it stands in.
        let relay = json!({"type": "custom_message", "id": "o3", "customType": "irc:incoming", "timestamp": t + 9_000, "details": {"id": "omp-8", "from": "Orch.A", "message": "Tests pass.", "replyTo": "omp-7", "wakeRelay": true}});
        log.absorb(record("Orch", relay, &mut IrcFileScan::new("Orch", false)).unwrap());
        let page = log.page(None, None, true);
        assert_eq!(page.messages.len(), 3, "{:#?}", page.messages);
        let (first, second, answer) = (&page.messages[0], &page.messages[1], &page.messages[2]);
        assert_eq!(answer.reply_to.as_deref(), Some(second.id.as_str()));
        // Orch.A's transcript names the first ask's omp id; nothing else about that ask changes.
        let before = log.rev();
        let inbound = json!({"type": "custom_message", "id": "a1", "customType": "irc:incoming", "timestamp": t + 20, "details": {"id": "omp-7", "from": "Orch", "message": "Status?"}});
        assert!(log.absorb(record("Orch.A", inbound, &mut IrcFileScan::new("Orch.A", false)).unwrap()), "the reply's link changed");
        let changed = log.page(Some(&page.epoch), Some(before), true);
        let relinked: Vec<(String, Option<String>)> = changed.messages.iter().map(|m| (m.id.clone(), m.reply_to.clone())).collect();
        assert_eq!(relinked, vec![(answer.id.clone(), Some(first.id.clone()))]);
    }

    /// What the user sent from the board: a message to one subagent, and one to every running
    /// subagent at once (one request each). omp writes each into the subagent's transcript as a
    /// prompt attributed to the user: live these add to the requests' messages, and after a
    /// restart they alone bring the same two messages back (receipts as the transcripts tell).
    #[test]
    fn what_the_user_sent_comes_back_from_the_transcripts() {
        let t = 1_793_570_994_000;
        let prompt = |id: &str, text: &str, at: Millis| json!({"type": "message", "id": id, "message": {"role": "user", "attribution": "user", "timestamp": at, "content": [{"type": "text", "text": text}]}});
        let transcripts = [
            ("Orch", vec![prompt("o1", "Wrap up.", t + 231)]),
            ("Orch.A", vec![prompt("a1", "Thanks.", t + 97), prompt("a2", "Wrap up.", t + 238)]),
            ("Orch.B", vec![prompt("b1", "Wrap up.", t + 369)]),
        ];
        let read = |log: &mut Log| {
            for (agent, lines) in &transcripts {
                let mut scan = IrcFileScan::new(agent, false);
                for line in lines {
                    log.absorb(record(agent, line.clone(), &mut scan).expect("a prompt from the user"));
                }
            }
        };
        let shape = |log: &Log| -> Vec<(String, Vec<String>, bool, String, Vec<(String, String)>)> {
            log.page(None, None, false).messages.iter().map(|m| (m.from.clone(), m.to.clone(), m.broadcast, m.text.clone(), outcomes(m))).collect()
        };
        let want = |outcome: &str| {
            let legs = |ids: &[&str]| ids.iter().map(|id| (id.to_string(), outcome.to_string())).collect::<Vec<_>>();
            vec![
                (USER.to_owned(), vec!["Orch.A".to_owned()], false, "Thanks.".to_owned(), legs(&["Orch.A"])),
                (USER.to_owned(), vec!["Orch".to_owned(), "Orch.A".to_owned(), "Orch.B".to_owned()], true, "Wrap up.".to_owned(), legs(&["Orch", "Orch.A", "Orch.B"])),
            ]
        };

        let mut live = Log::new();
        live.absorb(Obs::from_user("Orch.A", "Thanks.", false, None, t + 90));
        for (i, to) in ["Orch", "Orch.A", "Orch.B"].into_iter().enumerate() {
            live.absorb(Obs::from_user(to, "Wrap up.", true, None, t + 225 + i as Millis * 130));
        }
        assert_eq!(shape(&live), want("injected"), "the requests: one message each");
        read(&mut live);
        assert_eq!(shape(&live), want("injected"), "the transcripts add nothing");

        let mut rebuilt = Log::new();
        read(&mut rebuilt);
        assert_eq!(shape(&rebuilt), want("received"));
        // The same text to the same subagent again is a message of its own.
        rebuilt.absorb(record("Orch.A", prompt("a3", "Thanks.", t + 10_000), &mut IrcFileScan::new("Orch.A", false)).unwrap());
        assert_eq!(rebuilt.page(None, None, false).messages.len(), 3);
    }

    /// Incremental reads of a growing tree of transcript files: nested subagents (in the folder of
    /// the subagent that started them, beside its transcript), a line omp is still writing,
    /// advisors left out.
    #[test]
    fn reads_the_tree_incrementally() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("2026-11-01_s1.jsonl");
        let arts = dir.path().join("2026-11-01_s1");
        std::fs::create_dir_all(arts.join("Orch")).unwrap();
        let write = |p: &Path, s: &str| {
            use std::io::Write as _;
            std::fs::OpenOptions::new().create(true).append(true).open(p).unwrap().write_all(s.as_bytes()).unwrap();
        };
        write(&main, "{\"type\":\"session\",\"id\":\"s1\"}\n");
        write(&arts.join("Orch.jsonl"), "{\"type\":\"session\",\"id\":\"s2\"}\n");
        let b = arts.join("Orch").join("Orch.B.jsonl");
        let line = json!({"type": "custom_message", "id": "x1", "customType": "irc:incoming", "timestamp": 50_000, "details": {"id": "o1", "from": "Orch.A", "message": "port 7420"}}).to_string();
        let (head, rest) = line.split_at(30);
        write(&b, head);
        write(&arts.join("__advisor.default.jsonl"), &format!("{line}\n"));
        let chat = Chat::new();
        assert!(!chat.read_files(&main, MAIN_AGENT, true), "half a line is not read yet");
        write(&b, &format!("{rest}\n"));
        assert!(chat.read_files(&main, MAIN_AGENT, true));
        let page = chat.page(None, None, false);
        assert_eq!(page.messages.len(), 1, "{:#?}", page.messages);
        assert_eq!((page.messages[0].from.as_str(), page.messages[0].to.clone()), ("Orch.A", vec!["Orch.B".to_owned()]));
        assert_eq!(outcomes(&page.messages[0]), vec![("Orch.B".into(), "received".into())]);
        write(&b, "{\"type\":\"model_change\",\"id\":\"x2\"}\n");
        assert!(!chat.read_files(&main, MAIN_AGENT, true), "nothing new");
        // omp rewrote the file (shorter): read from the start again, nothing doubles.
        std::fs::write(&b, format!("{line}\n")).unwrap();
        assert!(!chat.read_files(&main, MAIN_AGENT, true));
        assert_eq!(chat.page(None, None, false).messages.len(), 1);
    }

    /// Only subagent transcripts are read: `<Id>.jsonl` in the artifacts dir, nested ones in the
    /// folder of a subagent whose transcript sits beside it. The session's `local://` root and other
    /// folders are not, whatever they hold: copies of transcripts saved there add no message and no
    /// agent. The walk looks at a bounded number of entries.
    #[test]
    fn reads_subagent_transcripts_only() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("2026-11-01_s1.jsonl");
        let arts = dir.path().join("2026-11-01_s1");
        let t = 70_000;
        let call = json!({"type": "message", "id": "e1", "message": {"role": "assistant", "timestamp": t, "content": [{"type": "toolCall", "id": "c1", "name": "write", "arguments": {"path": "agent://Orch.B", "content": "port 7420"}}]}});
        let result = json!({"type": "message", "id": "e2", "message": {"role": "toolResult", "toolCallId": "c1", "toolName": "write", "timestamp": t + 5,
            "details": {"message": {"op": "send", "from": "Orch.A", "to": "Orch.B", "receipts": [{"to": "Orch.B", "outcome": "injected"}]}}}});
        let inbound = json!({"type": "custom_message", "id": "x1", "customType": "irc:incoming", "timestamp": t + 1, "details": {"id": "o1", "from": "Orch.A", "message": "port 7420"}});
        let (sent, got) = (format!("{call}\n{result}\n"), format!("{inbound}\n"));
        let header = "{\"type\":\"session\",\"id\":\"s2\"}\n".to_owned();
        let orch = arts.join("Orch");
        let files = [
            (main.clone(), header.clone()),
            (arts.join("Orch.jsonl"), header.clone()),
            (orch.join("Orch.A.jsonl"), sent.clone()),
            (orch.join("Orch.B.jsonl"), got.clone()),
            // Not transcripts: copies saved in `local://` (even beside a transcript named after it),
            // an artifact folder of omp's, a folder with no transcript beside it.
            (arts.join("local.jsonl"), header.clone()),
            (arts.join("local").join("copy.jsonl"), format!("{sent}{got}")),
            (arts.join("local").join("Orch").join("Orch.B.jsonl"), got.clone()),
            (arts.join("url-search").join("Orch.C.jsonl"), sent.clone()),
            (arts.join("Gone").join("Gone.D.jsonl"), sent.clone()),
        ];
        for (path, text) in &files {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let mut found = Vec::new();
        let mut budget = MAX_ENTRIES;
        subagent_files(&arts, 0, &mut budget, &mut found);
        found.sort_by(|a, b| a.1.cmp(&b.1));
        let agents: Vec<&str> = found.iter().map(|(_, a)| a.as_str()).collect();
        assert_eq!(agents, ["Orch", "Orch.A", "Orch.B", "local"]);
        assert_eq!(found[1].0, orch.join("Orch.A.jsonl"));
        let chat = Chat::new();
        assert!(chat.read_files(&main, MAIN_AGENT, true));
        let page = chat.page(None, None, false);
        assert_eq!(page.messages.len(), 1, "{:#?}", page.messages);
        assert_eq!((page.messages[0].from.as_str(), page.messages[0].to.clone()), ("Orch.A", vec!["Orch.B".to_owned()]));
        assert_eq!(outcomes(&page.messages[0]), vec![("Orch.B".into(), "injected".into())]);
        let mut budget = 2;
        let mut few = Vec::new();
        subagent_files(&arts, 0, &mut budget, &mut few);
        assert!(few.len() <= 2 && budget == 0, "{few:?}");
    }

    /// A line too long to be an IRC row (a file without a newline, an inline image) is not kept
    /// in memory while it grows: it is skipped to its end, and the lines after it are read.
    #[test]
    fn an_overlong_line_is_skipped_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("2026-11-01_s1.jsonl");
        let arts = dir.path().join("2026-11-01_s1");
        std::fs::create_dir_all(&arts).unwrap();
        std::fs::write(&main, "{\"type\":\"session\",\"id\":\"s1\"}\n").unwrap();
        let b = arts.join("Orch.B.jsonl");
        let row = |id: &str, text: &str| json!({"type": "custom_message", "id": id, "customType": "irc:incoming", "timestamp": 50_000, "details": {"id": id, "from": "Orch.A", "message": text}}).to_string();
        std::fs::write(&b, vec![b' '; MAX_LINE + 1]).unwrap();
        let chat = Chat::new();
        assert!(!chat.read_files(&main, MAIN_AGENT, true));
        let held = || lock(&chat.files).cursors.values().map(|c| c.tail.len()).max().unwrap_or(0);
        assert!(held() <= MAX_LINE, "{} bytes of an unfinished line held", held());
        // The end of the long line (it reads as a row), then a row of its own.
        {
            use std::io::Write as _;
            let mut f = std::fs::OpenOptions::new().append(true).open(&b).unwrap();
            write!(f, "{}\n{}\n", row("x1", "the end of the long line"), row("x2", "port 7420")).unwrap();
        }
        assert!(chat.read_files(&main, MAIN_AGENT, true));
        let texts: Vec<String> = chat.page(None, None, false).messages.iter().map(|m| m.text.clone()).collect();
        assert_eq!(texts, ["port 7420"]);
        assert_eq!(held(), 0);
    }

    #[test]
    fn epochs_differ() {
        assert_ne!(Log::new().epoch, Log::new().epoch);
    }

    #[test]
    fn bounded() {
        let mut log = Log::new();
        for i in 0..(MAX_MESSAGES + 5) {
            log.absorb(Obs::from_leg(leg(&format!("p{i}"), "A", "B", &format!("m{i}"), i as Millis * 10_000)));
        }
        let page = log.page(None, None, true);
        assert_eq!(page.messages.len(), MAX_MESSAGES);
        assert!(page.truncated);
        assert_eq!(page.messages[0].text, "m5", "the oldest went");
    }
}
