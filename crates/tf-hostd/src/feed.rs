//! Bridge data plane (architecture §3.4): sessions whose TeleFlock bridge (≥ 2.0) announces
//! `caps.live` are served from the bridge's live feed plus omp's session file. No collab room is
//! joined for them.
//!
//! One driver task per session and bridge connection: `liveSubscribe` → the `resync` frame → the
//! session file through `lastEntryId` (read off the async runtime), the resync's in-flight frames,
//! then every `live` frame in `seq` order. The file's later entries are interleaved: before each
//! frame that can start something (anything but streaming updates and state) the tail of the file
//! is caught up, so an entry omp wrote before an event reaches the replica before that event, as
//! on a collab room; after a frame that settles something (an entry follows it) the tail is read
//! once nothing else is queued, and it is polled every [`TAIL_EVERY`]. Every read of the file
//! runs on the blocking pool, outside the session lock; only applying what it read takes the lock.
//! A gap in `seq`, a rewritten or moved file (also a resync naming a file omp wrote that is not
//! there: omp is moving it), a file that cannot be read, or `agent.connect` while the session
//! loads subscribe again (a fresh resync). Frames that reach a new subscription before its resync
//! were written for the one it replaced and are dropped. Restarts in a row (each subscription
//! between them ending within [`RESTART_SETTLED`]) pause before subscribing again: not after the
//! first, then [`RESTART_PAUSE`], doubling. So omp does not rebuild resyncs, nor hostd re-read a
//! large file, in a loop. When the bridge goes away the replica stays (`connecting`,
//! `bridgeLost`); [`crate::omp`]'s poller lets a published collab room take over after
//! [`crate::omp::BRIDGE_RETURN`], and the bridge takes the session back as soon as it returns.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde_json::Value;
use tf_collab::frame::{SessionHeader, SessionState as HostState, Welcome};
use tf_collab::{GuestEvent, HostFrame, Replica, Snapshot, Update, COLLAB_PROTO};
use tf_proto::model::{LinkReason, LinkVia};
use tf_proto::session::HistoryPage;
use tf_proto::{ApiError, Millis};
use tokio::sync::broadcast;
use tokio::time::Instant;
use tracing::{debug, info, warn};

use crate::bridge::{BridgeError, BridgeEvent, BridgeSession, LiveFeed, LiveMsg, Resync};
use crate::journal::{self, FullRead, JournalTail, Poll};
use crate::omp::{self, Inner, LinkStatus, OmpSession, OmpUpdate, Transport, BRIDGE_RETURN};
use crate::util::now_ms;

/// Session file poll while nothing else asks for it (a stat per poll).
const TAIL_EVERY: Duration = Duration::from_millis(250);
/// A subscription whose `resync` does not arrive in this long is started over.
const RESYNC_WAIT: Duration = Duration::from_secs(30);
/// After this many failed subscriptions in a row a published collab room may take over.
const SUBSCRIBE_GIVE_UP: u32 = 3;
/// The second feed restart in a row waits this long before it subscribes again, each further one
/// twice as long, up to [`RESTART_PAUSE_MAX`]; the first one subscribes at once.
pub(crate) const RESTART_PAUSE: Duration = Duration::from_millis(250);
const RESTART_PAUSE_MAX: Duration = Duration::from_secs(30);
/// A restart of a subscription that lasted this long is the first of a new run (no pause).
const RESTART_SETTLED: Duration = Duration::from_secs(10);
/// Largest tail of a subagent transcript rendered (`subagent.transcript`).
const TRANSCRIPT_MAX: u64 = 64 * 1024 * 1024;
/// How deep nested subagent transcripts are searched for (`<Id>/<Id>.<Child>.jsonl`, …).
const TRANSCRIPT_DEPTH: usize = 6;

/// Session entry types omp's collab host replicates as transcript entries (`collab/host.ts`
/// `WIRE_SESSION_ENTRY_TYPES`); the others only feed the journal (goal, plan mode, side spend).
fn is_wire_entry(entry: &Value) -> bool {
    matches!(
        entry.get("type").and_then(Value::as_str),
        Some("message" | "custom_message" | "compaction" | "branch_summary" | "model_change" | "thinking_level_change")
    )
}

fn event_type(frame: &HostFrame) -> Option<&str> {
    match frame {
        HostFrame::Event { event } => event.get("type").and_then(Value::as_str),
        _ => None,
    }
}

/// A frame that can start something (a row, a turn, a dialog): entries omp wrote before it go
/// first. Streaming updates, subagent progress and state cannot.
fn starts_something(frame: &HostFrame) -> bool {
    match frame {
        HostFrame::State { .. } => false,
        HostFrame::Bus { channel, .. } => channel != "task:subagent:progress",
        _ => !matches!(event_type(frame), Some("message_update" | "tool_execution_update")),
    }
}

/// A frame after which omp has written an entry (or will at once): read the file right away.
fn settles_something(frame: &HostFrame) -> bool {
    matches!(event_type(frame), Some("message_end" | "turn_end" | "agent_end" | "tool_execution_end" | "auto_compaction_end"))
}

fn merge(into: &mut Update, more: Update) {
    into.events.extend(more.events);
    into.replies.extend(more.replies);
    for (kind, n) in more.pulses {
        match into.pulses.iter_mut().find(|(k, _)| *k == kind) {
            Some((_, m)) => *m += n,
            None => into.pulses.push((kind, n)),
        }
    }
    into.signals.extend(more.signals);
    into.meta_changed |= more.meta_changed;
    into.liveness_changed |= more.liveness_changed;
}

/// Why a feed has to start over with a fresh resync.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Restart {
    /// Frames were lost between `expected` and `got`.
    Gap { expected: u64, got: u64 },
    /// omp rewrote the session file (shorter, replaced, or other bytes before the read position).
    Rewritten,
    /// The session file is gone (omp moved it).
    Missing,
    /// Reading the session file failed in an unexpected way (the read task died).
    ReadFailed(String),
}

impl std::fmt::Display for Restart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Gap { expected, got } => write!(f, "live frame {got} arrived where {expected} was due"),
            Self::Rewritten => f.write_str("omp rewrote the session file"),
            Self::Missing => f.write_str("the session file moved"),
            Self::ReadFailed(e) => write!(f, "reading the session file failed: {e}"),
        }
    }
}

/// What the session was when hostd first saw it, for a session file omp has not written yet.
#[derive(Debug, Clone)]
pub(crate) struct Origin {
    pub session_id: String,
    pub cwd: String,
}

/// The bridge feed → replica core of one session, without I/O: the driver reads the session file
/// (in full at a resync, its tail before frames that start something) off the runtime and hands
/// each read in. Every change goes through [`Replica::apply`] / [`Replica::apply_journal_entries`],
/// so subscribers see each one.
#[derive(Debug, Default)]
pub(crate) struct Feeder {
    /// The session file's tail after the last read; out on the blocking pool while a read runs.
    tail: Option<JournalTail>,
    /// `seq` of the last frame applied (the resync's, then each live frame's).
    last_seq: Option<u64>,
}

impl Feeder {
    /// Applies a resync: the session file through `lastEntryId` (`read`), the journal first and
    /// then the transcript as a snapshot (the welcome built from the file header and the resync's
    /// `state` and `agents`), then the resync's in-flight frames. Later frames continue from it.
    pub(crate) fn resync(&mut self, replica: &mut Replica, resync: Resync, read: FullRead, origin: &Origin, now: Millis) -> Update {
        let FullRead { header, title, entries, tail, .. } = read;
        let (mut unwritten, mut frames) = (Vec::new(), Vec::with_capacity(resync.frames.len()));
        for f in resync.frames {
            match f {
                HostFrame::Entry { entry } => unwritten.push(entry),
                other => frames.push(other),
            }
        }
        // Entries ride along only while omp has not written the file yet.
        let entries = if header.is_none() && entries.is_empty() { unwritten } else { entries };
        replica.reset_journal();
        let mut out = replica.apply_journal_entries(&entries, tail.offset());
        let mut state = frames
            .iter()
            .find_map(|f| match f {
                HostFrame::State { state } => Some(state.clone()),
                _ => None,
            })
            .unwrap_or_else(|| HostState { cwd: origin.cwd.clone(), ..HostState::default() });
        // The `state` frame is debounced; `streaming` is the session's own flag at resync time.
        state.is_streaming = resync.streaming;
        let agents = frames
            .iter()
            .find_map(|f| match f {
                HostFrame::Agents { agents } => Some(agents.clone()),
                _ => None,
            })
            .unwrap_or_default();
        let mut header: SessionHeader = header.and_then(|h| serde_json::from_value(h).ok()).unwrap_or_else(|| SessionHeader {
            id: origin.session_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            cwd: origin.cwd.clone(),
            title: None,
            extra: serde_json::Map::new(),
        });
        if header.title.is_none() {
            header.title = title;
        }
        let wire: Vec<Value> = entries.into_iter().filter(is_wire_entry).collect();
        let welcome = Welcome { proto: COLLAB_PROTO, header, state, agents, entry_count: wire.len() as u64, read_only: false };
        let resyncing = replica.header().is_some();
        merge(&mut out, replica.apply(&GuestEvent::Snapshot(Snapshot { welcome, entries: wire, resync: resyncing }), now));
        for f in frames {
            merge(&mut out, replica.apply(&GuestEvent::Frame(f), now));
        }
        self.tail = Some(tail);
        self.last_seq = Some(resync.seq);
        out
    }

    /// Live frame `seq` has to wait for a read of the file's tail ([`Self::apply_read`] first):
    /// it is the next frame and it can start something, so what omp wrote before it goes first.
    pub(crate) fn reads_before(&self, seq: u64, frame: &HostFrame) -> bool {
        self.tail.is_some() && self.last_seq.is_some_and(|last| seq == last + 1) && starts_something(frame)
    }

    /// A live frame of the current subscription (the driver drops a subscription's frames until
    /// its resync is applied, see [`run`]). Frames before the first resync and ones at or before
    /// the last applied `seq` are skipped; a gap means frames were lost. When
    /// [`Self::reads_before`] says so, apply a read of the file's tail taken after the frame
    /// arrived first ([`Self::read_then_frame`]).
    pub(crate) fn frame(&mut self, replica: &mut Replica, seq: u64, frame: HostFrame, now: Millis) -> Result<Update, Restart> {
        let Some(last) = self.last_seq else { return Ok(Update::default()) };
        if seq <= last {
            return Ok(Update::default());
        }
        if seq != last + 1 {
            return Err(Restart::Gap { expected: last + 1, got: seq });
        }
        self.last_seq = Some(seq);
        Ok(replica.apply(&GuestEvent::Frame(frame), now))
    }

    /// [`Self::frame`] after the read of the file's tail it waited for, if any.
    pub(crate) fn read_then_frame(&mut self, replica: &mut Replica, read: Option<Poll>, seq: u64, frame: HostFrame, now: Millis) -> Result<Update, Restart> {
        let mut out = match read {
            Some(read) => self.apply_read(replica, read, now)?,
            None => Update::default(),
        };
        merge(&mut out, self.frame(replica, seq, frame, now)?);
        Ok(out)
    }

    /// The tail to read ([`JournalTail::poll`], blocking I/O); `None` before the first resync.
    /// Hand it back with [`Self::put_tail`].
    pub(crate) fn take_tail(&mut self) -> Option<JournalTail> {
        self.tail.take()
    }

    pub(crate) fn put_tail(&mut self, tail: JournalTail) {
        self.tail = Some(tail);
    }

    /// The feed has read the file at `path` (its tail saw it): a resync naming it while it is gone
    /// comes from omp moving it, not from a session omp has yet to write.
    pub(crate) fn has_read(&self, path: &Path) -> bool {
        self.tail.as_ref().is_some_and(|t| t.seen() && t.path() == path)
    }

    /// Applies a read of the file's tail: the entries omp appended since the previous read.
    pub(crate) fn apply_read(&mut self, replica: &mut Replica, read: Poll, now: Millis) -> Result<Update, Restart> {
        match read {
            Poll::Idle => Ok(Update::default()),
            Poll::Appended { entries, offset } => {
                let mut out = replica.apply_journal_entries(&entries, offset);
                for entry in entries.into_iter().filter(is_wire_entry) {
                    merge(&mut out, replica.apply(&GuestEvent::Frame(HostFrame::Entry { entry }), now));
                }
                Ok(out)
            }
            Poll::Rewritten => Err(Restart::Rewritten),
            Poll::Missing => Err(Restart::Missing),
        }
    }
}

/// Reads the session file's tail on the blocking pool (a `stat`, plus what omp appended), never
/// on the runtime and never under the session lock; [`Feeder::apply_read`] applies the result.
async fn poll_tail(feeder: &mut Feeder) -> Result<Poll, Restart> {
    let Some(mut tail) = feeder.take_tail() else { return Ok(Poll::Idle) };
    let (tail, read) = tokio::task::spawn_blocking(move || {
        let read = tail.poll();
        (tail, read)
    })
    .await
    .map_err(|e| Restart::ReadFailed(e.to_string()))?;
    feeder.put_tail(tail);
    Ok(read)
}

// ───────────────────────────── session lifecycle ─────────────────────────────

/// Follows the bridge's sessions: a hello with `caps.live` attaches its session, a session
/// switch ends the bridge-served session the process left.
pub(crate) async fn bridge_events(weak: Weak<Inner>, mut rx: broadcast::Receiver<BridgeEvent>) {
    loop {
        let cancel = match weak.upgrade() {
            Some(inner) if !inner.cancel.is_cancelled() => inner.cancel.clone(),
            _ => return,
        };
        let ev = tokio::select! {
            r = rx.recv() => r,
            _ = cancel.cancelled() => return,
        };
        let Some(inner) = weak.upgrade() else { return };
        match ev {
            Ok(BridgeEvent::Connected { session }) if session.caps.data_plane() => attach(&inner, &session),
            Ok(BridgeEvent::SessionSwitch { previous_session_id, session, .. }) => {
                if let Some(old) = inner.session(&previous_session_id)
                    && !matches!(old.lock().transport, Transport::Collab(_))
                {
                    inner.forget(&old, "omp switched to another session");
                }
                if session.caps.data_plane() {
                    attach(&inner, &session);
                }
            }
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(n)) => {
                debug!("bridge events lagged by {n}");
                reconcile(&inner);
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// Serves `b`'s session from its bridge: creates the session (or keeps the one the room or an
/// earlier connection fed, with its replica and subscribers) and starts a feed driver for this
/// connection, unless one runs for it already.
pub(crate) fn attach(inner: &Arc<Inner>, b: &BridgeSession) {
    if !b.caps.data_plane() || inner.cancel.is_cancelled() {
        return;
    }
    let session = {
        let mut map = inner.sessions.write().unwrap_or_else(|p| p.into_inner());
        match map.get(&b.session_id).filter(|s| !s.is_closed()) {
            Some(s) => s.clone(),
            None => {
                let s = Arc::new(OmpSession::new(&b.session_id, b.pid, &inner.persist, inner.bridge.clone()));
                s.lock().set_link(syncing());
                map.insert(b.session_id.clone(), s.clone());
                omp::spawn_session_loops(inner, &s);
                info!(session = %b.session_id, pid = b.pid, version = %b.bridge_version, "bridge serves omp session");
                s
            }
        }
    };
    session.set_pid(b.pid);
    let token = omp::next_token();
    {
        let mut st = session.lock();
        if st.driver.is_some_and(|(conn, _)| conn == b.conn) {
            return;
        }
        st.driver = Some((b.conn, token));
        if matches!(st.transport, Transport::Detached) {
            st.set_link(syncing());
        }
    }
    tokio::spawn(drive(Arc::downgrade(inner), session, b.conn, token));
    let _ = inner.updates.send(OmpUpdate::Registry);
}

fn syncing() -> LinkStatus {
    LinkStatus::connecting(LinkReason::Syncing, Some(LinkVia::Bridge), "TeleFlock's bridge in omp is connected; loading the session")
}

/// Runs every registry poll: bridges whose session has no driver get one (a lagged event), and
/// sessions whose bridge did not come back are said so, then dropped once omp is gone.
pub(crate) fn reconcile(inner: &Arc<Inner>) {
    for b in inner.bridge.sessions() {
        if b.caps.data_plane() && inner.session(&b.session_id).is_none_or(|s| s.lock().driver.is_none_or(|(conn, _)| conn != b.conn)) {
            attach(inner, &b);
        }
    }
    let sessions: Vec<Arc<OmpSession>> = inner.sessions.read().unwrap_or_else(|p| p.into_inner()).values().cloned().collect();
    for s in sessions {
        let Some((lost_at, bye)) = ({
            let st = s.lock();
            match st.transport {
                Transport::Detached => st.bridge_lost,
                _ => None,
            }
        }) else {
            continue;
        };
        let waited = lost_at.elapsed();
        if waited < BRIDGE_RETURN {
            continue;
        }
        let room = inner.room_of(&s.session_id).is_some_and(|r| r.relay_connected && r.access == "control");
        if room {
            // The poller joins it (the session is not held any more).
            continue;
        }
        if bye || !process_alive(s.pid()) || waited >= omp_detached_forget() {
            info!(session = %s.session_id, "bridge did not come back and omp has no collab room; dropping the session");
            inner.forget(&s, if bye { "omp exited" } else { "omp's TeleFlock bridge did not come back" });
            continue;
        }
        // The same words on every poll: `linkSince` tells how long it has been (a counter here
        // would send every client a board patch per poll).
        let changed = s.lock().set_link(LinkStatus::connecting(
            LinkReason::BridgeLost,
            Some(LinkVia::Bridge),
            "TeleFlock's bridge in omp disconnected and omp has no collab room to fall back to; waiting for the bridge to reconnect",
        ));
        if changed {
            let _ = inner.updates.send(OmpUpdate::Changed { session_id: s.session_id.clone() });
        }
    }
}

fn omp_detached_forget() -> Duration {
    omp::DETACHED_FORGET
}

/// omp process `pid` still runs. Linux reads `/proc`; elsewhere it is assumed to.
fn process_alive(pid: u32) -> bool {
    if cfg!(target_os = "linux") && pid != 0 { Path::new(&format!("/proc/{pid}")).exists() } else { true }
}

/// The driver still owns the session (no newer connection's driver replaced it).
fn current(session: &OmpSession, token: u64) -> bool {
    owns(&session.lock(), token)
}

/// [`current`] for a caller that holds the session lock (it is not reentrant).
fn owns(st: &omp::SessionState, token: u64) -> bool {
    st.driver.is_some_and(|(_, t)| t == token)
}

/// How a subscription ended.
enum End {
    /// Subscribe again (gap, rewritten or moved file, failed read, no resync).
    Restart(String),
    /// Subscribe again at once: a retry was asked for while the session was loading.
    Retry,
    /// The connection closed (`bye`: omp said it was shutting down).
    Closed { bye: bool },
    /// A newer driver or the daemon's end took over.
    Stop,
}

/// The pause before subscribing again after the `n`th restart in a row: none after the first,
/// then [`RESTART_PAUSE`] doubling up to [`RESTART_PAUSE_MAX`].
fn restart_pause(n: u32) -> Duration {
    if n < 2 {
        return Duration::ZERO;
    }
    RESTART_PAUSE.saturating_mul(1 << (n - 2).min(16)).min(RESTART_PAUSE_MAX)
}

/// One session's feed on bridge connection `conn`.
async fn drive(weak: Weak<Inner>, session: Arc<OmpSession>, conn: u64, token: u64) {
    let sid = session.session_id.clone();
    let mut feeder = Feeder::default();
    let mut failures = 0u32;
    // Restarts in a row; each one pauses longer before the next subscription ([`restart_pause`]).
    // A subscription that lasted RESTART_SETTLED ends the run.
    let mut restarts = 0u32;
    loop {
        let Some(inner) = weak.upgrade() else { return };
        if session.is_closed() || inner.cancel.is_cancelled() || !current(&session, token) {
            return;
        }
        match inner.bridge.by_session(&sid) {
            Some(b) if b.conn == conn && b.caps.data_plane() => {}
            _ => return lost(&inner, &session, token, false),
        }
        let feed = match inner.bridge.live_subscribe(&sid).await {
            Ok(feed) => {
                failures = 0;
                feed
            }
            Err(BridgeError::NotConnected { .. } | BridgeError::Disconnected { .. }) => return lost(&inner, &session, token, false),
            Err(e) => {
                failures += 1;
                warn!(session = %sid, attempt = failures, "bridge live feed did not start: {e}");
                {
                    let mut st = session.lock();
                    if !matches!(st.transport, Transport::Collab(_)) {
                        st.set_link(LinkStatus::connecting(
                            LinkReason::Syncing,
                            Some(LinkVia::Bridge),
                            format!("TeleFlock's bridge did not start its live feed ({e}); retrying"),
                        ));
                    }
                    if failures >= SUBSCRIBE_GIVE_UP && matches!(st.transport, Transport::Detached) {
                        // Let a published collab room serve it meanwhile.
                        st.bridge_lost.get_or_insert((Instant::now(), false));
                    }
                }
                let _ = inner.updates.send(OmpUpdate::Changed { session_id: sid.clone() });
                drop(inner);
                let wait = Duration::from_secs(1u64 << failures.min(5)).min(Duration::from_secs(30));
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = session.feed_kick.notified() => {}
                }
                continue;
            }
        };
        let cancel = inner.cancel.clone();
        drop(inner);
        let began = Instant::now();
        let why = match run(&weak, &session, token, feed, &mut feeder).await {
            End::Restart(why) => why,
            End::Retry => {
                debug!(session = %sid, "bridge feed starts over: a retry was requested");
                continue;
            }
            End::Closed { bye } => {
                if let Some(inner) = weak.upgrade() {
                    lost(&inner, &session, token, bye);
                }
                return;
            }
            End::Stop => return,
        };
        restarts = if began.elapsed() >= RESTART_SETTLED { 1 } else { restarts + 1 };
        let pause = restart_pause(restarts);
        debug!(session = %sid, restarts, pause_ms = pause.as_millis() as u64, "bridge feed starts over: {why}");
        not_loaded(&weak, &session, token, &why);
        if !pause.is_zero() {
            tokio::select! {
                _ = tokio::time::sleep(pause) => {}
                // A retry asked for now (or the session's end).
                _ = session.feed_kick.notified() => {}
                _ = cancel.cancelled() => return,
            }
        }
    }
}

/// A subscription ended before its resync was applied: while nothing serves the session yet (the
/// bridge is bringing it up), the link says why and that it is retried. A session the bridge
/// served goes on showing that (live, its controls still work) until the next resync.
fn not_loaded(weak: &Weak<Inner>, session: &OmpSession, token: u64, why: &str) {
    let Some(inner) = weak.upgrade() else { return };
    let changed = {
        let mut st = session.lock();
        owns(&st, token)
            && matches!(st.transport, Transport::Detached)
            && st.bridge_lost.is_none()
            && st.set_link(LinkStatus::connecting(
                LinkReason::Syncing,
                Some(LinkVia::Bridge),
                format!("TeleFlock could not load the session ({why}); retrying"),
            ))
    };
    if changed {
        let _ = inner.updates.send(OmpUpdate::Changed { session_id: session.session_id.clone() });
    }
}

/// Applies one subscription's messages until it ends. Its resync comes first: live frames before
/// it were written for the subscription it replaced and are dropped (applying them would read the
/// tail of a file the resync reads again, or see a gap, and start over once more).
async fn run(weak: &Weak<Inner>, session: &Arc<OmpSession>, token: u64, mut feed: LiveFeed, feeder: &mut Feeder) -> End {
    let mut tick = tokio::time::interval(TAIL_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let resync_by = Instant::now() + RESYNC_WAIT;
    let mut synced = false;
    let mut bye = false;
    // A frame after which omp writes an entry was applied: read the file once nothing is queued
    // (a queued frame that starts something reads it anyway).
    let mut tail_due = false;
    let cancel = match weak.upgrade() {
        Some(inner) => inner.cancel.clone(),
        None => return End::Stop,
    };
    loop {
        let msg = tokio::select! {
            biased;
            _ = cancel.cancelled() => return End::Stop,
            _ = session.feed_kick.notified() => {
                if session.is_closed() {
                    return End::Stop;
                }
                // Asked for while the session loaded (the kick waited out the resync): this
                // subscription serves it now, there is nothing to retry.
                if synced {
                    continue;
                }
                return End::Retry;
            }
            msg = feed.rx.recv() => msg,
            _ = std::future::ready(()), if tail_due => {
                tail_due = false;
                if let Err(end) = catch_up(weak, session, token, feeder).await {
                    return end;
                }
                continue;
            }
            _ = tick.tick() => {
                if !synced {
                    if Instant::now() >= resync_by {
                        return End::Restart("no resync arrived".into());
                    }
                    continue;
                }
                if let Err(end) = catch_up(weak, session, token, feeder).await {
                    return end;
                }
                continue;
            }
        };
        let Some(inner) = weak.upgrade() else { return End::Stop };
        match msg {
            None => return End::Closed { bye },
            Some(LiveMsg::Bye) => bye = true,
            Some(LiveMsg::Resync(resync)) => {
                if let Err(why) = apply_resync(&inner, session, token, resync, feeder).await {
                    return End::Restart(why);
                }
                synced = true;
                tail_due = false;
            }
            Some(LiveMsg::Frame { seq, frame }) => {
                if !synced {
                    if Instant::now() >= resync_by {
                        return End::Restart("no resync arrived".into());
                    }
                    continue;
                }
                // Entries omp wrote before this frame go first: read the tail now that it is here.
                let read = if feeder.reads_before(seq, &frame) {
                    match poll_tail(feeder).await {
                        Ok(read) => Some(read),
                        Err(why) => return End::Restart(why.to_string()),
                    }
                } else {
                    None
                };
                let settles = settles_something(&frame);
                let now = now_ms();
                let (update, usage) = {
                    let mut st = session.lock();
                    if !owns(&st, token) {
                        return End::Stop;
                    }
                    match feeder.read_then_frame(&mut st.replica, read, seq, frame, now) {
                        Ok(update) => {
                            let usage = session.absorb(&mut st, &update);
                            (update, usage)
                        }
                        Err(why) => return End::Restart(why.to_string()),
                    }
                };
                tail_due |= settles;
                omp::publish(&inner, session, &update, usage, now, false).await;
            }
        }
    }
}

/// Reads the file's tail off the runtime and applies what omp appended under the session lock.
async fn catch_up(weak: &Weak<Inner>, session: &Arc<OmpSession>, token: u64, feeder: &mut Feeder) -> Result<(), End> {
    let read = poll_tail(feeder).await.map_err(|why| End::Restart(why.to_string()))?;
    if read == Poll::Idle {
        return Ok(());
    }
    let Some(inner) = weak.upgrade() else { return Err(End::Stop) };
    let now = now_ms();
    let (update, usage) = {
        let mut st = session.lock();
        if !owns(&st, token) {
            return Err(End::Stop);
        }
        let update = feeder.apply_read(&mut st.replica, read, now).map_err(|why| End::Restart(why.to_string()))?;
        let usage = session.absorb(&mut st, &update);
        (update, usage)
    };
    omp::publish(&inner, session, &update, usage, now, false).await;
    Ok(())
}

/// A resync: the file read off the runtime, then everything applied under one lock, and the
/// session switched over to the bridge (closing the collab guest that fed it, if any). The row
/// notes kept for the session go first ([`omp::load_notes`]): the rows the resync rebuilds from
/// the file then come out as they were built live.
async fn apply_resync(inner: &Arc<Inner>, session: &Arc<OmpSession>, token: u64, resync: Resync, feeder: &mut Feeder) -> Result<(), String> {
    omp::load_notes(inner, session).await;
    let bridged = inner.bridge.by_session(&session.session_id);
    let path = resync.session_file.clone().or_else(|| bridged.as_ref().and_then(|b| b.session_file.clone())).map(PathBuf::from);
    let origin = Origin { session_id: session.session_id.clone(), cwd: bridged.as_ref().map(|b| b.cwd.clone()).unwrap_or_default() };
    let caps = bridged.map(|b| b.caps).unwrap_or_default();
    let read = match path.clone() {
        Some(file) => {
            let last = resync.last_entry_id.clone();
            let started = Instant::now();
            let read = tokio::task::spawn_blocking(move || journal::read_full(&file, last.as_deref()))
                .await
                .map_err(|e| format!("session file read failed: {e}"))?
                .map_err(|e| format!("cannot read the session file: {e}"))?;
            // omp wrote this file (the bridge names its last entry, or this feed read it) and it is
            // gone: omp is moving it (`moveTo` renames it before the session points at the new
            // path). The replica stays as it is; a later resync names the new path.
            if !read.exists() && (resync.last_entry_id.is_some() || feeder.has_read(read.tail.path())) {
                return Err(Restart::Missing.to_string());
            }
            if resync.last_entry_id.is_some() && !read.found {
                warn!(session = %session.session_id, "resync entry not in the session file; taking all of it");
            }
            debug!(session = %session.session_id, entries = read.entries.len(), ms = started.elapsed().as_millis() as u64, "session file read");
            read
        }
        None => FullRead { header: None, title: None, entries: Vec::new(), found: false, tail: JournalTail::new(Path::new("")) },
    };
    let now = now_ms();
    let (update, usage, old_guest) = {
        let mut st = session.lock();
        if !owns(&st, token) || session.is_closed() {
            return Ok(());
        }
        let update = feeder.resync(&mut st.replica, resync, read, &origin, now);
        let old = std::mem::replace(&mut st.transport, Transport::Bridge { token, caps });
        st.bridge_lost = None;
        st.session_file = path;
        st.set_link(LinkStatus::live(LinkVia::Bridge));
        session.set_data_plane(&mut st, Some(caps));
        let usage = session.absorb(&mut st, &update);
        let old_guest = match old {
            Transport::Collab(room) => Some(room.guest),
            _ => None,
        };
        (update, usage, old_guest)
    };
    if let Some(guest) = old_guest {
        info!(session = %session.session_id, "bridge takes the session over from its collab room");
        guest.close();
    }
    omp::publish(inner, session, &update, usage, now, true).await;
    let _ = inner.updates.send(OmpUpdate::Registry);
    Ok(())
}

/// The bridge of a session went away (its connection closed, or it was taken over): the
/// replica stays, the link says why, and a collab room may take over after `BRIDGE_RETURN`.
fn lost(inner: &Inner, session: &Arc<OmpSession>, token: u64, bye: bool) {
    {
        let mut st = session.lock();
        if st.driver.is_some_and(|(_, t)| t != token) {
            return;
        }
        st.driver = None;
        let served = match st.transport {
            Transport::Bridge { token: t, .. } => t == token,
            Transport::Detached => true,
            Transport::Collab(_) => false,
        };
        if served {
            st.transport = Transport::Detached;
            st.bridge_lost = Some((Instant::now(), bye));
            let why = if bye {
                "omp is shutting down (its TeleFlock bridge said goodbye)"
            } else {
                "TeleFlock's bridge in omp disconnected; waiting for it to reconnect"
            };
            st.set_link(LinkStatus::connecting(LinkReason::BridgeLost, Some(LinkVia::Bridge), why));
            session.set_data_plane(&mut st, None);
        }
    }
    info!(session = %session.session_id, bye, "bridge feed ended");
    let _ = inner.updates.send(OmpUpdate::Changed { session_id: session.session_id.clone() });
    let _ = inner.updates.send(OmpUpdate::Registry);
    inner.repoll();
}

// ───────────────────────────── subagent transcripts ─────────────────────────────

/// A subagent's transcript rows, read from disk: the file omp named for it, else
/// `<id>.jsonl` under the main session's artifacts dir (nested subagents a few levels down).
/// Blocking I/O.
pub(crate) fn subagent_transcript(named: Option<&Path>, main: Option<&Path>, agent_id: &str) -> Result<HistoryPage, ApiError> {
    let found = named
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl") && p.is_file())
        .map(Path::to_path_buf)
        .or_else(|| main.and_then(|m| find_transcript(&crate::artifacts::artifacts_dir(m), agent_id, 0)));
    let Some(path) = found else {
        return Err(ApiError::new("not_found", format!("no transcript file for subagent {agent_id}")));
    };
    let text = read_tail(&path, TRANSCRIPT_MAX).map_err(|e| crate::ops::fs::io_error(e, &path))?;
    Ok(tf_collab::replica::transcript_page(&text))
}

fn find_transcript(dir: &Path, agent_id: &str, depth: usize) -> Option<PathBuf> {
    let want = format!("{agent_id}.jsonl");
    let direct = dir.join(&want);
    if direct.is_file() {
        return Some(direct);
    }
    if depth >= TRANSCRIPT_DEPTH {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).find_map(|e| find_transcript(&e.path(), agent_id, depth + 1))
}

/// The file, or its last `max` bytes from a line start.
fn read_tail(path: &Path, max: u64) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max);
    f.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)?;
    if start > 0 {
        let cut = bytes.iter().position(|&b| b == b'\n').map_or(bytes.len(), |i| i + 1);
        bytes.drain(..cut);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Recorded bridge runs (real omp 18.13.2 + bridge 2.0.0) and the session files omp wrote, for
/// tests of the feed and of the sessions it serves.
#[cfg(test)]
pub(crate) mod fixture {
    use std::io::Write as _;
    use std::path::{Path, PathBuf};

    use serde_json::Value;
    use tf_collab::HostFrame;

    use crate::bridge::Resync;

    /// hello, a resync of a fresh session, a bash tool turn, an `ask` answered with uiResponse,
    /// a task subagent with a nested one, and an agentCmd chat.
    pub(crate) const FEED_1: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/testdata/bridge-feed-1.jsonl");
    pub(crate) const SESSION_1: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/testdata/bridge-feed-1.session.jsonl");
    /// One omp process: hello, a resync of a fresh session, a turn of three long bash calls during
    /// which the probing hostd stopped reading (frames #34 on dropped for one overflow `resync`,
    /// taken after the turn ended), then `/new` (a switch hello and the new session's resync).
    pub(crate) const FEED_2: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/testdata/bridge-feed-2.jsonl");
    /// omp's final session file of the first session of [`FEED_2`].
    pub(crate) const SESSION_2: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/testdata/bridge-feed-2.session.jsonl");
    /// …and of the session `/new` switched to.
    pub(crate) const SWITCHED_2: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/testdata/bridge-feed-2.switched.jsonl");

    pub(crate) fn lines(path: &str) -> Vec<Value> {
        std::fs::read_to_string(path).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    pub(crate) fn resync_of(v: &Value) -> Resync {
        let live = &v["live"];
        Resync {
            seq: v["seq"].as_u64().unwrap(),
            session_id: v["sessionId"].as_str().unwrap().to_owned(),
            session_file: v["sessionFile"].as_str().map(str::to_owned),
            leaf_id: v["leafId"].as_str().map(str::to_owned),
            last_entry_id: v["lastEntryId"].as_str().map(str::to_owned),
            streaming: live["streaming"].as_bool().unwrap_or(false),
            frames: live["frames"].as_array().unwrap().iter().cloned().map(HostFrame::from_value).collect(),
        }
    }

    /// The message a `message_end` live frame carries.
    pub(crate) fn ended_message(frame: &Value) -> Option<&Value> {
        (frame["t"] == "event" && frame["event"]["type"] == "message_end").then(|| &frame["event"]["message"])
    }

    /// omp's session file as it grew during a recorded run, rebuilt from its final version: omp
    /// creates it at the first assistant message (with everything before), then appends each
    /// message once it ended, and the entries in between with it.
    pub(crate) struct GrowingFile {
        path: PathBuf,
        lines: Vec<String>,
        written: usize,
    }

    impl GrowingFile {
        pub(crate) fn new(path: PathBuf, final_file: &str) -> GrowingFile {
            let lines = std::fs::read_to_string(final_file).unwrap().split_inclusive('\n').map(str::to_owned).collect();
            GrowingFile { path, lines, written: 0 }
        }

        /// Index of the line for which `pick` holds.
        fn find(&self, pick: impl Fn(&Value) -> bool) -> usize {
            self.lines.iter().position(|l| serde_json::from_str::<Value>(l).is_ok_and(|v| pick(&v))).expect("entry in the session file")
        }

        /// `message` (a `message_end`'s) was persisted.
        pub(crate) fn message_ended(&mut self, message: &Value) {
            if self.written == 0 && message["role"] != "assistant" {
                return;
            }
            let at = &message["timestamp"];
            let i = self.find(|v| v["type"] == "message" && v["message"]["timestamp"] == *at);
            self.write_through(i);
        }

        /// Writes the file through entry `id`.
        pub(crate) fn through(&mut self, id: &str) {
            let i = self.find(|v| v["id"] == id);
            self.write_through(i);
        }

        /// Appends a line omp did not write in the recorded run (for the unix-only `omp::session_tests`).
        #[cfg(unix)]
        pub(crate) fn append(&self, entry: &Value) {
            let mut f = std::fs::OpenOptions::new().append(true).open(&self.path).unwrap();
            writeln!(f, "{entry}").unwrap();
        }

        fn write_through(&mut self, i: usize) {
            if i < self.written {
                return;
            }
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&self.path).unwrap();
            f.write_all(self.lines[self.written..=i].concat().as_bytes()).unwrap();
            self.written = i + 1;
        }

        pub(crate) fn path(&self) -> &Path {
            &self.path
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::{self, GrowingFile};
    use super::*;
    use tf_proto::session::{SessionEvent, SubagentStatus, ToolStatus, TranscriptItem};

    const SESSION_FILE: &str = fixture::SESSION_1;

    /// Every line the real extension (bridge 2.0.0 in omp 18.13.2) wrote to a probing hostd.
    fn lines() -> Vec<Value> {
        fixture::lines(fixture::FEED_1)
    }

    fn resync_of(v: &Value) -> Resync {
        fixture::resync_of(v)
    }

    /// A client that only applies the emitted events (what an app holds).
    #[derive(Default)]
    struct Mirror {
        order: Vec<String>,
        items: std::collections::HashMap<String, TranscriptItem>,
        ui: Option<String>,
        asked: usize,
    }

    impl Mirror {
        fn apply(&mut self, events: &[SessionEvent]) {
            for ev in events {
                match ev {
                    SessionEvent::Reset { snapshot } => {
                        self.order = snapshot.items.iter().map(|i| i.id().to_owned()).collect();
                        self.items = snapshot.items.iter().map(|i| (i.id().to_owned(), i.clone())).collect();
                        self.ui = snapshot.ui.as_ref().map(|u| u.id.clone());
                    }
                    SessionEvent::Upsert { item, .. } => {
                        if !self.items.contains_key(item.id()) {
                            self.order.push(item.id().to_owned());
                        }
                        self.items.insert(item.id().to_owned(), item.clone());
                    }
                    SessionEvent::Append { id, text, .. } => match self.items.get_mut(id) {
                        Some(TranscriptItem::Assistant(a)) => a.text.push_str(text),
                        Some(TranscriptItem::Thinking(t)) => t.text.push_str(text),
                        Some(TranscriptItem::Tool(t)) => t.output.get_or_insert_with(String::new).push_str(text),
                        other => panic!("append to {id}: {other:?}"),
                    },
                    SessionEvent::Remove { id } => {
                        self.items.remove(id);
                        self.order.retain(|x| x != id);
                    }
                    SessionEvent::Ui { request } => {
                        self.asked += usize::from(request.is_some());
                        self.ui = request.as_ref().map(|u| u.id.clone());
                    }
                    _ => {}
                }
            }
        }
    }

    /// One live frame the way [`run`] applies it, with the file's tail read inline: before a
    /// frame that starts something, and after one that settles something (the driver reads that
    /// one once its queue is empty).
    fn step(feeder: &mut Feeder, replica: &mut Replica, seq: u64, frame: HostFrame, now: Millis) -> Result<Update, Restart> {
        let read = feeder.reads_before(seq, &frame).then(|| read_now(feeder));
        let settles = settles_something(&frame);
        let mut out = feeder.read_then_frame(replica, read, seq, frame, now)?;
        if settles {
            let read = read_now(feeder);
            merge(&mut out, feeder.apply_read(replica, read, now)?);
        }
        Ok(out)
    }

    fn read_now(feeder: &mut Feeder) -> Poll {
        let Some(mut tail) = feeder.take_tail() else { return Poll::Idle };
        let read = tail.poll();
        feeder.put_tail(tail);
        read
    }

    /// Feeds the fixture through a [`Feeder`]: `file` is the session file the tail reads (absent:
    /// omp never wrote it during the run).
    fn feed(file: Option<&Path>) -> (Replica, Mirror, Vec<Update>) {
        let lines = lines();
        let hello = lines.iter().find(|l| l["t"] == "hello").unwrap();
        let origin = Origin { session_id: hello["sessionId"].as_str().unwrap().into(), cwd: hello["cwd"].as_str().unwrap().into() };
        let mut replica = Replica::new(origin.session_id.clone());
        let (mut feeder, mut mirror, mut updates) = (Feeder::default(), Mirror::default(), Vec::new());
        let missing = std::env::temp_dir().join(format!("tf-feed-none-{}.jsonl", std::process::id()));
        let mut t = 1_800_000_000_000;
        for l in &lines {
            t += 50;
            let up = match l["t"].as_str().unwrap() {
                "resync" => {
                    let tail_path = file.unwrap_or(&missing);
                    let read = journal::read_full(tail_path, None).unwrap();
                    // The fresh session had no file at resync time; with `file` the tail starts at
                    // the file's beginning so its entries arrive as appends, ahead of the frames.
                    let read = FullRead { header: None, title: None, entries: Vec::new(), found: false, tail: JournalTail::new(read.tail.path()) };
                    feeder.resync(&mut replica, resync_of(l), read, &origin, t)
                }
                "live" => step(&mut feeder, &mut replica, l["seq"].as_u64().unwrap(), HostFrame::from_value(l["f"].clone()), t).unwrap(),
                _ => continue,
            };
            mirror.apply(&up.events);
            updates.push(up);
        }
        (replica, mirror, updates)
    }

    fn rows(r: &Replica) -> Vec<TranscriptItem> {
        r.snapshot(usize::MAX).items
    }

    fn check_mirror(r: &Replica, m: &Mirror) {
        let want = rows(r);
        let got: Vec<&TranscriptItem> = m.order.iter().map(|id| &m.items[id]).collect();
        assert_eq!(got.len(), want.len(), "row count: mirror {:?} vs replica {:?}", m.order, want.iter().map(TranscriptItem::id).collect::<Vec<_>>());
        for (g, w) in got.iter().zip(&want) {
            assert_eq!(*g, w, "mirror row differs");
        }
        assert_eq!(m.ui, r.ui().map(|u| u.id.clone()), "ui mirror");
    }

    #[test]
    fn real_bridge_frames_build_the_session() {
        let (replica, mirror, updates) = feed(None);
        check_mirror(&replica, &mirror);
        let rows = rows(&replica);
        let users: Vec<&str> = rows.iter().filter_map(|i| match i {
            TranscriptItem::User(u) => Some(u.text.as_str()),
            _ => None,
        }).collect();
        assert!(users.len() >= 3, "user rows: {users:?}");
        // The bash tool ran and its row closed with output.
        let bash = rows.iter().find_map(|i| match i {
            TranscriptItem::Tool(t) if t.tool == "bash" => Some(t),
            _ => None,
        }).expect("bash row");
        assert_eq!(bash.status, ToolStatus::Ok, "{bash:?}");
        assert!(bash.output.as_deref().is_some_and(|o| !o.is_empty()));
        // The ask was shown to clients, then settled when it was answered (no dialog left).
        assert_eq!(mirror.asked, 1);
        assert!(replica.ui().is_none());
        let ask = rows.iter().find_map(|i| match i {
            TranscriptItem::Tool(t) if t.tool == "ask" => Some(t),
            _ => None,
        }).expect("ask row");
        assert_eq!(ask.status, ToolStatus::Ok);
        // The subagent and its nested child are on the session, finished.
        let subs = &replica.meta().subagents;
        assert!(subs.iter().any(|s| s.id == "ThickMandrill"), "{subs:?}");
        assert!(subs.iter().any(|s| s.id == "ThickMandrill.PongHelper"), "{subs:?}");
        assert!(subs.iter().all(|s| s.status != SubagentStatus::Running), "{subs:?}");
        // Every turn closed and the session is idle.
        assert!(!replica.is_streaming());
        let turns = updates.iter().flat_map(|u| &u.signals).filter(|s| matches!(s, tf_collab::Signal::TurnEnded { .. })).count();
        assert!(turns >= 3, "{turns} turns");
        // The assistant text streamed as appends (compacted deltas), not whole messages.
        let appends = updates.iter().flat_map(|u| &u.events).filter(|e| matches!(e, SessionEvent::Append { .. })).count();
        assert!(appends > 0);
    }

    #[test]
    fn session_file_entries_and_live_frames_make_the_same_rows() {
        // The same run with omp's final session file under the tail: every entry lands before the
        // frames that would have created its row, and the result must not change (ids match, no
        // duplicates, nothing reordered), the file adding only what live frames lack.
        let (live_only, _, _) = feed(None);
        let (with_file, mirror, _) = feed(Some(Path::new(SESSION_FILE)));
        check_mirror(&with_file, &mirror);
        let a: Vec<String> = rows(&live_only).iter().filter(|i| !matches!(i, TranscriptItem::Notice(_) | TranscriptItem::Mode(_))).map(|i| i.id().to_owned()).collect();
        let b: Vec<String> = rows(&with_file).iter().filter(|i| !matches!(i, TranscriptItem::Notice(_) | TranscriptItem::Mode(_))).map(|i| i.id().to_owned()).collect();
        assert_eq!(a, b);
        // The file's assistant entries carry usage: the session cost is known.
        assert!(with_file.usage().is_some_and(|c| c.usd >= 0.0));
    }

    #[test]
    fn frames_before_the_resync_and_stale_ones_are_skipped_and_a_gap_restarts() {
        let lines = lines();
        let resync = lines.iter().find(|l| l["t"] == "resync").unwrap();
        let lives: Vec<&Value> = lines.iter().filter(|l| l["t"] == "live").collect();
        let origin = Origin { session_id: resync["sessionId"].as_str().unwrap().into(), cwd: "/w".into() };
        let mut replica = Replica::new(origin.session_id.clone());
        let mut feeder = Feeder::default();
        let frame = |l: &Value| HostFrame::from_value(l["f"].clone());
        // Before any resync nothing applies.
        let up = feeder.frame(&mut replica, lives[0]["seq"].as_u64().unwrap(), frame(lives[0]), 1).unwrap();
        assert!(up.events.is_empty() && replica.is_empty());
        let missing = std::env::temp_dir().join(format!("tf-feed-gap-{}.jsonl", std::process::id()));
        let read = journal::read_full(&missing, None).unwrap();
        feeder.resync(&mut replica, resync_of(resync), read, &origin, 2);
        let seq = resync["seq"].as_u64().unwrap();
        // A frame of an earlier subscription (seq ≤ the resync's) is stale.
        assert!(feeder.frame(&mut replica, seq, frame(lives[0]), 3).unwrap().events.is_empty());
        feeder.frame(&mut replica, seq + 1, frame(lives[0]), 4).unwrap();
        assert_eq!(feeder.frame(&mut replica, seq + 3, frame(lives[1]), 5), Err(Restart::Gap { expected: seq + 2, got: seq + 3 }));
    }

    #[test]
    fn subagent_transcripts_come_from_their_files() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src/testdata/bridge-feed-1.session");
        let main = Path::new(SESSION_FILE);
        // Named by omp's lifecycle frames (or the bridge roster)…
        let named = Path::new(dir).join("ThickMandrill.jsonl");
        let page = subagent_transcript(Some(&named), None, "ThickMandrill").unwrap();
        assert!(page.items.iter().any(|i| matches!(i, TranscriptItem::Assistant(a) if !a.text.is_empty())));
        // …else found next to the main session file, nested ones a level down.
        let page = subagent_transcript(None, Some(main), "ThickMandrill.PongHelper").unwrap();
        assert!(!page.items.is_empty());
        let err = subagent_transcript(None, Some(main), "Nobody").unwrap_err();
        assert_eq!(err.code, "not_found");
    }

    fn bash_rows(r: &Replica) -> Vec<tf_proto::session::ToolItem> {
        rows(r)
            .into_iter()
            .filter_map(|i| match i {
                TranscriptItem::Tool(t) if t.tool == "bash" => Some(t),
                _ => None,
            })
            .collect()
    }

    fn last_assistant_text(r: &Replica) -> Option<String> {
        rows(r).into_iter().rev().find_map(|i| match i {
            TranscriptItem::Assistant(a) if !a.text.is_empty() => Some(a.text),
            _ => None,
        })
    }

    #[test]
    fn an_overflow_resync_mid_turn_settles_the_session() {
        // The extension had to drop frames #34… while hostd did not read (a busy turn of three
        // long bash calls) and sent one resync instead, taken after the turn ended. The replica
        // must end up exactly where a hostd starting at that moment would be: no tool left
        // running, no row twice, the rows only the dropped frames carried taken from the file.
        let lines = fixture::lines(fixture::FEED_2);
        let resyncs: Vec<&Value> = lines.iter().filter(|l| l["t"] == "resync").collect();
        let (first, overflow) = (resyncs[0], resyncs[1]);
        assert_eq!(overflow["sessionId"], first["sessionId"], "the overflow resync is of the same session");
        let origin = Origin { session_id: first["sessionId"].as_str().unwrap().into(), cwd: lines[0]["cwd"].as_str().unwrap().into() };
        let dir = tempfile::tempdir().unwrap();
        let mut file = GrowingFile::new(dir.path().join("session.jsonl"), fixture::SESSION_2);
        let mut replica = Replica::new(origin.session_id.clone());
        let (mut feeder, mut mirror) = (Feeder::default(), Mirror::default());
        let mut t = 1_800_000_000_000;

        // A fresh session: omp has not written its file yet.
        let read = journal::read_full(file.path(), None).unwrap();
        mirror.apply(&feeder.resync(&mut replica, resync_of(first), read, &origin, t).events);
        let overflow_seq = overflow["seq"].as_u64().unwrap();
        for l in lines.iter().filter(|l| l["t"] == "live") {
            let seq = l["seq"].as_u64().unwrap();
            assert!(seq < overflow_seq);
            t += 50;
            mirror.apply(&step(&mut feeder, &mut replica, seq, HostFrame::from_value(l["f"].clone()), t).unwrap().events);
            // omp persists a message once it ended; the next read of the tail picks it up.
            if let Some(message) = fixture::ended_message(&l["f"]) {
                file.message_ended(message);
            }
        }
        check_mirror(&replica, &mirror);
        // The last frame before the overflow: the second call runs, its output streaming.
        let bash = bash_rows(&replica);
        assert_eq!(bash.iter().map(|t| t.status).collect::<Vec<_>>(), [ToolStatus::Ok, ToolStatus::Running], "{bash:#?}");
        assert!(replica.is_streaming());

        // omp went on writing while the frames were dropped.
        let last = overflow["lastEntryId"].as_str().unwrap();
        file.through(last);
        let read = journal::read_full(file.path(), Some(last)).unwrap();
        assert!(read.found);
        t += 50;
        let up = feeder.resync(&mut replica, resync_of(overflow), read, &origin, t);
        assert!(up.events.iter().any(|e| matches!(e, SessionEvent::Reset { .. })), "clients start over from the resync");
        mirror.apply(&up.events);
        check_mirror(&replica, &mirror);

        assert!(!replica.is_streaming() && replica.ui().is_none());
        let bash = bash_rows(&replica);
        assert_eq!(bash.len(), 3, "the third call only the dropped frames and the file carried: {bash:#?}");
        for t in &bash {
            assert_eq!(t.status, ToolStatus::Ok, "{t:#?}");
            assert!(t.output.as_deref().is_some_and(|o| o.lines().count() > 1000), "{}: {:?}", t.id, t.output.as_ref().map(String::len));
        }
        assert_eq!(last_assistant_text(&replica).as_deref(), Some("done"));
        let ids: Vec<String> = rows(&replica).iter().map(|i| i.id().to_owned()).collect();
        let unique: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "a row twice: {ids:?}");
        // Exactly what a hostd starting now builds from the session file.
        let mut fresh = Replica::new(origin.session_id.clone());
        Feeder::default().resync(&mut fresh, resync_of(overflow), journal::read_full(file.path(), Some(last)).unwrap(), &origin, t);
        assert_eq!(rows(&replica), rows(&fresh));
        assert_eq!(replica.meta(), fresh.meta());

        // The feed goes on after the resync's seq; frames of before it are stale.
        let state = HostFrame::State { state: replica.state().clone() };
        assert!(!feeder.reads_before(overflow_seq, &state));
        assert!(feeder.frame(&mut replica, overflow_seq - 1, state.clone(), t).unwrap().events.is_empty());
        assert!(feeder.frame(&mut replica, overflow_seq + 1, state.clone(), t).is_ok());
        assert_eq!(feeder.frame(&mut replica, overflow_seq + 3, state, t), Err(Restart::Gap { expected: overflow_seq + 2, got: overflow_seq + 3 }));
    }

    #[test]
    fn entries_written_before_a_starting_frame_land_before_it() {
        // The driver reads the tail after such a frame arrived and applies that read first: an
        // entry omp wrote before the event (a model switch) is not shown after the turn it
        // preceded, whenever the poll ran last.
        let lines = fixture::lines(fixture::FEED_2);
        let switched = lines.iter().filter(|l| l["t"] == "resync").nth(2).unwrap();
        let origin = Origin { session_id: switched["sessionId"].as_str().unwrap().into(), cwd: "/w".into() };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::copy(fixture::SWITCHED_2, &path).unwrap();
        let mut replica = Replica::new(origin.session_id.clone());
        let mut feeder = Feeder::default();
        let last = switched["lastEntryId"].as_str().unwrap();
        feeder.resync(&mut replica, resync_of(switched), journal::read_full(&path, Some(last)).unwrap(), &origin, 1);
        let seq = switched["seq"].as_u64().unwrap();
        let model = serde_json::json!({ "type": "model_change", "id": "aa11bb22", "parentId": last,
            "timestamp": "2026-10-28T16:46:00.000Z", "model": "openai-codex/gpt-6-sol" });
        std::io::Write::write_all(&mut std::fs::OpenOptions::new().append(true).open(&path).unwrap(), format!("{model}\n").as_bytes()).unwrap();
        let user = HostFrame::from_value(serde_json::json!({ "t": "event", "event": { "type": "message_start",
            "message": { "role": "user", "content": [{ "type": "text", "text": "hi" }], "timestamp": 1_793_205_960_000_u64 } } }));
        assert!(feeder.reads_before(seq + 1, &user));
        // A `state` frame starts nothing: no read waits for it.
        assert!(!feeder.reads_before(seq + 1, &HostFrame::State { state: replica.state().clone() }));
        step(&mut feeder, &mut replica, seq + 1, user, 2).unwrap();
        let order: Vec<String> = rows(&replica).iter().map(|i| i.id().to_owned()).collect();
        let (mode, user) = (order.iter().position(|id| id == "maa11bb22"), order.iter().position(|id| id.starts_with('u')));
        assert!(mode.is_some() && user.is_some() && mode < user, "{order:?}");
    }

    /// The notes an update took, as [`omp::publish`] persists them.
    fn noted(up: &Update) -> Vec<(String, tf_collab::replica::RowNote)> {
        up.signals
            .iter()
            .filter_map(|s| match s {
                tf_collab::Signal::Noted { id, note } => Some((id.clone(), note.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn rows_built_live_equal_rows_rebuilt_after_a_restart() {
        // The recorded run (bridge 2.0.0, omp 18.13.2) with omp's session file growing as omp
        // wrote it; the desktop app sent the first prompt. What the replica noted goes to the notes
        // store as tf-hostd keeps it. A tf-hostd started afterwards rebuilds the session from the
        // file and that store: every row (notices are live-only) is the same, field for field, so
        // a client holding the rows by hash keeps every one of them.
        let lines = lines();
        let hello = lines.iter().find(|l| l["t"] == "hello").unwrap();
        let origin = Origin { session_id: hello["sessionId"].as_str().unwrap().into(), cwd: hello["cwd"].as_str().unwrap().into() };
        let sid = origin.session_id.clone();
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let mut file = GrowingFile::new(dir.path().join("session.jsonl"), SESSION_FILE);
        let prompt = "Run `echo bridge-ok` with the bash tool, then reply with just: done";
        let mut replica = Replica::new(sid.clone());
        replica.expect_prompt(prompt, "desktop");
        let (mut feeder, mut mirror) = (Feeder::default(), Mirror::default());
        let mut t = 1_800_000_000_000;
        for l in &lines {
            t += 50;
            let up = match l["t"].as_str().unwrap() {
                "resync" => feeder.resync(&mut replica, resync_of(l), journal::read_full(file.path(), None).unwrap(), &origin, t),
                "live" => {
                    let up = step(&mut feeder, &mut replica, l["seq"].as_u64().unwrap(), HostFrame::from_value(l["f"].clone()), t).unwrap();
                    // Custom messages are `custom_message` entries: written with the next message.
                    if let Some(message) = fixture::ended_message(&l["f"]).filter(|m| m["role"] != "custom") {
                        file.message_ended(message);
                    }
                    up
                }
                _ => continue,
            };
            crate::notes::append(&notes, &sid, &noted(&up)).unwrap();
            mirror.apply(&up.events);
        }
        // What omp wrote after the last frame.
        let last = fixture::lines(SESSION_FILE).last().unwrap()["id"].as_str().unwrap().to_owned();
        file.through(&last);
        let read = read_now(&mut feeder);
        let up = feeder.apply_read(&mut replica, read, t).unwrap();
        crate::notes::append(&notes, &sid, &noted(&up)).unwrap();
        mirror.apply(&up.events);
        check_mirror(&replica, &mirror);

        // tf-hostd restarted: the session's notes from the store, then the bridge's resync (the file
        // through its last entry, omp idle).
        let restart = |notes: Option<&Path>| {
            let mut fresh = Replica::new(sid.clone());
            if let Some(dir) = notes {
                fresh.keep_notes(crate::notes::load(dir, &sid));
            }
            let mut resync = resync_of(lines.iter().find(|l| l["t"] == "resync").unwrap());
            resync.last_entry_id = Some(last.clone());
            resync.streaming = false;
            Feeder::default().resync(&mut fresh, resync, journal::read_full(file.path(), Some(&last)).unwrap(), &origin, t + 60_000);
            fresh
        };
        let fresh = restart(Some(&notes));
        let file_rows = |r: &Replica| rows(r).into_iter().filter(|i| !matches!(i, TranscriptItem::Notice(_))).collect::<Vec<_>>();
        let (live, again) = (file_rows(&replica), file_rows(&fresh));
        assert_eq!(live.iter().map(TranscriptItem::id).collect::<Vec<_>>(), again.iter().map(TranscriptItem::id).collect::<Vec<_>>());
        for (a, b) in live.iter().zip(&again) {
            assert_eq!(a, b, "row {} built live differs from its rebuild", a.id());
            assert_eq!(crate::sync::row_hash(a), crate::sync::row_hash(b));
        }
        let author = |r: &[TranscriptItem]| {
            r.iter().find_map(|i| match i {
                TranscriptItem::User(u) if u.text == prompt => Some(u.author.clone()),
                _ => None,
            })
        };
        assert_eq!(author(&again), Some(Some("desktop".to_owned())), "the prompt's sender survives the restart");
        // The store is what keeps it: without it the file alone has no sender.
        assert_eq!(author(&file_rows(&restart(None))), Some(None));
        // Tool rows carry the recorded call (no intent field, no nulls) and omp's own timings.
        let bash = bash_rows(&fresh).remove(0);
        assert_eq!(bash.args, serde_json::json!({ "command": "echo bridge-ok" }));
        assert_eq!(bash.duration_ms, Some(36), "the bash tool's wall time");
    }
}
