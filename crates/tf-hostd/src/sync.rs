//! Session subscriptions (architecture §3.3): the clients an omp session's events go to, and what
//! a `sessionSync` subscriber gets on top of the plain stream.
//!
//! A plain subscription (old apps, `session.open` without `have`) gets exactly the stream it
//! always got. A `sessionSync` one ([`tf_proto::host::FEATURE_SESSION_SYNC`]) gets:
//! * a **delta snapshot**: the window (the newest `limit` rows of the replica's current path)
//!   minus the rows `have` lists with the same hash, with `order` listing the whole window;
//! * every later `session` message numbered (`seq`), upserts with their row hash (`h`), appends
//!   with the byte length of the field before them (`at`);
//! * `meta` as `metaPatch` (changed top-level fields) / `treePatch` (changed tree nodes);
//! * live `reset`s (collab or bridge resyncs, rewritten files) as delta snapshots against what it
//!   holds.
//!
//! hostd knows what such a client holds because every message after its snapshot reaches it in
//! order (a gap makes the client re-open with `have`): the snapshot's window, then every upsert,
//! append, remove and reset. Rows appended to since their last hash are resent by a later delta.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use tf_proto::host::ServerMsg;
use tf_proto::model::QueueInfo;
use tf_proto::session::{
    AppendField, RowDigest, SessionEvent, SessionHave, SessionMeta, SessionSnapshot, SessionSync, TranscriptItem, TreeInfo, TreeNode,
};

use crate::clients::ClientHandle;

/// Apps from this version (pre-releases included) keep a session's tree when a `meta` comes
/// without one, so plain subscriptions of theirs get the tree only when it changed; older apps get
/// it in every `meta`.
const TREE_ON_CHANGE_SINCE: &str = "0.5.1-0";

/// Rows of `have` that are looked at ([`SessionHave::rows`] promises at most this many).
pub const HAVE_MAX: usize = 500;

/// Whether an app of `version` keeps its session tree when a `meta` comes without one.
pub fn keeps_tree(version: &str) -> bool {
    tf_proto::version::cmp_semver(version, TREE_ON_CHANGE_SINCE).is_some_and(|o| o.is_ge())
}

/// Content hash of a transcript row or meta part (sha-256 of its JSON, first 8 bytes).
pub type Hash = u64;

/// Wire form of a hash (opaque to clients: they compare for equality only).
pub fn hex(h: Hash) -> String {
    format!("{h:016x}")
}

struct HashWriter<'a>(&'a mut Sha256);

impl std::io::Write for HashWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.update(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn hash_json<T: serde::Serialize + ?Sized>(v: &T) -> Hash {
    let mut h = Sha256::new();
    // Serializing our own wire types into a hasher cannot fail.
    let _ = serde_json::to_writer(HashWriter(&mut h), v);
    let d = h.finalize();
    u64::from_le_bytes(d[..8].try_into().expect("sha-256 has 32 bytes"))
}

/// Hash of a transcript row ([`SessionEvent::Upsert`]'s `h`, [`SessionSync::hashes`]).
pub fn row_hash(item: &TranscriptItem) -> Hash {
    hash_json(item)
}

/// UTF-8 length of the field an `append` extends (`None`: the row has no such field), applied the
/// way clients apply appends: `text` of rows that have one, `output` of tools.
pub fn field_len(item: &TranscriptItem, field: AppendField) -> Option<u64> {
    let n = match (item, field) {
        (TranscriptItem::User(i), AppendField::Text) => i.text.len(),
        (TranscriptItem::Assistant(i), AppendField::Text) => i.text.len(),
        (TranscriptItem::Thinking(i), AppendField::Text) => i.text.len(),
        (TranscriptItem::Notice(i), AppendField::Text) => i.text.len(),
        (TranscriptItem::Mode(i), AppendField::Text) => i.text.len(),
        (TranscriptItem::Tool(i), AppendField::Output) => i.output.as_ref().map_or(0, String::len),
        _ => return None,
    };
    Some(n as u64)
}

/// The session tree subscribers are sent: `tree` at revision `rev`, which the session bumps on
/// every change. A revision's hash and shared copy are made once ([`Fanout`] keeps them), not on
/// every `meta` flush.
#[derive(Clone, Copy)]
pub struct Tree<'a> {
    pub tree: Option<&'a TreeInfo>,
    pub rev: u64,
}

/// A tree as subscribers' metas hold it: shared, with its hash.
#[derive(Clone)]
struct TreeState {
    tree: Option<Arc<TreeInfo>>,
    hash: Hash,
}

impl TreeState {
    fn of(tree: Option<&TreeInfo>) -> TreeState {
        TreeState { hash: hash_json(&tree), tree: tree.map(|t| Arc::new(t.clone())) }
    }
}

/// A meta as patches see it: its top-level fields except `tree` (JSON), and the tree.
struct MetaState {
    fields: Map<String, Value>,
    fields_hash: Hash,
    tree: TreeState,
}

impl MetaState {
    /// `meta` with its tree.
    #[cfg(test)]
    fn of(meta: &SessionMeta) -> MetaState {
        let mut bare = meta.clone();
        let tree = bare.tree.take();
        MetaState::new(&bare, TreeState::of(tree.as_ref()))
    }

    /// `meta` with `tree`. `meta` comes without a tree (the replica's never has one): its fields
    /// are serialized for every `meta` flush, the tree only per revision.
    fn new(meta: &SessionMeta, tree: TreeState) -> MetaState {
        let fields = match serde_json::to_value(meta) {
            Ok(Value::Object(mut m)) => {
                m.remove("tree");
                m
            }
            _ => Map::new(),
        };
        MetaState { fields_hash: hash_json(&fields), fields, tree }
    }

    /// [`SessionSync::meta_hash`]: hash of the full meta.
    fn hash(&self) -> String {
        combine(self.fields_hash, self.tree.hash)
    }
}

fn combine(fields: Hash, tree: Hash) -> String {
    let mut h = Sha256::new();
    h.update(fields.to_le_bytes());
    h.update(tree.to_le_bytes());
    let d = h.finalize();
    hex(u64::from_le_bytes(d[..8].try_into().expect("sha-256 has 32 bytes")))
}

/// The `metaPatch` `set` taking `old` to `new` (`null` clears a field).
fn fields_patch(old: &Map<String, Value>, new: &Map<String, Value>) -> Map<String, Value> {
    let mut set = Map::new();
    for (k, v) in new {
        if old.get(k) != Some(v) {
            set.insert(k.clone(), v.clone());
        }
    }
    for k in old.keys() {
        if !new.contains_key(k) {
            set.insert(k.clone(), Value::Null);
        }
    }
    set
}

/// `treePatch` parts (`upsert`, `remove`) taking `old` to `new`, in the order clients apply them:
/// removed nodes go, changed ones are replaced in place, new ones are appended. When that would
/// not reproduce `new`'s node order, every old node is removed and every new one upserted.
pub fn tree_patch(old: Option<&TreeInfo>, new: &TreeInfo) -> (Vec<TreeNode>, Vec<String>) {
    let Some(old) = old else { return (new.nodes.clone(), Vec::new()) };
    let before: HashMap<&str, &TreeNode> = old.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let after: HashSet<&str> = new.nodes.iter().map(|n| n.id.as_str()).collect();
    let remove: Vec<String> = old.nodes.iter().filter(|n| !after.contains(n.id.as_str())).map(|n| n.id.clone()).collect();
    let upsert: Vec<TreeNode> = new.nodes.iter().filter(|n| before.get(n.id.as_str()) != Some(n)).cloned().collect();
    let rebuilt = old
        .nodes
        .iter()
        .map(|n| n.id.as_str())
        .filter(|id| after.contains(id))
        .chain(new.nodes.iter().map(|n| n.id.as_str()).filter(|id| !before.contains_key(id)));
    if rebuilt.eq(new.nodes.iter().map(|n| n.id.as_str())) {
        (upsert, remove)
    } else {
        (new.nodes.clone(), old.nodes.iter().map(|n| n.id.clone()).collect())
    }
}

/// Applies a `treePatch` the way clients do ([`tree_patch`]).
pub fn apply_tree_patch(tree: &mut TreeInfo, upsert: &[TreeNode], remove: &[String], leaf_id: Option<String>) {
    if !remove.is_empty() {
        let gone: HashSet<&str> = remove.iter().map(String::as_str).collect();
        tree.nodes.retain(|n| !gone.contains(n.id.as_str()));
    }
    let mut at: HashMap<String, usize> = tree.nodes.iter().enumerate().map(|(i, n)| (n.id.clone(), i)).collect();
    for n in upsert {
        match at.get(&n.id) {
            Some(&i) => tree.nodes[i] = n.clone(),
            None => {
                at.insert(n.id.clone(), tree.nodes.len());
                tree.nodes.push(n.clone());
            }
        }
    }
    tree.leaf_id = leaf_id;
}

/// Empties the heavy parts of a meta sent only as a placeholder (`SessionSync::meta_same`).
fn placeholder(meta: &mut SessionMeta) {
    meta.tree = None;
    meta.todos.clear();
    meta.subagents.clear();
    meta.files.clear();
    meta.goal = None;
    meta.queue = QueueInfo { steering: Vec::new(), follow_up: Vec::new() };
}

/// What a `sessionSync` subscriber holds, as far as hostd knows.
struct SyncState {
    /// Seq of the last `session` message sent to it.
    seq: u64,
    /// Rows it holds, with their hash (`None`: appended to since).
    held: HashMap<String, Option<Hash>>,
    /// The meta it holds.
    meta: Arc<MetaState>,
}

/// Which rows of a window (`items`, with their `hashes`) a subscriber holding `held` lacks or
/// holds with another hash (`true`: send it), and their digests.
fn lacking(items: &[TranscriptItem], hashes: &[Hash], held: &HashMap<&str, Hash>) -> (Vec<bool>, Vec<RowDigest>) {
    let mut send = Vec::with_capacity(items.len());
    let mut digests = Vec::new();
    for (item, &h) in items.iter().zip(hashes) {
        let lacks = held.get(item.id()) != Some(&h);
        if lacks {
            digests.push(RowDigest { id: item.id().to_owned(), h: hex(h) });
        }
        send.push(lacks);
    }
    (send, digests)
}

impl SyncState {
    /// Completes a snapshot for the subscriber: `sync` (`order`: the window's ids, when rows were
    /// left out) and the meta: a placeholder when it holds `meta` already, else with `meta`'s tree.
    fn finish(snap: &mut SessionSnapshot, order: Option<Vec<String>>, digests: Vec<RowDigest>, meta_same: bool, meta: &MetaState, seq: u64) {
        if meta_same {
            placeholder(&mut snap.meta);
        } else {
            snap.meta.tree = meta.tree.tree.as_deref().cloned();
        }
        snap.sync = Some(SessionSync { seq, delta: order.is_some(), order, hashes: digests, meta_hash: meta.hash(), meta_same });
    }

    /// A subscriber opening with `have`: its snapshot (`snap`, the full window with a meta without
    /// tree, becomes what it lacks) and its state. `session_id` is the omp session the window
    /// belongs to; `meta` the session's meta with its tree.
    fn open(snap: &mut SessionSnapshot, have: &SessionHave, session_id: &str, seq: u64, meta: Arc<MetaState>) -> SyncState {
        let hashes: Vec<Hash> = snap.items.iter().map(row_hash).collect();
        let same = have.session_id == session_id;
        let have_rows: HashMap<&str, Hash> = if same {
            have.rows
                .iter()
                .take(HAVE_MAX)
                .filter_map(|r| u64::from_str_radix(&r.h, 16).ok().filter(|_| r.h.len() == 16).map(|h| (r.id.as_str(), h)))
                .collect()
        } else {
            HashMap::new()
        };
        let meta_same = same && have.meta_hash.as_deref() == Some(meta.hash().as_str());
        let held = snap.items.iter().zip(&hashes).map(|(i, &h)| (i.id().to_owned(), Some(h))).collect();
        let (send, digests) = lacking(&snap.items, &hashes, &have_rows);
        let order = send.contains(&false).then(|| snap.items.iter().map(|i| i.id().to_owned()).collect());
        snap.items = std::mem::take(&mut snap.items).into_iter().zip(send).filter_map(|(item, send)| send.then_some(item)).collect();
        SyncState::finish(snap, order, digests, meta_same, &meta, seq);
        SyncState { seq, held, meta }
    }

    /// A live `reset` for this subscriber: the delta against what it holds (only the rows it
    /// lacks are copied out of `full`).
    fn reset(&mut self, full: &SessionSnapshot, hashes: &[Hash], meta: &Arc<MetaState>, agent_id: &str) -> SessionSnapshot {
        let held: HashMap<&str, Hash> = self.held.iter().filter_map(|(id, h)| h.map(|h| (id.as_str(), h))).collect();
        let (send, digests) = lacking(&full.items, hashes, &held);
        let order = send.contains(&false).then(|| full.items.iter().map(|i| i.id().to_owned()).collect());
        let mut snap = SessionSnapshot {
            agent_id: agent_id.to_owned(),
            meta: full.meta.clone(),
            items: full.items.iter().zip(&send).filter(|(_, send)| **send).map(|(item, _)| item.clone()).collect(),
            has_more: full.has_more,
            cursor: full.cursor.clone(),
            ui: full.ui.clone(),
            sync: None,
        };
        let meta_same = self.meta.hash() == meta.hash();
        SyncState::finish(&mut snap, order, digests, meta_same, meta, self.seq + 1);
        self.held = full.items.iter().zip(hashes).map(|(i, &h)| (i.id().to_owned(), Some(h))).collect();
        self.meta = meta.clone();
        snap
    }

    /// Records a row event sent to it.
    fn sent(&mut self, ev: &SessionEvent, hash: Option<Hash>) {
        match ev {
            SessionEvent::Upsert { item, .. } => {
                self.held.insert(item.id().to_owned(), hash);
            }
            SessionEvent::Append { id, .. } => {
                if let Some(h) = self.held.get_mut(id) {
                    *h = None;
                }
            }
            SessionEvent::Remove { id } => {
                self.held.remove(id);
            }
            _ => {}
        }
    }

    /// The events taking its meta to `now` (none when it is current).
    fn meta_events(&self, now: &MetaState) -> Vec<SessionEvent> {
        let old = &*self.meta;
        let mut out = Vec::new();
        let set = fields_patch(&old.fields, &now.fields);
        let tree_changed = old.tree.hash != now.tree.hash;
        if !set.is_empty() {
            out.push(SessionEvent::MetaPatch { set, hash: combine(now.fields_hash, old.tree.hash) });
        }
        if tree_changed {
            match &now.tree.tree {
                Some(tree) => {
                    let (upsert, remove) = tree_patch(old.tree.tree.as_deref(), tree);
                    out.push(SessionEvent::TreePatch { upsert, remove, leaf_id: tree.leaf_id.clone(), hash: now.hash() });
                }
                // A tree gone (never happens in practice): the whole meta.
                None => {
                    let mut meta: SessionMeta = match serde_json::from_value(Value::Object(now.fields.clone())) {
                        Ok(m) => m,
                        Err(_) => return out,
                    };
                    meta.tree = None;
                    out.clear();
                    out.push(SessionEvent::Meta { meta });
                }
            }
        }
        out
    }
}

/// One flush's events as `sessionSync` subscribers get them: appends that a later upsert, remove
/// or reset of the same row makes moot are dropped (and everything a later reset replaces), the
/// rest carry `at`; upserts carry `h`; resets their row hashes and meta.
#[allow(clippy::large_enum_variant, reason = "`Event` is nearly every element: boxing it would allocate per event")]
enum Prepared<'a> {
    Event(SessionEvent, Option<Hash>),
    Reset(&'a SessionSnapshot, Vec<Hash>, Arc<MetaState>),
    /// Always delivered as is (`btw`, `ended`).
    Pass(&'a SessionEvent),
}

/// `reset_meta` gives a reset's meta state (the snapshot's meta has no tree; at most one reset per
/// flush survives).
fn prepare<'a>(events: &'a [SessionEvent], field_len: &dyn Fn(&str, AppendField) -> Option<u64>, reset_meta: &mut dyn FnMut(&SessionMeta) -> Arc<MetaState>) -> Vec<Prepared<'a>> {
    let mut out = Vec::with_capacity(events.len());
    let mut replaced: HashSet<&str> = HashSet::new();
    let mut reset = false;
    let mut len: HashMap<(&str, AppendField), Option<u64>> = HashMap::new();
    for ev in events.iter().rev() {
        match ev {
            SessionEvent::Reset { snapshot } => {
                if !reset {
                    reset = true;
                    let hashes = snapshot.items.iter().map(row_hash).collect();
                    out.push(Prepared::Reset(snapshot, hashes, reset_meta(&snapshot.meta)));
                }
            }
            SessionEvent::Upsert { item, .. } if !reset => {
                replaced.insert(item.id());
                let h = row_hash(item);
                out.push(Prepared::Event(SessionEvent::Upsert { item: item.clone(), h: Some(hex(h)) }, Some(h)));
            }
            SessionEvent::Remove { id } if !reset => {
                replaced.insert(id);
                out.push(Prepared::Event(ev.clone(), None));
            }
            SessionEvent::Append { id, field, text, .. } if !reset && !replaced.contains(id.as_str()) => {
                let cur = len.entry((id.as_str(), *field)).or_insert_with(|| field_len(id, *field));
                let at = cur.and_then(|c| c.checked_sub(text.len() as u64));
                *cur = at;
                out.push(Prepared::Event(SessionEvent::Append { id: id.clone(), field: *field, text: text.clone(), at }, None));
            }
            SessionEvent::Upsert { .. } | SessionEvent::Remove { .. } | SessionEvent::Append { .. } | SessionEvent::Ui { .. } if reset => {}
            SessionEvent::Append { .. } => {}
            SessionEvent::Btw { .. } | SessionEvent::Ended { .. } => out.push(Prepared::Pass(ev)),
            other => out.push(Prepared::Event(other.clone(), None)),
        }
    }
    out.reverse();
    out
}

/// A client subscribed to the session (`session.open`) as one of its agents.
struct Sub {
    client: ClientHandle,
    agent_id: String,
    /// Plain subscriptions: the app keeps its tree when a `meta` omits it ([`keeps_tree`]).
    tree_on_change: bool,
    sync: Option<SyncState>,
}

impl Sub {
    fn send(&mut self, ev: SessionEvent) {
        let seq = self.sync.as_mut().map(|s| {
            s.seq += 1;
            s.seq
        });
        self.client.send(ServerMsg::Session { agent_id: self.agent_id.clone(), ev, seq });
    }
}

/// The subscribers of one omp session. Every method is called under the session's lock, in the
/// order the replica produced the events.
#[derive(Default)]
pub struct Fanout {
    subs: Vec<Sub>,
    /// The tree `sessionSync` subscribers' metas hold, by revision ([`Tree::rev`]): hashed and
    /// copied once per change, dropped when no such subscriber is left.
    tree: Option<(u64, TreeState)>,
}

impl Fanout {
    pub fn is_empty(&self) -> bool {
        self.subs.is_empty()
    }

    pub fn len(&self) -> usize {
        self.subs.len()
    }

    /// Forgets disconnected clients.
    pub fn prune(&mut self) {
        self.subs.retain(|s| !s.client.is_closed());
        self.settle();
    }

    pub fn clear(&mut self) {
        self.subs.clear();
        self.settle();
    }

    pub fn unsubscribe(&mut self, client_id: &str, agent_id: &str) {
        self.subs.retain(|s| !(s.client.id() == client_id && s.agent_id == agent_id));
        self.settle();
    }

    pub fn unsubscribe_client(&mut self, client_id: &str) {
        self.subs.retain(|s| s.client.id() != client_id);
        self.settle();
    }

    /// Drops the tree copy nobody needs any more.
    fn settle(&mut self) {
        if !self.subs.iter().any(|s| s.sync.is_some()) {
            self.tree = None;
        }
    }

    /// `tree` as metas hold it (computed once per revision).
    fn tree_state(&mut self, tree: Tree<'_>) -> TreeState {
        match &self.tree {
            Some((rev, state)) if *rev == tree.rev => state.clone(),
            _ => {
                let state = TreeState::of(tree.tree);
                self.tree = Some((tree.rev, state.clone()));
                state
            }
        }
    }

    /// Subscribes `client` as `agent_id` (replacing its earlier subscription as that agent) and
    /// returns its snapshot: `snap` (the full window, meta with overlay, without tree) with
    /// `tree`, or, when the client speaks `sessionSync` and sent `have`, what it lacks.
    /// `session_id` is the omp session the window belongs to when the meta does not say.
    pub fn subscribe(&mut self, client: &ClientHandle, agent_id: &str, mut snap: SessionSnapshot, tree: Tree<'_>, have: Option<&SessionHave>, session_id: &str) -> SessionSnapshot {
        let prev = self.subs.iter().position(|s| s.client.id() == client.id() && s.agent_id == agent_id).map(|i| self.subs.remove(i));
        self.subs.retain(|s| !s.client.is_closed());
        // A re-open continues the numbering, so the client can tell the old subscription's
        // messages (seq ≤ the new snapshot's) from the new one's.
        let seq = prev.and_then(|p| p.sync).map_or(0, |s| s.seq);
        snap.agent_id = agent_id.to_owned();
        let sync = match have {
            Some(have) if client.features().session_sync => {
                let meta = Arc::new(MetaState::new(&snap.meta, self.tree_state(tree)));
                let current = snap.meta.session_id.clone().unwrap_or_else(|| session_id.to_owned());
                Some(SyncState::open(&mut snap, have, &current, seq, meta))
            }
            _ => {
                snap.meta.tree = tree.tree.cloned();
                None
            }
        };
        self.subs.push(Sub { client: client.clone(), agent_id: agent_id.to_owned(), tree_on_change: keeps_tree(&client.info().version), sync });
        self.settle();
        snap
    }

    /// Sends one flush's events (coalesced; `reset`s with overlay applied, without tree: they go
    /// out with `tree`). `field_len` is the current length of a row's field in the replica (`at`
    /// of appends).
    pub fn send_events(&mut self, events: &[SessionEvent], tree: Tree<'_>, field_len: &dyn Fn(&str, AppendField) -> Option<u64>) {
        if events.is_empty() {
            return;
        }
        let prepared = if self.subs.iter().any(|s| s.sync.is_some()) {
            prepare(events, field_len, &mut |meta| Arc::new(MetaState::new(meta, self.tree_state(tree))))
        } else {
            Vec::new()
        };
        for sub in &mut self.subs {
            if sub.sync.is_none() {
                for ev in events {
                    let ev = match ev {
                        SessionEvent::Reset { snapshot } => {
                            let mut s = snapshot.clone();
                            s.agent_id = sub.agent_id.clone();
                            s.meta.tree = tree.tree.cloned();
                            SessionEvent::Reset { snapshot: s }
                        }
                        other => other.clone(),
                    };
                    sub.send(ev);
                }
                continue;
            }
            for p in &prepared {
                let ev = match p {
                    Prepared::Reset(snap, hashes, meta) => {
                        let sync = sub.sync.as_mut().expect("sync subscription");
                        SessionEvent::Reset { snapshot: sync.reset(snap, hashes, meta, &sub.agent_id) }
                    }
                    Prepared::Event(ev, h) => {
                        sub.sync.as_mut().expect("sync subscription").sent(ev, *h);
                        ev.clone()
                    }
                    Prepared::Pass(ev) => (*ev).clone(),
                };
                sub.send(ev);
            }
        }
    }

    /// Sends the session's `meta` (overlay applied, without tree) and `tree`: plain subscribers
    /// get a `meta` (with the tree when it changed, or when their app would drop it), `sessionSync`
    /// ones the patches from the meta they hold.
    pub fn send_meta(&mut self, meta: &SessionMeta, tree: Tree<'_>, tree_changed: bool) {
        let with_tree = tree.tree.filter(|_| tree_changed || self.subs.iter().any(|s| s.sync.is_none() && !s.tree_on_change)).map(|t| {
            let mut full = meta.clone();
            full.tree = Some(t.clone());
            full
        });
        let now = self.subs.iter().any(|s| s.sync.is_some()).then(|| Arc::new(MetaState::new(meta, self.tree_state(tree))));
        // Subscribers holding the same meta share one diff.
        let mut patches: Vec<(*const MetaState, Vec<SessionEvent>)> = Vec::new();
        for sub in &mut self.subs {
            match (&mut sub.sync, &now) {
                (Some(sync), Some(now)) => {
                    let key = Arc::as_ptr(&sync.meta);
                    let evs = match patches.iter().find(|(k, _)| *k == key) {
                        Some((_, evs)) => evs.clone(),
                        None => {
                            let evs = sync.meta_events(now);
                            patches.push((key, evs.clone()));
                            evs
                        }
                    };
                    sync.meta = now.clone();
                    for ev in evs {
                        sub.send(ev);
                    }
                }
                _ => {
                    let m = match &with_tree {
                        Some(full) if tree_changed || !sub.tree_on_change => full.clone(),
                        _ => meta.clone(),
                    };
                    sub.send(SessionEvent::Meta { meta: m });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clients::Features;
    use tf_proto::host::ClientInfo;
    use tf_proto::session::{AssistantItem, Capabilities, NoticeItem, NoticeLevel, ToolItem, ToolStatus, TreeNodeKind, UserItem};

    fn caps() -> Capabilities {
        serde_json::from_value(serde_json::json!({
            "prompt": true, "steer": true, "followUp": true, "abort": true, "answer": true, "model": true, "thinking": true,
            "fast": true, "plan": true, "goal": true, "compact": true, "rename": true, "fork": true, "branch": true, "tree": true,
            "btw": true, "export": true, "handoff": true, "subagents": true, "bridge": true
        }))
        .unwrap()
    }

    pub(crate) fn meta(title: &str) -> SessionMeta {
        SessionMeta {
            session_id: Some("s1".into()),
            session_file: None,
            title: Some(title.into()),
            cwd: Some("/w".into()),
            model: None,
            thinking: None,
            fast: false,
            mode: tf_proto::model::OmpMode::Normal,
            goal: None,
            context: None,
            cost: None,
            tps: None,
            todos: Vec::new(),
            subagents: Vec::new(),
            files: Vec::new(),
            queue: QueueInfo { steering: Vec::new(), follow_up: Vec::new() },
            tree: None,
            caps: caps(),
            started_at: None,
        }
    }

    fn user(id: &str, text: &str) -> TranscriptItem {
        TranscriptItem::User(UserItem { id: id.into(), at: 1, text: text.into(), images: vec![], author: None, steering: false, synthetic: false })
    }

    fn assistant(id: &str, text: &str) -> TranscriptItem {
        TranscriptItem::Assistant(AssistantItem { id: id.into(), at: 2, text: text.into(), streaming: true, model: None, usage: None, stop_reason: None, error: None })
    }

    fn tool(id: &str, output: Option<&str>) -> TranscriptItem {
        TranscriptItem::Tool(ToolItem {
            id: id.into(),
            at: 3,
            call_id: id.into(),
            tool: "bash".into(),
            title: "ls".into(),
            intent: None,
            args: serde_json::json!({}),
            status: ToolStatus::Running,
            duration_ms: None,
            output: output.map(String::from),
            truncated: false,
            view: None,
            error: None,
        })
    }

    fn snap(items: Vec<TranscriptItem>, meta: SessionMeta) -> SessionSnapshot {
        SessionSnapshot { agent_id: "x".into(), meta, items, has_more: false, cursor: None, ui: None, sync: None }
    }

    fn client(id: &str, sync: bool) -> ClientHandle {
        let info = ClientInfo { app: "teleflock-desktop".into(), version: "0.6.0".into(), platform: "linux".into(), device: "d".into(), features: None };
        ClientHandle::with_features(id.into(), info, Features { zstd: false, session_sync: sync })
    }

    fn have_of(s: &SessionSnapshot) -> SessionHave {
        let sync = s.sync.as_ref().unwrap();
        SessionHave {
            session_id: "s1".into(),
            rows: sync.hashes.iter().rev().cloned().collect(),
            meta_hash: Some(sync.meta_hash.clone()),
        }
    }

    fn msgs(c: &ClientHandle) -> Vec<serde_json::Value> {
        let mut lines = Vec::new();
        c.take_batch(&mut lines);
        lines.iter().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn ids(s: &SessionSnapshot) -> Vec<&str> {
        s.items.iter().map(|i| i.id()).collect()
    }

    const NO_TREE: Tree<'static> = Tree { tree: None, rev: 0 };

    #[test]
    fn apps_from_0_5_1_keep_their_tree() {
        for (v, keeps) in [("0.5.0", false), ("0.0.0", false), ("dev", false), ("0.5.1-rc.1", true), ("0.5.1", true), ("0.6.0", true)] {
            assert_eq!(keeps_tree(v), keeps, "{v}");
        }
    }

    /// The delta of a re-open: rows held with the same hash are not resent, changed and new ones
    /// are; `order` lists the window; a matching meta hash sends a placeholder meta.
    #[test]
    fn delta_snapshot_sends_only_missing_and_stale_rows() {
        let rows = vec![user("u1", "hi"), assistant("a1", "hello"), tool("t1", Some("out")), user("u2", "more")];
        let c = client("c1", true);
        let mut f = Fanout::default();
        // First open: nothing cached → a full snapshot with every hash.
        let have = SessionHave { session_id: "s1".into(), rows: vec![], meta_hash: None };
        let first = f.subscribe(&c, "a", snap(rows.clone(), meta("t")), NO_TREE, Some(&have), "s1");
        let sync = first.sync.clone().unwrap();
        assert!(!sync.delta && sync.order.is_none() && !sync.meta_same);
        assert_eq!(ids(&first), ["u1", "a1", "t1", "u2"]);
        assert_eq!(sync.hashes.len(), 4);
        assert_eq!(first.meta.title.as_deref(), Some("t"));

        // Unchanged: nothing but the order.
        let again = f.subscribe(&c, "a", snap(rows.clone(), meta("t")), NO_TREE, Some(&have_of(&first)), "s1");
        let s = again.sync.as_ref().unwrap();
        assert!(s.delta && s.meta_same && again.items.is_empty() && s.hashes.is_empty());
        assert_eq!(s.order.as_deref().unwrap(), ["u1", "a1", "t1", "u2"]);
        assert_eq!(again.meta.title.as_deref(), Some("t"), "placeholder keeps the small fields");

        // Appended, changed and removed rows; another meta.
        let mut next = rows.clone();
        next.remove(1);
        next[1] = tool("t1", Some("out and more"));
        next.push(assistant("a2", "new"));
        let delta = f.subscribe(&c, "a", snap(next, meta("t2")), NO_TREE, Some(&have_of(&first)), "s1");
        let s = delta.sync.as_ref().unwrap();
        assert!(s.delta && !s.meta_same);
        assert_eq!(ids(&delta), ["t1", "a2"]);
        assert_eq!(s.order.as_deref().unwrap(), ["u1", "t1", "u2", "a2"]);
        assert_eq!(s.hashes.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["t1", "a2"]);
        assert_eq!(delta.meta.title.as_deref(), Some("t2"));

        // Another omp session (rotation): a full snapshot whatever the ids say.
        let mut other = have_of(&first);
        other.session_id = "s0".into();
        let full = f.subscribe(&c, "a", snap(rows.clone(), meta("t")), NO_TREE, Some(&other), "s1");
        assert!(!full.sync.as_ref().unwrap().delta && full.items.len() == 4);

        // A client without the feature (or without `have`): today's snapshot.
        let old = client("c2", false);
        let plain = f.subscribe(&old, "a", snap(rows.clone(), meta("t")), NO_TREE, Some(&have_of(&first)), "s1");
        assert!(plain.sync.is_none() && plain.items.len() == 4);
        let plain = f.subscribe(&c, "b", snap(rows, meta("t")), NO_TREE, None, "s1");
        assert!(plain.sync.is_none() && plain.items.len() == 4);
    }

    /// A branch switch leaves the file as it was but changes the window: the rows of the new path
    /// that the client lacks come, `order` drops the old branch's.
    #[test]
    fn branch_switch_with_unchanged_file() {
        let base: Vec<TranscriptItem> = (0..5).map(|i| user(&format!("u{i}"), "x")).collect();
        let old_branch: Vec<TranscriptItem> = base.iter().cloned().chain((5..10).map(|i| assistant(&format!("a{i}"), "old"))).collect();
        let new_branch: Vec<TranscriptItem> = base.iter().cloned().chain((5..8).map(|i| assistant(&format!("b{i}"), "new"))).collect();
        let c = client("c1", true);
        let mut f = Fanout::default();
        let have = SessionHave { session_id: "s1".into(), rows: vec![], meta_hash: None };
        let first = f.subscribe(&c, "a", snap(old_branch, meta("t")), NO_TREE, Some(&have), "s1");
        let switched = f.subscribe(&c, "a", snap(new_branch, meta("t")), NO_TREE, Some(&have_of(&first)), "s1");
        let s = switched.sync.as_ref().unwrap();
        assert_eq!(ids(&switched), ["b5", "b6", "b7"]);
        assert_eq!(s.order.as_deref().unwrap(), ["u0", "u1", "u2", "u3", "u4", "b5", "b6", "b7"]);
    }

    /// Live messages: numbered from the snapshot's `sync.seq`; a re-open continues the numbering.
    /// Upserts carry hashes; appends their offset; appends a later upsert of the row replaces
    /// are dropped; plain subscribers get the same stream as before.
    #[test]
    fn live_events_carry_seq_hashes_and_offsets() {
        let c = client("c1", true);
        let old = client("c2", false);
        let mut f = Fanout::default();
        let have = SessionHave { session_id: "s1".into(), rows: vec![], meta_hash: None };
        let s = f.subscribe(&c, "a", snap(vec![assistant("a1", "he")], meta("t")), NO_TREE, Some(&have), "s1");
        assert_eq!(s.sync.unwrap().seq, 0);
        f.subscribe(&old, "a", snap(vec![assistant("a1", "he")], meta("t")), NO_TREE, None, "s1");
        // Replica now: a1 = "hello" (two appends), t1 upserted then appended "x", then replaced.
        let events = vec![
            SessionEvent::Append { id: "a1".into(), field: AppendField::Text, text: "l".into(), at: None },
            SessionEvent::Upsert { item: tool("t1", Some("")), h: None },
            SessionEvent::Append { id: "t1".into(), field: AppendField::Output, text: "x".into(), at: None },
            SessionEvent::Append { id: "a1".into(), field: AppendField::Text, text: "lo".into(), at: None },
            SessionEvent::Upsert { item: tool("t1", Some("done")), h: None },
            SessionEvent::Btw { btw_id: "b".into(), turn: 0, question: None, text: "?".into(), done: false },
        ];
        let lens = |id: &str, f: AppendField| match (id, f) {
            ("a1", AppendField::Text) => Some(5),
            ("t1", AppendField::Output) => Some(4),
            _ => None,
        };
        f.send_events(&events, NO_TREE, &lens);
        let got = msgs(&c);
        let kinds: Vec<(&str, u64)> = got.iter().map(|m| (m["ev"]["k"].as_str().unwrap(), m["seq"].as_u64().unwrap())).collect();
        assert_eq!(kinds, [("append", 1), ("upsert", 2), ("append", 3), ("upsert", 4), ("btw", 5)]);
        assert_eq!(got[0]["ev"]["at"], 2, "\"he\" before \"l\"");
        assert_eq!(got[2]["ev"]["at"], 3, "\"hel\" before \"lo\"");
        assert_eq!(got[1]["ev"]["h"].as_str().unwrap(), hex(row_hash(&tool("t1", Some("")))));
        assert_eq!(got[3]["ev"]["h"].as_str().unwrap(), hex(row_hash(&tool("t1", Some("done")))));
        // The plain subscriber: exactly the coalesced events, no seq, no hashes, no offsets.
        let plain = msgs(&old);
        assert_eq!(plain.len(), events.len());
        assert!(plain.iter().all(|m| m.get("seq").is_none() && m["ev"].get("h").is_none() && m["ev"].get("at").is_none()));

        // A re-open continues at the last seq.
        let again = f.subscribe(&c, "a", snap(vec![assistant("a1", "hello")], meta("t")), NO_TREE, Some(&have), "s1");
        assert_eq!(again.sync.unwrap().seq, 5);
        f.send_events(&[SessionEvent::Remove { id: "a1".into() }], NO_TREE, &lens);
        assert_eq!(msgs(&c)[0]["seq"], 6);
    }

    /// A live reset (collab/bridge resync) reaches a sync subscriber as a delta against what it
    /// holds: rows it got (snapshot, upserts) with the same hash are left out, rows appended to
    /// since are resent, and its meta is a placeholder when unchanged.
    #[test]
    fn live_reset_is_a_delta_against_what_the_client_holds() {
        let c = client("c1", true);
        let mut f = Fanout::default();
        let have = SessionHave { session_id: "s1".into(), rows: vec![], meta_hash: None };
        let rows = vec![user("u1", "a"), assistant("a1", "b"), user("u2", "c")];
        f.subscribe(&c, "a", snap(rows.clone(), meta("t")), NO_TREE, Some(&have), "s1");
        let lens = |_: &str, _: AppendField| Some(2);
        f.send_events(&[SessionEvent::Append { id: "a1".into(), field: AppendField::Text, text: "x".into(), at: None }], NO_TREE, &lens);
        f.send_events(&[SessionEvent::Upsert { item: user("u3", "d"), h: None }], NO_TREE, &lens);
        msgs(&c);
        let mut rows2 = rows.clone();
        rows2[1] = assistant("a1", "bx");
        rows2.push(user("u3", "d"));
        rows2.push(user("u4", "e"));
        f.send_events(&[SessionEvent::Reset { snapshot: snap(rows2, meta("t")) }], NO_TREE, &lens);
        let got = msgs(&c);
        assert_eq!(got.len(), 1);
        let s: SessionSnapshot = serde_json::from_value(got[0]["ev"]["snapshot"].clone()).unwrap();
        let sync = s.sync.as_ref().unwrap();
        assert_eq!(ids(&s), ["a1", "u4"], "a1 was appended to; u4 is new");
        assert_eq!(sync.order.as_deref().unwrap(), ["u1", "a1", "u2", "u3", "u4"]);
        assert!(sync.meta_same);
        assert_eq!(s.agent_id, "a");
        assert_eq!(sync.seq, got[0]["seq"].as_u64().unwrap(), "a reset's sync.seq is its own seq");
    }

    #[test]
    fn events_before_a_reset_are_dropped_for_sync_subscribers() {
        let c = client("c1", true);
        let mut f = Fanout::default();
        let have = SessionHave { session_id: "s1".into(), rows: vec![], meta_hash: None };
        f.subscribe(&c, "a", snap(vec![], meta("t")), NO_TREE, Some(&have), "s1");
        let events = vec![
            SessionEvent::Upsert { item: user("u1", "a"), h: None },
            SessionEvent::Append { id: "u1".into(), field: AppendField::Text, text: "b".into(), at: None },
            SessionEvent::Btw { btw_id: "b".into(), turn: 0, question: None, text: "?".into(), done: false },
            SessionEvent::Reset { snapshot: snap(vec![user("u1", "ab")], meta("t")) },
            SessionEvent::Append { id: "u1".into(), field: AppendField::Text, text: "c".into(), at: None },
        ];
        f.send_events(&events, NO_TREE, &|_, _| Some(3));
        let kinds: Vec<String> = msgs(&c).iter().map(|m| m["ev"]["k"].as_str().unwrap().to_owned()).collect();
        assert_eq!(kinds, ["btw", "reset", "append"]);
    }

    /// Meta: plain subscribers get the full meta (tree rules as before), sync ones patches — none
    /// when nothing changed, the changed fields (`null` clears one), changed tree nodes.
    #[test]
    fn meta_goes_out_as_patches() {
        let c = client("c1", true);
        let plain = client("c2", false);
        let mut f = Fanout::default();
        let node = |id: &str, label: &str| TreeNode {
            id: id.into(),
            parent_id: None,
            kind: TreeNodeKind::User,
            label: label.into(),
            at: 0,
            on_path: true,
            children: 0,
        };
        let tree1 = TreeInfo { nodes: vec![node("n1", "a"), node("n2", "b")], leaf_id: Some("n2".into()) };
        let rev1 = Tree { tree: Some(&tree1), rev: 1 };
        let have = SessionHave { session_id: "s1".into(), rows: vec![], meta_hash: None };
        let first = f.subscribe(&c, "a", snap(vec![], meta("t")), rev1, Some(&have), "s1");
        assert_eq!(first.meta.tree.as_ref(), Some(&tree1), "a full snapshot carries the tree");
        let opened = f.subscribe(&plain, "a", snap(vec![], meta("t")), rev1, None, "s1");
        assert_eq!(opened.meta.tree.as_ref(), Some(&tree1));
        let bare = meta("t");

        // Unchanged meta: nothing for the sync subscriber, the full meta for the plain one.
        f.send_meta(&bare, rev1, false);
        assert!(msgs(&c).is_empty());
        assert_eq!(msgs(&plain).len(), 1);

        // A field changes, another clears.
        let mut m2 = bare.clone();
        m2.title = Some("t2".into());
        m2.cwd = None;
        f.send_meta(&m2, rev1, false);
        let got = msgs(&c);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["ev"]["k"], "metaPatch");
        assert_eq!(got[0]["ev"]["set"], serde_json::json!({"title": "t2", "cwd": null}));
        let mut full2 = m2.clone();
        full2.tree = Some(tree1.clone());
        assert_eq!(got[0]["ev"]["hash"].as_str().unwrap(), MetaState::of(&full2).hash());
        assert_ne!(first.sync.unwrap().meta_hash, MetaState::of(&full2).hash());
        msgs(&plain);

        // The tree changes: one node, a new one, the leaf.
        let tree2 = TreeInfo { nodes: vec![node("n1", "a"), node("n2", "b2"), node("n3", "c")], leaf_id: Some("n3".into()) };
        f.send_meta(&m2, Tree { tree: Some(&tree2), rev: 2 }, true);
        let got = msgs(&c);
        assert_eq!(got.len(), 1);
        let SessionEvent::TreePatch { upsert, remove, leaf_id, hash } = serde_json::from_value(got[0]["ev"].clone()).unwrap() else { panic!() };
        assert_eq!(upsert.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["n2", "n3"]);
        assert!(remove.is_empty());
        let mut rebuilt = tree1.clone();
        apply_tree_patch(&mut rebuilt, &upsert, &remove, leaf_id);
        assert_eq!(rebuilt, tree2);
        let mut full3 = m2.clone();
        full3.tree = Some(tree2.clone());
        assert_eq!(hash, MetaState::of(&full3).hash());
        let p = msgs(&plain);
        assert!(p[0]["ev"]["meta"].get("tree").is_some(), "plain apps get the changed tree");
    }

    /// A `meta` flush with the tree unchanged reuses its revision's hash and copy (a big tree costs
    /// nothing per flush); resets too; a new revision is diffed against the copy the subscriber
    /// holds; the copy goes with the last `sessionSync` subscriber.
    #[test]
    fn the_tree_is_hashed_and_copied_once_per_revision() {
        let c = client("c1", true);
        let mut f = Fanout::default();
        let tree = big_tree(50);
        let rev1 = Tree { tree: Some(&tree), rev: 1 };
        let have = SessionHave { session_id: "s1".into(), rows: vec![], meta_hash: None };
        f.subscribe(&c, "a", snap(vec![user("u1", "a")], meta("t")), rev1, Some(&have), "s1");
        msgs(&c);
        let held = |f: &Fanout| f.subs[0].sync.as_ref().unwrap().meta.tree.tree.clone().unwrap();
        let copy = held(&f);
        assert_eq!(*copy, tree);
        for i in 0..3 {
            let mut m = meta("t");
            m.tps = Some(i as f32 + 0.5);
            f.send_meta(&m, rev1, false);
            assert!(Arc::ptr_eq(&held(&f), &copy), "revision 1's copy");
        }
        f.send_events(&[SessionEvent::Reset { snapshot: snap(vec![user("u1", "a")], meta("t")) }], rev1, &|_, _| None);
        assert!(Arc::ptr_eq(&held(&f), &copy), "a reset holds revision 1's copy too");
        let kinds: Vec<String> = msgs(&c).iter().map(|m| m["ev"]["k"].as_str().unwrap().to_owned()).collect();
        assert_eq!(kinds, ["metaPatch", "metaPatch", "metaPatch", "reset"]);
        // The revision says whether the tree changed: it is not looked at again within one.
        let other = big_tree(3);
        f.send_meta(&meta("t"), Tree { tree: Some(&other), rev: 1 }, false);
        assert!(Arc::ptr_eq(&held(&f), &copy));
        assert!(msgs(&c).iter().all(|m| m["ev"]["k"] != "treePatch"));
        // A new revision: a new copy, sent as a patch from the one held.
        f.send_meta(&meta("t"), Tree { tree: Some(&other), rev: 2 }, true);
        assert_eq!(*held(&f), other);
        let got = msgs(&c);
        let SessionEvent::TreePatch { upsert, remove, leaf_id, .. } = serde_json::from_value(got[0]["ev"].clone()).unwrap() else { panic!("{got:?}") };
        let mut rebuilt = tree.clone();
        apply_tree_patch(&mut rebuilt, &upsert, &remove, leaf_id);
        assert_eq!(rebuilt, other);
        f.unsubscribe("c1", "a");
        assert!(f.tree.is_none(), "nobody holds a tree any more");
    }

    /// Tree patches rebuild the new tree exactly, node order included (reordered trees fall back
    /// to a full replacement).
    #[test]
    fn tree_patch_round_trip() {
        let node = |id: &str, on_path: bool| TreeNode { id: id.into(), parent_id: None, kind: TreeNodeKind::Assistant, label: id.into(), at: 1, on_path, children: 0 };
        let t = |nodes: Vec<TreeNode>, leaf: &str| TreeInfo { nodes, leaf_id: Some(leaf.into()) };
        let cases = [
            (t(vec![node("a", true), node("b", true)], "b"), t(vec![node("a", true), node("b", false), node("c", true)], "c")),
            (t(vec![node("a", true), node("b", true), node("c", true)], "c"), t(vec![node("a", true), node("c", true)], "c")),
            (t(vec![node("a", true), node("b", true)], "b"), t(vec![node("b", true), node("a", true)], "a")),
            (t(vec![node("a", true), node("c", true)], "c"), t(vec![node("a", true), node("b", true), node("c", true)], "b")),
            (t(vec![], "x"), t(vec![node("a", true)], "a")),
        ];
        for (old, new) in cases {
            let (upsert, remove) = tree_patch(Some(&old), &new);
            let mut rebuilt = old.clone();
            apply_tree_patch(&mut rebuilt, &upsert, &remove, new.leaf_id.clone());
            assert_eq!(rebuilt, new, "{old:?} → {new:?}");
        }
        let fresh = t(vec![node("a", true)], "a");
        let (upsert, remove) = tree_patch(None, &fresh);
        let mut rebuilt = TreeInfo { nodes: vec![], leaf_id: None };
        apply_tree_patch(&mut rebuilt, &upsert, &remove, fresh.leaf_id.clone());
        assert_eq!(rebuilt, fresh);
    }

    #[test]
    fn field_lengths_follow_how_clients_append() {
        assert_eq!(field_len(&user("u", "héllo"), AppendField::Text), Some(6), "UTF-8 bytes");
        assert_eq!(field_len(&tool("t", None), AppendField::Output), Some(0));
        assert_eq!(field_len(&tool("t", Some("ab")), AppendField::Output), Some(2));
        assert_eq!(field_len(&tool("t", Some("ab")), AppendField::Text), None);
        let n = TranscriptItem::Notice(NoticeItem { id: "n".into(), at: 0, level: NoticeLevel::Info, text: "x".into(), source: None });
        assert_eq!(field_len(&n, AppendField::Text), Some(1));
    }

    /// A session tree of `n` nodes like a long omp session's (labels a line of prose).
    fn big_tree(n: usize) -> TreeInfo {
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

    /// Bench: what one `meta` flush (tps, ~2/s while streaming; the tree unchanged) costs a
    /// session with a big tree and a `sessionSync` subscriber. Release build:
    /// `cargo test --release -p tf-hostd --lib meta_send_cost -- --ignored --nocapture`
    #[test]
    #[ignore = "bench"]
    fn meta_send_cost() {
        for n in [2_000usize, 10_000, 30_000] {
            let tree = big_tree(n);
            let c = client("c1", true);
            let mut f = Fanout::default();
            let have = SessionHave { session_id: "s1".into(), rows: vec![], meta_hash: None };
            let rev = Tree { tree: Some(&tree), rev: 1 };
            f.subscribe(&c, "a", snap(vec![], meta("t")), rev, Some(&have), "s1");
            msgs(&c);
            let reps = 20u32;
            let t = std::time::Instant::now();
            for i in 0..reps {
                let mut bare = meta("t");
                bare.tps = Some(i as f32 + 0.5);
                f.send_meta(&bare, rev, false);
            }
            let per = t.elapsed() / reps;
            assert_eq!(msgs(&c).len(), reps as usize);
            println!("tree nodes {n:>6}: meta flush {:>8.3} ms", per.as_secs_f64() * 1e3);
        }
    }
}
