//! The settle watchdog (architecture §3.4 "Stalled feed"): every session's copy is held against
//! omp's own word, whatever feeds it, and a copy that missed something is reloaded from omp.
//!
//! A live source can stop delivering in ways nobody foresaw: a bridge feed driver stuck in an
//! await, frames hostd could not read, a bridge whose writer stopped, a collab room that went
//! silent. The copy then stays where it was while omp goes on, and the app's own repair cannot
//! help (it re-reads this copy). omp's word, apart from the live source:
//! - its session file: the newest transcript entry omp wrote (read from the end of the file when
//!   it changed, [`journal::newest_entry`]) and whether that entry ended the run;
//! - the bridge's control state (`idle`, from `ctx.isIdle()`), on a channel of its own;
//! - the collab registry (`busy`, omp's `isStreaming`, asked of the omp process on every poll).
//!
//! Every [`EVERY`] the watchdog judges a live session's copy ([`Watch::judge`]). It is
//! - **behind** when the session file holds a transcript entry it lacks, for [`BEHIND_AFTER`];
//! - **stale** when it shows a turn running (`Replica::at_work`) while omp says its turn is over,
//!   for [`STALE_AFTER`];
//! - **unseen** when omp says it works while the copy shows nothing at work, for [`STALE_AFTER`].
//!
//! A repair first asks the live source for everything again: the bridge feed subscribes again (a
//! fresh `resync`), the collab guest says hello again (a fresh snapshot). A copy the source has not
//! settled [`SOURCE_GRACE`] later is rebuilt from the session file (every entry as omp wrote it,
//! nothing in flight; subscribers get it as a `reset`), and a bridge feed driver that delivered no
//! resync meanwhile is started over: it may be stuck where no ask reaches it (with its bridge gone,
//! the session loses it there). Repairs are paced: the second one at the earliest twice [`BACKOFF`]
//! after the first, twice as long for each further one in a row, up to [`BACKOFF_MAX`]; a copy that
//! stayed settled that long starts over. One warning per repair.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime};

use tf_collab::Guest;
use tf_proto::model::LinkState;
use tokio::time::Instant;
use tracing::{debug, warn};

use crate::feed;
use crate::journal::{self, JournalTail, Newest, Poll};
use crate::omp::{self, Inner, OmpSession, Transport};
use crate::util::now_ms;

/// How often a session is judged (a `stat` of its file; a read of its end when it changed).
const EVERY: Duration = if cfg!(test) { Duration::from_millis(20) } else { Duration::from_secs(2) };
/// omp wrote a transcript entry the copy still lacks this long after the watchdog first saw it:
/// the live source lost it (a healthy one delivers it within a second).
const BEHIND_AFTER: Duration = if cfg!(test) { Duration::from_millis(200) } else { Duration::from_secs(10) };
/// The copy and omp disagree on whether a turn runs for this long (omp's state and the live
/// feed's agree within a second or two on a healthy feed).
const STALE_AFTER: Duration = if cfg!(test) { Duration::from_millis(300) } else { Duration::from_secs(30) };
/// What a repair gives the live source to settle the copy before it is rebuilt from the file.
const SOURCE_GRACE: Duration = if cfg!(test) { Duration::from_millis(400) } else { Duration::from_secs(15) };
/// After the n-th repair in a row, the next waits this long × 2ⁿ, up to [`BACKOFF_MAX`].
const BACKOFF: Duration = if cfg!(test) { Duration::from_millis(500) } else { Duration::from_secs(60) };
const BACKOFF_MAX: Duration = Duration::from_secs(15 * 60);
/// How often the file of a session no bridge names is looked up while it is not found.
const LOOK_EVERY: Duration = if cfg!(test) { Duration::from_millis(50) } else { Duration::from_secs(10) };
/// How often a session file that serves a session is read for what omp appended ([`following`]).
const FOLLOW_EVERY: Duration = if cfg!(test) { Duration::from_millis(20) } else { Duration::from_millis(500) };

const BRIDGE: &str = "omp's control state";
const REGISTRY: &str = "omp's collab registry";
const FILE: &str = "omp's session file";

/// What the watchdog asked of a session's live source, and when the source last sent everything
/// it has (a bridge `resync`, a collab snapshot); kept in the session state.
#[derive(Debug, Default)]
pub(crate) struct Asked {
    /// A fresh resync the bridge feed driver has yet to start, and why ([`crate::feed`] takes it).
    pub(crate) ask: Option<String>,
    resynced: Option<Instant>,
}

impl Asked {
    /// The live source just sent everything it has: any ask is answered.
    pub(crate) fn resynced(&mut self) {
        self.ask = None;
        self.resynced = Some(Instant::now());
    }

    fn resynced_since(&self, t: Instant) -> bool {
        self.resynced.is_some_and(|r| r >= t)
    }
}

/// What the watchdog sees of a copy and of omp.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Facts {
    /// The copy shows work in flight ([`tf_collab::Replica::at_work`]).
    pub(crate) at_work: bool,
    /// The session file's newest transcript entry, when the copy lacks it.
    pub(crate) missing: Option<String>,
    /// Who says omp's turn is over.
    pub(crate) idle_by: Option<&'static str>,
    /// Who says omp is working (when nobody says it is idle).
    pub(crate) busy_by: Option<&'static str>,
}

/// One session's judge ([`Watch::judge`]).
#[derive(Debug, Default)]
pub(crate) struct Watch {
    /// Since when the file has had an entry the copy lacks.
    behind: Option<Instant>,
    /// Since when the copy shows work in flight while omp says its turn is over.
    stale: Option<Instant>,
    /// Since when omp says it works while the copy shows nothing.
    unseen: Option<Instant>,
    /// Repairs in a row, and when the last one began.
    repairs: u32,
    last: Option<Instant>,
    /// An entry omp's own copy lacks too (it is on a branch the session left): never missed again.
    ignored: Option<String>,
}

impl Watch {
    /// Why the copy must be reloaded now, if it must: what [`Facts`] showed long enough, when the
    /// pacing allows another repair.
    pub(crate) fn judge(&mut self, f: &Facts, now: Instant) -> Option<String> {
        let (behind, stale, unseen) = self.held(f);
        self.behind = behind.then(|| self.behind.unwrap_or(now));
        self.stale = stale.then(|| self.stale.unwrap_or(now));
        self.unseen = unseen.then(|| self.unseen.unwrap_or(now));
        let held = |since: Option<Instant>, after: Duration| since.map(|t| now.duration_since(t)).filter(|d| *d >= after).map(|d| d.as_secs());
        let why = if let Some(secs) = held(self.behind, BEHIND_AFTER) {
            format!("omp's session file has entries this copy lacks ({secs} s)")
        } else if let Some(secs) = held(self.stale, STALE_AFTER) {
            format!("omp's turn is over ({} says so) but this copy shows it at work ({secs} s)", f.idle_by.unwrap_or(BRIDGE))
        } else if let Some(secs) = held(self.unseen, STALE_AFTER) {
            format!("omp is working ({} says so) but this copy never said so ({secs} s)", f.busy_by.unwrap_or(BRIDGE))
        } else {
            if !(behind || stale || unseen) && self.last.is_some_and(|t| now.duration_since(t) >= BACKOFF_MAX) {
                self.repairs = 0;
            }
            return None;
        };
        let pause = BACKOFF.saturating_mul(1 << self.repairs.min(10)).min(BACKOFF_MAX);
        if self.last.is_some_and(|t| now.duration_since(t) < pause) {
            return None;
        }
        self.repairs += 1;
        self.last = Some(now);
        Some(why)
    }

    /// Whether the copy disagrees with omp right now: (behind, stale, unseen).
    fn held(&self, f: &Facts) -> (bool, bool, bool) {
        let behind = f.missing.as_ref().is_some_and(|id| self.ignored.as_ref() != Some(id));
        (behind, f.at_work && f.idle_by.is_some(), !f.at_work && f.busy_by.is_some())
    }

    /// The copy agrees with omp.
    pub(crate) fn settled(&self, f: &Facts) -> bool {
        self.held(f) == (false, false, false)
    }

    /// `id` is missing from omp's own copy too (its fresh snapshot lacks it): it stays out of the
    /// session omp shows, so it no longer counts as missing.
    fn ignore(&mut self, id: Option<String>) {
        self.ignored = id;
        self.behind = None;
    }
}

/// What feeds a copy, as the watchdog saw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Plane {
    Bridge,
    Collab,
    None,
}

/// One look at a session.
struct Seen {
    facts: Facts,
    /// The link says live (a repair starts only then; one in progress goes on regardless).
    live: bool,
    plane: Plane,
    /// A bridge feed driver runs for the session.
    driver: bool,
    guest: Option<Guest>,
}

/// A repair under way: when it asked the live source, and whether the copy was rebuilt from the
/// file since.
struct Pending {
    at: Instant,
    plane: Plane,
    rebuilt: bool,
}

/// One session's watchdog, for its lifetime ([`omp::spawn_session_loops`]).
pub(crate) async fn watch(weak: Weak<Inner>, session: Arc<OmpSession>) {
    let mut judge = Watch::default();
    let mut file = FileWatch::default();
    let mut pending: Option<Pending> = None;
    // The session file's tail while it serves the session ([`following`]).
    let mut follow: Option<JournalTail> = None;
    loop {
        let Some(cancel) = weak.upgrade().map(|inner| inner.cancel.clone()) else { return };
        let every = if following(&session) { FOLLOW_EVERY } else { EVERY };
        tokio::select! {
            _ = tokio::time::sleep(every) => {}
            _ = cancel.cancelled() => return,
        }
        if session.is_closed() {
            return;
        }
        let Some(inner) = weak.upgrade() else { return };
        let path = file.path(&inner, &session).await;
        if following(&session) {
            // No live source: the file keeps the copy current, and repairs have nothing to ask.
            pending = None;
            if let Some(p) = &path {
                follow = follow_file(&inner, &session, p, follow.take()).await;
            }
            continue;
        }
        follow = None;
        let newest = match &path {
            Some(p) => file.newest(p).await,
            None => None,
        };
        let Some(seen) = observe(&inner, &session, newest.as_ref()) else { continue };
        let now = Instant::now();
        if let Some(p) = pending.as_mut() {
            if judge.settled(&seen.facts) {
                pending = None;
            } else if !p.rebuilt && now.duration_since(p.at) >= SOURCE_GRACE {
                p.rebuilt = true;
                escalate(&inner, &session, &seen, p, path.as_deref(), &mut judge).await;
            }
        }
        if !seen.live {
            continue;
        }
        if let Some(why) = judge.judge(&seen.facts, now) {
            warn!(session = %session.session_id, repair = judge.repairs, "{why}; reloading the session from omp");
            pending = Some(ask_source(&inner, &session, &seen, why, now, path.as_deref()).await);
        }
    }
}

/// Nothing live serves the session: its collab guest is reconnecting or gone, hostd never managed
/// to join its room, or its bridge went away. omp's session file serves it meanwhile.
fn following(session: &OmpSession) -> bool {
    following_locked(&session.lock())
}

/// One step of a file follow: what omp appended to the session file since `tail` (from where the
/// copy's journal left the file when the follow starts: no reset), applied as the file has it.
/// A copy that never read the file, or a file rewritten meanwhile, is rebuilt from it once
/// (a `reset`). Returns the tail to continue from (`None`: start again next time).
async fn follow_file(inner: &Arc<Inner>, session: &Arc<OmpSession>, path: &Path, tail: Option<JournalTail>) -> Option<JournalTail> {
    let tail = match tail.filter(|t| t.path() == path) {
        Some(t) => t,
        None => {
            let (loaded, offset) = {
                let st = session.lock();
                (st.replica.header().is_some(), st.replica.journal_offset())
            };
            let file = path.to_path_buf();
            let resumed = if loaded {
                tokio::task::spawn_blocking(move || JournalTail::resume(&file, offset).ok().flatten()).await.ok().flatten()
            } else {
                None
            };
            match resumed {
                Some(t) => t,
                None => {
                    let streaming = omp_says_busy(inner, &session.session_id);
                    return match rebuild_from_file(inner, session, path, streaming).await {
                        Ok(t) => Some(t),
                        Err(e) => {
                            debug!(session = %session.session_id, "file follow: {e}");
                            None
                        }
                    };
                }
            }
        }
    };
    let (tail, read) = tokio::task::spawn_blocking(move || {
        let mut tail = tail;
        let read = tail.poll();
        (tail, read)
    })
    .await
    .ok()?;
    match read {
        Poll::Idle => Some(tail),
        Poll::Appended { entries, offset } => {
            let now = now_ms();
            let (update, usage) = {
                let mut st = session.lock();
                if session.is_closed() || !following_locked(&st) {
                    return None;
                }
                let update = feed::apply_appended(&mut st.replica, entries, offset, now);
                let usage = session.absorb(&mut st, &update);
                (update, usage)
            };
            omp::publish(inner, session, &update, usage, now, false).await;
            Some(tail)
        }
        // Rewritten (a full rewrite) or gone (a `/move`): read it again from the start next time.
        Poll::Rewritten | Poll::Missing => None,
    }
}

/// [`following`] for a caller holding the session lock. A guest's first join is no outage: its
/// snapshot is on its way (only a copy it loaded before is followed while it reconnects).
fn following_locked(st: &omp::SessionState) -> bool {
    match st.transport {
        Transport::Collab(_) => st.link != LinkState::Live && st.replica.header().is_some(),
        Transport::Detached => st.room_lost.is_some() || st.bridge_lost.is_some(),
        Transport::Bridge { .. } => false,
    }
}

/// omp's control state or collab registry says a turn runs (and neither says it is idle).
fn omp_says_busy(inner: &Inner, session_id: &str) -> bool {
    let bridge_idle = inner.bridge.by_session(session_id).map(|b| b.state.idle);
    let registry_idle = inner.room_of(session_id).and_then(|r| r.busy).map(|busy| !busy);
    bridge_idle != Some(true) && registry_idle != Some(true) && (bridge_idle == Some(false) || registry_idle == Some(false))
}

/// Reads what the watchdog judges by: the copy (under the session lock) and omp's other words.
/// `None` while the copy has nothing to judge (not loaded yet, or ended).
fn observe(inner: &Inner, session: &OmpSession, newest: Option<&Newest>) -> Option<Seen> {
    // Read before the session lock (each takes a lock of its own).
    let bridge_idle = inner.bridge.by_session(&session.session_id).map(|b| b.state.idle);
    let registry_idle = inner.room_of(&session.session_id).and_then(|r| r.busy).map(|busy| !busy);
    let st = session.lock();
    if st.replica.header().is_none() || st.replica.ended() || session.is_closed() {
        return None;
    }
    let (plane, guest) = match &st.transport {
        Transport::Bridge { .. } => (Plane::Bridge, None),
        Transport::Collab(r) => (Plane::Collab, Some(r.guest.clone())),
        Transport::Detached => (Plane::None, None),
    };
    // The most direct word first. The file's alone counts only when omp says nothing else: a
    // compaction after the turn's last message runs (and writes nothing) for a while.
    let idle_by = match (bridge_idle, registry_idle) {
        (Some(true), _) => Some(BRIDGE),
        (_, Some(true)) => Some(REGISTRY),
        (None, None) if newest.is_some_and(|n| n.turn_end) => Some(FILE),
        _ => None,
    };
    let busy_by = match (idle_by, bridge_idle, registry_idle) {
        (Some(_), _, _) => None,
        (None, Some(false), _) => Some(BRIDGE),
        (None, _, Some(false)) => Some(REGISTRY),
        _ => None,
    };
    let facts = Facts {
        at_work: st.replica.at_work(),
        missing: newest.filter(|n| !st.replica.knows_entry(&n.id)).map(|n| n.id.clone()),
        idle_by,
        busy_by,
    };
    Some(Seen { facts, live: st.link == LinkState::Live && plane != Plane::None, plane, driver: st.driver.is_some(), guest })
}

/// A repair's first step: the live source is asked for everything again. A copy nothing could be
/// asked of is rebuilt from the file at once.
async fn ask_source(inner: &Arc<Inner>, session: &Arc<OmpSession>, seen: &Seen, why: String, now: Instant, path: Option<&Path>) -> Pending {
    let asked = match seen.plane {
        Plane::Bridge if seen.driver => {
            session.lock().settle.ask = Some(why);
            session.feed_kick.notify_one();
            true
        }
        Plane::Collab => seen.guest.as_ref().is_some_and(|g| g.resync().is_ok()),
        _ => false,
    };
    let mut pending = Pending { at: now, plane: seen.plane, rebuilt: false };
    if !asked {
        pending.rebuilt = true;
        rebuild(inner, session, path, seen.facts.busy_by.is_some()).await;
    }
    pending
}

/// A repair's second step, when the live source did not settle the copy in time: the copy is
/// rebuilt from the file, and a bridge feed driver that delivered no resync is started over.
async fn escalate(inner: &Arc<Inner>, session: &Arc<OmpSession>, seen: &Seen, p: &Pending, path: Option<&Path>, judge: &mut Watch) {
    let resynced = session.lock().settle.resynced_since(p.at);
    let (behind, stale, unseen) = judge.held(&seen.facts);
    if p.plane == Plane::Collab && resynced && behind && !stale && !unseen {
        debug!(session = %session.session_id, entry = ?seen.facts.missing, "omp's fresh snapshot lacks the session file's newest entry too; not missing it any more");
        judge.ignore(seen.facts.missing.clone());
        return;
    }
    if p.plane == Plane::Bridge && !resynced {
        let started = feed::restart_driver(inner, session);
        debug!(session = %session.session_id, started, "the bridge feed delivered no resync since the repair asked; starting it over");
    }
    rebuild(inner, session, path, seen.facts.busy_by.is_some()).await;
}

async fn rebuild(inner: &Arc<Inner>, session: &Arc<OmpSession>, path: Option<&Path>, streaming: bool) {
    let Some(path) = path else {
        debug!(session = %session.session_id, "no session file to reload the copy from");
        return;
    };
    match rebuild_from_file(inner, session, path, streaming).await {
        Ok(_) => debug!(session = %session.session_id, file = %path.display(), streaming, "copy reloaded from the session file"),
        Err(e) => debug!(session = %session.session_id, "could not reload the copy from the session file: {e}"),
    }
}

/// Rebuilds `session`'s copy from omp's session file at `path` ([`feed::rebuild`]) and hands its
/// subscribers the result. `streaming`: omp says a turn runs.
pub(crate) async fn rebuild_from_file(inner: &Arc<Inner>, session: &Arc<OmpSession>, path: &Path, streaming: bool) -> Result<JournalTail, String> {
    omp::load_notes(inner, session).await;
    let file = path.to_path_buf();
    // `stat` first: never open anything but a regular file (a FIFO would block the read for good).
    let read = tokio::task::spawn_blocking(move || journal::stat(&file).and_then(|_| journal::read_full(&file, None)))
        .await
        .map_err(|e| format!("session file read failed: {e}"))?
        .map_err(|e| format!("cannot read the session file: {e}"))?;
    if !read.exists() {
        return Err("the session file is gone".into());
    }
    let cwd = inner.bridge.by_session(&session.session_id).map(|b| b.cwd);
    let now = now_ms();
    let (update, usage, tail) = {
        let mut st = session.lock();
        if session.is_closed() {
            return Err("the session ended".into());
        }
        let cwd = cwd.or_else(|| st.replica.header().map(|h| h.cwd.clone())).unwrap_or_default();
        let origin = feed::Origin { session_id: session.session_id.clone(), cwd };
        let (update, tail) = feed::rebuild(&mut st.replica, read, &origin, streaming, now);
        let usage = session.absorb(&mut st, &update);
        (update, usage, tail)
    };
    omp::publish(inner, session, &update, usage, now, true).await;
    Ok(tail)
}

/// The session file as the watchdog follows it: where it is, and what its end said last.
#[derive(Default)]
struct FileWatch {
    /// The file of a session no bridge names, found by its name, and when to look again.
    found: Option<PathBuf>,
    look_at: Option<Instant>,
    /// The last read: the file, its size and change time, and its newest transcript entry.
    last: Option<(PathBuf, u64, Option<SystemTime>, Option<Newest>)>,
}

impl FileWatch {
    /// The session's file: the one its bridge named, else the one found under omp's sessions dir.
    async fn path(&mut self, inner: &Inner, session: &OmpSession) -> Option<PathBuf> {
        if let Some(named) = session.lock().session_file.clone() {
            return Some(named);
        }
        if self.found.is_some() {
            return self.found.clone();
        }
        let now = Instant::now();
        if self.look_at.is_some_and(|t| now < t) {
            return None;
        }
        self.look_at = Some(now + LOOK_EVERY);
        let root = inner.sessions_root.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let id = session.session_id.clone();
        self.found = tokio::task::spawn_blocking(move || crate::artifacts::find_session_file(&root, &id)).await.ok().flatten();
        self.found.clone()
    }

    /// The newest transcript entry of `path`: one `stat`, and a read of the file's end only when it
    /// changed. Blocking I/O on the blocking pool.
    async fn newest(&mut self, path: &Path) -> Option<Newest> {
        let file = path.to_path_buf();
        let last = self.last.clone();
        let read = tokio::task::spawn_blocking(move || {
            let (len, modified) = journal::stat(&file).ok()?;
            if let Some((was, l, m, newest)) = last
                && was == file
                && l == len
                && m == modified
            {
                return Some((file, len, modified, newest));
            }
            let newest = journal::newest_entry(&file, len).ok().flatten();
            Some((file, len, modified, newest))
        })
        .await
        .ok()
        .flatten();
        match read {
            Some(last) => {
                let newest = last.3.clone();
                self.last = Some(last);
                newest
            }
            None => {
                // Gone (moved), or not written yet: look it up again.
                self.last = None;
                if self.found.as_deref() == Some(path) {
                    self.found = None;
                }
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn behind(id: &str) -> Facts {
        Facts { missing: Some(id.into()), ..Facts::default() }
    }

    fn stale(by: &'static str) -> Facts {
        Facts { at_work: true, idle_by: Some(by), ..Facts::default() }
    }

    /// Judges `f` every 10 ms from `from` for `span`; the times a repair was due.
    fn repairs(w: &mut Watch, f: &Facts, from: Instant, span: Duration) -> Vec<Duration> {
        let mut out = Vec::new();
        let mut t = Duration::ZERO;
        while t <= span {
            if w.judge(f, from + t).is_some() {
                out.push(t);
            }
            t += Duration::from_millis(10);
        }
        out
    }

    #[test]
    fn a_healthy_copy_is_left_alone() {
        let mut w = Watch::default();
        let now = Instant::now();
        // At work while omp works; idle while omp is idle; omp saying nothing.
        for f in [
            Facts { at_work: true, busy_by: Some(BRIDGE), ..Facts::default() },
            Facts { idle_by: Some(REGISTRY), ..Facts::default() },
            Facts { at_work: true, ..Facts::default() },
            Facts::default(),
        ] {
            assert!(repairs(&mut w, &f, now, Duration::from_secs(5)).is_empty(), "{f:?}");
        }
    }

    #[test]
    fn a_copy_missing_what_omp_wrote_is_repaired_after_a_while() {
        let mut w = Watch::default();
        let now = Instant::now();
        // Missing for a moment (the live source delivers it): nothing.
        assert!(repairs(&mut w, &behind("e9"), now, BEHIND_AFTER / 2).is_empty());
        w.judge(&Facts::default(), now + BEHIND_AFTER);
        // Missing for good: once BEHIND_AFTER has passed, then paced.
        let at = repairs(&mut w, &behind("e9"), now + BEHIND_AFTER, BEHIND_AFTER * 2);
        assert_eq!(at.len(), 1);
        assert!(at[0] >= BEHIND_AFTER && at[0] < BEHIND_AFTER + Duration::from_millis(20), "{at:?}");
        // A newer entry still missing keeps the clock running (the copy is behind all along).
        let mut w = Watch::default();
        w.judge(&behind("e9"), now);
        assert!(w.judge(&behind("e10"), now + BEHIND_AFTER).is_some());
    }

    #[test]
    fn a_turn_omp_ended_while_the_copy_works_is_repaired_whoever_says_so() {
        for by in [BRIDGE, REGISTRY, FILE] {
            let mut w = Watch::default();
            let now = Instant::now();
            let at = repairs(&mut w, &stale(by), now, STALE_AFTER + Duration::from_millis(50));
            assert_eq!(at.len(), 1, "{by}");
            assert!(at[0] >= STALE_AFTER, "{by}: {at:?}");
            assert!(w.judge(&stale(by), now + STALE_AFTER * 2).is_none(), "paced");
        }
        // omp working while the copy shows nothing.
        let mut w = Watch::default();
        let unseen = Facts { busy_by: Some(REGISTRY), ..Facts::default() };
        assert_eq!(repairs(&mut w, &unseen, Instant::now(), STALE_AFTER).len(), 1);
    }

    #[test]
    fn repairs_in_a_row_back_off_and_a_settled_copy_starts_over() {
        let mut w = Watch::default();
        let now = Instant::now();
        let at = repairs(&mut w, &behind("e9"), now, BEHIND_AFTER + BACKOFF * 7);
        let gaps: Vec<Duration> = at.windows(2).map(|p| p[1] - p[0]).collect();
        assert_eq!(gaps.len(), 2, "{at:?}");
        assert!(gaps[0] >= BACKOFF * 2 && gaps[0] < BACKOFF * 2 + Duration::from_millis(20), "{gaps:?}");
        assert!(gaps[1] >= BACKOFF * 4 && gaps[1] < BACKOFF * 4 + Duration::from_millis(20), "{gaps:?}");
        // Settled for BACKOFF_MAX: the next repair is the first of a new run.
        let later = now + Duration::from_secs(3600);
        assert!(w.judge(&Facts::default(), later).is_none());
        assert_eq!(w.repairs, 0);
    }

    #[test]
    fn an_entry_omp_does_not_show_either_stops_counting() {
        let mut w = Watch::default();
        let now = Instant::now();
        w.ignore(Some("left".into()));
        assert!(w.settled(&behind("left")));
        assert!(repairs(&mut w, &behind("left"), now, BEHIND_AFTER * 3).is_empty());
        // A newer entry the copy lacks counts again.
        assert!(!w.settled(&behind("e10")));
    }
}
