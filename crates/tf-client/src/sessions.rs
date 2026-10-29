//! Session mirrors (architecture §5.2): what the app core keeps of every omp session the UI opens.
//!
//! With a hostd that speaks `sessionSync` (`tf_proto::host`, point 7), every open — the UI's, the
//! re-open after a reconnect, a repair — tells hostd what the mirror holds (`session.open
//! {have}`) and gets only the rows it lacks or holds stale. The mirror applies the live stream,
//! verifying `seq` and append offsets (any mismatch silently re-opens with `have`), and turns it
//! back into the plain session events the UI understands (`reset`, `upsert`, `append`, `remove`,
//! `meta`, …). Mirrors are persisted per host and omp session ([`crate::session_cache`]): after
//! an app restart the cached rows show at once and only the delta crosses the network. Older rows
//! paged in once (`session.history`) stay in the mirror and are served from it. Closed mirrors
//! stay in memory up to a size budget per host, least recently used leaving first (the cache
//! keeps them); a mirror an open, a re-open or a write is working on never leaves.
//!
//! A re-open that fails while the link stays up (no answer, the session not shared yet) is tried
//! again, waiting longer each time, as long as the UI has the session open; one that cannot work
//! ends the session for the UI (`ended`, with the reason).
//!
//! With an older hostd, opens and events pass through unchanged; the mirror only remembers what
//! to re-open after a reconnect.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tf_proto::session::{
    AppendField, HistoryPage, RowDigest, SessionEvent, SessionHave, SessionMeta, SessionSnapshot, TranscriptItem, TreeInfo, TreeNode,
    UiRequest,
};
use tf_proto::{ApiError, SessionHistoryParams, SessionOpenParams};

use crate::link::{DEFAULT_TIMEOUT, Link};
use crate::session_cache::{SessionCache, Saved};

/// Rows of a `session.open` without `limit` (tf-hostd's default).
const DEFAULT_LIMIT: usize = 200;
/// Rows of a `session.history` without `limit`.
const DEFAULT_PAGE: usize = 100;
/// Rows `have` lists at most (`SessionHave::rows`).
const HAVE_MAX: usize = 500;
/// Rows a mirror keeps at most (older ones page from the host again).
const MAX_ROWS: usize = 3000;
/// More gap repairs than this within [`REPAIR_WINDOW`] give up on `sessionSync` for the mirror
/// (its next open is a plain subscription).
const MAX_REPAIRS: usize = 3;
const REPAIR_WINDOW: Duration = Duration::from_secs(60);
/// A re-open that found no answer is tried again after this, then after twice as long each time
/// up to [`RETRY_MAX`], while the UI has the session open.
const RETRY_FIRST: Duration = if cfg!(test) { Duration::from_millis(20) } else { Duration::from_secs(1) };
const RETRY_MAX: Duration = if cfg!(test) { Duration::from_millis(80) } else { Duration::from_secs(30) };
/// A changed mirror that stays open is written to the cache on every periodic tick
/// ([`persist_due`], 15 s), a big one once this long passed since its last write: per MiB of it
/// (writing it costs more), up to [`PERSIST_MAX`]…
const PERSIST_PER_MIB: Duration = Duration::from_secs(15);
const PERSIST_MAX: Duration = Duration::from_secs(120);
/// …give or take this (ticks and writes do not keep exact time).
const PERSIST_SLACK: Duration = Duration::from_secs(2);
/// Rows hostd no longer has (live-only rows of an earlier tf-hostd) a history page drops at most
/// before it gives up on paging further back.
const UNKNOWN_MAX: usize = 32;

/// One transcript row the mirror holds, with the hash hostd gave it (`None`: appended to since,
/// or paged in by `session.history`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Row {
    pub item: TranscriptItem,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<String>,
}

/// What a mirror holds of one omp session.
#[derive(Debug, Clone, PartialEq)]
pub struct Data {
    pub session_id: String,
    /// The meta without its tree (that is `tree`).
    pub meta: SessionMeta,
    /// The session tree, shared: meta patches, cache writes and evicted mirrors never copy it.
    pub tree: Option<Arc<TreeInfo>>,
    /// hostd's hash of the meta with its tree (`SessionSync::meta_hash`).
    pub meta_hash: Option<String>,
    /// Oldest first: the window hostd syncs, and older rows paged in.
    pub rows: Vec<Arc<Row>>,
    /// hostd has rows older than `rows[0]`.
    pub has_more: bool,
    pub ui: Option<UiRequest>,
}

/// UTF-8 length of the field an append extends, the way the UI applies appends.
fn field_len(item: &TranscriptItem, field: AppendField) -> Option<usize> {
    Some(match (item, field) {
        (TranscriptItem::User(i), AppendField::Text) => i.text.len(),
        (TranscriptItem::Assistant(i), AppendField::Text) => i.text.len(),
        (TranscriptItem::Thinking(i), AppendField::Text) => i.text.len(),
        (TranscriptItem::Notice(i), AppendField::Text) => i.text.len(),
        (TranscriptItem::Mode(i), AppendField::Text) => i.text.len(),
        (TranscriptItem::Tool(i), AppendField::Output) => i.output.as_ref().map_or(0, String::len),
        _ => return None,
    })
}

fn append(item: &mut TranscriptItem, field: AppendField, text: &str) {
    match (item, field) {
        (TranscriptItem::User(i), AppendField::Text) => i.text.push_str(text),
        (TranscriptItem::Assistant(i), AppendField::Text) => i.text.push_str(text),
        (TranscriptItem::Thinking(i), AppendField::Text) => i.text.push_str(text),
        (TranscriptItem::Notice(i), AppendField::Text) => i.text.push_str(text),
        (TranscriptItem::Mode(i), AppendField::Text) => i.text.push_str(text),
        (TranscriptItem::Tool(i), AppendField::Output) => i.output.get_or_insert_with(String::new).push_str(text),
        _ => {}
    }
}

/// Applies a `treePatch` the way tf-hostd computes them (`tf_hostd::sync::tree_patch`): removed
/// nodes go, changed ones are replaced in place, new ones are appended in the patch's order.
fn apply_tree_patch(tree: &mut TreeInfo, upsert: Vec<TreeNode>, remove: &[String], leaf_id: Option<String>) {
    if !remove.is_empty() {
        let gone: HashSet<&str> = remove.iter().map(String::as_str).collect();
        tree.nodes.retain(|n| !gone.contains(n.id.as_str()));
    }
    let mut at: HashMap<String, usize> = tree.nodes.iter().enumerate().map(|(i, n)| (n.id.clone(), i)).collect();
    for n in upsert {
        match at.get(&n.id) {
            Some(&i) => tree.nodes[i] = n,
            None => {
                at.insert(n.id.clone(), tree.nodes.len());
                tree.nodes.push(n);
            }
        }
    }
    tree.leaf_id = leaf_id;
}

/// A meta from hostd as a mirror keeps it: without its tree, and the tree shared.
fn split(mut meta: SessionMeta) -> (SessionMeta, Option<Arc<TreeInfo>>) {
    let tree = meta.tree.take().map(Arc::new);
    (meta, tree)
}

impl Data {
    /// What a `session.open` sends when nothing is cached.
    fn empty_have(session_id: Option<&str>) -> SessionHave {
        SessionHave { session_id: session_id.unwrap_or_default().to_owned(), rows: Vec::new(), meta_hash: None }
    }

    /// `session.open { have }`: the newest `limit` rows we hold a hash for, newest first.
    fn have(&self, limit: usize) -> SessionHave {
        SessionHave {
            session_id: self.session_id.clone(),
            rows: self
                .rows
                .iter()
                .rev()
                .take(limit.min(HAVE_MAX))
                .filter_map(|r| r.h.as_ref().map(|h| RowDigest { id: r.item.id().to_owned(), h: h.clone() }))
                .collect(),
            meta_hash: self.meta_hash.clone(),
        }
    }

    fn index(&self, id: &str) -> Option<usize> {
        self.rows.iter().rposition(|r| r.item.id() == id)
    }

    /// The meta with its tree, as the UI gets it in a `reset`.
    pub fn full_meta(&self) -> SessionMeta {
        SessionMeta { tree: self.tree.as_deref().cloned(), ..self.meta.clone() }
    }

    /// Holds what `other` holds, as far as the cache is concerned: the same rows (shared), the
    /// same meta hash.
    fn same_as(&self, other: &Data) -> bool {
        self.session_id == other.session_id
            && self.meta_hash.is_some()
            && self.meta_hash == other.meta_hash
            && self.has_more == other.has_more
            && self.rows.len() == other.rows.len()
            && self.rows.iter().zip(&other.rows).all(|(a, b)| Arc::ptr_eq(a, b))
    }

    /// The newest `n` rows as the snapshot the UI gets.
    pub fn window(&self, agent_id: &str, n: usize) -> SessionSnapshot {
        let start = self.rows.len().saturating_sub(n);
        let has_more = start > 0 || self.has_more;
        SessionSnapshot {
            agent_id: agent_id.to_owned(),
            meta: self.full_meta(),
            items: self.rows[start..].iter().map(|r| r.item.clone()).collect(),
            has_more,
            cursor: if has_more { self.rows.get(start).map(|r| r.item.id().to_owned()) } else { None },
            ui: self.ui.clone(),
            sync: None,
        }
    }

    /// Folds a snapshot hostd sent with `sync` (an open, a live reset) into what `prev` holds.
    /// A delta lists the window in `order`; rows it does not carry come from `prev`. Rows older
    /// than the window stay when its first row is one we hold unchanged (the same entry has the
    /// same ancestors), so pages paged in earlier survive; other rows of `prev` go.
    pub fn merge(prev: Option<&Data>, mut snap: SessionSnapshot) -> Result<Data, String> {
        let Some(sync) = snap.sync.take() else {
            // No sync (a parked agent's transcript, a plain fallback): rows without hashes.
            let (meta, tree) = split(snap.meta);
            return Ok(Data {
                session_id: meta.session_id.clone().unwrap_or_default(),
                rows: snap.items.into_iter().map(|item| Arc::new(Row { item, h: None })).collect(),
                meta,
                tree,
                meta_hash: None,
                has_more: snap.has_more,
                ui: snap.ui,
            });
        };
        let mut hashes: HashMap<String, String> = sync.hashes.into_iter().map(|d| (d.id, d.h)).collect();
        let (meta, tree) = if sync.meta_same {
            let p = prev.ok_or("meta_same without a cached meta")?;
            (p.meta.clone(), p.tree.clone())
        } else {
            split(snap.meta)
        };
        let session_id = meta.session_id.clone().or_else(|| prev.map(|p| p.session_id.clone())).unwrap_or_default();
        let prev = prev.filter(|p| p.session_id == session_id);
        let pos: HashMap<&str, usize> = prev.map(|p| p.rows.iter().enumerate().map(|(i, r)| (r.item.id(), i)).collect()).unwrap_or_default();
        let window: Vec<Arc<Row>> = if sync.delta {
            let order = sync.order.ok_or("a delta snapshot without order")?;
            let mut fresh: HashMap<String, TranscriptItem> = snap.items.into_iter().map(|i| (i.id().to_owned(), i)).collect();
            let mut window = Vec::with_capacity(order.len());
            for id in order {
                match fresh.remove(&id) {
                    Some(item) => window.push(Arc::new(Row { h: hashes.remove(&id), item })),
                    None => match (prev, pos.get(id.as_str())) {
                        (Some(p), Some(&i)) => window.push(p.rows[i].clone()),
                        _ => return Err(format!("row {id} is in the window but not cached")),
                    },
                }
            }
            window
        } else {
            snap.items.into_iter().map(|item| Arc::new(Row { h: hashes.remove(item.id()), item })).collect()
        };
        // The window's first row, held unchanged: everything we hold before it is still its past.
        let anchor = match (prev, window.first()) {
            (Some(p), Some(first)) => pos.get(first.item.id()).copied().filter(|&i| Arc::ptr_eq(&p.rows[i], first) || (first.h.is_some() && p.rows[i].h == first.h)),
            _ => None,
        };
        let (mut rows, has_more) = match (prev, anchor) {
            (Some(p), Some(i)) => {
                let in_window: HashSet<&str> = window.iter().map(|r| r.item.id()).collect();
                (p.rows[..i].iter().filter(|r| !in_window.contains(r.item.id())).cloned().collect::<Vec<_>>(), p.has_more)
            }
            _ => (Vec::new(), snap.has_more),
        };
        rows.extend(window);
        let mut d = Data { session_id, meta, tree, meta_hash: Some(sync.meta_hash), rows, has_more, ui: snap.ui };
        d.trim();
        Ok(d)
    }

    /// Drops the oldest rows beyond [`MAX_ROWS`].
    fn trim(&mut self) {
        if self.rows.len() > MAX_ROWS {
            let n = self.rows.len() - MAX_ROWS;
            self.rows.drain(..n);
            self.has_more = true;
        }
    }

    /// Applies one live `sessionSync` event (not `reset`); returns what the UI gets.
    /// `Err`: we no longer hold what hostd thinks (re-open with `have`).
    pub fn apply(&mut self, ev: SessionEvent) -> Result<SessionEvent, String> {
        Ok(match ev {
            SessionEvent::Upsert { item, h } => {
                let row = Arc::new(Row { item: item.clone(), h });
                match self.index(item.id()) {
                    Some(i) => self.rows[i] = row,
                    None => {
                        self.rows.push(row);
                        self.trim();
                    }
                }
                SessionEvent::Upsert { item, h: None }
            }
            SessionEvent::Append { id, field, text, at } => {
                let i = self.index(&id).ok_or_else(|| format!("append to {id}, which is not held"))?;
                let row = Arc::make_mut(&mut self.rows[i]);
                let len = field_len(&row.item, field).ok_or_else(|| format!("append to {id}'s {field:?}, which it lacks"))?;
                if let Some(at) = at
                    && at != len as u64
                {
                    return Err(format!("append to {id} at {at}, holding {len} bytes"));
                }
                append(&mut row.item, field, &text);
                row.h = None;
                SessionEvent::Append { id, field, text, at: None }
            }
            SessionEvent::Remove { id } => {
                if let Some(i) = self.index(&id) {
                    self.rows.remove(i);
                }
                SessionEvent::Remove { id }
            }
            SessionEvent::MetaPatch { set, hash } => {
                // The meta without its tree: a patch never copies the tree (it is not in `set`).
                let mut v = serde_json::to_value(&self.meta).map_err(|e| e.to_string())?;
                let obj = v.as_object_mut().ok_or("meta is not an object")?;
                for (k, val) in set {
                    if k == "tree" {
                        continue;
                    }
                    if val.is_null() {
                        obj.remove(&k);
                    } else {
                        obj.insert(k, val);
                    }
                }
                self.meta = serde_json::from_value(v).map_err(|e| format!("meta patch: {e}"))?;
                self.meta_hash = Some(hash);
                // The UI keeps its tree when a `meta` comes without one.
                SessionEvent::Meta { meta: self.meta.clone() }
            }
            SessionEvent::TreePatch { upsert, remove, leaf_id, hash } => {
                let tree = self.tree.get_or_insert_with(|| Arc::new(TreeInfo { nodes: Vec::new(), leaf_id: None }));
                apply_tree_patch(Arc::make_mut(tree), upsert, &remove, leaf_id);
                self.meta_hash = Some(hash);
                SessionEvent::Meta { meta: self.full_meta() }
            }
            SessionEvent::Meta { meta } => {
                // A whole meta (tf-hostd sends one when a patch cannot say it): hash unknown.
                let out = meta.clone();
                (self.meta, self.tree) = split(meta);
                self.meta_hash = None;
                SessionEvent::Meta { meta: out }
            }
            SessionEvent::Ui { request } => {
                self.ui = request.clone();
                SessionEvent::Ui { request }
            }
            ev @ (SessionEvent::Btw { .. } | SessionEvent::Ended { .. } | SessionEvent::Reset { .. }) => ev,
        })
    }

    /// Rows older than `cursor` that we hold (`None`: ask hostd).
    pub fn older(&self, cursor: &str, limit: usize) -> Option<HistoryPage> {
        let i = self.index(cursor)?;
        if i == 0 {
            return None;
        }
        let start = i.saturating_sub(limit);
        let has_more = start > 0 || self.has_more;
        Some(HistoryPage {
            items: self.rows[start..i].iter().map(|r| r.item.clone()).collect(),
            has_more,
            cursor: has_more.then(|| self.rows[start].item.id().to_owned()),
        })
    }

    /// Keeps a page hostd sent for `cursor` when it continues our oldest row.
    pub fn prepend(&mut self, cursor: &str, page: &HistoryPage) -> bool {
        if self.rows.first().is_none_or(|r| r.item.id() != cursor) {
            return false;
        }
        let held: HashSet<&str> = self.rows.iter().map(|r| r.item.id()).collect();
        let older: Vec<Arc<Row>> = page.items.iter().filter(|i| !held.contains(i.id())).map(|i| Arc::new(Row { item: i.clone(), h: None })).collect();
        self.rows.splice(0..0, older);
        self.has_more = page.has_more;
        self.trim();
        true
    }
}

/// What a host's session mirrors need from the engine.
pub trait SessionHost: Send + Sync + 'static {
    fn host_id(&self) -> &str;
    fn sessions(&self) -> &Sessions;
    fn cache(&self) -> &SessionCache;
    /// The host's current link.
    fn link(&self) -> Option<Arc<Link>>;
    /// Delivers a session event to the UI.
    fn emit(&self, agent_id: &str, ev: SessionEvent);
    /// What host state says of an agent.
    fn agent(&self, agent_id: &str) -> AgentHint;
}

/// [`SessionHost::agent`].
#[derive(Debug, Clone, Default)]
pub struct AgentHint {
    /// Its omp session (the cache key).
    pub session_id: Option<String>,
    /// hostd has the session live (an open will most likely succeed).
    pub live: bool,
}

/// Where a mirror's subscription stands.
#[derive(Default)]
enum Sub {
    /// None on the current link.
    #[default]
    None,
    /// `session.open` in flight on `link` (an open, a reconnect, a repair): the session messages
    /// arriving meanwhile wait here until the snapshot says where they start.
    Opening { link: u64, buffer: Vec<(SessionEvent, Option<u64>)> },
    /// Subscribed on `link`; `seq`: the last message applied (`None`: a plain subscription, its
    /// events pass through).
    Live { link: u64, seq: Option<u64> },
}

struct State {
    /// The UI has it open: re-opened after a reconnect.
    wanted: bool,
    /// Rows the UI asked for.
    limit: usize,
    sub: Sub,
    data: Option<Data>,
    /// `data` changed since the cache was written.
    dirty: bool,
    /// When the cache was last written (or read) for `data`, and its size then (JSON bytes): a
    /// big mirror that stays open is written less often ([`persist_due`]).
    saved: Option<(Instant, usize)>,
    /// What `data` takes, roughly (its JSON bytes; `None`: not measured since it changed).
    weight: Option<usize>,
    /// Recent gap repairs (storm guard).
    repairs: VecDeque<Instant>,
    /// Too many repairs: opens go without `have` (a plain subscription) until the UI closes it.
    plain: bool,
    /// Last opened or closed (closed mirrors leave memory least recently used first).
    used: Instant,
}

impl State {
    fn new() -> State {
        State {
            wanted: false,
            limit: 0,
            sub: Sub::None,
            data: None,
            dirty: false,
            saved: None,
            weight: None,
            repairs: VecDeque::new(),
            plain: false,
            used: Instant::now(),
        }
    }

    /// `data` changed: the cache is behind, its size unknown.
    fn changed(&mut self) {
        self.dirty = true;
        self.weight = None;
    }

    /// Takes `d` (a merge of what it held), changed or not.
    fn take(&mut self, d: Data) {
        if !self.data.as_ref().is_some_and(|p| p.same_as(&d)) {
            self.changed();
        }
        self.data = Some(d);
    }

    /// Closed and written to the cache: memory may let it go.
    fn idle(&self) -> bool {
        !self.wanted && !self.dirty && matches!(self.sub, Sub::None)
    }

    /// [`State::weight`], measured when unknown.
    fn weight(&mut self) -> usize {
        match self.weight {
            Some(w) => w,
            None => {
                let w = self.data.as_ref().map_or(0, weight_of);
                self.weight = Some(w);
                w
            }
        }
    }

    /// A `session` message from link `link`. True when it shows a gap: the caller re-opens.
    fn event(&mut self, host: &dyn SessionHost, agent: &str, link: u64, ev: SessionEvent, seq: Option<u64>) -> bool {
        let last = match &mut self.sub {
            Sub::Opening { link: l, buffer } if *l == link => {
                buffer.push((ev, seq));
                return false;
            }
            Sub::Live { link: l, seq } if *l == link => *seq,
            // Another link's, or a session no longer open.
            _ => return false,
        };
        match (last, seq) {
            (None, _) => {
                let ended = matches!(ev, SessionEvent::Ended { .. });
                host.emit(agent, ev);
                if ended {
                    self.sub = Sub::None;
                    self.wanted = false;
                }
                false
            }
            (Some(last), Some(s)) if s == last + 1 => {
                self.sub = Sub::Live { link, seq: Some(s) };
                match self.apply(host, agent, ev) {
                    Ok(()) => false,
                    Err(why) => {
                        log::info!("session {agent}: {why}; re-opening");
                        self.sub = Sub::Opening { link, buffer: Vec::new() };
                        true
                    }
                }
            }
            (Some(last), s) => {
                log::info!("session {agent}: message {s:?} after {last}; re-opening");
                self.sub = Sub::Opening { link, buffer: Vec::new() };
                true
            }
        }
    }

    fn apply(&mut self, host: &dyn SessionHost, agent: &str, ev: SessionEvent) -> Result<(), String> {
        match ev {
            SessionEvent::Reset { snapshot } => {
                let n = snapshot.sync.as_ref().and_then(|s| s.order.as_ref().map(Vec::len)).unwrap_or(snapshot.items.len());
                let d = Data::merge(self.data.as_ref(), snapshot)?;
                let window = d.window(agent, n.max(self.limit));
                self.take(d);
                host.emit(agent, SessionEvent::Reset { snapshot: window });
            }
            SessionEvent::Ended { reason } => {
                self.sub = Sub::None;
                self.wanted = false;
                host.emit(agent, SessionEvent::Ended { reason });
            }
            ev => {
                // What the cache keeps: rows, meta, tree (not the dialog, not side answers).
                let kept = !matches!(ev, SessionEvent::Ui { .. } | SessionEvent::Btw { .. });
                let d = self.data.as_mut().ok_or("a live event before the snapshot")?;
                let out = d.apply(ev)?;
                if kept {
                    self.changed();
                }
                host.emit(agent, out);
            }
        }
        Ok(())
    }

    /// Counts a repair; false (and opens go plain from now on) when there were too many.
    fn note_repair(&mut self, agent: &str) -> bool {
        let now = Instant::now();
        while self.repairs.front().is_some_and(|t| now.duration_since(*t) > REPAIR_WINDOW) {
            self.repairs.pop_front();
        }
        self.repairs.push_back(now);
        if self.repairs.len() > MAX_REPAIRS && !self.plain {
            log::warn!("session {agent}: {} re-opens within a minute; syncing it without the cache", self.repairs.len());
            self.plain = true;
        }
        !self.plain
    }
}

/// What the app core keeps of one agent's session.
pub struct Mirror {
    agent_id: String,
    /// One open at a time (the UI's, a reconnect's, a repair).
    opening: tokio::sync::Mutex<()>,
    /// One cache write at a time.
    persisting: tokio::sync::Mutex<()>,
    st: Mutex<State>,
}

impl Mirror {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// The session mirrors of one host.
#[derive(Default)]
pub struct Sessions {
    mirrors: Mutex<HashMap<String, Arc<Mirror>>>,
}

impl Sessions {
    fn map(&self) -> MutexGuard<'_, HashMap<String, Arc<Mirror>>> {
        self.mirrors.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn mirror(&self, agent_id: &str) -> Arc<Mirror> {
        self.map()
            .entry(agent_id.to_owned())
            .or_insert_with(|| {
                Arc::new(Mirror {
                    agent_id: agent_id.to_owned(),
                    opening: tokio::sync::Mutex::new(()),
                    persisting: tokio::sync::Mutex::new(()),
                    st: Mutex::new(State::new()),
                })
            })
            .clone()
    }

    fn get(&self, agent_id: &str) -> Option<Arc<Mirror>> {
        self.map().get(agent_id).cloned()
    }

    fn all(&self) -> Vec<Arc<Mirror>> {
        self.map().values().cloned().collect()
    }

    /// The link went down: no subscription survives it (the UI's sessions stay wanted).
    pub fn link_down(&self) {
        for m in self.all() {
            m.lock().sub = Sub::None;
        }
    }

    /// The UI went away (webview reload): nothing is open any more. Returns what was.
    pub fn page_closed(&self) -> Vec<String> {
        let mut open = Vec::new();
        for m in self.all() {
            let mut st = m.lock();
            if st.wanted {
                open.push(m.agent_id.clone());
            }
            st.wanted = false;
            st.plain = false;
            st.sub = Sub::None;
        }
        open
    }

    /// Forgets closed mirrors (their data is in the cache), least recently used first, until the
    /// rest take at most `budget` bytes. A mirror anyone else holds — an open loading it, a
    /// re-open, a write, a history page — is never forgotten: whoever holds it would go on with a
    /// mirror the host no longer routes events to.
    fn evict_idle(&self, budget: usize) {
        // Measured outside the map's lock (a big mirror takes a while).
        let idle: Vec<(String, Arc<Mirror>)> =
            self.map().iter().filter(|(_, m)| Arc::strong_count(m) == 1 && m.lock().idle()).map(|(id, m)| (id.clone(), m.clone())).collect();
        let mut sized: Vec<(Instant, usize, String)> = idle.iter().map(|(id, m)| {
            let mut st = m.lock();
            (st.used, st.weight(), id.clone())
        }).collect();
        drop(idle);
        let mut total: usize = sized.iter().map(|(_, w, _)| w).sum();
        if total <= budget {
            return;
        }
        sized.sort();
        let mut map = self.map();
        for (_, w, id) in sized {
            if total <= budget {
                break;
            }
            // Still nobody else's and closed: an open takes its mirror out of the map under this
            // lock, so it either holds it already (and it stays) or finds it gone.
            if map.get(&id).is_some_and(|m| Arc::strong_count(m) == 1 && m.lock().idle()) {
                map.remove(&id);
            }
            total -= w;
        }
    }
}

/// Roughly what a mirror's data takes in memory: the size of its JSON.
fn weight_of(d: &Data) -> usize {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0 += buf.len();
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut n = Count(0);
    // Serializing our own wire types into a counter cannot fail.
    let _ = serde_json::to_writer(&mut n, &d.meta);
    let _ = serde_json::to_writer(&mut n, &d.tree.as_deref());
    for r in &d.rows {
        let _ = serde_json::to_writer(&mut n, &**r);
    }
    n.0
}

fn internal(what: impl std::fmt::Display) -> ApiError {
    ApiError::new("internal", what.to_string())
}

/// A `session` message from link `link` (the link's reader task, in order).
pub fn on_event(host: &Arc<dyn SessionHost>, link: u64, agent_id: String, ev: SessionEvent, seq: Option<u64>) {
    let Some(m) = host.sessions().get(&agent_id) else {
        // Not opened through a mirror: plain events pass, `sessionSync` ones mean nothing to the UI.
        if seq.is_none() {
            host.emit(&agent_id, ev);
        }
        return;
    };
    let gap = m.lock().event(host.as_ref(), &agent_id, link, ev, seq);
    if gap {
        tokio::spawn(repair(host.clone(), link, m, true));
    }
}

/// Loads the cached session `session_id` into `m` unless it holds it already (writing back what
/// it holds of another session first).
async fn load(host: &Arc<dyn SessionHost>, m: &Arc<Mirror>, session_id: &str) {
    let other = {
        let mut st = m.lock();
        match &st.data {
            Some(d) if d.session_id == session_id => return,
            Some(d) if st.dirty && d.meta_hash.is_some() => {
                let s = Saved::of(d);
                st.dirty = false;
                Some(s)
            }
            _ => None,
        }
    };
    if let Some(s) = other {
        host.cache().store(host.host_id(), s).await;
    }
    let loaded = host.cache().load(host.host_id(), session_id).await;
    let mut st = m.lock();
    if st.data.as_ref().is_none_or(|d| d.session_id != session_id) {
        let size = loaded.as_ref().map(|(_, size)| *size);
        st.data = loaded.map(|(d, _)| d);
        st.saved = size.map(|s| (Instant::now(), s));
        st.weight = size;
        st.dirty = false;
    }
}

/// `session.open` (with what `m` holds) on `link`, merged into `m`; then the messages that came
/// meanwhile. `announce`: the UI shows this session already and gets the result as a `reset`
/// (and an `ended`, error `ended`, when the session ended while it opened).
/// `Ok(Some(answer))`: hostd answered plainly (a parked agent; the fallback after repeated
/// repairs), events pass through.
async fn sync_open(host: &Arc<dyn SessionHost>, link: &Arc<Link>, m: &Arc<Mirror>, limit: usize, session_hint: Option<&str>, announce: bool) -> Result<Option<Value>, ApiError> {
    let agent = m.agent_id.as_str();
    let mut full = false;
    'reopen: for _ in 0..=MAX_REPAIRS + 1 {
        let params = {
            let mut st = m.lock();
            let buffer = match std::mem::take(&mut st.sub) {
                Sub::Opening { link: l, buffer } if l == link.id => buffer,
                _ => Vec::new(),
            };
            st.sub = Sub::Opening { link: link.id, buffer };
            let have = match (&st.data, st.plain, full) {
                (_, true, _) => None,
                (Some(d), false, false) => Some(d.have(limit)),
                _ => Some(Data::empty_have(session_hint)),
            };
            serde_json::json!({ "agentId": agent, "limit": limit, "have": have })
        };
        let r = link.request("session.open", params, DEFAULT_TIMEOUT).await;
        let subscribed = r.is_ok();
        // From the answer until the subscription is live the mirror stays locked (no message
        // slips past), and nothing awaits. `true`: it was closed (by the UI, a page close) or the
        // link went down while it opened.
        let closed = 'answer: {
            let mut st = m.lock();
            let buffer = match std::mem::take(&mut st.sub) {
                Sub::Opening { link: l, buffer } if l == link.id => buffer,
                other => {
                    st.sub = other;
                    break 'answer true;
                }
            };
            let v = match r {
                Ok(v) => v,
                Err(e) => {
                    // The session ended while it opened: its last message says so, nothing else will.
                    let ended = buffer.into_iter().find_map(|(ev, _)| match ev {
                        SessionEvent::Ended { reason } => Some(reason),
                        _ => None,
                    });
                    let Some(reason) = ended else { return Err(e) };
                    st.wanted = false;
                    drop(st);
                    if announce {
                        host.emit(agent, SessionEvent::Ended { reason: reason.clone() });
                    }
                    return Err(ApiError::new("ended", reason));
                }
            };
            let snap: SessionSnapshot = serde_json::from_value(v.clone()).map_err(|e| internal(format!("session.open: {e}")))?;
            let Some(base) = snap.sync.as_ref().map(|s| s.seq) else {
                st.sub = Sub::Live { link: link.id, seq: None };
                if announce {
                    host.emit(agent, SessionEvent::Reset { snapshot: snap });
                }
                for (ev, seq) in buffer {
                    // The earlier subscription's numbered messages are stale.
                    if seq.is_none() {
                        st.event(host.as_ref(), agent, link.id, ev, None);
                    }
                }
                return Ok(Some(v));
            };
            let n = snap.sync.as_ref().and_then(|s| s.order.as_ref().map(Vec::len)).unwrap_or(snap.items.len());
            match Data::merge(st.data.as_ref(), snap) {
                Ok(d) => st.take(d),
                Err(why) if !full => {
                    log::info!("session {agent}: {why}; re-opening without the cache");
                    full = true;
                    st.sub = Sub::Opening { link: link.id, buffer };
                    continue 'reopen;
                }
                Err(why) => return Err(internal(why)),
            }
            st.sub = Sub::Live { link: link.id, seq: Some(base) };
            if announce {
                let window = st.data.as_ref().map(|d| d.window(agent, n.max(limit)));
                if let Some(snapshot) = window {
                    host.emit(agent, SessionEvent::Reset { snapshot });
                }
            }
            // Messages that came while it opened: the snapshot holds those up to `base`.
            let mut gap = false;
            for (ev, seq) in buffer {
                if seq.is_some_and(|s| s <= base) {
                    continue;
                }
                gap |= st.event(host.as_ref(), agent, link.id, ev, seq);
            }
            if !gap {
                return Ok(None);
            }
            st.note_repair(agent);
            false
        };
        if closed {
            // hostd subscribed all the same: release that before this mirror's next open goes out
            // (whoever opens it next waits for this one), or it streams to us until the link ends.
            if subscribed && !link.is_closed() {
                let _ = link.request("session.close", serde_json::json!({ "agentId": agent }), DEFAULT_TIMEOUT).await;
            }
            return Err(ApiError::new("not_connected", "the session was closed while it opened").retryable());
        }
    }
    m.lock().sub = Sub::None;
    Err(internal("the session kept changing under its re-opens").retryable())
}

/// Re-opens `m` on link `link`: right away after a gap (`gap`; unless another open got there
/// first), else after a re-open that failed. One that finds no answer (or no session: the bridge
/// reconnecting) is tried again after [`RETRY_FIRST`], twice as long each time up to
/// [`RETRY_MAX`], while the UI has the session open and the link is up (a reconnect re-opens it
/// otherwise). One that cannot work ends the session for the UI.
async fn repair(host: Arc<dyn SessionHost>, link: u64, m: Arc<Mirror>, gap: bool) {
    let mut wait = RETRY_FIRST;
    let mut first = gap;
    loop {
        if !first {
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(RETRY_MAX);
        }
        let r = {
            let _one = m.opening.lock().await;
            let Some(l) = host.link().filter(|l| l.id == link && !l.is_closed()) else { return };
            let limit = {
                let mut st = m.lock();
                if first {
                    if !matches!(st.sub, Sub::Opening { link: x, .. } if x == link) {
                        return;
                    }
                    st.note_repair(&m.agent_id);
                } else if !st.wanted || !matches!(st.sub, Sub::None) {
                    // Closed meanwhile, or open again.
                    return;
                }
                st.limit.max(1)
            };
            let hint = host.agent(&m.agent_id).session_id;
            sync_open(&host, &l, &m, limit, hint.as_deref(), true).await
        };
        first = false;
        match r {
            Ok(_) => return,
            Err(e) if e.code == "ended" => return,
            Err(e) if retry_later(&e) => log::info!("session {}: re-open failed ({}); trying again in {wait:?}", m.agent_id, e.message),
            Err(e) => {
                m.lock().wanted = false;
                host.emit(&m.agent_id, SessionEvent::Ended { reason: e.message });
                return;
            }
        }
    }
}

/// A failed `session.open` worth trying again: no answer, or no session yet.
fn retry_later(e: &ApiError) -> bool {
    matches!(e.code.as_str(), "not_connected" | "timeout")
}

/// `session.open` from the UI.
pub async fn open(host: &Arc<dyn SessionHost>, link: &Arc<Link>, p: &SessionOpenParams) -> Result<Value, ApiError> {
    let agent = p.agent_id.as_str();
    let limit = p.limit.map_or(DEFAULT_LIMIT, |l| (l as usize).clamp(1, 2000));
    // Held until it returns: while it is, no eviction forgets the mirror.
    let m = host.sessions().mirror(agent);
    let _one = m.opening.lock().await;
    let opened = |m: &Mirror| {
        let mut st = m.lock();
        st.wanted = true;
        st.limit = limit;
        st.used = Instant::now();
    };
    if !link.features.session_sync {
        let v = link.request("session.open", serde_json::to_value(p).map_err(internal)?, DEFAULT_TIMEOUT).await?;
        opened(&m);
        m.lock().sub = Sub::Live { link: link.id, seq: None };
        return Ok(v);
    }
    // Subscribed on this link already (another tab, the UI re-opening after our reconnect).
    {
        let st = m.lock();
        if let (Sub::Live { link: l, seq: Some(_) }, Some(d)) = (&st.sub, &st.data)
            && *l == link.id
        {
            let snap = d.window(agent, limit);
            drop(st);
            opened(&m);
            return serde_json::to_value(&snap).map_err(internal);
        }
    }
    let hint = host.agent(agent);
    if let Some(sid) = &hint.session_id {
        load(host, &m, sid).await;
    }
    {
        // The cached rows show at once; the delta follows.
        let st = m.lock();
        if !st.wanted
            && hint.live
            && let Some(d) = st.data.as_ref().filter(|d| hint.session_id.as_deref() == Some(d.session_id.as_str()))
        {
            host.emit(agent, SessionEvent::Reset { snapshot: d.window(agent, limit) });
        }
    }
    let plain = sync_open(host, link, &m, limit, hint.session_id.as_deref(), false).await?;
    opened(&m);
    match plain {
        Some(v) => Ok(v),
        None => {
            let snap = m.lock().data.as_ref().map(|d| d.window(agent, limit)).ok_or_else(|| internal("no session after the open"))?;
            serde_json::to_value(&snap).map_err(internal)
        }
    }
}

/// `session.history` from the UI: rows the mirror holds come from it (a page it holds only part
/// of is completed from hostd), and pages hostd sends that continue its oldest row are kept. A
/// mirror's oldest rows that hostd no longer has (live-only rows of an earlier tf-hostd: hostd
/// says `not_found`) are dropped, and the page continues from the next row.
pub async fn history(host: &Arc<dyn SessionHost>, link: &Arc<Link>, p: &SessionHistoryParams) -> Result<Value, ApiError> {
    let limit = p.limit.map_or(DEFAULT_PAGE, |l| (l as usize).clamp(1, 2000));
    let m = host.sessions().get(&p.agent_id);
    let cached = m.as_ref().and_then(|m| m.lock().data.as_ref().and_then(|d| d.older(&p.cursor, limit)));
    if let Some(page) = &cached
        && (page.items.len() >= limit || !page.has_more)
    {
        return serde_json::to_value(page).map_err(internal);
    }
    // The rest from hostd, from where the mirror's rows end.
    let (mut cursor, want) = match &cached {
        Some(page) => (page.cursor.clone().unwrap_or_else(|| p.cursor.clone()), limit - page.items.len()),
        None => (p.cursor.clone(), limit),
    };
    let mut dropped = 0;
    let v = loop {
        let params = serde_json::json!({ "agentId": p.agent_id, "cursor": cursor, "limit": want });
        match link.request("session.history", params, DEFAULT_TIMEOUT).await {
            Ok(v) => break v,
            Err(e) if e.code == "not_found" && dropped < UNKNOWN_MAX => {
                let next = m.as_ref().and_then(|m| {
                    let mut st = m.lock();
                    let d = st.data.as_mut().filter(|d| d.rows.first().is_some_and(|r| r.item.id() == cursor))?;
                    d.rows.remove(0);
                    let next = d.rows.first().map(|r| r.item.id().to_owned());
                    st.changed();
                    next
                });
                let Some(next) = next else { return Err(e) };
                log::info!("session {}: hostd no longer has row {cursor}; paging on from {next}", p.agent_id);
                cursor = next;
                dropped += 1;
            }
            Err(e) => return Err(e),
        }
    };
    let Some(m) = m.filter(|m| m.lock().data.is_some()) else { return Ok(v) };
    let fetched: HistoryPage = serde_json::from_value(v).map_err(|e| internal(format!("session.history: {e}")))?;
    {
        let mut st = m.lock();
        let kept = st.data.as_mut().is_some_and(|d| d.meta_hash.is_some() && d.prepend(&cursor, &fetched));
        if kept {
            st.changed();
        }
    }
    let page = match cached {
        Some(c) => {
            let mut items = fetched.items;
            items.extend(c.items);
            HistoryPage { items, has_more: fetched.has_more, cursor: fetched.cursor }
        }
        None => fetched,
    };
    serde_json::to_value(&page).map_err(internal)
}

/// `session.close` from the UI (forwarded to hostd by the caller): the mirror stops, its data
/// goes to the cache.
pub fn closed(host: &Arc<dyn SessionHost>, agent_id: &str) {
    let Some(m) = host.sessions().get(agent_id) else { return };
    {
        let mut st = m.lock();
        st.wanted = false;
        st.plain = false;
        st.sub = Sub::None;
        st.used = Instant::now();
    }
    tokio::spawn(persist(host.clone(), m, true));
}

/// After a reconnect: re-opens what the UI has open (with what each mirror holds) and gives the
/// UI each as a `reset`. One that finds no answer is tried again ([`repair`]); one that cannot
/// be re-opened ends.
pub async fn reopen(host: Arc<dyn SessionHost>, link: Arc<Link>) {
    for m in host.sessions().all() {
        let agent = m.agent_id.as_str();
        let r = {
            let _one = m.opening.lock().await;
            let (wanted, live, limit, cached) = {
                let st = m.lock();
                (st.wanted, matches!(st.sub, Sub::Live { link: l, .. } if l == link.id), st.limit.max(1), st.data.as_ref().map(|d| d.session_id.clone()))
            };
            if !wanted || live {
                continue;
            }
            if link.features.session_sync {
                let hint = host.agent(agent).session_id.or(cached);
                sync_open(&host, &link, &m, limit, hint.as_deref(), true).await.map(|_| ())
            } else {
                let r = link.request("session.open", serde_json::json!({ "agentId": agent, "limit": limit }), DEFAULT_TIMEOUT).await;
                r.and_then(|v| serde_json::from_value::<SessionSnapshot>(v).map_err(internal)).map(|snapshot| {
                    m.lock().sub = Sub::Live { link: link.id, seq: None };
                    host.emit(agent, SessionEvent::Reset { snapshot });
                })
            }
        };
        match r {
            Ok(()) => {}
            Err(e) if e.code == "ended" => {}
            // The link went down: the next one re-opens them all.
            Err(_) if link.is_closed() => return,
            Err(e) if retry_later(&e) => {
                log::info!("session {agent}: re-open failed ({}); trying again", e.message);
                tokio::spawn(repair(host.clone(), link.id, m.clone(), false));
            }
            Err(e) => {
                {
                    let mut st = m.lock();
                    st.wanted = false;
                    st.sub = Sub::None;
                }
                host.emit(agent, SessionEvent::Ended { reason: e.message });
            }
        }
    }
}

/// How long a changed mirror of `bytes` that stays open waits after a cache write before the
/// next (0: the next periodic tick).
fn persist_every(bytes: usize) -> Duration {
    (PERSIST_PER_MIB * (bytes >> 20) as u32).min(PERSIST_MAX)
}

/// Writes `m`'s data to the cache when it changed. `force`: now (it closes, the link goes, the
/// app quits); else once [`persist_every`] has passed since the last write.
async fn persist(host: Arc<dyn SessionHost>, m: Arc<Mirror>, force: bool) {
    let _one = m.persisting.lock().await;
    let saved = {
        let mut st = m.lock();
        if !st.dirty || (!force && st.saved.is_some_and(|(at, size)| at.elapsed() + PERSIST_SLACK < persist_every(size))) {
            return;
        }
        st.dirty = false;
        // Only what came with hashes is worth a `have`.
        match &st.data {
            Some(d) if !d.session_id.is_empty() && d.meta_hash.is_some() => Saved::of(d),
            _ => return,
        }
    };
    let size = host.cache().store(host.host_id(), saved).await;
    let mut st = m.lock();
    st.saved = Some((Instant::now(), size));
    if !st.dirty {
        st.weight = Some(size);
    }
}

/// Writes every changed mirror to the cache (a mirror closes, the link goes, the page goes, the
/// app quits), then lets closed mirrors beyond the memory budget go.
pub async fn persist_all(host: Arc<dyn SessionHost>) {
    for m in host.sessions().all() {
        persist(host.clone(), m, true).await;
    }
    host.sessions().evict_idle(host.cache().idle_budget());
}

/// The periodic cache write: changed mirrors, big ones less often ([`persist_every`]); then lets
/// closed mirrors beyond the memory budget go.
pub async fn persist_due(host: Arc<dyn SessionHost>) {
    for m in host.sessions().all() {
        persist(host.clone(), m, false).await;
    }
    host.sessions().evict_idle(host.cache().idle_budget());
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::link::{LinkSink, requested_features};
    use tf_proto::session::{AssistantItem, NoticeItem, NoticeLevel, ToolItem, ToolStatus, TreeNodeKind, UserItem};
    use tf_proto::{ClientInfo, ClientMsg, HostState, OmpMode, PROTOCOL_VERSION, QueueInfo, ServerMsg, StatePatch};

    pub(crate) fn user(id: &str, text: &str) -> TranscriptItem {
        TranscriptItem::User(UserItem { id: id.into(), at: 1, text: text.into(), images: vec![], author: None, steering: false, synthetic: false })
    }

    fn assistant(id: &str, text: &str) -> TranscriptItem {
        TranscriptItem::Assistant(AssistantItem { id: id.into(), at: 2, text: text.into(), streaming: true, model: None, usage: None, stop_reason: None, error: None })
    }

    fn tool(id: &str, output: &str) -> TranscriptItem {
        TranscriptItem::Tool(ToolItem {
            id: id.into(),
            at: 3,
            call_id: id.into(),
            tool: "bash".into(),
            title: format!("run {id}"),
            intent: None,
            args: serde_json::json!({ "command": format!("ls {id}") }),
            status: ToolStatus::Ok,
            duration_ms: Some(12),
            output: Some(output.into()),
            truncated: false,
            view: None,
            error: None,
        })
    }

    pub(crate) fn meta(title: &str) -> SessionMeta {
        let caps = serde_json::from_value(serde_json::json!({
            "prompt": true, "steer": true, "followUp": true, "abort": true, "answer": true, "model": true, "thinking": true,
            "fast": true, "plan": true, "goal": true, "compact": true, "rename": true, "fork": true, "branch": true, "tree": true,
            "btw": true, "export": true, "handoff": true, "subagents": true, "bridge": true
        }))
        .unwrap();
        SessionMeta {
            session_id: Some("s1".into()),
            session_file: None,
            title: Some(title.into()),
            cwd: Some("/work".into()),
            model: None,
            thinking: None,
            fast: false,
            mode: OmpMode::Normal,
            goal: None,
            context: None,
            cost: None,
            tps: None,
            todos: vec![],
            subagents: vec![],
            files: vec![],
            queue: QueueInfo { steering: vec![], follow_up: vec![] },
            tree: None,
            caps,
            started_at: None,
        }
    }

    /// A mirror holding `items` of session `sid`, each with a made-up hash.
    pub(crate) fn data(sid: &str, items: Vec<TranscriptItem>) -> Data {
        Data {
            session_id: sid.into(),
            meta: SessionMeta { session_id: Some(sid.into()), ..meta("t") },
            tree: None,
            meta_hash: Some("m".into()),
            rows: items.into_iter().map(|item| Arc::new(Row { h: Some(format!("h-{}", item.id())), item })).collect(),
            has_more: false,
            ui: None,
        }
    }

    fn ids(rows: &[Arc<Row>]) -> Vec<&str> {
        rows.iter().map(|r| r.item.id()).collect()
    }

    fn delta(order: &[&str], items: Vec<TranscriptItem>, meta_same: bool) -> SessionSnapshot {
        let hashes = items.iter().map(|i| RowDigest { id: i.id().into(), h: format!("new-{}", i.id()) }).collect();
        SessionSnapshot {
            agent_id: "a".into(),
            meta: meta("placeholder"),
            items,
            has_more: true,
            cursor: order.first().map(|s| s.to_string()),
            ui: None,
            sync: Some(tf_proto::session::SessionSync {
                seq: 7,
                delta: true,
                order: Some(order.iter().map(|s| s.to_string()).collect()),
                hashes,
                meta_hash: "m2".into(),
                meta_same,
            }),
        }
    }

    /// A delta keeps the rows it does not resend, takes the ones it does, keeps the pages older
    /// than its window (anchored on a row held unchanged), and reports where to page on.
    #[test]
    fn delta_merge_keeps_held_rows_and_older_pages() {
        let mut prev = data("s1", (0..10).map(|i| user(&format!("u{i}"), "x")).collect());
        prev.has_more = true;
        let order = ["u5", "u6", "u7", "u8", "u9", "u10"];
        let d = Data::merge(Some(&prev), delta(&order, vec![user("u9", "changed"), user("u10", "new")], true)).unwrap();
        assert_eq!(ids(&d.rows), ["u0", "u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9", "u10"]);
        assert!(Arc::ptr_eq(&d.rows[5], &prev.rows[5]), "held rows are shared, not copied");
        assert_eq!(d.rows[9].h.as_deref(), Some("new-u9"));
        assert!(d.has_more, "the host still has rows before u0");
        assert_eq!(d.meta.title.as_deref(), Some("t"), "metaSame keeps the cached meta");
        assert_eq!(d.meta_hash.as_deref(), Some("m2"));
        // The UI's window: the newest rows, paging on from the oldest it got.
        let w = d.window("a", 4);
        assert_eq!(w.items.iter().map(|i| i.id()).collect::<Vec<_>>(), ["u7", "u8", "u9", "u10"]);
        assert_eq!((w.has_more, w.cursor.as_deref()), (true, Some("u7")));
    }

    /// A branch switch: the window lists other rows after the shared ones; what the old branch
    /// had beyond them is gone, everything before stays.
    #[test]
    fn delta_merge_drops_rows_that_left_the_window() {
        let prev = data("s1", (0..10).map(|i| user(&format!("u{i}"), "x")).collect());
        let d = Data::merge(Some(&prev), delta(&["u3", "u4", "b5", "b6"], vec![assistant("b5", "y"), assistant("b6", "z")], false)).unwrap();
        assert_eq!(ids(&d.rows), ["u0", "u1", "u2", "u3", "u4", "b5", "b6"]);
        assert_eq!(d.meta.title.as_deref(), Some("placeholder"), "a new meta replaces the cached one");
        // A window row we do not hold: the delta cannot be applied.
        let e = Data::merge(Some(&prev), delta(&["u8", "u9", "zz"], vec![], true)).unwrap_err();
        assert!(e.contains("zz"), "{e}");
        // Its first row resent (changed): nothing older can be trusted to precede it.
        let d = Data::merge(Some(&prev), delta(&["u5", "u6"], vec![user("u5", "edited")], true)).unwrap();
        assert_eq!(ids(&d.rows), ["u5", "u6"]);
    }

    #[test]
    fn full_window_keeps_older_rows_only_behind_an_unchanged_first_row() {
        let prev = data("s1", (0..6).map(|i| user(&format!("u{i}"), "x")).collect());
        let full = |first_hash: &str| SessionSnapshot {
            agent_id: "a".into(),
            meta: meta("t"),
            items: vec![user("u3", "x"), user("u4", "x"), user("u5", "x")],
            has_more: true,
            cursor: Some("u3".into()),
            ui: None,
            sync: Some(tf_proto::session::SessionSync {
                seq: 0,
                delta: false,
                order: None,
                hashes: vec![
                    RowDigest { id: "u3".into(), h: first_hash.into() },
                    RowDigest { id: "u4".into(), h: "h-u4".into() },
                    RowDigest { id: "u5".into(), h: "h-u5".into() },
                ],
                meta_hash: "m".into(),
                meta_same: false,
            }),
        };
        assert_eq!(ids(&Data::merge(Some(&prev), full("h-u3")).unwrap().rows), ["u0", "u1", "u2", "u3", "u4", "u5"]);
        assert_eq!(ids(&Data::merge(Some(&prev), full("other")).unwrap().rows), ["u3", "u4", "u5"]);
        // Another session's cache is never mixed in.
        let other = data("s0", (0..6).map(|i| user(&format!("u{i}"), "x")).collect());
        assert_eq!(ids(&Data::merge(Some(&other), full("h-u3")).unwrap().rows), ["u3", "u4", "u5"]);
    }

    /// Live events: appends verify their offset, meta/tree patches become whole metas for the UI.
    #[test]
    fn apply_checks_offsets_and_rebuilds_metas() {
        let mut d = data("s1", vec![user("u1", "hi"), assistant("a1", "he")]);
        let out = d.apply(SessionEvent::Append { id: "a1".into(), field: AppendField::Text, text: "llo".into(), at: Some(2) }).unwrap();
        assert_eq!(out, SessionEvent::Append { id: "a1".into(), field: AppendField::Text, text: "llo".into(), at: None });
        assert_eq!(d.rows[1].item, assistant("a1", "hello"));
        assert_eq!(d.rows[1].h, None, "its hash is unknown now");
        assert!(d.apply(SessionEvent::Append { id: "a1".into(), field: AppendField::Text, text: "!".into(), at: Some(4) }).is_err());
        assert!(d.apply(SessionEvent::Append { id: "zz".into(), field: AppendField::Text, text: "!".into(), at: Some(0) }).is_err());
        let out = d.apply(SessionEvent::Upsert { item: tool("t1", "ok"), h: Some("ht".into()) }).unwrap();
        assert_eq!(out, SessionEvent::Upsert { item: tool("t1", "ok"), h: None });
        assert_eq!(d.rows[2].h.as_deref(), Some("ht"));
        d.apply(SessionEvent::Remove { id: "u1".into() }).unwrap();
        assert_eq!(ids(&d.rows), ["a1", "t1"]);

        let mut set = serde_json::Map::new();
        set.insert("title".into(), "renamed".into());
        set.insert("cwd".into(), Value::Null);
        let SessionEvent::Meta { meta: m } = d.apply(SessionEvent::MetaPatch { set, hash: "m3".into() }).unwrap() else { panic!() };
        assert_eq!((m.title.as_deref(), m.cwd.as_deref()), (Some("renamed"), None));
        assert_eq!(d.meta_hash.as_deref(), Some("m3"));
        let node = |id: &str| TreeNode { id: id.into(), parent_id: None, kind: TreeNodeKind::User, label: id.into(), at: 0, on_path: true, children: 0 };
        let SessionEvent::Meta { meta: m } =
            d.apply(SessionEvent::TreePatch { upsert: vec![node("n1"), node("n2")], remove: vec![], leaf_id: Some("n2".into()), hash: "m4".into() }).unwrap()
        else {
            panic!()
        };
        assert_eq!(m.tree.as_ref().unwrap().nodes.len(), 2);
        // A later meta patch leaves the tree out of the UI's meta (it keeps its own).
        let SessionEvent::Meta { meta: m } = d.apply(SessionEvent::MetaPatch { set: serde_json::Map::new(), hash: "m5".into() }).unwrap() else { panic!() };
        assert!(m.tree.is_none() && d.tree.is_some());
    }

    /// A meta patch (tps, context, cost: twice a second while streaming) never copies the tree,
    /// however big: neither into the meta it patches nor into the event the UI gets. A tree
    /// patch changes the mirror's tree in place unless a cache write still holds it.
    #[test]
    fn meta_patches_leave_the_tree_alone() {
        let mut d = data("s1", vec![user("u1", "hi")]);
        d.tree = Some(Arc::new(big_tree(1000)));
        let tree = d.tree.clone().unwrap();
        for i in 0..3 {
            let mut set = serde_json::Map::new();
            set.insert("tps".into(), serde_json::json!(i as f32 + 0.5));
            let SessionEvent::Meta { meta } = d.apply(SessionEvent::MetaPatch { set, hash: format!("m{i}") }).unwrap() else { panic!() };
            assert!(meta.tree.is_none(), "the UI keeps its own");
            assert_eq!(meta.tps, Some(i as f32 + 0.5));
            assert!(Arc::ptr_eq(d.tree.as_ref().unwrap(), &tree), "the same tree, not a copy");
            assert!(d.meta.tree.is_none());
        }
        // A cache write in progress shares the tree: a tree patch then works on a copy of its own.
        let saved = crate::session_cache::Saved::of(&d);
        let node = TreeNode { id: "new".into(), parent_id: None, kind: TreeNodeKind::User, label: "new".into(), at: 0, on_path: true, children: 0 };
        let SessionEvent::Meta { meta } = d.apply(SessionEvent::TreePatch { upsert: vec![node.clone()], remove: vec![], leaf_id: Some("new".into()), hash: "t1".into() }).unwrap() else { panic!() };
        assert_eq!(meta.tree.as_ref().unwrap().nodes.len(), 1001, "the UI gets the whole tree");
        assert_eq!(saved.tree.as_ref().unwrap().nodes.len(), 1000, "what is being written stays as it was");
        drop(saved);
        let held = Arc::as_ptr(d.tree.as_ref().unwrap());
        d.apply(SessionEvent::TreePatch { upsert: vec![TreeNode { id: "newer".into(), ..node }], remove: vec![], leaf_id: None, hash: "t2".into() }).unwrap();
        assert_eq!(Arc::as_ptr(d.tree.as_ref().unwrap()), held, "patched in place");
        assert_eq!(d.tree.as_ref().unwrap().nodes.len(), 1002);
    }

    #[test]
    fn history_pages_come_from_the_mirror_then_hostd() {
        let mut d = data("s1", (0..10).map(|i| user(&format!("u{i}"), "x")).collect());
        d.has_more = true;
        let p = d.older("u6", 4).unwrap();
        assert_eq!(p.items.iter().map(|i| i.id()).collect::<Vec<_>>(), ["u2", "u3", "u4", "u5"]);
        assert_eq!((p.has_more, p.cursor.as_deref()), (true, Some("u2")));
        let p = d.older("u2", 4).unwrap();
        assert_eq!(p.items.len(), 2);
        assert_eq!(p.cursor.as_deref(), Some("u0"), "hostd has more before u0");
        assert!(d.older("u0", 4).is_none(), "hostd's turn");
        // hostd's page continues our oldest row: kept.
        let page = HistoryPage { items: vec![user("o1", "x"), user("o2", "x")], has_more: false, cursor: None };
        assert!(d.prepend("u0", &page));
        assert_eq!(ids(&d.rows[..3]), ["o1", "o2", "u0"]);
        assert!(!d.has_more);
        assert!(!d.prepend("u5", &page), "a page for another cursor is not ours to keep");
    }

    #[test]
    fn have_lists_the_newest_hashed_rows() {
        let mut d = data("s1", (0..10).map(|i| user(&format!("u{i}"), "x")).collect());
        Arc::make_mut(&mut d.rows[8]).h = None;
        let have = d.have(4);
        assert_eq!(have.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["u9", "u7", "u6"]);
        assert_eq!((have.session_id.as_str(), have.meta_hash.as_deref()), ("s1", Some("m")));
    }

    /// A session tree of `n` nodes like a long omp session's (labels a line of prose).
    pub(crate) fn big_tree(n: usize) -> TreeInfo {
        let id = |i: usize| format!("{:08x}", i.wrapping_mul(2_654_435_761) % 0xffff_ffff);
        let nodes = (0..n)
            .map(|i| TreeNode {
                id: id(i),
                parent_id: (i > 0).then(|| id(i - 1)),
                kind: if i % 2 == 0 { TreeNodeKind::User } else { TreeNodeKind::Assistant },
                label: format!("node {i}: the handler returns early when the queue is empty and the parser reads a token…"),
                at: 1_793_205_532_197 + i as i64,
                on_path: true,
                children: 1,
            })
            .collect();
        TreeInfo { nodes, leaf_id: Some(id(n.saturating_sub(1))) }
    }

    /// Bench: what one live `metaPatch` (tps, ~2/s while streaming) and one `treePatch` (a new
    /// node) cost a mirror whose session has a big tree. Release build:
    /// `cargo test --release -p tf-client meta_patch_cost -- --ignored --nocapture`
    #[test]
    #[ignore = "bench"]
    fn meta_patch_cost() {
        for n in [2_000usize, 10_000, 30_000] {
            let mut d = data("s1", vec![user("u1", "x")]);
            d.tree = Some(Arc::new(big_tree(n)));
            let reps = 20u32;
            let t = Instant::now();
            for i in 0..reps {
                let mut set = serde_json::Map::new();
                set.insert("tps".into(), serde_json::json!(i as f32 + 0.5));
                std::hint::black_box(d.apply(SessionEvent::MetaPatch { set, hash: format!("m{i}") }).unwrap());
            }
            let patch = t.elapsed() / reps;
            let t = Instant::now();
            for i in 0..reps {
                let node = TreeNode { id: format!("new{i}"), parent_id: None, kind: TreeNodeKind::User, label: "new".into(), at: 0, on_path: true, children: 0 };
                std::hint::black_box(d.apply(SessionEvent::TreePatch { upsert: vec![node], remove: vec![], leaf_id: Some(format!("new{i}")), hash: format!("t{i}") }).unwrap());
            }
            let tree = t.elapsed() / reps;
            println!("tree nodes {n:>6}: metaPatch {:>8.3} ms, treePatch {:>8.3} ms", patch.as_secs_f64() * 1e3, tree.as_secs_f64() * 1e3);
        }
    }

    // ── against tf-hostd's real subscription and stream code ─────────────────────────────────

    use tf_hostd::clients::{ClientHandle, Features, framed_reader, read_line, write_loop};
    use tf_hostd::sync::{Fanout, Tree};
    use tokio::io::{AsyncWriteExt, BufReader};

    /// Holds tf-hostd's next `session.open`: `reached` fires when it arrives, its answer goes out
    /// once `release` fires.
    struct Gate {
        reached: tokio::sync::oneshot::Sender<()>,
        release: tokio::sync::oneshot::Receiver<()>,
    }

    fn gate() -> (Gate, tokio::sync::oneshot::Receiver<()>, tokio::sync::oneshot::Sender<()>) {
        let (reached, reached_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release) = tokio::sync::oneshot::channel();
        (Gate { reached, release }, reached_rx, release_tx)
    }

    /// tf-hostd's side of one session: the replica's rows and meta, and its subscribers.
    struct HostSide {
        rows: Vec<TranscriptItem>,
        /// With its tree.
        meta: SessionMeta,
        /// Bumped when the tree changes (`OmpSession`'s `tree_rev`).
        tree_rev: u64,
        fanout: Fanout,
        /// What each `session.open` answered.
        opened: Vec<SessionSnapshot>,
        /// `session.open` requests (answered or not), `session.close` requests.
        open_requests: usize,
        closes: usize,
        /// The next `session.open`s fail with these error codes.
        fail_opens: VecDeque<&'static str>,
        gate: Option<Gate>,
    }

    impl HostSide {
        fn new(rows: Vec<TranscriptItem>, meta: SessionMeta) -> HostSide {
            HostSide { rows, meta, tree_rev: 1, fanout: Fanout::default(), opened: Vec::new(), open_requests: 0, closes: 0, fail_opens: VecDeque::new(), gate: None }
        }

        /// The newest `limit` rows, the meta without its tree (the tree goes out as a [`Tree`]).
        fn window(&self, limit: usize) -> SessionSnapshot {
            let start = self.rows.len().saturating_sub(limit);
            SessionSnapshot {
                agent_id: "a".into(),
                meta: SessionMeta { tree: None, ..self.meta.clone() },
                items: self.rows[start..].to_vec(),
                has_more: start > 0,
                cursor: (start > 0).then(|| self.rows[start].id().to_owned()),
                ui: None,
                sync: None,
            }
        }

        /// Applies a row event to the replica without telling anyone (a lost message).
        fn mutate(&mut self, ev: &SessionEvent) {
            match ev {
                SessionEvent::Upsert { item, .. } => match self.rows.iter().position(|r| r.id() == item.id()) {
                    Some(i) => self.rows[i] = item.clone(),
                    None => self.rows.push(item.clone()),
                },
                SessionEvent::Append { id, field, text, .. } => {
                    if let Some(r) = self.rows.iter_mut().find(|r| r.id() == id) {
                        append(r, *field, text);
                    }
                }
                SessionEvent::Remove { id } => self.rows.retain(|r| r.id() != id),
                _ => {}
            }
        }

        /// The replica changes and the change goes out (one flush).
        fn change(&mut self, ev: SessionEvent) {
            self.mutate(&ev);
            let rows = &self.rows;
            let len = |id: &str, f: AppendField| rows.iter().find(|r| r.id() == id).and_then(|r| tf_hostd::sync::field_len(r, f));
            self.fanout.send_events(&[ev], Tree { tree: self.meta.tree.as_ref(), rev: self.tree_rev }, &len);
        }

        fn set_meta(&mut self, meta: SessionMeta, tree_changed: bool) {
            if tree_changed {
                self.tree_rev += 1;
            }
            self.meta = meta;
            let bare = SessionMeta { tree: None, ..self.meta.clone() };
            self.fanout.send_meta(&bare, Tree { tree: self.meta.tree.as_ref(), rev: self.tree_rev }, tree_changed);
        }

        /// `session.open`, the way tf-hostd answers it.
        fn open(&mut self, c: &ClientHandle, p: &SessionOpenParams) -> Result<Value, ApiError> {
            if let Some(code) = self.fail_opens.pop_front() {
                return Err(ApiError::new(code, "no session here right now").retryable());
            }
            let snap = self.window(p.limit.unwrap_or(200) as usize);
            let tree = Tree { tree: self.meta.tree.as_ref(), rev: self.tree_rev };
            let out = self.fanout.subscribe(c, &p.agent_id, snap, tree, p.have.as_ref(), "s1");
            self.opened.push(out.clone());
            Ok(serde_json::to_value(out).unwrap())
        }

        /// `session.history`, the way tf-hostd answers it: a row it does not have is `not_found`.
        fn history(&self, p: &SessionHistoryParams) -> Result<Value, ApiError> {
            let end = self.rows.iter().position(|r| r.id() == p.cursor).ok_or_else(|| ApiError::new("not_found", format!("row {} is not in the session", p.cursor)))?;
            let start = end.saturating_sub(p.limit.unwrap_or(100) as usize);
            let page = HistoryPage { items: self.rows[start..end].to_vec(), has_more: start > 0, cursor: (start > 0).then(|| self.rows[start].id().to_owned()) };
            Ok(serde_json::to_value(page).unwrap())
        }
    }

    type Side = Arc<Mutex<HostSide>>;

    /// Serves one connection the way `tf_hostd::clients::serve` does: plain hello and welcome,
    /// then the negotiated streams. `speaks`: false plays a tf-hostd from before features.
    async fn serve(read: tokio::io::DuplexStream, mut write: tokio::io::DuplexStream, side: Side, speaks: bool, id: String) -> ClientHandle {
        let mut reader = BufReader::new(read);
        let mut line = String::new();
        read_line(&mut reader, &mut line).await.unwrap();
        let ClientMsg::Hello { client, .. } = serde_json::from_str(&line).unwrap() else { panic!("{line}") };
        let requested = client.features.clone();
        let features = if speaks { Features::negotiate(requested.as_deref()) } else { Features::default() };
        let welcome = ServerMsg::Welcome {
            protocol: PROTOCOL_VERSION,
            hostd_version: "test".into(),
            client_id: id.clone(),
            features: if speaks { features.welcome(requested.as_deref()) } else { None },
        };
        write.write_all(format!("{}\n", serde_json::to_string(&welcome).unwrap()).as_bytes()).await.unwrap();
        let ch = ClientHandle::with_features(id, client, features);
        ch.send(ServerMsg::Snapshot { rev: 1, state: crate::state::fixtures::host_state() });
        tokio::spawn(write_loop(ch.clone(), write));
        let mut lines = framed_reader(reader, features);
        let c = ch.clone();
        tokio::spawn(async move {
            let mut line = String::new();
            while let Ok(true) = read_line(&mut lines, &mut line).await {
                let Ok(msg) = serde_json::from_str::<ClientMsg>(&line) else { continue };
                match msg {
                    ClientMsg::Req { id, method, params } => {
                        let result = match method.as_str() {
                            "session.open" => {
                                let p: SessionOpenParams = serde_json::from_value(params).unwrap();
                                let gate = {
                                    let mut s = side.lock().unwrap();
                                    s.open_requests += 1;
                                    s.gate.take()
                                };
                                if let Some(g) = gate {
                                    let _ = g.reached.send(());
                                    let _ = g.release.await;
                                }
                                side.lock().unwrap().open(&c, &p)
                            }
                            "session.history" => side.lock().unwrap().history(&serde_json::from_value(params).unwrap()),
                            "session.close" => {
                                let mut s = side.lock().unwrap();
                                s.closes += 1;
                                s.fanout.unsubscribe(c.id(), params["agentId"].as_str().unwrap());
                                Ok(serde_json::json!({}))
                            }
                            _ => Ok(serde_json::json!({})),
                        };
                        c.send(match result {
                            Ok(v) => ServerMsg::Res { id, result: Some(v), error: None },
                            Err(e) => ServerMsg::Res { id, result: None, error: Some(e) },
                        });
                    }
                    ClientMsg::Ping { ts } => {
                        c.send(ServerMsg::Pong { ts });
                    }
                    ClientMsg::Bye => break,
                    _ => {}
                }
            }
            c.close();
        });
        ch
    }

    /// The app core's side: mirrors, a session cache, and what the UI got.
    struct TestHost {
        sessions: Sessions,
        cache: SessionCache,
        link: Mutex<Option<Arc<Link>>>,
        ui: Mutex<Vec<SessionEvent>>,
        hint: Mutex<AgentHint>,
    }

    impl SessionHost for TestHost {
        fn host_id(&self) -> &str {
            "lab"
        }
        fn sessions(&self) -> &Sessions {
            &self.sessions
        }
        fn cache(&self) -> &SessionCache {
            &self.cache
        }
        fn link(&self) -> Option<Arc<Link>> {
            self.link.lock().unwrap().clone().filter(|l| !l.is_closed())
        }
        fn emit(&self, _agent_id: &str, ev: SessionEvent) {
            self.ui.lock().unwrap().push(ev);
        }
        fn agent(&self, _agent_id: &str) -> AgentHint {
            self.hint.lock().unwrap().clone()
        }
    }

    struct TestSink(Arc<TestHost>);

    impl LinkSink for TestSink {
        fn snapshot(&self, _: u64, _: HostState) {}
        fn patch(&self, _: u64, _: Vec<StatePatch>) {}
        fn latency(&self, _: u32) {}
        fn push(&self, msg: ServerMsg) {
            if let ServerMsg::Session { agent_id, ev, seq } = msg {
                let host: Arc<dyn SessionHost> = self.0.clone();
                let link = self.0.link().map_or(0, |l| l.id);
                on_event(&host, link, agent_id, ev, seq);
            }
        }
    }

    fn test_host(cache_dir: &std::path::Path) -> Arc<TestHost> {
        test_host_with(cache_dir, crate::session_cache::IDLE_DESKTOP)
    }

    /// `idle`: what closed mirrors may take in memory.
    fn test_host_with(cache_dir: &std::path::Path, idle: usize) -> Arc<TestHost> {
        Arc::new(TestHost {
            sessions: Sessions::default(),
            cache: SessionCache::with_budget(cache_dir.to_path_buf(), 1 << 30, idle),
            link: Mutex::new(None),
            ui: Mutex::new(Vec::new()),
            hint: Mutex::new(AgentHint { session_id: Some("s1".into()), live: true }),
        })
    }

    async fn connect(host: &Arc<TestHost>, side: &Side, client_speaks: bool, server_speaks: bool, id: &str) -> (Arc<Link>, ClientHandle) {
        let (client_w, server_r) = tokio::io::duplex(1 << 22);
        let (server_w, client_r) = tokio::io::duplex(1 << 22);
        let server = tokio::spawn(serve(server_r, server_w, side.clone(), server_speaks, id.to_owned()));
        let hello = ClientMsg::Hello {
            protocol: PROTOCOL_VERSION,
            client: ClientInfo {
                app: "teleflock-test".into(),
                version: "0.6.0".into(),
                platform: "linux".into(),
                device: "d".into(),
                features: client_speaks.then(requested_features),
            },
            herdr_session: "s".into(),
        };
        let link = Link::establish(Box::new(client_w), Box::new(client_r), None, hello, Arc::new(TestSink(host.clone()))).await.unwrap();
        *host.link.lock().unwrap() = Some(link.clone());
        (link, server.await.unwrap())
    }

    /// What the UI shows, built from the open result and the events like `src/core`'s reducer.
    #[derive(Debug, Default)]
    struct Ui {
        rows: Vec<TranscriptItem>,
        meta: Option<SessionMeta>,
        resets: usize,
        ended: Option<String>,
    }

    impl Ui {
        fn apply(&mut self, ev: &SessionEvent) {
            match ev {
                SessionEvent::Reset { snapshot } => {
                    self.rows = snapshot.items.clone();
                    self.meta = Some(snapshot.meta.clone());
                    self.resets += 1;
                }
                SessionEvent::Upsert { item, .. } => match self.rows.iter().position(|r| r.id() == item.id()) {
                    Some(i) => self.rows[i] = item.clone(),
                    None => self.rows.push(item.clone()),
                },
                SessionEvent::Append { id, field, text, .. } => {
                    if let Some(r) = self.rows.iter_mut().find(|r| r.id() == id) {
                        append(r, *field, text);
                    }
                }
                SessionEvent::Remove { id } => self.rows.retain(|r| r.id() != id),
                SessionEvent::Meta { meta } => {
                    let tree = if meta.tree.is_none() { self.meta.as_ref().and_then(|m| m.tree.clone()) } else { meta.tree.clone() };
                    self.meta = Some(SessionMeta { tree, ..meta.clone() });
                }
                SessionEvent::Ended { reason } => self.ended = Some(reason.clone()),
                SessionEvent::Ui { .. } => {}
                other => panic!("the UI never sees {other:?}"),
            }
        }

        /// Takes the events emitted so far.
        fn drain(&mut self, host: &TestHost) {
            for ev in std::mem::take(&mut *host.ui.lock().unwrap()) {
                self.apply(&ev);
            }
        }
    }

    /// Waits until the UI shows the newest rows of the host's session and its meta.
    async fn converge(ui: &mut Ui, host: &TestHost, side: &Side) {
        for _ in 0..500 {
            ui.drain(host);
            let converged = {
                let s = side.lock().unwrap();
                let n = ui.rows.len().min(s.rows.len());
                n > 0 && ui.rows[ui.rows.len() - n..] == s.rows[s.rows.len() - n..] && ui.meta.as_ref() == Some(&s.meta)
            };
            if converged {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let s = side.lock().unwrap();
        panic!("the UI did not converge:\nui   {:?}\nhost {:?}", ui.rows.iter().rev().take(3).collect::<Vec<_>>(), s.rows.iter().rev().take(3).collect::<Vec<_>>());
    }

    /// Prose that compresses like a transcript does (words, not one repeated phrase).
    fn prose(seed: u64, words: usize) -> String {
        const VOCAB: [&str; 48] = [
            "the", "handler", "returns", "early", "when", "queue", "is", "empty", "parser", "reads", "a", "token", "and", "then",
            "checks", "whether", "buffer", "holds", "complete", "line", "we", "should", "move", "this", "into", "session",
            "cache", "so", "reconnects", "only", "fetch", "rows", "that", "changed", "since", "last", "open", "test", "fails",
            "because", "offset", "drifts", "after", "an", "append", "lost", "on", "wire",
        ];
        let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        (0..words)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                VOCAB[(x % VOCAB.len() as u64) as usize]
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn long_session() -> HostSide {
        let mut rows = Vec::new();
        for i in 0..150u64 {
            rows.push(user(&format!("u{i}"), &prose(i, 40)));
            rows.push(tool(&format!("t{i}"), &(0..12).map(|l| format!("src/file_{i}.rs:{}: {}\n", l * 7 + 1, prose(i * 100 + l, 8))).collect::<String>()));
            rows.push(assistant(&format!("a{i}"), &prose(i + 10_000, 120)));
        }
        let mut m = meta("long");
        m.tree = Some(TreeInfo {
            nodes: (0..200).map(|i| TreeNode { id: format!("n{i}"), parent_id: (i > 0).then(|| format!("n{}", i - 1)), kind: TreeNodeKind::User, label: prose(i as u64, 6), at: i, on_path: true, children: 1 }).collect(),
            leaf_id: Some("n199".into()),
        });
        HostSide::new(rows, m)
    }

    /// The rows the last `session.open` answer carried, and whether the meta was left out.
    fn last_open(side: &Side) -> (Vec<String>, bool, bool) {
        let s = side.lock().unwrap();
        let o = s.opened.last().expect("an open");
        let sync = o.sync.as_ref().expect("a sync snapshot");
        (o.items.iter().map(|i| i.id().to_owned()).collect(), sync.delta, sync.meta_same)
    }

    fn open_params(limit: u32) -> SessionOpenParams {
        SessionOpenParams { agent_id: "a".into(), limit: Some(limit), have: None }
    }

    /// End to end against tf-hostd's subscription and stream code: a first open, live streaming,
    /// an app restart that re-opens from the cache, a reconnect in the middle of a stream, a
    /// lost message caught by `seq` and one caught by an append offset. Each re-open moves only
    /// what changed, and the UI always ends up with the host's session.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cached_reopens_reconnects_and_gaps_move_only_what_changed() {
        let dir = tempfile::tempdir().unwrap();
        let side: Side = Arc::new(Mutex::new(long_session()));

        // First open: nothing cached, the whole window.
        let host = test_host(dir.path());
        let (link, _) = connect(&host, &side, true, true, "c1").await;
        assert_eq!(link.features, crate::link::Features { zstd: true, session_sync: true });
        let dyn_host: Arc<dyn SessionHost> = host.clone();
        let before = link.totals();
        let first = open(&dyn_host, &link, &open_params(200)).await.unwrap();
        let first_bytes = link.totals().rx - before.rx;
        let mut ui = Ui::default();
        ui.apply(&SessionEvent::Reset { snapshot: serde_json::from_value(first).unwrap() });
        assert_eq!(ui.rows.len(), 200);
        let (ids, delta, _) = last_open(&side);
        assert!(ids.len() == 200 && !delta, "nothing cached: the whole window");
        converge(&mut ui, &host, &side).await;
        let plain = link.totals().rx_plain - before.rx_plain;
        assert!(first_bytes * 3 < plain, "zstd: {first_bytes} bytes on the wire for {plain} bytes of JSON");

        // Streaming: appends, a new row, a meta change and a tree change.
        side.lock().unwrap().change(SessionEvent::Upsert { item: assistant("a150", ""), h: None });
        for i in 0..40 {
            side.lock().unwrap().change(SessionEvent::Append { id: "a150".into(), field: AppendField::Text, text: format!("tok{i} "), at: None });
        }
        {
            let mut s = side.lock().unwrap();
            let mut m = s.meta.clone();
            m.title = Some("renamed".into());
            m.tree.as_mut().unwrap().nodes.push(TreeNode { id: "n200".into(), parent_id: Some("n199".into()), kind: TreeNodeKind::Assistant, label: "new".into(), at: 200, on_path: true, children: 0 });
            s.set_meta(m, true);
        }
        converge(&mut ui, &host, &side).await;

        // The UI closes it: the mirror goes to the cache.
        closed(&dyn_host, "a");
        link.request("session.close", serde_json::json!({ "agentId": "a" }), DEFAULT_TIMEOUT).await.unwrap();
        persist_all(dyn_host.clone()).await;
        assert!(dir.path().join("lab/s1.json.zst").is_file());
        link.close("app quits");

        // While the app is closed: a row changes, two arrive.
        {
            let mut s = side.lock().unwrap();
            s.mutate(&SessionEvent::Upsert { item: assistant("a150", "the final answer"), h: None });
            s.mutate(&SessionEvent::Upsert { item: user("u151", "next question"), h: None });
            s.mutate(&SessionEvent::Upsert { item: assistant("a151", "next answer"), h: None });
        }

        // App restart: the cached rows show at once, then only the delta crosses the wire.
        let host = test_host(dir.path());
        let dyn_host: Arc<dyn SessionHost> = host.clone();
        let (link, _) = connect(&host, &side, true, true, "c2").await;
        let before = link.totals();
        let again = open(&dyn_host, &link, &open_params(200)).await.unwrap();
        let reopen_bytes = link.totals().rx - before.rx;
        let mut ui = Ui::default();
        ui.drain(&host);
        assert_eq!((ui.resets, ui.rows.len()), (1, 200), "the cached rows came at once");
        assert_eq!(ui.rows.last().unwrap().id(), "a150");
        ui.apply(&SessionEvent::Reset { snapshot: serde_json::from_value(again).unwrap() });
        converge(&mut ui, &host, &side).await;
        assert_eq!(last_open(&side), (vec!["a150".to_string(), "u151".into(), "a151".into()], true, true), "only the changed and new rows");
        assert!(reopen_bytes * 10 < first_bytes, "a cached re-open moved {reopen_bytes} bytes, the first open {first_bytes}");

        // Older rows page in once, then come from the mirror.
        let cursor = {
            let s = side.lock().unwrap();
            s.rows[s.rows.len() - 200].id().to_owned()
        };
        let before = link.totals();
        let page = history(&dyn_host, &link, &SessionHistoryParams { agent_id: "a".into(), cursor: cursor.clone(), limit: Some(50) }).await.unwrap();
        assert!(link.totals().rx > before.rx);
        assert_eq!(page["items"].as_array().unwrap().len(), 50);
        let before = link.totals();
        let cached = history(&dyn_host, &link, &SessionHistoryParams { agent_id: "a".into(), cursor, limit: Some(50) }).await.unwrap();
        assert_eq!(cached, page);
        assert_eq!(link.totals().rx, before.rx, "a page fetched once is served by the mirror");

        // A reconnect in the middle of a stream: the re-open sends the streaming row and the new
        // ones, not the window.
        side.lock().unwrap().change(SessionEvent::Upsert { item: assistant("a152", "streaming"), h: None });
        converge(&mut ui, &host, &side).await;
        link.close("network lost");
        host.sessions.link_down();
        {
            let mut s = side.lock().unwrap();
            s.fanout.prune();
            for i in 0..30 {
                s.change(SessionEvent::Append { id: "a152".into(), field: AppendField::Text, text: format!(" more{i}"), at: None });
            }
            s.change(SessionEvent::Upsert { item: tool("t152", "done"), h: None });
        }
        let (link, ch) = connect(&host, &side, true, true, "c3").await;
        let before = link.totals();
        reopen(dyn_host.clone(), link.clone()).await;
        let reconnect_bytes = link.totals().rx - before.rx;
        converge(&mut ui, &host, &side).await;
        assert_eq!(last_open(&side), (vec!["a152".to_string(), "t152".into()], true, true), "the streaming row and the new one");
        assert!(reconnect_bytes * 10 < first_bytes, "a reconnect moved {reconnect_bytes} bytes, the first open {first_bytes}");
        eprintln!("wire bytes: first open {first_bytes} ({plain} as JSON), cached re-open {reopen_bytes}, reconnect {reconnect_bytes}");

        // A lost message: hostd's replica changed without the client hearing it; the next append
        // starts at another offset, the client re-opens, and the UI catches up.
        let resets = ui.resets;
        {
            let mut s = side.lock().unwrap();
            s.mutate(&SessionEvent::Append { id: "a152".into(), field: AppendField::Text, text: " (lost)".into(), at: None });
            s.change(SessionEvent::Append { id: "a152".into(), field: AppendField::Text, text: " next".into(), at: None });
        }
        converge(&mut ui, &host, &side).await;
        assert!(ui.resets > resets, "repaired with a reset");

        // A gap in `seq`: the same.
        let resets = ui.resets;
        ch.send(ServerMsg::Session { agent_id: "a".into(), ev: SessionEvent::Remove { id: "u0".into() }, seq: Some(1_000_000) });
        side.lock().unwrap().change(SessionEvent::Upsert { item: user("u153", "after the gap"), h: None });
        converge(&mut ui, &host, &side).await;
        assert!(ui.resets > resets, "repaired with a reset");
    }

    /// Old peers: an app without features gets today's messages from a new tf-hostd; this app
    /// against a tf-hostd from before features gets plain sessions (no cache, no `have`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn old_peers_get_plain_sessions() {
        let dir = tempfile::tempdir().unwrap();
        for (client_speaks, server_speaks) in [(false, true), (true, false)] {
            let side: Side = Arc::new(Mutex::new(long_session()));
            let host = test_host(dir.path());
            let dyn_host: Arc<dyn SessionHost> = host.clone();
            let (link, _) = connect(&host, &side, client_speaks, server_speaks, "c1").await;
            assert_eq!(link.features, crate::link::Features::default());
            let snap: SessionSnapshot = serde_json::from_value(open(&dyn_host, &link, &open_params(100)).await.unwrap()).unwrap();
            assert!(snap.sync.is_none() && snap.items.len() == 100);
            let mut ui = Ui::default();
            ui.apply(&SessionEvent::Reset { snapshot: snap });
            {
                let mut s = side.lock().unwrap();
                s.change(SessionEvent::Append { id: "a149".into(), field: AppendField::Text, text: " more".into(), at: None });
                let mut m = s.meta.clone();
                m.title = Some("plain".into());
                s.set_meta(m, false);
            }
            converge(&mut ui, &host, &side).await;
            persist_all(dyn_host.clone()).await;
            assert!(!dir.path().join("lab").exists(), "plain sessions are not cached");
        }
    }

    /// Waits (up to 5 s) until `f` holds.
    async fn until(what: &str, mut f: impl FnMut() -> bool) {
        for _ in 0..500 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting until {what}");
    }

    /// Opens agent `a` the way the UI does; what the UI shows once it caught up.
    async fn ui_open(host: &Arc<TestHost>, link: &Arc<Link>, side: &Side, limit: u32) -> Ui {
        let dyn_host: Arc<dyn SessionHost> = host.clone();
        let snap = open(&dyn_host, link, &open_params(limit)).await.unwrap();
        let mut ui = Ui::default();
        ui.drain(host);
        ui.apply(&SessionEvent::Reset { snapshot: serde_json::from_value(snap).unwrap() });
        converge(&mut ui, host, side).await;
        ui
    }

    /// A message out of order: the mirror re-opens.
    fn gap(ch: &ClientHandle) {
        ch.send(ServerMsg::Session { agent_id: "a".into(), ev: SessionEvent::Remove { id: "zz".into() }, seq: Some(1_000_000) });
    }

    /// The mirror of `a` is closed, written to the cache, and held by nobody but the host.
    async fn settled(host: &TestHost) {
        until("the mirror is closed and written", || host.sessions.get("a").is_some_and(|m| Arc::strong_count(&m) == 2 && m.lock().idle())).await;
    }

    /// A mirror an open is working on never leaves memory, however long ago it was used and
    /// however small the budget: the open would finish on a mirror the host no longer routes
    /// events to, and the UI would show a live session that never changes. The interleaving:
    /// omp moved the agent to a new session, the open loads it from a (stalled) disk, and the
    /// periodic cache write evicts meanwhile.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn eviction_never_takes_a_mirror_being_opened() {
        let dir = tempfile::tempdir().unwrap();
        let side: Side = Arc::new(Mutex::new(long_session()));
        // Closed mirrors may take 1 byte: every one leaves memory at the next eviction.
        let host = test_host_with(dir.path(), 1);
        let dyn_host: Arc<dyn SessionHost> = host.clone();
        let (link, _) = connect(&host, &side, true, true, "c1").await;
        ui_open(&host, &link, &side, 200).await;
        closed(&dyn_host, "a");
        link.request("session.close", serde_json::json!({ "agentId": "a" }), DEFAULT_TIMEOUT).await.unwrap();
        settled(&host).await;

        {
            let mut s = side.lock().unwrap();
            s.meta.session_id = Some("s2".into());
            s.rows.truncate(60);
        }
        *host.hint.lock().unwrap() = AgentHint { session_id: Some("s2".into()), live: true };
        host.ui.lock().unwrap().clear();
        let stall = host.cache.stall().await;
        let opening = tokio::spawn({
            let (h, l) = (dyn_host.clone(), link.clone());
            async move { open(&h, &l, &open_params(200)).await }
        });
        until("the open is loading the new session", || host.sessions.get("a").is_some_and(|m| m.opening.try_lock().is_err())).await;
        persist_all(dyn_host.clone()).await;
        assert!(host.sessions.get("a").is_some(), "the mirror being opened stays");
        drop(stall);
        let snap: SessionSnapshot = serde_json::from_value(opening.await.unwrap().unwrap()).unwrap();
        assert_eq!(snap.meta.session_id.as_deref(), Some("s2"));
        let mut ui = Ui::default();
        ui.apply(&SessionEvent::Reset { snapshot: snap });
        side.lock().unwrap().change(SessionEvent::Upsert { item: user("u-live", "streamed after the open"), h: None });
        converge(&mut ui, &host, &side).await;

        // Without an open in progress, the same eviction takes it.
        closed(&dyn_host, "a");
        link.request("session.close", serde_json::json!({ "agentId": "a" }), DEFAULT_TIMEOUT).await.unwrap();
        settled(&host).await;
        persist_all(dyn_host.clone()).await;
        assert!(host.sessions.get("a").is_none(), "a closed mirror over the budget leaves memory");
    }

    /// The page goes away (webview reload) while a first open waits for hostd: the open does not
    /// count as open, and the subscription hostd made for it is released, not streamed to the
    /// app for the rest of the connection.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn page_close_during_a_first_open_releases_the_subscription() {
        let dir = tempfile::tempdir().unwrap();
        let side: Side = Arc::new(Mutex::new(long_session()));
        let host = test_host(dir.path());
        let dyn_host: Arc<dyn SessionHost> = host.clone();
        let (link, _) = connect(&host, &side, true, true, "c1").await;
        let (g, reached, release) = gate();
        side.lock().unwrap().gate = Some(g);
        let opening = tokio::spawn({
            let (h, l) = (dyn_host.clone(), link.clone());
            async move { open(&h, &l, &open_params(100)).await }
        });
        reached.await.unwrap();
        assert!(host.sessions.page_closed().is_empty(), "a first open is not open yet");
        release.send(()).unwrap();
        let e = opening.await.unwrap().unwrap_err();
        assert_eq!(e.code, "not_connected");
        let s = side.lock().unwrap();
        assert_eq!((s.opened.len(), s.closes), (1, 1), "hostd subscribed, then was told to let go");
        assert!(s.fanout.is_empty(), "nothing streams to a page that is gone");
        assert!(!host.sessions.get("a").unwrap().lock().wanted);
    }

    /// A notice the mirror kept from before tf-hostd restarted is a row the new tf-hostd does not
    /// have (its live-only rows are new ones with new ids): paging past it goes on from the next
    /// row, never shows the newest rows again, and the mirror lets the stale row go.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn history_pages_past_rows_hostd_no_longer_has() {
        let dir = tempfile::tempdir().unwrap();
        let notice = TranscriptItem::Notice(NoticeItem { id: "n-old.1".into(), at: 5, level: NoticeLevel::Warn, text: "Retrying (1/3)".into(), source: Some("retry".into()) });
        let rows = (0..3).map(|i| user(&format!("o{i}"), "older")).chain([notice]).chain((0..10).map(|i| user(&format!("u{i}"), "x"))).collect();
        let side: Side = Arc::new(Mutex::new(HostSide::new(rows, meta("t"))));
        let host = test_host(dir.path());
        let dyn_host: Arc<dyn SessionHost> = host.clone();
        let (link, _) = connect(&host, &side, true, true, "c1").await;
        ui_open(&host, &link, &side, 11).await;

        // tf-hostd restarts: its new replica rebuilt the rows from the file, without the notice.
        link.close("tf-hostd restarts");
        host.sessions.link_down();
        {
            let mut s = side.lock().unwrap();
            s.rows.retain(|r| r.id() != "n-old.1");
            s.fanout.clear();
        }
        let (link, _) = connect(&host, &side, true, true, "c2").await;
        let ui = ui_open(&host, &link, &side, 10).await;
        assert_eq!(ui.rows.first().map(|r| r.id()), Some("u0"));
        let held = |host: &TestHost| host.sessions.get("a").unwrap().lock().data.as_ref().map(|d| ids(&d.rows).into_iter().map(String::from).collect::<Vec<_>>()).unwrap();
        assert_eq!(held(&host)[..2], ["n-old.1", "u0"], "the mirror kept the notice in front of the window");

        let page = history(&dyn_host, &link, &SessionHistoryParams { agent_id: "a".into(), cursor: "u0".into(), limit: Some(5) }).await.unwrap();
        let page: HistoryPage = serde_json::from_value(page).unwrap();
        assert_eq!(page.items.iter().map(|i| i.id()).collect::<Vec<_>>(), ["o0", "o1", "o2", "n-old.1"]);
        assert!(!page.has_more);
        assert_eq!(held(&host)[..4], ["o0", "o1", "o2", "u0"], "pages on from the rows hostd has");
    }

    /// A re-open after a gap that finds no answer (the session is not shared again yet) is tried
    /// again, waiting longer each time, while the UI has the session open; one that cannot work
    /// ends the session for the UI, and so does an end that came while it re-opened.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_repairs_retry_while_wanted_or_end_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let side: Side = Arc::new(Mutex::new(long_session()));
        let host = test_host(dir.path());
        let (link, ch) = connect(&host, &side, true, true, "c1").await;
        let mut ui = ui_open(&host, &link, &side, 50).await;
        let opens = |side: &Side| side.lock().unwrap().open_requests;

        // Twice no session: tried again until it works.
        let before = opens(&side);
        side.lock().unwrap().fail_opens.extend(["not_connected", "not_connected"]);
        gap(&ch);
        side.lock().unwrap().change(SessionEvent::Upsert { item: user("u-gap", "after the gap"), h: None });
        converge(&mut ui, &host, &side).await;
        assert_eq!(opens(&side) - before, 3, "two re-opens found no session, the third worked");
        assert!(ui.ended.is_none());

        // An answer that will not change: the UI hears the session ended, and why.
        side.lock().unwrap().fail_opens.push_back("not_found");
        gap(&ch);
        until("the UI hears it ended", || {
            ui.drain(&host);
            ui.ended.is_some()
        })
        .await;
        assert!(!host.sessions.get("a").unwrap().lock().wanted);

        // Open again; this time omp ends the session while the mirror re-opens.
        let mut ui = ui_open(&host, &link, &side, 50).await;
        let (g, reached, release) = gate();
        side.lock().unwrap().gate = Some(g);
        gap(&ch);
        reached.await.unwrap();
        {
            let mut s = side.lock().unwrap();
            s.change(SessionEvent::Ended { reason: "omp exited".into() });
            s.fail_opens.push_back("not_connected");
        }
        let before = opens(&side);
        release.send(()).unwrap();
        until("the UI hears it ended", || {
            ui.drain(&host);
            ui.ended.is_some()
        })
        .await;
        assert_eq!(ui.ended.as_deref(), Some("omp exited"));
        tokio::time::sleep(RETRY_MAX * 3).await;
        assert_eq!(opens(&side), before, "an ended session is not re-opened");
        assert!(!host.sessions.get("a").unwrap().lock().wanted);
    }

    /// The periodic cache write rewrites only mirrors that changed (a dialog or an unchanged
    /// re-open is no change), a big one that stays open less often; a close writes at once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cache_writes_follow_changes_and_size() {
        let dir = tempfile::tempdir().unwrap();
        let side: Side = Arc::new(Mutex::new(long_session()));
        let host = test_host(dir.path());
        let dyn_host: Arc<dyn SessionHost> = host.clone();
        let (link, _) = connect(&host, &side, true, true, "c1").await;
        let mut ui = ui_open(&host, &link, &side, 200).await;
        let dirty = |host: &TestHost| host.sessions.get("a").unwrap().lock().dirty;
        assert!(dirty(&host));
        persist_due(dyn_host.clone()).await;
        assert!(!dirty(&host), "a small mirror is written on the next tick");
        let file = dir.path().join("lab/s1.json.zst");
        let written = std::fs::metadata(&file).unwrap().modified().unwrap();

        // A dialog opens and closes: nothing the cache keeps.
        side.lock().unwrap().change(SessionEvent::Ui { request: None });
        converge(&mut ui, &host, &side).await;
        // A reconnect re-opens it with nothing new.
        link.close("network lost");
        host.sessions.link_down();
        side.lock().unwrap().fanout.clear();
        let (link, _) = connect(&host, &side, true, true, "c2").await;
        reopen(dyn_host.clone(), link.clone()).await;
        assert_eq!(last_open(&side), (vec![], true, true), "nothing resent");
        assert!(!dirty(&host));
        persist_due(dyn_host.clone()).await;
        assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), written, "not rewritten");

        // A row changes: written on the next tick.
        side.lock().unwrap().change(SessionEvent::Upsert { item: assistant("a150", "new"), h: None });
        converge(&mut ui, &host, &side).await;
        persist_due(dyn_host.clone()).await;
        assert!(!dirty(&host));

        // Now 3 MiB: written once, then not again for a while.
        side.lock().unwrap().change(SessionEvent::Upsert { item: tool("big", &prose(7, 500_000)), h: None });
        converge(&mut ui, &host, &side).await;
        persist_due(dyn_host.clone()).await;
        assert!(!dirty(&host));
        side.lock().unwrap().change(SessionEvent::Upsert { item: assistant("a151", "more"), h: None });
        converge(&mut ui, &host, &side).await;
        persist_due(dyn_host.clone()).await;
        assert!(dirty(&host), "a big mirror waits");
        // Closing it writes it at once.
        closed(&dyn_host, "a");
        until("the close wrote it", || !dirty(&host)).await;
    }

    /// Closed mirrors leave memory least recently used first once they take more than the
    /// budget, by size however many they are; open ones, unwritten ones and ones anyone holds
    /// (an open, a write) stay.
    #[test]
    fn idle_mirrors_are_capped_by_size() {
        let s = Sessions::default();
        let t0 = Instant::now();
        let put = |id: &str, rows: usize, at: u64| {
            let m = s.mirror(id);
            let mut st = m.lock();
            st.data = Some(data("s", (0..rows).map(|i| user(&format!("u{i}"), &prose(i as u64, 50))).collect()));
            st.used = t0 + Duration::from_millis(at);
        };
        put("old", 200, 0);
        put("mid", 200, 1);
        put("new", 200, 2);
        put("open", 200, 0);
        s.get("open").unwrap().lock().wanted = true;
        put("unwritten", 200, 0);
        s.get("unwritten").unwrap().lock().dirty = true;
        put("held", 200, 0);
        let held = s.get("held").unwrap();
        let one = s.get("old").unwrap().lock().weight();
        let present = |s: &Sessions| ["old", "mid", "new", "open", "unwritten", "held"].map(|id| s.get(id).is_some());
        s.evict_idle(2 * one + one / 2);
        assert_eq!(present(&s), [false, true, true, true, true, true], "the least recently used leaves first");
        s.evict_idle(0);
        assert_eq!(present(&s), [false, false, false, true, true, true]);
        drop(held);
        s.evict_idle(0);
        assert!(s.get("held").is_none());
        // Many small ones fit where a few big ones would not.
        for i in 0..40 {
            put(&format!("small{i}"), 1, 10 + i);
        }
        s.evict_idle(2 * one);
        assert!((0..40).all(|i| s.get(&format!("small{i}")).is_some()));
    }

    // ── lab: a real long session through a real tf-hostd ──────────────────────────────────────

    struct Quiet;

    impl LinkSink for Quiet {
        fn snapshot(&self, _: u64, _: HostState) {}
        fn patch(&self, _: u64, _: Vec<StatePatch>) {}
        fn push(&self, _: ServerMsg) {}
        fn latency(&self, _: u32) {}
    }

    fn lab_env(k: &str) -> String {
        std::env::var(k).unwrap_or_else(|_| panic!("set {k} (see lab_wire_bytes)"))
    }

    /// A client through `tf-hostd attach` (`features`: this app's, else today's protocol).
    async fn lab_attach(features: bool, sink: Arc<dyn LinkSink>) -> (Arc<Link>, tokio::process::Child) {
        let session = lab_env("TF_LAB_SESSION");
        let mut child = tokio::process::Command::new(lab_env("TF_LAB_HOSTD"))
            .args(["attach", "--session", &session, "--relay-port", &lab_env("TF_LAB_RELAY")])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("tf-hostd attach");
        let hello = ClientMsg::Hello {
            protocol: PROTOCOL_VERSION,
            client: ClientInfo {
                app: "teleflock-lab".into(),
                version: if features { "0.6.0" } else { "0.5.3" }.into(),
                platform: "linux".into(),
                device: "lab".into(),
                features: features.then(requested_features),
            },
            herdr_session: session,
        };
        let (i, o, e) = (child.stdin.take().unwrap(), child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let link = Link::establish(Box::new(i), Box::new(o), Some(Box::new(e)), hello, sink).await.expect("link");
        (link, child)
    }

    async fn lab_agent(link: &Link, agent: &str) -> Value {
        let st = link.request("state.get", serde_json::json!({}), DEFAULT_TIMEOUT).await.expect("state.get");
        st["agents"].as_array().and_then(|a| a.iter().find(|x| x["id"] == agent).cloned()).unwrap_or(Value::Null)
    }

    /// Wire bytes (and JSON bytes) `link` received while `f` ran.
    async fn received<T>(link: &Link, f: impl Future<Output = T>) -> (T, u64, u64) {
        let before = link.totals();
        let out = f.await;
        let after = link.totals();
        (out, after.rx - before.rx, after.rx_plain - before.rx_plain)
    }

    /// Lab measurement: wire bytes of a real long omp session through a real tf-hostd, today's
    /// protocol against zstd + session sync — first open, cached re-open after an app restart,
    /// reconnect in the middle of a stream, 10 s of streaming — and, at the end, the mirror
    /// against a fresh full snapshot. Needs an isolated lab (own TF_HOSTD_HOME, herdr session,
    /// relay port, omp agent dir with a model credential):
    ///
    /// ```sh
    /// TF_HOSTD_HOME=/tmp/tf-lab-cs2-home PI_CODING_AGENT_DIR=/tmp/tf-lab-cs2-home/omp-agent \
    /// TF_LAB_HOSTD=target/ClientSync/debug/tf-hostd TF_LAB_SESSION=tf-lab-cs2 TF_LAB_RELAY=47637 \
    /// TF_LAB_SESSION_FILE=<a long session .jsonl in the lab agent dir> TF_LAB_CWD=/tmp/tf-lab-cs2-work \
    /// cargo test -p tf-client lab_wire_bytes -- --ignored --nocapture
    /// ```
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "lab: a real tf-hostd, herdr and omp (see the doc comment)"]
    async fn lab_wire_bytes() {
        let home = lab_env("TF_HOSTD_HOME");
        let relay = lab_env("TF_LAB_RELAY");
        std::fs::write(
            format!("{home}/omp-overlay.yml"),
            format!("collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:{relay}\n  displayName: tf-lab-cs2\n"),
        )
        .unwrap();
        std::fs::create_dir_all(format!("{home}/ext")).unwrap();
        std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/../../host/teleflock-bridge/teleflock-bridge.ts"), format!("{home}/ext/teleflock-bridge.ts")).unwrap();

        // The long session, resumed in the lab.
        let (setup, _setup) = lab_attach(false, Arc::new(Quiet)).await;
        let target = serde_json::json!({ "kind": "cwd", "cwd": lab_env("TF_LAB_CWD"), "label": "lab" });
        let started = setup
            .request("host.resume", serde_json::json!({ "sessionFile": lab_env("TF_LAB_SESSION_FILE"), "target": target }), crate::link::LAUNCH_TIMEOUT)
            .await
            .expect("host.resume");
        let agent = started["agentId"].as_str().expect("agent id").to_owned();
        let mut sid = String::new();
        for _ in 0..180 {
            let a = lab_agent(&setup, &agent).await;
            if a["omp"]["link"] == "live" {
                sid = a["omp"]["sessionId"].as_str().unwrap_or_default().to_owned();
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        assert!(!sid.is_empty(), "the agent never went live");
        let model = serde_json::json!({ "agentId": agent, "model": "openai-codex/gpt-6-luna", "thinking": "low" });
        setup.request("agent.setModel", model, DEFAULT_TIMEOUT).await.expect("agent.setModel");
        let params = serde_json::json!({ "agentId": agent, "limit": 200 });
        let typed = SessionOpenParams { agent_id: agent.clone(), limit: Some(200), have: None };

        // Today's protocol.
        let (old, old_child) = lab_attach(false, Arc::new(Quiet)).await;
        let (snap, before_open, _) = received(&old, old.request("session.open", params.clone(), DEFAULT_TIMEOUT)).await;
        let rows = snap.expect("session.open")["items"].as_array().map_or(0, Vec::len);
        old.request("session.close", serde_json::json!({ "agentId": agent }), DEFAULT_TIMEOUT).await.unwrap();
        let (_, before_reopen, _) = received(&old, old.request("session.open", params.clone(), DEFAULT_TIMEOUT)).await;
        old.close("lab");
        drop(old_child);
        let (old, old_child) = lab_attach(false, Arc::new(Quiet)).await;
        let before_connect = old.totals().rx;
        let (_, before_reconnect, _) = received(&old, old.request("session.open", params.clone(), DEFAULT_TIMEOUT)).await;

        // This app: zstd + session sync with the cache.
        let cache = tempfile::tempdir().unwrap();
        let lab_host = || {
            let h = test_host(cache.path());
            *h.hint.lock().unwrap() = AgentHint { session_id: Some(sid.clone()), live: true };
            h
        };
        let host = lab_host();
        let dh: Arc<dyn SessionHost> = host.clone();
        let (new, new_child) = lab_attach(true, Arc::new(TestSink(host.clone()))).await;
        *host.link.lock().unwrap() = Some(new.clone());
        assert_eq!(new.features, crate::link::Features { zstd: true, session_sync: true });
        let (_, after_open, after_open_plain) = received(&new, open(&dh, &new, &typed)).await;
        closed(&dh, &agent);
        new.request("session.close", serde_json::json!({ "agentId": agent }), DEFAULT_TIMEOUT).await.unwrap();
        persist_all(dh.clone()).await;
        new.close("app quits");
        drop(new_child);
        // App restart: a new process with the cache on disk.
        let host = lab_host();
        let dh: Arc<dyn SessionHost> = host.clone();
        let (new, new_child) = lab_attach(true, Arc::new(TestSink(host.clone()))).await;
        *host.link.lock().unwrap() = Some(new.clone());
        let after_connect = new.totals().rx;
        let (_, after_reopen, _) = received(&new, open(&dh, &new, &typed)).await;

        // 10 s of streaming, both clients subscribed: a bash loop that prints for ~10 s.
        let prompt = std::env::var("TF_LAB_PROMPT").unwrap_or_else(|_| {
            "Run exactly this bash command, then reply only `done`: for i in $(seq 1 90); do echo \"line $i of the lab stream $(date +%s%N)\"; sleep 0.11; done".into()
        });
        let send = |link: Arc<Link>| {
            let p = serde_json::json!({ "agentId": agent, "text": prompt, "images": [], "delivery": "auto" });
            async move { link.request("agent.prompt", p, crate::link::LAUNCH_TIMEOUT).await.expect("agent.prompt") }
        };
        let (o0, n0) = (old.totals(), new.totals());
        send(old.clone()).await;
        tokio::time::sleep(Duration::from_secs(10)).await;
        let (o1, n1) = (old.totals(), new.totals());
        // The first stream ends before the next one starts.
        for _ in 0..120 {
            if lab_agent(&old, &agent).await["state"] != "working" {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        // A reconnect in the middle of the next stream.
        send(old.clone()).await;
        tokio::time::sleep(Duration::from_secs(4)).await;
        old.close("network lost");
        drop(old_child);
        let (old, _old_child) = lab_attach(false, Arc::new(Quiet)).await;
        let (_, before_mid, _) = received(&old, old.request("session.open", params.clone(), DEFAULT_TIMEOUT)).await;
        new.close("network lost");
        host.sessions.link_down();
        drop(new_child);
        let (new, _new_child) = lab_attach(true, Arc::new(TestSink(host.clone()))).await;
        *host.link.lock().unwrap() = Some(new.clone());
        let (_, after_mid, _) = received(&new, reopen(dh.clone(), new.clone())).await;

        // When the stream ends, the mirror shows what a full snapshot shows.
        for _ in 0..120 {
            if lab_agent(&old, &agent).await["state"] != "working" {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        let full: SessionSnapshot = serde_json::from_value(old.request("session.open", params.clone(), DEFAULT_TIMEOUT).await.unwrap()).unwrap();
        let mine: SessionSnapshot = serde_json::from_value(open(&dh, &new, &typed).await.unwrap()).unwrap();
        assert_eq!(mine.items.len(), full.items.len());
        for (a, b) in mine.items.iter().zip(&full.items) {
            assert_eq!(a, b, "mirror row {} differs", a.id());
        }

        println!("lab: {rows} rows in the window, omp session {sid}");
        println!("| | today | zstd + session sync |");
        println!("|---|---:|---:|");
        println!("| first open (`session.open`, 200 rows) | {before_open} | {after_open} ({after_open_plain} as JSON) |");
        println!("| re-open (today: closed and opened again; sync: after an app restart, from the cache) | {before_reopen} | {after_reopen} |");
        println!("| connect (hello → host snapshot) | {before_connect} | {after_connect} |");
        println!("| reconnect: session re-open | {before_reconnect} | — |");
        println!("| reconnect mid-stream: session re-open | {before_mid} | {after_mid} |");
        println!("| 10 s of streaming (everything received) | {} | {} ({} as JSON) |", o1.rx - o0.rx, n1.rx - n0.rx, n1.rx_plain - n0.rx_plain);
    }
}
