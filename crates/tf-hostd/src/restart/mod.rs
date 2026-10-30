//! Bring agents back (architecture §3.25). No work is lost to a crash: every omp agent the board
//! shows live is in the ledger ([`ledger`], `<home>/ledger.json`) with what it takes to bring it
//! back exactly, and an agent whose omp ends without anyone closing it (herdr stopped or crashed,
//! the host restarted, omp crashed or was killed, its pane died) stays as an ended card
//! (`Parked.ended`: Review, same agent id, its transcript) with why and when. It comes back once
//! herdr runs again: by itself while the host's auto-resume is on (a `restart` ticket,
//! `crate::recovery`), else on Continue.
//!
//! * [`start_session`]: one worker per herdr session (`Ctx::create`), every [`TICK`]:
//!   - **tracks** every live omp agent: pane, process and its command line, name, model,
//!     thinking, its own omp settings and decide-for-me policy, what it is doing, its background
//!     jobs;
//!   - **ends** an entry whose omp is gone: herdr down (`crate::herdr_health`), another boot,
//!     another herdr server, omp gone from a pane that is still there (its exit record says why;
//!     a clean exit is a close on purpose; one somebody stopped with SIGTERM / SIGINT is a card
//!     that waits for Continue, never relaunched by itself), a pane that died (`pane.exited`; one
//!     closed under the same herdr while hostd watched was closed on purpose, one that went
//!     unseen is a card that waits for Continue). How it goes on is decided right then
//!     ([`decide`]). An entry that ended more than [`ledger::CRASH_ENDS`] times in
//!     [`ledger::CRASH_WINDOW_MS`] waits for Continue too (a crash loop);
//!   - **keeps the cards**: an ended entry whose card is gone from state.json gets it back from
//!     the entry, unless its session file is certainly gone;
//!   - **opens** the `restart` ticket of every ended card while herdr runs (servers that relaunch
//!     agents themselves get [`HERDR_RESUME_GRACE_MS`] first; a limit ticket on the card makes way
//!     for it), and of a live agent whose plan is still to run (herdr's own restore, or a resume
//!     by hand, brought it back; dropped when somebody went on in the session since);
//!   - **reports** the resume command to herdr ([`herdr`], always `--resume`).
//! * [`continue_session`] (the ticket's executor): relaunches an ended card with `--resume` and
//!   TeleFlock's full launch under its name (its restored pane when that is a shell again, else a
//!   new tab in its workspace or its folder), never while some omp runs that session (a process
//!   naming it, or the one the ledger recorded) and never before the board is built; then, once
//!   it is live on its bridge, goes on by the plan: omp's restore of what is safe to repeat, omp's
//!   retry of a cut-off reply, one note for the rest (at most once: the plan leaves the ledger
//!   before anything is sent).
//! * [`start`]: a daemon starting after a reboot opens the contexts of the herdr sessions the
//!   ledger has agents for: herdr starts again and the agents come back with no app connected.

pub mod decide;
pub mod detect;
pub mod herdr;
pub mod images;
pub mod launch;
pub mod ledger;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};
use tracing::{info, warn};

use tf_proto::autoresume::{AgentEnded, AutoResumeKind, EndCause, EndedTurn, RetryResult, RetryVia};
use tf_proto::methods::{Delivery, ImageInput, StartTarget};
use tf_proto::model::{ActivityKind, Agent, HerdrState, HostState, LinkState, Notification, NotifyKind};
use tf_proto::{ApiError, HerdrDownCause, HerdrHealth, Millis};

use crate::agentcfg::{AgentOmp, Store};
use crate::daemon::Daemon;
use crate::ops::Ctx;
use crate::recovery::{Ticket, TicketInit, RESCHEDULED};
use crate::state::parked::{check_file, FileCheck, ResumeClaim};
use crate::util::{new_id, now_ms};
use decide::{Can, Plan, Seen};
use ledger::{Book, Entry};

/// The worker looks at the board this often.
const TICK: Duration = Duration::from_secs(2);
/// An agent that vanished from the board whose entry was last seen live this much before this
/// process first noticed it missing was not being watched when it went (TeleFlock was off, or the
/// board was away): a pane closed on purpose is only told apart from a lost one while watching.
const WATCH_GAP_MS: Millis = 15_000;
/// Why a card that keeps ending (more than [`ledger::CRASH_ENDS`] times in
/// [`ledger::CRASH_WINDOW_MS`]) waits for Continue.
const CRASH_LOOP_HOLD: &str = "keeps crashing — continue when ready";
/// A session file written this long after the omp process started was written by that process's
/// own work (a resume writes a little right at its start).
const STARTUP_WRITE_MS: Millis = 30_000;
/// Written this much after an agent ended counts as written after it.
const END_SLACK_MS: Millis = 5_000;
/// A herdr session of the ledger that does not start yet is tried again this often.
const SESSION_RETRY: Duration = Duration::from_secs(30);
/// An agent off the board whose omp is gone (or that cannot be told) this long has ended.
const GONE_GRACE_MS: Millis = 4_000;
/// herdr does not answer and nothing says why (no herdr health): its agents count as ended after
/// this long.
const UNREACHABLE_MS: Millis = 15_000;
/// Servers that relaunch the agents of the panes they restore themselves (`herdrResumes`) get
/// this long before TeleFlock brings them back (it then takes over the omp herdr started).
pub const HERDR_RESUME_GRACE_MS: Millis = 30_000;
/// A brought-back agent gets this long to be live on its bridge before it goes on.
const LIVE_WAIT: Duration = Duration::from_secs(120);
/// Bridge `restore` / `retry`.
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(30);
/// A restored pane's shell gets this long to come to its prompt.
const PANE_WAIT: Duration = Duration::from_secs(45);
/// An agent's own settings are read again this often.
const SETTINGS_EVERY_MS: Millis = 30_000;
/// After a live agent's bridge link went down, what it was doing stays as last seen live this
/// long (omp ending drops the link before herdr's state changes; a link that stays down while
/// omp runs on leaves herdr's state).
const LINK_GONE_MS: Millis = 30_000;
/// Last-seen times alone are written at most this often.
const SAVE_EVERY_MS: Millis = 60_000;
/// A `pane.exited` counts for the agent of that pane this long.
const EXITED_MS: Millis = 30_000;
/// An omp session TeleFlock stops to start it again is not ended meanwhile.
const RELAUNCH_MS: Millis = 60_000;
/// After a live handoff (`HerdrHealth.keptPanes`) agents get this long to show up under their new
/// agent ids before any counts as ended.
const HANDOFF_GRACE_MS: Millis = 60_000;
/// An exit record older than the last sighting by this much was written by an earlier process.
const STALE_EXIT_MS: Millis = 120_000;
/// The device the note's row names.
const DEVICE: &str = "TeleFlock";

static EXITED: LazyLock<Mutex<HashMap<(String, String), Millis>>> = LazyLock::new(Default::default);
static RELAUNCHING: LazyLock<Mutex<HashMap<String, Millis>>> = LazyLock::new(Default::default);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// herdr said a pane's process died (`pane.exited`): an agent gone with it ended, it was not
/// closed (state store's event loop).
pub fn pane_exited(session: &str, pane_id: &str) {
    let now = now_ms();
    let mut m = lock(&EXITED);
    m.retain(|_, at| now - *at < EXITED_MS);
    m.insert((session.to_string(), pane_id.to_string()), now);
}

fn pane_died(session: &str, pane_id: &str) -> bool {
    lock(&EXITED).get(&(session.to_string(), pane_id.to_string())).is_some_and(|at| now_ms() - at < EXITED_MS)
}

/// TeleFlock stops the omp of `file` to start it again (`launch::restart_in_place`).
pub(crate) fn relaunching(file: &str) {
    let now = now_ms();
    let mut m = lock(&RELAUNCHING);
    m.retain(|_, at| now - *at < RELAUNCH_MS);
    m.insert(file.to_string(), now);
}

fn being_relaunched(file: &str) -> bool {
    lock(&RELAUNCHING).get(file).is_some_and(|at| now_ms() - at < RELAUNCH_MS)
}

/// Opens the contexts of the herdr sessions the ledger has agents for (`daemon::async_main`), so
/// a daemon started after a reboot (systemd's keepalive, `automations/systemd.rs`) starts herdr
/// and brings them back with no app connected.
pub fn start(daemon: &Arc<Daemon>) {
    let sessions = ledger::sessions(&daemon.paths.home);
    if sessions.is_empty() {
        return;
    }
    // One task per session: a herdr session that cannot start (its server is broken) never holds
    // up the others.
    for s in sessions {
        let d = daemon.clone();
        tokio::spawn(async move {
            let cancel = d.shutdown.clone();
            let opened = open_until_ready(&s, &cancel, SESSION_RETRY, || async { d.ctx_for(&s).await.map(|_| ()) }).await;
            if opened {
                info!(session = %s, "agent ledger: bringing its agents back");
            }
        });
    }
}

/// Runs `attempt` until it succeeds, `retry` apart (false: shut down first).
async fn open_until_ready<E: std::fmt::Display, F: Future<Output = Result<(), E>>>(
    session: &str,
    cancel: &tokio_util::sync::CancellationToken,
    retry: Duration,
    mut attempt: impl FnMut() -> F,
) -> bool {
    loop {
        match attempt().await {
            Ok(()) => return true,
            Err(e) => warn!(session = %session, "agent ledger: herdr session not available yet: {e}"),
        }
        tokio::select! {
            _ = cancel.cancelled() => return false,
            _ = tokio::time::sleep(retry) => {}
        }
    }
}

/// Starts the herdr session's worker (and registers the context with `crate::recovery`).
pub fn start_session(ctx: &Arc<Ctx>) {
    crate::recovery::register(ctx);
    let ctx = ctx.clone();
    tokio::spawn(async move {
        let cancel = ctx.cancel.clone();
        let mut w = Worker::new(ctx);
        tokio::select! {
            _ = cancel.cancelled() => {}
            _ = w.run() => {}
        }
        ledger::open(&w.book).save(now_ms(), true, 0);
    });
}

/// The omp agent is in a turn: working, blocked on a dialog, or its subagents or background jobs
/// still run.
fn active(a: &Agent) -> bool {
    let o = a.omp.as_ref();
    matches!(a.state, HerdrState::Working | HerdrState::Blocked)
        || a.needs.is_some()
        || o.and_then(|o| o.subagents.as_ref()).is_some_and(|s| s.live > 0)
        || o.and_then(|o| o.jobs.as_ref()).is_some_and(|j| j.running > 0)
}

fn session_file(a: &Agent) -> Option<&str> {
    a.omp.as_ref()?.session_file.as_deref().filter(|f| !f.is_empty())
}

fn runs(e: &Entry, a: &Agent) -> bool {
    a.omp.as_ref().is_some_and(|o| e.runs(o.session_file.as_deref(), o.session_id.as_deref()))
}

/// A user row of a first turn the replica shows.
struct Turn {
    id: String,
    text: String,
    images: Vec<tf_proto::session::ImageRef>,
}

/// A first turn whose images could not be kept is tried this many times (a blob not journaled yet).
const KEEP_TRIES: u8 = 15;

/// Launches of omp agents in flight (`keep_first_prompt` .. `record_first_prompt`). While one is,
/// the observer may update the entries it has but never creates one (and leaves entries that know
/// no session alone): so every entry under the new agent's id when it is recorded predates the
/// launch, and the record can move all of them aside without asking whose they are.
static LAUNCHES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Holds the launch gate open; released on drop, whatever path the launch takes.
pub(crate) struct LaunchGuard(());

impl LaunchGuard {
    fn new() -> Self {
        LAUNCHES.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self(())
    }
}

impl Drop for LaunchGuard {
    fn drop(&mut self) {
        LAUNCHES.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

fn launch_in_flight() -> bool {
    LAUNCHES.load(std::sync::atomic::Ordering::SeqCst) > 0
}

/// The observer leaves an agent alone while a launch is in flight when it has no entry yet, or an
/// entry that knows no omp session (it could be the predecessor's stub the launch is about to move)
/// — except an entry a launch made for this very agent (its name and pane are the launch's: the
/// card is complete from the start), which is always observed and refined.
fn observer_waits(gated: bool, entry: Option<&Entry>, a: &Agent) -> bool {
    gated && entry.is_none_or(|e| !has_identity(e) && !own_launch(e, a))
}

/// The entry a launch made for agent `a` (no session known yet; its name and pane are the
/// launch's): the agent's own, never another's, gated or not.
fn own_launch(e: &Entry, a: &Agent) -> bool {
    launch_made(e) && e.record.name == a.name && e.pane_id == a.pane_id
}

/// An entry a launch made and no omp has told its session to yet: not ended, no session, the
/// launch's name and pane.
fn launch_made(e: &Entry) -> bool {
    e.record.ended.is_none() && !has_identity(e) && !e.record.name.is_empty() && !e.pane_id.is_empty()
}

/// What the board shows of an agent's omp session, and when the omp process behind it started
/// (the launch evidence `learn_session` needs; `None` when it could not be read).
#[derive(Debug, Clone)]
struct Row {
    sid: Option<String>,
    file: String,
    /// Ms since boot (the boot's own clock), not wall time.
    started: Option<i64>,
}

/// The row of the agent `id` as just seen: kept as it is when it is the same session (ids it did
/// not know yet, and the process start, are added to it), replaced by a new one when another
/// session shows under the id.
fn note_row(rows: &mut HashMap<String, Row>, id: &str, seen: Row) {
    match rows.get_mut(id) {
        Some(old) if old.same_session(&seen) => {
            if old.sid.is_none() {
                old.sid = seen.sid;
            }
            if old.file.is_empty() {
                old.file = seen.file;
            }
            if old.started.is_none() {
                old.started = seen.started;
            }
        }
        _ => {
            rows.insert(id.to_string(), seen);
        }
    }
}

impl Row {
    fn same_session(&self, other: &Row) -> bool {
        (!self.file.is_empty() && self.file == other.file) || (self.sid.is_some() && self.sid == other.sid)
    }
}

/// The board's row of `a`'s omp session; `started` is the start time of the omp process behind it.
fn row_of(a: &Agent, started: Option<Millis>) -> Option<Row> {
    let o = a.omp.as_ref()?;
    let sid = o.session_id.clone().filter(|s| !s.is_empty());
    let file = o.session_file.clone().unwrap_or_default();
    (sid.is_some() || !file.is_empty()).then_some(Row { sid, file, started })
}

/// The record knows an omp session of its own (not just the key of a fileless card).
fn real_identity(rec: &crate::state::persist::ParkedRecord) -> bool {
    !rec.session_file.is_empty() || rec.session_id.as_deref().is_some_and(|s| !s.is_empty() && !s.starts_with("fresh:"))
}

/// A record that never learned its session takes it from the board's row of its agent only on
/// launch evidence: the omp process behind the row started at or after the launch that made the
/// entry (`/proc`, read when the row was first seen, so it holds after the process is gone). A
/// session that was there before is a predecessor's under a reused id, whenever it was seen and
/// whatever the cached board still publishes; no evidence (another OS, no pid, a process we could
/// not read) means not learned: the card stays fileless with its kept prompt, and Continue is
/// manual. True when it learned.
fn learn_session(rec: &mut crate::state::persist::ParkedRecord, launch: Option<&ledger::BootStamp>, row: Option<&Row>) -> bool {
    let Some(row) = row else { return false };
    if !started_with_launch(row.started, launch) || real_identity(rec) {
        return false;
    }
    rec.session_id = row.sid.clone();
    rec.session_file = row.file.clone();
    true
}

/// Any of the entries `ids` is not what `before` has (changed, removed, or appeared).
fn changed_since<'a>(b: &Book, before: &std::collections::BTreeMap<String, Entry>, ids: impl IntoIterator<Item = &'a str>) -> bool {
    ids.into_iter().any(|id| b.entries.get(id) != before.get(id))
}

/// What a launch gave the new agent as its first prompt, kept for the ledger: its text and its
/// images as files (`restart/images.rs`) or why they could not be kept. Holds the launch gate.
pub(crate) struct FirstPrompt {
    text: Option<String>,
    images: Result<Vec<images::Kept>, String>,
    guard: Option<LaunchGuard>,
    /// The launch's own entry, with the card filled in (`launch_card`).
    card: Option<Entry>,
}

/// Keeps the images of a launch's first prompt (before the agent starts) and opens the launch
/// gate (dropped with the returned value on every path). Every omp launch gets a record, with or
/// without a prompt: the agent's entry exists from the start, and whatever entry has this id then
/// belongs to an agent before it and moves away (`record_into`).
pub(crate) async fn keep_first_prompt(ctx: &Ctx, spec: &tf_proto::methods::AgentSpec, at: LaunchAt) -> Option<FirstPrompt> {
    let guard = LaunchGuard::new();
    let text = spec.prompt.clone().filter(|t| !t.trim().is_empty());
    let images = if spec.images.is_empty() {
        Ok(Vec::new())
    } else {
        let (home, given) = (ctx.paths.home.clone(), spec.images.clone());
        tokio::task::spawn_blocking(move || images::keep_inputs(&home, &given)).await.unwrap_or_else(|e| Err(format!("keeping images: {e}")))
    };
    if let Err(why) = &images {
        warn!("agent ledger: the images of a first prompt cannot be kept: {why}");
    }
    let card = Some(launch_card(&ctx.state.snapshot().workspaces, spec, at, now_ms()));
    Some(FirstPrompt { text, images, guard: Some(guard), card })
}

/// Where and under what name a launch starts its agent.
pub(crate) struct LaunchAt {
    pub name: String,
    pub pane_id: String,
    pub workspace_id: String,
    pub cwd: Option<String>,
}

/// The entry a launch makes for its agent: the card it becomes (name, folder, repo, branch,
/// worktree, workspace, model, thinking level) from the launch's own parameters and its workspace
/// on the board, so it is complete before the observer has seen the agent. The observer refines it
/// (session, pid, title, what it does).
fn launch_card(workspaces: &[tf_proto::model::Workspace], spec: &tf_proto::methods::AgentSpec, at: LaunchAt, now: Millis) -> Entry {
    let ws = workspaces.iter().find(|w| w.id == at.workspace_id);
    let worktree = ws.and_then(|w| {
        let wt = w.worktree.as_ref()?;
        Some(crate::state::persist::ParkedWorktree { path: wt.path.clone(), repo_root: w.repo.as_ref().map(|r| r.root.clone()).unwrap_or_default() })
    });
    let model = spec.model.as_deref().and_then(|m| {
        let (provider, id) = m.split_once('/')?;
        let id = id.split(':').next().unwrap_or(id);
        Some(tf_proto::model::ModelRef { provider: provider.to_string(), id: id.to_string(), label: None })
    });
    let mut e = Entry::default();
    e.pane_id = at.pane_id;
    e.record = crate::state::persist::ParkedRecord {
        name: at.name.clone(),
        kind: "omp".into(),
        title: at.name,
        cwd: at.cwd,
        repo: ws.and_then(|w| w.repo.as_ref()).map(|r| r.name.clone()),
        branch: ws.and_then(|w| w.repo.as_ref()).and_then(|r| r.branch.clone()),
        model,
        thinking: spec.thinking,
        started_at: Some(now),
        worktree,
        workspace_id: Some(at.workspace_id).filter(|w| !w.is_empty()),
        workspace_cwd: ws.map(|w| w.cwd.clone()),
        ..Default::default()
    };
    e.launch_boot = ledger::boot_stamp();
    e
}

/// Records a launch's first prompt in the ledger entry of the agent hostd just started, and saves
/// it: from here on the ledger, not a task or the replica, knows what the agent was given. Any
/// entry that has the agent's id moves to its own key first; its card in state.json moves only
/// once the ledger is saved (a failed save changes nothing: the observer retries). The launch
/// gate stays open until this is done.
pub(crate) fn record_first_prompt(ctx: &Ctx, agent_id: &str, mut k: FirstPrompt) {
    if let Some(card) = k.card.as_mut() {
        // Bound just before: its own omp settings and decide-for-me policy.
        if let Some(r) = Store::new(&ctx.paths).get(&ctx.herdr_session, agent_id) {
            card.settings = r.omp;
        }
        card.auto_answer = crate::autoanswer::own(ctx, agent_id);
    }
    let _gate = k.guard.take();
    let book = ledger::book(&ctx.paths.home, &ctx.herdr_session);
    let (saved, moved) = {
        let mut b = ledger::open(&book);
        record_into(&mut b, agent_id, k)
    };
    if let Some(new) = moved {
        ctx.state.rekey_parked(agent_id, &new);
    }
    if !saved {
        warn!(agent = %agent_id, "agent ledger: the agent's first prompt could not be saved");
    }
}

/// An entry with nothing in it worth keeping.
fn is_empty_stub(e: &Entry) -> bool {
    !has_identity(e)
        && e.record.name.is_empty()
        && e.prompts.is_empty()
        && e.images.is_empty()
        && e.images_lost.is_none()
        && e.launching.is_none()
        && e.record.ended.is_none()
        && e.pid.is_none()
        && e.plan.is_none()
        && e.ends.is_empty()
        && e.hold.is_none()
        && !e.recorded
}

/// The entry of agent `agent_id`, which hostd just started, holds its first prompt and images.
/// While the launch gate was open the observer created no entry, so whatever is under this id
/// belongs to an agent before it: it moves to a key of its own (`rekey_in_book`), or is dropped
/// when it is a completely empty stub; this launch's entry is always new. When the ledger cannot
/// be saved everything is put back and `(false, None)` is returned.
fn record_into(b: &mut Book, agent_id: &str, mut k: FirstPrompt) -> (bool, Option<String>) {
    let mut dropped = None;
    let moved = match b.entries.get(agent_id) {
        None => None,
        Some(e) if is_empty_stub(e) => {
            dropped = b.entries.remove(agent_id);
            None
        }
        Some(_) => rekey_in_book(b, agent_id),
    };
    let e = b.entries.entry(agent_id.to_string()).or_insert_with(|| {
        // The card it becomes is complete from the start, from what the launch knows: an agent that
        // ends before the observer saw it is still a usable ended card.
        let mut e = k.card.take().unwrap_or_default();
        e.record.agent_id = agent_id.to_string();
        e
    });
    if k.text.is_some() || k.images.as_ref().map_or(true, |i| !i.is_empty()) {
        e.prompts = k.text.into_iter().collect();
        match k.images {
            Ok(kept) => {
                e.images = kept;
                e.images_lost = None;
            }
            Err(why) => {
                e.images = Vec::new();
                e.images_lost = Some(why);
            }
        }
        e.recorded = true;
    }
    e.file_seen = false;
    b.touch();
    if b.save(now_ms(), false, 0) {
        return (true, moved);
    }
    b.entries.remove(agent_id);
    if let Some(d) = dropped {
        b.entries.insert(agent_id.to_string(), d);
    }
    if let Some(new) = &moved {
        undo_rekey(b, agent_id, new);
    }
    (false, None)
}

/// A kept prompt not confirmed by the session file this long after it was sent (the agent idle)
/// holds the card for Continue.
const CONFIRM_MS: Millis = 2 * 60_000;
/// omp has this long to take the prompt call.
const HAND_OVER_TIMEOUT: Duration = Duration::from_secs(30);

/// What `Worker::launched` does about an ended fileless card a new agent was started for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchStep {
    Wait,
    /// Send the kept prompt through the link, once (recorded before the send).
    Send,
    /// The file still does not exist 2 minutes after the send while idle: hold for Continue.
    Unconfirmed,
    /// The session file proves the task was taken (or nothing was kept): the old card goes.
    Retire,
    /// The session file exists and its first message is not the kept prompt (or it has images).
    Settle,
}

/// The decision, pure. `idle_live`: live link and idle; `idle`: idle; `nothing`: no prompt and no
/// images were kept; `same`: the file's first user message is the kept prompt (text only).
fn launch_step(l: &ledger::Launching, now: Millis, file_exists: bool, idle_live: bool, idle: bool, nothing: bool, same: bool) -> LaunchStep {
    if file_exists {
        return if nothing || same { LaunchStep::Retire } else { LaunchStep::Settle };
    }
    if nothing || l.unconfirmed {
        return LaunchStep::Wait;
    }
    match l.sent_at {
        None if idle_live => LaunchStep::Send,
        Some(t) if idle && now - t >= CONFIRM_MS => LaunchStep::Unconfirmed,
        _ => LaunchStep::Wait,
    }
}

/// How a ledger entry stands to the live agent that has its id. herdr reuses agent ids at once, so
/// decisions compare omp SESSIONS (the session id and the session file path omp chose, known from
/// the bridge's hello before the file exists), never ids alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rel {
    /// The entry's own agent (or, for an ended entry, its omp back with the same session).
    Same,
    /// Another agent: it took the id of the entry's (ended or just dead) omp. The entry moves away.
    Other,
    /// An ended entry and an agent that claims its session but whose process is gone (a registry
    /// that still shows the dead omp): no verdict yet, nothing is touched.
    Stale,
}

/// The entry knows its omp session (an id or a file path).
fn has_identity(e: &Entry) -> bool {
    e.record.session_id.as_deref().is_some_and(|s| !s.is_empty()) || !e.record.session_file.is_empty()
}

/// A card whose omp never told its session (the agent ended before its hello: no session id, no
/// file) still needs the key its restart ticket, Continue and its ledger entry are found by. It is
/// `fresh:<agent id>:<start time>`: not an omp session id, so it matches no live agent, and
/// distinct for two launches that shared an agent id. The card stays fileless (its Continue starts
/// the kept prompt as a new session; `resume_without_file`).
fn fileless_key(rec: &mut crate::state::persist::ParkedRecord) {
    if rec.session_id.as_deref().is_none_or(str::is_empty) && rec.session_file.is_empty() {
        rec.session_id = Some(format!("fresh:{}:{}", rec.agent_id, rec.started_at.unwrap_or(0)));
    }
}

/// An ended card whose omp never wrote a session file (and may never have told its session): it
/// has nothing to resume; Continue starts its kept prompt as a new session.
pub(crate) fn is_fileless(rec: &crate::state::persist::ParkedRecord) -> bool {
    rec.ended.is_some() && rec.session_file.is_empty()
}

/// Positive proof that `a` is the live omp of `e`'s session. With a pid on Linux: its process
/// exists (`/proc`) and its command line names the session file (`--resume=<file>`; any live process
/// when the entry knows no file); a process that is gone is a NO, never a reason to fall back to a
/// bridge link. Without a pid, or off Linux: a live bridge link for that very session id.
fn proves_live(e: &Entry, a: &Agent) -> bool {
    let Some(o) = a.omp.as_ref() else { return false };
    #[cfg(target_os = "linux")]
    if let Some(pid) = o.pid {
        return herdr::cmdline(pid).is_some_and(|argv| {
            let file = e.record.session_file.as_str();
            file.is_empty() || argv.iter().any(|s| s.contains(file))
        });
    }
    o.link == LinkState::Live && o.session_id.is_some() && o.session_id == e.record.session_id
}

/// Evidence that the omp the board shows under `a`'s id is the one the launch behind `e` started,
/// not a predecessor's under a reused id (the board may be a cached view published before the
/// launch): on Linux with a pid, that process started at or after the launch (`/proc`); with no
/// pid (or off Linux), the board's herdr view was pulled at or after the launch (`published_at`).
/// An entry with no launch time has none.
fn launch_proof(e: &Entry, a: &Agent, published_at: Millis) -> bool {
    let Some(launch) = e.record.started_at else { return false };
    match (a.omp.as_ref().and_then(|o| o.pid), e.launch_boot.as_ref()) {
        (Some(pid), Some(stamp)) if cfg!(target_os = "linux") => started_with_launch(process_boot_started(pid), Some(stamp)),
        // No pid, off Linux, or an entry from before the boot stamp existed.
        _ => published_at >= launch,
    }
}

fn entry_vs_agent(e: &Entry, a: &Agent, published_at: Millis) -> Rel {
    if e.record.ended.is_some() {
        // Its omp ended. Only an omp with the SAME session that is PROVEN alive is its return: a
        // fresh session under a reused id is never its own return (and never clears its launch);
        // an entry that never learned its session (the agent died before the hello) is never
        // returned to; a session claimed by a process nobody can show alive is `Stale`.
        if !has_identity(e) || !runs(e, a) {
            Rel::Other
        } else if proves_live(e, a) {
            Rel::Same
        } else {
            Rel::Stale
        }
    } else if !has_identity(e) {
        // Knows no omp session. A launch-made entry (it has the launch's name and pane) is judged
        // only on a row that is shown to be NEWER than the launch (`launch_proof`): a cached
        // board still publishing a predecessor under the reused id — whatever its name or pane —
        // is `Stale`, nothing touched until a later tick. On a post-launch row the entry is the
        // agent's own when name and pane match, else the row is another agent's and the entry
        // moves aside with what it holds. An entry no launch made is never taken for the agent's
        // (it moves aside too), except an empty stub, which holds nothing.
        if launch_made(e) {
            if !launch_proof(e, a, published_at) {
                Rel::Stale
            } else if own_launch(e, a) {
                Rel::Same
            } else {
                Rel::Other
            }
        } else if is_empty_stub(e) {
            Rel::Same
        } else {
            Rel::Other
        }
    } else if e.pid.is_some() && e.pid == a.omp.as_ref().and_then(|o| o.pid) {
        Rel::Same // the same process, maybe in another session (a session switch)
    } else if runs(e, a) {
        Rel::Same // its session
    } else {
        Rel::Other
    }
}

/// The key an entry moves to: `<id>~<8 hex of its identity>` (its omp session id; else its
/// session file, name, end and last-seen times and prompts). Deterministic, so a re-key repeated
/// after a crash lands on the same key and never makes a second one.
fn rekey_name(id: &str, e: &Entry) -> String {
    let ident = match e.record.session_id.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => s.to_string(),
        None => format!("{}|{}|{}|{}|{:?}", e.record.session_file, e.record.name, e.record.ended.as_ref().map_or(0, |x| x.at), e.seen_at, e.prompts),
    };
    let h = ident.bytes().fold(0x811c_9dc5_u32, |h, b| (h ^ u32::from(b)).wrapping_mul(0x0100_0193));
    format!("{id}~{h:08x}")
}

/// Moves the entry `id` (ended or just dead) to its own key ([`rekey_name`]; `-<n>` if another
/// entry sits there). Its launch, kept prompt and images go with it.
fn rekey_in_book(b: &mut Book, id: &str) -> Option<String> {
    let e = b.entries.get(id)?;
    let base = rekey_name(id, e);
    let new = std::iter::once(base.clone()).chain((2..).map(|n| format!("{base}-{n}"))).find(|k| !b.entries.contains_key(k))?;
    let mut e = b.entries.remove(id)?;
    e.record.agent_id = new.clone();
    b.entries.insert(new.clone(), e);
    b.touch();
    Some(new)
}

/// The parked card `c` is the card of ledger entry `e` (the same omp session).
fn same_card(c: &crate::state::persist::ParkedRecord, e: &Entry) -> bool {
    c.ended.is_some()
        && ((c.session_id.is_some() && c.session_id == e.record.session_id) || (!c.session_file.is_empty() && c.session_file == e.record.session_file))
}

/// The ended entry whose pending launch the live agent `live_id` / `live_name` is the successor of
/// (its entry moved to `<live_id>~…` when the successor took the id).
fn launch_of_successor<'a>(entries: &'a std::collections::BTreeMap<String, Entry>, live_id: &str, live_name: &str) -> Option<(&'a String, &'a ledger::Launching)> {
    let prefix = format!("{live_id}~");
    entries.iter().filter(|(k, e)| k.starts_with(&prefix) && e.record.ended.is_some()).find_map(|(k, e)| e.launching.as_ref().filter(|l| !l.settled && l.name == live_name).map(|l| (k, l)))
}

/// A request addressed to the id of a live agent that is the successor of a pending launch (the
/// client may still hold the card's old id): `busy`, or, when the kept prompt was not confirmed,
/// the prompt is sent again. `None`: the id is nothing of the kind.
pub(crate) fn starting_again(ctx: &Ctx, agent_id: &str) -> Option<Result<RetryResult, ApiError>> {
    let snap = ctx.state.snapshot();
    let a = snap.agents.iter().find(|a| a.id == agent_id && a.parked.is_none() && a.kind == "omp")?;
    let book = ledger::book(&ctx.paths.home, &ctx.herdr_session);
    let (key, l) = {
        let b = ledger::open(&book);
        let (k, l) = launch_of_successor(&b.entries, agent_id, &a.name)?;
        (k.clone(), l.clone())
    };
    Some(match continue_route(Some(&l), &snap.agents, now_ms()) {
        ContinueRoute::Resend(_) if send_again(&book, &key) => Ok(RetryResult { started: true, via: RetryVia::Restore }),
        ContinueRoute::Resend(a) => Err(ApiError::new("busy", format!("It is starting again as {}", a.name)).retryable()),
        ContinueRoute::Busy(name) => Err(ApiError::new("busy", format!("It is starting again as {name}")).retryable()),
        ContinueRoute::Start => return None,
    })
}

/// Puts an entry moved by [`rekey_in_book`] back under `id` (its ledger save failed).
fn undo_rekey(b: &mut Book, id: &str, new: &str) {
    if let Some(mut e) = b.entries.remove(new) {
        e.record.agent_id = id.to_string();
        b.entries.insert(id.to_string(), e);
        b.touch();
    }
}

/// A live agent has the id of an ended card: its ledger entry (the ticket is keyed by omp
/// session, so it follows by itself) moves to a key of its own and is SAVED; only then does the
/// card in state.json move. A failed save puts the entry back and the next tick tries again; a
/// crash between the two is repaired by `stale` (a card under the old id whose entry lives under
/// `<id>~…` moves there: one card, never two). The live agent gets a fresh entry of its own.
fn rekey_ended(ctx: &Ctx, book: &Arc<Mutex<Book>>, id: &str, observer: Option<&mut std::collections::BTreeMap<String, Entry>>) -> Option<String> {
    let moved = rekey_ledger(book, id, observer)?;
    ctx.state.rekey_parked(id, &moved);
    info!(agent = %id, to = %moved, "agent ledger: another agent took the id of an ended card; the card moved to its own key");
    Some(moved)
}

/// The ledger's part of [`rekey_ended`]: moved and saved, or nothing changed. With `observer` (the
/// entries an observer tick saw) it goes on only if the entry of `id` is still what the tick saw,
/// and takes the moved entry out of that copy (it is gone from `id`).
fn rekey_ledger(book: &Arc<Mutex<Book>>, id: &str, observer: Option<&mut std::collections::BTreeMap<String, Entry>>) -> Option<String> {
    let mut b = ledger::open(book);
    if observer.as_deref().is_some_and(|before| changed_since(&b, before, [id])) {
        return None;
    }
    let moved = rekey_in_book(&mut b, id)?;
    if !b.save(now_ms(), false, 0) {
        undo_rekey(&mut b, id, &moved);
        warn!(agent = %id, "agent ledger: the ledger cannot be written; the ended card moves later");
        return None;
    }
    if let Some(before) = observer {
        before.remove(id);
    }
    Some(moved)
}

/// The FIRST user message of omp's session file at `path` is `text` (equal after trim) with
/// `images` images: the session took exactly that prompt first. Blocking read.
fn first_user_message_is(path: &std::path::Path, text: &str, images: usize) -> bool {
    use std::io::BufRead as _;
    let Ok(file) = std::fs::File::open(path) else { return false };
    let first = std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| l.contains(r#""role":"user""#))
        .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
        .find(|v| v["message"]["role"] == "user");
    let Some(v) = first else { return false };
    let (got, n) = match &v["message"]["content"] {
        Value::String(s) => (s.clone(), 0),
        Value::Array(blocks) => (
            blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<String>(),
            blocks.iter().filter(|b| b["type"] == "image").count(),
        ),
        _ => return false,
    };
    got.trim() == text.trim() && n == images
}

/// The old fileless card may be retired automatically only for a text-only kept prompt that the
/// new session's first user message equals exactly (after trim). A kept prompt with images is
/// never retired by itself: it cannot be matched by text alone, and what it holds is not to be
/// deleted on a guess (the card stays "started again as <name>", for the user to dismiss).
fn may_retire(path: &std::path::Path, text: &str, images: usize) -> bool {
    images == 0 && first_user_message_is(path, text, 0)
}

fn snapshot(a: &Agent, snap: &HostState, now: Millis) -> Option<crate::state::persist::ParkedRecord> {
    let ws = snap.workspaces.iter().find(|w| w.id == a.workspace_id);
    let worktree = ws.and_then(|w| {
        let wt = w.worktree.as_ref()?;
        Some(crate::state::persist::ParkedWorktree { path: wt.path.clone(), repo_root: w.repo.as_ref().map(|r| r.root.clone()).unwrap_or_default() })
    });
    crate::state::parked::record_from_agent(a, 0, now, worktree, ws.map(|w| w.cwd.clone()))
}

/// A record without what changes with every reply (cost, diff, line, turns, times): what is worth
/// a write when it changes.
fn stable(r: &crate::state::persist::ParkedRecord) -> crate::state::persist::ParkedRecord {
    crate::state::persist::ParkedRecord {
        cost: None,
        diff: None,
        line: None,
        turns: 0,
        last_turn_ended_at: None,
        parked_at: 0,
        archived_at: 0,
        ..r.clone()
    }
}

/// `HerdrHealth.cause` as the card's cause.
fn herdr_cause(h: &HerdrHealth) -> EndCause {
    match h.cause {
        Some(HerdrDownCause::Crashed) => EndCause::HerdrCrashed,
        Some(HerdrDownCause::NotAnswering) => EndCause::HerdrNotAnswering,
        Some(HerdrDownCause::Restart) => EndCause::HerdrRestart,
        Some(HerdrDownCause::Update) => EndCause::HerdrUpdate,
        Some(HerdrDownCause::Stopped) | None => EndCause::HerdrStopped,
    }
}

/// Why omp ended in a pane that is still there, from its exit record: `None` for a clean exit
/// (`/exit`, Ctrl+D: a close on purpose). A record older than the last sighting by
/// [`STALE_EXIT_MS`] was written by an earlier process: this one recorded nothing.
fn omp_cause(exit: Option<&detect::Exit>, seen_at: Millis) -> Option<(EndCause, String)> {
    let exit = exit.filter(|x| x.at.is_none_or(|at| at >= seen_at - STALE_EXIT_MS));
    match exit.map(|x| (x.kind, x.reason.as_str())) {
        Some((detect::ExitKind::Normal, _)) => None,
        Some((detect::ExitKind::Signal, reason)) => Some((EndCause::OmpKilled, format!("omp was stopped ({reason})"))),
        Some((detect::ExitKind::Fatal, _)) => Some((EndCause::OmpCrashed, "omp crashed".into())),
        Some((detect::ExitKind::ProcessExit, _)) => Some((EndCause::OmpCrashed, "omp exited unexpectedly".into())),
        None => Some((EndCause::OmpCrashed, "omp ended without a word (killed or crashed)".into())),
    }
}

/// What a card says about what the agent was doing.
fn doing(turn: EndedTurn, last: Option<&str>) -> String {
    match (turn, last) {
        (EndedTurn::Working, Some(a)) => format!("It was in {a}"),
        (EndedTurn::Working, None) => "It was working".into(),
        (EndedTurn::Replying, _) => "It was writing a reply".into(),
        (EndedTurn::Idle, _) => "It was idle".into(),
    }
}

/// What reading an ended agent's session file found.
enum Session {
    Read(detect::Ended),
    /// There is no such file; the check says whether it is certainly gone (its folder is there) or
    /// the place cannot be judged (an unmounted home, an unreadable folder).
    NotFound(FileCheck),
    Failed(std::io::Error),
}

/// Reads the session file of an ended agent off the async threads (`None`: the task failed).
async fn read_session(file: PathBuf) -> Option<Session> {
    let read = tokio::task::spawn_blocking(move || match detect::ended(&file) {
        Ok(x) => Session::Read(x),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Session::NotFound(check_file(&file)),
        Err(e) => Session::Failed(e),
    });
    match read.await {
        Ok(s) => Some(s),
        Err(e) => {
            warn!("reading the session of an ended agent: {e}");
            None
        }
    }
}

/// How an agent's pane left the board under the same herdr, no omp left to say why.
#[derive(Debug, PartialEq, Eq)]
enum PaneGone {
    /// herdr said the pane's process died (`pane.exited`).
    Died,
    /// Gone while TeleFlock watched it, with no such event: it was closed on purpose.
    Closed,
    /// Nobody saw it go.
    Missed,
}

/// `noticed`: when this process first saw the entry missing; `seen_at`: when it was last live.
fn pane_gone(died: bool, noticed: Millis, seen_at: Millis) -> PaneGone {
    if died {
        PaneGone::Died
    } else if noticed - seen_at > WATCH_GAP_MS {
        PaneGone::Missed
    } else {
        PaneGone::Closed
    }
}

/// omp was stopped by somebody (SIGTERM, SIGINT: `kill`, `pkill omp`) while herdr and the host
/// stayed up: an ended card with Continue, not relaunched by itself. (A SIGHUP is the terminal
/// going away, a SIGKILL or a crash leaves no word: those come back by themselves.)
fn stopped_on_purpose(cause: EndCause, reason: &str) -> bool {
    // omp words it in lower case ("omp was stopped (sigterm)"); match the signal in any case.
    let reason = reason.to_ascii_lowercase();
    cause == EndCause::OmpKilled && (reason.contains("sigterm") || reason.contains("sigint"))
}

/// The session file was written after the agent ended and by work of the omp that runs it now:
/// somebody went on in it (a resume by hand, then a turn), and the old plan no longer applies.
fn moved_on(mtime: Millis, end_at: Millis, started: Option<Millis>) -> bool {
    mtime > end_at + END_SLACK_MS && started.is_none_or(|s| mtime > s + STARTUP_WRITE_MS)
}

fn session_moved_on(file: &str, end_at: Millis, pid: Option<u32>) -> bool {
    let mtime = std::fs::metadata(file).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
    mtime.is_some_and(|m| moved_on(m.as_millis() as Millis, end_at, pid.and_then(process_started)))
}

/// When a process started (Linux `/proc/<pid>/stat` and the boot time).
#[cfg(target_os = "linux")]
fn process_started(pid: u32) -> Option<Millis> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Field 22, counted after the command's closing parenthesis (field 3 comes first).
    let ticks: i64 = stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()?;
    let boot: i64 = std::fs::read_to_string("/proc/stat").ok()?.lines().find_map(|l| l.strip_prefix("btime ")?.trim().parse().ok())?;
    // SAFETY: sysconf(3) with a constant name.
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    (hz > 0).then(|| boot * 1000 + ticks * 1000 / hz as i64)
}

#[cfg(not(target_os = "linux"))]
fn process_started(_pid: u32) -> Option<Millis> {
    None
}

/// When a process started on the boot's own clock: ms since boot (`/proc/<pid>/stat`, field 22,
/// in clock ticks). No wall clock and no `btime` (`/proc/stat` cuts it to whole seconds, which
/// can put a process up to a second before a wall-clock stamp taken just before it started).
#[cfg(target_os = "linux")]
fn process_boot_started(pid: u32) -> Option<i64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let ticks: i64 = stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()?;
    // SAFETY: sysconf(3) with a constant name.
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    (hz > 0).then(|| ticks * 1000 / hz as i64)
}

#[cfg(not(target_os = "linux"))]
fn process_boot_started(_pid: u32) -> Option<i64> {
    None
}

/// Clock ticks are 10 ms: a process that started this close before the launch stamp, by the two
/// clocks' resolution, still counts as started with it.
const START_SLACK_MS: i64 = 50;

/// A process that started (`started`, ms since boot) at or after the launch began (`launch`), on
/// the same boot. No stamp, another boot or no start time: no.
fn started_with_launch(started: Option<i64>, launch: Option<&ledger::BootStamp>) -> bool {
    let (Some(s), Some(l)) = (started, launch) else { return false };
    ledger::boot_id().as_deref() == Some(l.id.as_str()) && s + START_SLACK_MS >= l.ms
}

struct Worker {
    ctx: Arc<Ctx>,
    book: Arc<Mutex<Book>>,
    boot: Option<String>,
    /// Entries off the board: agent id → since.
    missing: HashMap<String, Millis>,
    /// Entries whose session file could not be read: agent id → when.
    unreadable: HashMap<String, Millis>,
    /// What the board last showed of each agent's omp session: an entry that ends before it
    /// learned its session takes it from here.
    rows: HashMap<String, Row>,
    /// Entries whose pane herdr said died (`pane.exited`), kept until the decision is made.
    died: HashSet<String>,
    /// When an agent's own settings were last read; its background jobs' running count.
    settings_at: HashMap<String, Millis>,
    jobs_seen: HashMap<String, u32>,
    /// When a live agent's bridge link went down (its facts stay as last seen live for a while).
    unlinked: HashMap<String, Millis>,
    /// Live agents whose plan was read from their session (a successor herdr or a person started).
    successors: HashSet<(String, u32)>,
    reports: herdr::Reports,
    keepalive: Option<bool>,
    /// The first turn whose images were kept last: agent id → (its rows, failed tries).
    kept: HashMap<String, (String, u8)>,
}

impl Worker {
    fn new(ctx: Arc<Ctx>) -> Self {
        let book = ledger::book(&ctx.paths.home, &ctx.herdr_session);
        Self {
            ctx,
            book,
            boot: ledger::boot_id(),
            missing: HashMap::new(),
            unreadable: HashMap::new(),
            rows: HashMap::new(),
            died: HashSet::new(),
            settings_at: HashMap::new(),
            jobs_seen: HashMap::new(),
            unlinked: HashMap::new(),
            successors: HashSet::new(),
            reports: herdr::Reports::default(),
            keepalive: None,
            kept: HashMap::new(),
        }
    }

    /// Keeps the images of the user rows `items` of agent `agent_id`'s first turn ([`images`]).
    /// `None`: nothing to do (the rows were kept already, or a try failed too often); the same
    /// rows are not read again and again.
    async fn keep_images(&mut self, agent_id: &str, omp_session: Option<&str>, items: &[Turn]) -> Option<Result<Vec<images::Kept>, String>> {
        let sig = items.iter().map(|t| format!("{}:{}", t.id, t.images.len())).collect::<Vec<_>>().join(",");
        let tries = match self.kept.get(agent_id) {
            Some((s, n)) if *s == sig => *n,
            _ => 0,
        };
        if tries >= KEEP_TRIES || (tries == 0 && self.kept.get(agent_id).is_some_and(|(s, _)| *s == sig)) {
            return None;
        }
        let refs: Vec<tf_proto::session::ImageRef> = items.iter().flat_map(|t| t.images.iter().cloned()).collect();
        let result = if refs.is_empty() {
            Ok(Vec::new())
        } else {
            let home = self.ctx.paths.home.clone();
            let sid = omp_session.map(str::to_string);
            tokio::task::spawn_blocking(move || images::keep_refs(&home, &refs, sid.as_deref())).await.unwrap_or_else(|e| Err(format!("keeping images: {e}")))
        };
        match &result {
            Ok(_) => {
                self.kept.insert(agent_id.to_string(), (sig, 0));
            }
            Err(why) => {
                warn!(agent = %agent_id, "agent ledger: the images of its first prompt are not kept yet: {why}");
                self.kept.insert(agent_id.to_string(), (sig, tries + 1));
            }
        }
        Some(result)
    }

    /// An ended fileless card a new agent was started for (`start_fresh`, on Continue). The new agent
    /// is started with no prompt; the kept prompt reaches it from here, **once**, through its link
    /// only (never typed into the pane), and only when it is live, idle and has no session file yet
    /// (`launch_step`). The send is recorded (`Launching::sent_at`) and saved BEFORE it is made, and
    /// is never repeated by itself, whatever restarts in between (the record is the ledger's, not
    /// a task's). If the session file still does not exist 2 minutes after the send while the agent
    /// is idle, the card waits for Continue ("couldn't confirm its first prompt was taken"), which
    /// sends again. When the file exists, the card goes only for a text-only kept prompt that the
    /// file's FIRST user message equals exactly after trim (`may_retire`), or when nothing was kept;
    /// on any other first message, and always when the kept prompt has images, the card stays as
    /// "started again as <name>", manual (Dismiss / Mark done), with the kept prompt and images.
    async fn launched(&mut self, snap: &HostState, now: Millis) {
        let ctx = self.ctx.clone();
        struct Cand {
            id: String,
            sid: Option<String>,
            l: ledger::Launching,
            text: Option<String>,
            kept: Vec<images::Kept>,
            file: Option<PathBuf>,
            idle_live: bool,
            idle: bool,
            omp_session: Option<String>,
        }
        let cands: Vec<Cand> = {
            let b = ledger::open(&self.book);
            b.entries
                .iter()
                .filter(|(_, e)| e.record.ended.is_some())
                .filter_map(|(id, e)| {
                    let l = e.launching.clone().filter(|l| !l.settled)?;
                    let a = snap.agents.iter().find(|a| a.parked.is_none() && a.kind == "omp" && a.name == l.name)?;
                    let o = a.omp.as_ref()?;
                    let omp_session = o.session_id.clone();
                    let idle = matches!(a.state, HerdrState::Idle | HerdrState::Done) && a.needs.is_none();
                    let live = o.link == LinkState::Live && omp_session.as_deref().and_then(|s| ctx.omp.session(s)).is_some_and(|s| s.link().0 == LinkState::Live);
                    Some(Cand {
                        id: id.clone(),
                        sid: e.record.session_id.clone(),
                        l,
                        text: e.first_prompt(),
                        kept: e.images.clone(),
                        file: session_file(a).map(PathBuf::from),
                        idle_live: idle && live,
                        idle,
                        omp_session,
                    })
                })
                .collect()
        };
        for c in cands {
            let Cand { id, sid, l, text, kept, file, idle_live, idle, omp_session } = c;
            let file_exists = file.as_ref().is_some_and(|f| f.exists());
            let nothing = text.is_none() && kept.is_empty();
            let same = if file_exists && !nothing {
                let (f, t, n) = (file.clone().unwrap_or_default(), text.clone().unwrap_or_default(), kept.len());
                tokio::task::spawn_blocking(move || may_retire(&f, &t, n)).await.unwrap_or(false)
            } else {
                false
            };
            match launch_step(&l, now, file_exists, idle_live, idle, nothing, same) {
                LaunchStep::Wait => {}
                LaunchStep::Retire => {
                    if let Err(err) = Store::new(&ctx.paths).forget(&ctx.herdr_session, &id) {
                        warn!(agent = %id, "dropping the ended agent's omp settings: {err}");
                    }
                    crate::autoanswer::forget(&ctx, &id);
                    if let (Some(r), Some(sid)) = (crate::recovery::get(), sid) {
                        r.close(&ctx.herdr_session, &sid, Some(AutoResumeKind::Restart));
                    }
                    ctx.state.unpark(&id);
                    ctx.state.persist_now();
                    let mut b = ledger::open(&self.book);
                    if b.entries.remove(&id).is_some() {
                        info!(agent = %id, "agent ledger: its new session took the kept prompt; the ended card and its kept prompt go");
                        b.touch();
                    }
                }
                LaunchStep::Settle => {
                    let name = l.name.clone();
                    let rec = {
                        let mut b = ledger::open(&self.book);
                        let Some(e) = b.entries.get_mut(&id) else { continue };
                        if let Some(l) = e.launching.as_mut() {
                            l.settled = true;
                        }
                        e.hold = Some(format!("started again as {name}, whose first message is not this prompt (or the prompt has images); the prompt is kept — dismiss this card, or continue it to start it again"));
                        if let Some(end) = e.record.ended.as_mut() {
                            end.reason = format!("started again as {name}");
                        }
                        b.touch();
                        b.entries.get(&id).map(|e| e.record.clone())
                    };
                    if let Some(rec) = rec {
                        ctx.state.park(rec);
                    }
                    info!(agent = %id, %name, "agent ledger: the new session's first message is not the kept prompt; the card stays, marked started again");
                }
                LaunchStep::Unconfirmed => {
                    self.unconfirmed(&id, &l.name, "couldn't confirm its first prompt was taken; continue it to send it again".into());
                }
                LaunchStep::Send => {
                    let Some(s) = omp_session.as_deref().and_then(|sid| ctx.omp.session(sid)) else { continue };
                    let home = ctx.paths.home.clone();
                    let images = match tokio::task::spawn_blocking(move || images::load_all(&home, &kept)).await {
                        Ok(Ok(i)) => i,
                        Ok(Err(why)) => {
                            self.unconfirmed(&id, &l.name, format!("couldn't send its kept prompt: {why}; dismiss this card, or continue it to start it again"));
                            continue;
                        }
                        Err(_) => continue,
                    };
                    // Recorded and saved first: a hostd that dies in the middle never sends again by itself.
                    let saved = {
                        let mut b = ledger::open(&self.book);
                        if let Some(l) = b.entries.get_mut(&id).and_then(|e| e.launching.as_mut()) {
                            l.sent_at = Some(now);
                        }
                        b.touch();
                        b.save(now, false, 0)
                    };
                    if !saved {
                        // Not recorded: not sent (sent_at is set again, and saved, on a later tick).
                        if let Some(l) = ledger::open(&self.book).entries.get_mut(&id).and_then(|e| e.launching.as_mut()) {
                            l.sent_at = None;
                        }
                        continue;
                    }
                    let contents: Vec<tf_collab::ImageContent> = images.into_iter().map(|i| tf_collab::ImageContent { kind: "image".into(), data: i.data, mime_type: i.mime }).collect();
                    let sent = tokio::time::timeout(HAND_OVER_TIMEOUT, s.prompt(&text.unwrap_or_default(), contents, Delivery::Auto)).await;
                    match sent {
                        Ok(Ok(())) => info!(agent = %id, name = %l.name, "agent ledger: its kept prompt was sent to the new session"),
                        Ok(Err(e)) => warn!(agent = %id, name = %l.name, "sending its kept prompt to the new session: {e}; not repeated by itself"),
                        Err(_) => warn!(agent = %id, name = %l.name, "sending its kept prompt to the new session: no answer; not repeated by itself"),
                    }
                }
            }
        }
    }

    /// The card of `id` waits for Continue, with `why`; the launch stays (Continue sends again).
    fn unconfirmed(&mut self, id: &str, name: &str, why: String) {
        let ctx = self.ctx.clone();
        {
            let mut b = ledger::open(&self.book);
            let Some(e) = b.entries.get_mut(id) else { return };
            if let Some(l) = e.launching.as_mut() {
                l.unconfirmed = true;
            }
            e.hold = Some(why.clone());
            b.touch();
        }
        warn!(agent = %id, %name, "{why}");
        ctx.state.record_activity(id, ActivityKind::Error, "Its first prompt was not confirmed".into(), Some(why));
    }

    async fn run(&mut self) {
        loop {
            self.tick().await;
            tokio::time::sleep(TICK).await;
        }
    }

    async fn tick(&mut self) {
        let ctx = self.ctx.clone();
        let now = now_ms();
        let before = ledger::open(&self.book).entries.clone();
        let (snap, published_at) = ctx.state.snapshot_at();
        self.note_rows(&snap);
        let health = crate::herdr_health::current(&ctx.herdr_session);
        let ids = ctx.state.agent_ids_in_use();
        let down = health.as_ref().is_some_and(HerdrHealth::panes_lost);
        if ids.is_some() && !down {
            self.observe(&snap, health.as_ref(), now, published_at, before).await;
        }
        self.ends(&snap, health.as_ref(), ids.is_some(), down, now).await;
        if ids.is_some() && !down {
            self.launched(&snap, now).await;
            self.tickets(&snap, health.as_ref(), now);
            herdr::report(&ctx, &snap.agents, &mut self.reports, now).await;
        }
        self.sync_keepalive();
        let mut book = ledger::open(&self.book);
        if book.is_dirty() {
            // An ended entry's card is in state.json before the ledger says the agent ended: a crash
            // in between leaves a card without an entry, never an entry without its card.
            self.ctx.state.persist_now();
        }
        book.save(now, true, SAVE_EVERY_MS);
    }

    /// Every live omp agent into the ledger.
    ///
    /// `before` is the ledger's entries as the tick saw them BEFORE it took the board snapshot
    /// `snap`: a commit for an agent is discarded when that agent's entry (or the entries of the
    /// same session under other ids it would take over) is not what the tick saw, since the
    /// snapshot may show the agent that had the id before; the tick's own re-key moves its copy.
    /// Changes to other agents' entries never discard it.
    async fn observe(&mut self, snap: &HostState, health: Option<&HerdrHealth>, now: Millis, published_at: Millis, mut before: std::collections::BTreeMap<String, Entry>) {
        let ctx = self.ctx.clone();
        let live: Vec<&Agent> = snap.agents.iter().filter(|a| a.parked.is_none() && a.kind == "omp" && session_file(a).is_some()).collect();
        self.unlinked.retain(|id, _| live.iter().any(|a| &a.id == id));
        for a in live {
            let Some(o) = &a.omp else { continue };
            let pid = o.pid;
            // herdr reuses agent ids at once: an agent that is not the ended card's own omp but has
            // its id (the successor of a Continue, or any new agent in that pane) gets an entry of
            // its own; the card and its entry move to a key of their own first.
            let rel = ledger::open(&self.book).entries.get(&a.id).map(|e| entry_vs_agent(e, a, published_at));
            match rel {
                Some(Rel::Other) => {
                    // Not retried below when the ledger cannot be saved: the next tick tries again.
                    if rekey_ended(&ctx, &self.book, &a.id, Some(&mut before)).is_none() {
                        continue;
                    }
                }
                // A registry still showing the dead omp: never its return, nothing is touched.
                Some(Rel::Stale) => continue,
                Some(Rel::Same) | None => {}
            }
            let (known, known_pid, known_argv, file_seen, recorded, waits) = {
                let b = ledger::open(&self.book);
                let e = b.entries.get(&a.id);
                // Seen for this very session file (a session switch starts over).
                let seen = e.is_some_and(|e| e.file_seen && Some(e.record.session_file.as_str()) == session_file(a));
                (e.is_some(), e.and_then(|e| e.pid), e.map(|e| e.argv.clone()).unwrap_or_default(), seen, e.is_some_and(|e| e.recorded), observer_waits(launch_in_flight(), e, a))
            };
            // A launch of an agent is in flight: no entry is created (nor a stub's filled) under an id
            // it may be about to take; this agent is looked at again on a later tick.
            if waits {
                continue;
            }
            let argv = if known && known_pid == pid { known_argv } else { pid.and_then(herdr::cmdline).unwrap_or_default() };
            // Until omp writes the session file (with its first reply) its prompts live only in
            // the replica: kept (text and images), so an agent that ends in its first turn can be
            // started again with them (Continue).
            let file_now = file_seen || session_file(a).is_some_and(|f| std::path::Path::new(f).exists());
            let first_turn: Option<Vec<Turn>> = if file_now {
                Some(Vec::new())
            } else {
                o.session_id.as_deref().and_then(|sid| ctx.omp.session(sid)).and_then(|s| s.history(None, 64)).map(|page| {
                    page.items
                        .into_iter()
                        .filter_map(|i| match i {
                            tf_proto::session::TranscriptItem::User(u) if !u.synthetic && (!u.text.trim().is_empty() || !u.images.is_empty()) => {
                                Some(Turn { id: u.id, text: u.text, images: u.images })
                            }
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                })
            };
            let captured = match first_turn.as_deref() {
                Some(items) if !items.is_empty() && !recorded => self.keep_images(&a.id, o.session_id.as_deref(), items).await,
                _ => None,
            };
            let ours = herdr::launched_by_us(&ctx.paths, &argv);
            let settings = (!known || self.settings_at.get(&a.id).is_none_or(|at| now - at >= SETTINGS_EVERY_MS)).then(|| {
                self.settings_at.insert(a.id.clone(), now);
                (Store::new(&ctx.paths).get(&ctx.herdr_session, &a.id).map(|r| r.omp), crate::autoanswer::own(&ctx, &a.id))
            });
            let linked = o.link == LinkState::Live;
            let running = o.jobs.as_ref().map_or(0, |j| j.running);
            let jobs = if linked && self.jobs_seen.get(&a.id) != Some(&running) {
                self.jobs_seen.insert(a.id.clone(), running);
                Some(if running == 0 { Vec::new() } else { job_labels(&ctx, o.session_id.as_deref()).await })
            } else {
                None
            };
            let Some(rec) = snapshot(a, snap, now) else { continue };
            let busy = active(a) || a.live.streaming;
            let tool = a.live.tool.as_ref().map(|t| crate::util::clip(&t.label, 100));
            let mut successor = None;
            let mut carried_ids = Vec::new();
            {
                let mut b = ledger::open(&self.book);
                // Entries of the same session under another agent id: the same agent under a new
                // id (brought back, herdr handed its pane over or restored it, a resume by hand).
                let others: Vec<String> = b.entries.iter().filter(|(id, e)| *id != &a.id && runs(e, a)).map(|(id, _)| id.clone()).collect();
                // This agent's entry (or one of those) changed since the tick's snapshot (a launch
                // recorded its entry, a re-key, Continue, Dismiss…) while it awaited, or one appeared
                // where there was none: what it saw is stale and must not be merged over it. Nothing
                // is written; the agent is observed afresh on the next tick. Changes to OTHER agents'
                // entries do not matter here.
                if changed_since(&b, &before, std::iter::once(a.id.as_str()).chain(others.iter().map(String::as_str))) {
                    self.settings_at.remove(&a.id);
                    self.jobs_seen.remove(&a.id);
                    self.kept.remove(&a.id);
                    continue;
                }
                let mut carried: Option<Entry> = None;
                for id in others {
                    if let Some(old) = b.entries.remove(&id) {
                        info!(old = %id, agent = %a.id, "agent ledger: same session under a new agent id");
                        if carried.as_ref().is_none_or(|c| c.plan.is_none()) {
                            carried = Some(old);
                        }
                        carried_ids.push(id);
                        b.touch();
                    }
                }
                let existed = b.entries.contains_key(&a.id);
                let e = b.entries.entry(a.id.clone()).or_insert_with(|| {
                    let mut c = carried.clone().unwrap_or_default();
                    c.record.ended = None;
                    c.hold = None;
                    c.launching = None;
                    c
                });
                if let Some(c) = &carried {
                    if existed && e.plan.is_none() {
                        e.plan = c.plan.clone();
                    }
                    // Another process runs it now and nothing was decided yet: read how it stood.
                    if c.pid != pid && e.plan.is_none() && !herdr::restoring(&argv) {
                        successor = Some(pid.unwrap_or(0));
                    }
                }
                let mut changed = false;
                macro_rules! set {
                    ($field:expr, $value:expr) => {{
                        let value = $value;
                        if $field != value {
                            $field = value;
                            changed = true;
                        }
                    }};
                }
                if e.record.ended.is_some() {
                    // Its very omp is back on the board (herdr answered again before it was
                    // replaced): not ended after all.
                    info!(agent = %a.id, "agent ledger: back without a relaunch");
                    ctx.state.unpark(&a.id);
                    if let (Some(r), Some(sid)) = (crate::recovery::get(), o.session_id.as_deref()) {
                        r.close(&ctx.herdr_session, sid, Some(AutoResumeKind::Restart));
                    }
                    e.plan = None;
                    e.hold = None;
                    e.launching = None;
                    changed = true;
                }
                let moved = stable(&e.record) != stable(&rec);
                e.record = rec;
                changed |= moved;
                set!(e.pane_id, a.pane_id.clone());
                set!(e.tab_id, a.tab_id.clone());
                set!(e.archived, a.archived);
                set!(e.pid, pid);
                set!(e.argv, argv.clone());
                set!(e.ours, ours);
                if let Some((s, aa)) = settings {
                    // Copies of what the stores keep; an agent whose stores have nothing (herdr's
                    // own restore started it under a new id) keeps the copies it brought along.
                    if let Some(s) = s {
                        set!(e.settings, s);
                    }
                    if aa.is_some() {
                        set!(e.auto_answer, aa);
                    }
                }
                set!(e.file_seen, file_now);
                if let Some(items) = first_turn {
                    if file_now {
                        // omp's file holds the turn now (written with its first reply).
                        set!(e.prompts, Vec::new());
                        set!(e.images, Vec::new());
                        set!(e.images_lost, None);
                        set!(e.recorded, false);
                    } else if !e.recorded && !items.is_empty() {
                        // Prompts typed in the omp TUI: only the replica knows them. What hostd
                        // recorded itself when it started the agent is never replaced by it, and
                        // an empty replica (the row not there yet) never clears anything.
                        set!(e.prompts, items.iter().filter(|t| !t.text.trim().is_empty()).map(|t| t.text.clone()).collect());
                        match captured {
                            Some(Ok(kept)) => {
                                set!(e.images, kept);
                                set!(e.images_lost, None);
                            }
                            // A copy already kept stands (the replica's own may be cut or not
                            // journaled yet); one that is not kept in full says so.
                            Some(Err(why)) if e.images.len() < items.iter().map(|t| t.images.len()).sum::<usize>() => {
                                set!(e.images_lost, Some(why));
                            }
                            _ => {}
                        }
                    }
                }
                // What it was doing comes from its bridge, whose link goes first when omp ends
                // (herdr's state changes later): while a link that was live is down, the facts
                // last seen live stand. An agent never linked has herdr's state only.
                if linked {
                    self.unlinked.remove(&a.id);
                } else if e.linked {
                    self.unlinked.entry(a.id.clone()).or_insert(now);
                }
                let frozen = !linked && e.linked && self.unlinked.get(&a.id).is_some_and(|at| now - at < LINK_GONE_MS);
                if !frozen {
                    set!(e.busy, busy);
                    e.replying = a.live.streaming && tool.is_none();
                    e.tool = tool;
                    e.subagents = o.subagents.as_ref().map_or(0, |s| s.live);
                    e.linked = linked;
                }
                if let Some(j) = jobs {
                    set!(e.jobs, j);
                }
                set!(e.boot, self.boot.clone());
                set!(e.herdr_pid, health.and_then(|h| h.pid));
                e.seen_at = now;
                if changed {
                    b.touch();
                }
            }
            self.missing.remove(&a.id);
            // Its own omp settings and decide-for-me policy follow it to its new id.
            for old in carried_ids {
                if let Err(err) = Store::new(&ctx.paths).rebind(&ctx.herdr_session, &old, &a.id, now) {
                    warn!(agent = %a.id, %old, "moving the agent's omp settings: {err}");
                }
                if let Some(p) = crate::autoanswer::own(&ctx, &old) {
                    if crate::autoanswer::own(&ctx, &a.id).is_none() {
                        crate::autoanswer::bind(&ctx, &a.id, &p);
                    }
                    crate::autoanswer::forget(&ctx, &old);
                }
            }
            if let Some(pid) = successor
                && self.successors.insert((a.id.clone(), pid))
            {
                self.read_successor(a).await;
            }
        }
    }

    /// Remembers what the board shows of each agent's omp session (see `rows`).
    fn note_rows(&mut self, snap: &HostState) {
        for a in snap.agents.iter().filter(|a| a.parked.is_none() && a.kind == "omp") {
            if let Some(mut r) = row_of(a, None) {
                // The process behind the row: read once per session (it is gone when the agent ends).
                if self.rows.get(&a.id).is_none_or(|old| !old.same_session(&r) || old.started.is_none()) {
                    r.started = a.omp.as_ref().and_then(|o| o.pid).and_then(process_boot_started);
                }
                note_row(&mut self.rows, &a.id, r);
            }
        }
        let b = ledger::open(&self.book);
        self.rows.retain(|id, _| b.entries.contains_key(id) || snap.agents.iter().any(|a| &a.id == id));
    }

    /// A live agent another process brought back (herdr's own restore, `omp --resume` by hand):
    /// how its session stood decides how it goes on, as for one TeleFlock brings back.
    async fn read_successor(&mut self, a: &Agent) {
        let Some(file) = session_file(a).map(PathBuf::from) else { return };
        let ended = match tokio::task::spawn_blocking(move || detect::ended(&file)).await {
            Ok(Ok(e)) => e,
            Ok(Err(e)) => return warn!(agent = %a.id, "reading the session of a successor: {e}"),
            Err(e) => return warn!(agent = %a.id, "reading the session of a successor: {e}"),
        };
        let mut b = ledger::open(&self.book);
        let Some(e) = b.entries.get_mut(&a.id) else { return };
        let at = ended.root.exit.as_ref().and_then(|x| x.at).unwrap_or(e.seen_at);
        let reason = omp_cause(ended.root.exit.as_ref(), e.seen_at).map_or_else(|| "its previous process ended".to_string(), |(_, r)| r);
        let plan = decide::decide(&ended, &Seen { busy: e.busy, jobs: e.jobs.clone() }, at, &reason, Can::ALL);
        if plan.any() {
            info!(agent = %a.id, turn = ?plan.turn, "agent ledger: a successor process runs its session; it goes on by its plan");
            e.end = Some(ledger::End { at, reason, busy: e.busy, jobs: e.jobs.clone() });
            e.plan = Some(plan);
            b.touch();
        }
    }

    /// Entries whose omp is gone: ended cards (or a close on purpose).
    async fn ends(&mut self, snap: &HostState, health: Option<&HerdrHealth>, board: bool, down: bool, now: Millis) {
        let ctx = self.ctx.clone();
        let live: HashSet<&str> = snap.agents.iter().filter(|a| a.parked.is_none()).map(|a| a.id.as_str()).collect();
        if board && !down {
            self.stale(snap).await;
        }
        let candidates: Vec<(String, Entry)> = {
            let b = ledger::open(&self.book);
            b.entries.iter().filter(|(id, e)| e.record.ended.is_none() && (down || !live.contains(id.as_str()))).map(|(id, e)| (id.clone(), e.clone())).collect()
        };
        for (id, mut e) in candidates {
            // An entry that never learned its session takes it from the board's last row of its
            // agent: only an agent that showed no session anywhere is fileless.
            learn_session(&mut e.record, e.launch_boot.as_ref(), self.rows.get(&id));
            // A parked card owns it now (Mark done closed its pane, it moved to another host).
            if ctx.state.parked(&id).is_some_and(|p| p.ended.is_none()) {
                self.forget(&id, "parked");
                continue;
            }
            // Another live agent runs its session: the next sighting moves the entry over.
            if !down && snap.agents.iter().any(|a| a.parked.is_none() && runs(&e, a)) {
                continue;
            }
            if being_relaunched(&e.record.session_file) {
                continue;
            }
            // A live handoff kept every pane process: its agents show up under new ids in a moment.
            if health.is_some_and(|h| h.kept_panes && h.is_up() && now - h.since < HANDOFF_GRACE_MS && h.pid != e.herdr_pid) {
                continue;
            }
            let since = *self.missing.entry(id.clone()).or_insert(now);
            // The exit event is remembered for good: the decision below can wait (an unreadable
            // session), and the event must not age out meanwhile.
            if pane_died(&ctx.herdr_session, &e.pane_id) {
                self.died.insert(id.clone());
            }
            if ledger::alive(e.pid, &e.argv) == Some(true) {
                // Its omp still runs: the board lags, or herdr hands its pane over.
                continue;
            }
            if !down && now - since < if board { GONE_GRACE_MS } else { UNREACHABLE_MS } {
                continue;
            }
            if self.unreadable.get(&id).is_some_and(|at| now - at < 30_000) {
                continue;
            }
            let file = PathBuf::from(&e.record.session_file);
            // omp writes a session's file with its first reply: a first turn cut off has none,
            // and comes back as a new session with its prompts (no tool call ran yet).
            let mut fresh = false;
            let ended = match read_session(file).await {
                Some(Session::Read(x)) => {
                    // omp writes the file at its SIGHUP exit too, after hostd's last sighting:
                    // an agent whose file exists when its end is planned is never fileless.
                    mark_file_seen(&self.book, &id);
                    x
                }
                Some(Session::NotFound(_)) if !e.file_seen => {
                    fresh = true;
                    detect::Ended::default()
                }
                Some(Session::NotFound(FileCheck::Missing)) => {
                    self.forget(&id, "its session file is gone");
                    continue;
                }
                Some(Session::NotFound(check)) => {
                    // Its folders are gone too, or empty (an unmounted home): that is no deletion.
                    warn!(agent = %id, file = %e.record.session_file, ?check, "the session of an ended agent cannot be found; it is kept");
                    self.unreadable.insert(id.clone(), now);
                    continue;
                }
                Some(Session::Failed(err)) => {
                    warn!(agent = %id, file = %e.record.session_file, "reading the session of an ended agent: {err}");
                    self.unreadable.insert(id.clone(), now);
                    continue;
                }
                None => continue,
            };
            let exit_at = ended.root.exit.as_ref().and_then(|x| x.at).filter(|at| *at >= e.seen_at - STALE_EXIT_MS);
            let mut hold = None;
            let (cause, reason, at) = if down {
                let h = health.expect("down comes from herdr health");
                (herdr_cause(h), h.reason().unwrap_or("herdr stopped").to_string(), h.down_at.unwrap_or(now))
            } else if e.boot.is_some() && e.boot != self.boot {
                (EndCause::Reboot, "the host restarted".to_string(), exit_at.unwrap_or(e.seen_at))
            } else if !board {
                (EndCause::HerdrStopped, "herdr stopped".to_string(), e.seen_at)
            } else if health.and_then(|h| h.pid).is_some_and(|p| e.herdr_pid.is_some_and(|q| q != p)) {
                (EndCause::HerdrRestart, "herdr was restarted".to_string(), exit_at.unwrap_or(e.seen_at))
            } else {
                let pane_there = snap.workspaces.iter().flat_map(|w| w.tabs.iter()).flat_map(|t| t.panes.iter()).any(|p| p.id == e.pane_id);
                if pane_there {
                    match omp_cause(ended.root.exit.as_ref(), e.seen_at) {
                        Some((cause, reason)) => {
                            hold = stopped_on_purpose(cause, &reason).then(|| format!("{reason}; continue it when you are ready"));
                            (cause, reason, exit_at.unwrap_or(now))
                        }
                        None => {
                            self.forget(&id, "omp exited cleanly");
                            continue;
                        }
                    }
                } else {
                    match pane_gone(self.died.contains(&id) || pane_died(&ctx.herdr_session, &e.pane_id), since, e.seen_at) {
                        PaneGone::Closed => {
                            // Its pane was closed under the same herdr while TeleFlock watched it,
                            // and herdr said nothing died: on purpose.
                            self.forget(&id, "its pane was closed");
                            continue;
                        }
                        PaneGone::Died => (EndCause::PaneClosed, "its herdr pane died".to_string(), exit_at.unwrap_or(now)),
                        PaneGone::Missed => {
                            // Nobody saw it go (TeleFlock was not running, or herdr's event was
                            // missed): losing the agent would cost more than a card to dismiss.
                            hold = Some("its herdr pane went while TeleFlock was not watching; continue it when you are ready".to_string());
                            (EndCause::PaneClosed, "its herdr pane is gone".to_string(), exit_at.unwrap_or(now))
                        }
                    }
                }
            };
            let mut plan = decide::decide(&ended, &Seen { busy: e.busy, jobs: e.jobs.clone() }, at, &reason, Can::ALL);
            if fresh {
                plan = fresh_plan(&e);
            }
            self.end(&id, e, ended.session_id, cause, reason, at, plan, hold);
        }
        self.plan_ended().await;
    }

    /// Ended cards made at once when herdr went down ([`herdr_down`]) get their plan from their
    /// session, and the card what it was doing.
    async fn plan_ended(&mut self) {
        let ctx = self.ctx.clone();
        let unplanned: Vec<(String, Entry)> = {
            let b = ledger::open(&self.book);
            b.entries.iter().filter(|(_, e)| e.record.ended.is_some() && e.plan.is_none()).map(|(id, e)| (id.clone(), e.clone())).collect()
        };
        for (id, mut e) in unplanned {
            learn_session(&mut e.record, e.launch_boot.as_ref(), self.rows.get(&id));
            let Some(ended) = e.record.ended.clone() else { continue };
            let file = PathBuf::from(&e.record.session_file);
            let plan = match read_session(file).await {
                Some(Session::Read(x)) => {
                    mark_file_seen(&self.book, &id);
                    decide::decide(&x, &Seen { busy: e.busy, jobs: e.jobs.clone() }, ended.at, &ended.reason, Can::ALL)
                }
                Some(Session::NotFound(_)) if !e.file_seen => fresh_plan(&e),
                Some(Session::NotFound(FileCheck::Missing)) => {
                    // Its session was deleted: on purpose, as for an agent that ends by itself.
                    if ctx.state.parked(&id).is_some_and(|p| p.ended.is_some()) {
                        ctx.state.unpark(&id);
                    }
                    self.forget(&id, "its session file is gone");
                    continue;
                }
                Some(Session::NotFound(check)) => {
                    // Its folders are gone too, or empty (an unmounted home): no deletion; the card
                    // stays, and Continue says what is wrong.
                    warn!(agent = %id, file = %e.record.session_file, ?check, "the session of an ended agent cannot be found; its card stays");
                    Plan::idle()
                }
                Some(Session::Failed(err)) => {
                    warn!(agent = %id, file = %e.record.session_file, "reading the session of an ended agent: {err}");
                    Plan::idle()
                }
                None => continue,
            };
            info!(agent = %id, name = %e.record.name, turn = ?plan.turn, restore_turn = plan.restore_turn, retry = plan.retry, note = plan.note.is_some(), fresh = plan.fresh, "ended agent: plan decided");
            let mut rec = e.record.clone();
            rec.ended = Some(AgentEnded { turn: plan.turn, last_action: plan.last_action.clone(), ..ended });
            if ctx.state.parked(&id).is_some_and(|p| p.ended.is_some()) {
                ctx.state.park(rec.clone());
            }
            let mut b = ledger::open(&self.book);
            if let Some(entry) = b.entries.get_mut(&id) {
                entry.record = rec;
                entry.plan = Some(plan);
                b.touch();
            }
        }
    }

    /// Ended entries whose card is not in state.json (a lost or truncated store, a prune, a
    /// dismissal that did not reach the ledger) and that no live agent runs again. The ledger is
    /// the second copy of such a card: the entry goes only when its session file is certainly
    /// gone (deleted on purpose) or the card went to Done; in every other case the card is made
    /// again from the entry's record, and it can be dismissed or continued.
    async fn stale(&mut self, snap: &HostState) {
        let ctx = self.ctx.clone();
        let in_use = ctx.state.agent_ids_in_use().unwrap_or_default();
        let ended: Vec<(String, Entry)> = {
            let b = ledger::open(&self.book);
            b.entries.iter().filter(|(_, e)| e.record.ended.is_some() && !snap.agents.iter().any(|a| a.parked.is_none() && runs(e, a))).map(|(id, e)| (id.clone(), e.clone())).collect()
        };
        let mut gone = Vec::new();
        for (id, e) in ended {
            match ctx.state.parked(&id) {
                Some(p) if p.ended.is_some() => {}
                Some(_) => self.forget(&id, "its card went to Done"),
                // Being resumed: the entry follows the agent to its new id in a moment.
                None if in_use.contains(&id) => {}
                None => gone.push((id, e)),
            }
        }
        for (id, e) in gone {
            // A re-key saved the ledger and died before moving the card: the card still sits under
            // the old id (`<id>~…` is the entry's key). It moves there, never a second card.
            if let Some((base, _)) = id.split_once('~')
                && ctx.state.parked(base).is_some_and(|c| same_card(&c, &e))
            {
                ctx.state.rekey_parked(base, &id);
                info!(agent = %id, from = %base, "agent ledger: the ended card finished its move to its own key");
                continue;
            }
            let file = e.record.session_file.clone();
            let check = tokio::task::spawn_blocking(move || check_file(std::path::Path::new(&file))).await.ok();
            if session_deleted(e.file_seen, check.as_ref()) {
                self.forget(&id, "its session file is gone");
                continue;
            }
            let mut rec = e.record.clone();
            rec.agent_id = id.clone();
            warn!(agent = %id, name = %rec.name, "an ended agent's card was missing; made again from the ledger");
            ctx.state.park(rec);
        }
    }

    fn forget(&mut self, id: &str, why: &str) {
        let mut b = ledger::open(&self.book);
        if b.entries.remove(id).is_some() {
            info!(agent = %id, "agent ledger: forgotten ({why})");
            b.touch();
        }
        self.missing.remove(id);
        self.died.remove(id);
    }

    /// The ended card of entry `id`, with its plan.
    #[allow(clippy::too_many_arguments)]
    fn end(&mut self, id: &str, e: Entry, header_id: Option<String>, cause: EndCause, reason: String, at: Millis, plan: Plan, hold: Option<String>) {
        let ctx = self.ctx.clone();
        self.missing.remove(id);
        self.died.remove(id);
        let mut rec = e.record.clone();
        rec.agent_id = id.to_string();
        rec.parked_at = at;
        if rec.session_id.is_none() {
            rec.session_id = header_id;
        }
        let name = rec.name.clone();
        if e.archived {
            // Marked done while it still had its pane: it waits in Done like any parked agent.
            rec.archived_at = at;
            ctx.state.park(rec);
            ctx.state.record_activity_as(id, &name, ActivityKind::Stopped, format!("{name} ended ({reason})"), Some("It was marked done; resume it from Done".into()));
            self.forget(id, "marked done before it ended");
            return;
        }
        fileless_key(&mut rec);
        rec.ended = Some(AgentEnded { at, cause, reason: reason.clone(), turn: plan.turn, last_action: plan.last_action.clone() });
        info!(agent = %id, %name, ?cause, %reason, turn = ?plan.turn, restore_turn = plan.restore_turn, retry = plan.retry, note = plan.note.is_some(), "agent ended; its card stays until it is back");
        ctx.state.park(rec.clone());
        let held;
        {
            let mut b = ledger::open(&self.book);
            let entry = b.entries.entry(id.to_string()).or_insert(e);
            entry.end = Some(ledger::End { at, reason: reason.clone(), busy: entry.busy, jobs: entry.jobs.clone() });
            entry.record = rec;
            entry.plan = Some(plan.clone());
            entry.hold = hold.clone();
            entry.note_end(at, now_ms());
            held = restart_hold(entry, now_ms()).is_some();
            b.touch();
        }
        let auto = crate::recovery::get().is_none_or(|r| r.enabled()) && !held;
        let next = if auto { "it comes back by itself once herdr runs" } else { "Continue brings it back" };
        ctx.state.record_activity_as(id, &name, ActivityKind::Stopped, format!("{name} ended ({reason})"), Some(format!("{}; {next}", doing(plan.turn, plan.last_action.as_deref()))));
        // herdr's own outage has its notification (`crate::herdr_health`); one agent's end has its own.
        if matches!(cause, EndCause::OmpKilled | EndCause::OmpCrashed | EndCause::PaneClosed) {
            ctx.state.broadcast_notification(Notification {
                id: new_id("ntf"),
                at: now_ms(),
                kind: NotifyKind::Info,
                agent_id: id.to_string(),
                title: format!("{name} ended: {reason}"),
                body: if auto { "TeleFlock brings it back in a moment.".into() } else { "Continue brings it back.".into() },
                request_id: None,
                actions: Vec::new(),
            });
        }
    }

    /// `restart` tickets: every ended card, and every live agent whose plan is still to run.
    fn tickets(&mut self, snap: &HostState, health: Option<&HerdrHealth>, now: Millis) {
        let Some(r) = crate::recovery::get() else { return };
        let ctx = &self.ctx;
        let session = &ctx.herdr_session;
        let grace_until = health.filter(|h| h.herdr_resumes).map_or(now, |h| (h.since + HERDR_RESUME_GRACE_MS).max(now));
        let mut drop_plans = Vec::new();
        for a in &snap.agents {
            let Some(o) = &a.omp else { continue };
            let Some(sid) = o.session_id.as_deref() else { continue };
            let (planned, pending, hold, end_at) = {
                let b = ledger::open(&self.book);
                let e = b.entries.get(&a.id);
                let plan = e.and_then(|e| e.plan.clone());
                // What keeps an ended card's restart for Continue: why it ended, or a crash loop.
                let hold = e.and_then(|e| restart_hold(e, now));
                (plan.is_some(), plan.filter(Plan::any), hold, e.and_then(|e| e.end.as_ref().map(|x| x.at)))
            };
            let ended_card = a.parked.as_ref().is_some_and(|p| p.moved.is_none() && p.ended.is_some());
            if ended_card && ctx.state.parked(&a.id).is_none() {
                // The board still shows it, but it was brought back (or dismissed) just now.
                continue;
            }
            let (reason, at, subs) = match (&a.parked, &pending) {
                (Some(p), _) if p.moved.is_none() => match &p.ended {
                    // Its plan is still being read from its session (herdr just went down).
                    Some(_) if !planned && ledger::open(&self.book).entries.contains_key(&a.id) => continue,
                    Some(ended) => (ended.reason.clone(), grace_until, pending.map(|p| p.restore_subagents).unwrap_or_default()),
                    None => continue,
                },
                (None, Some(plan)) => {
                    if r.ticket(session, sid).is_none() {
                        // It went on by other means (a prompt, the TUI): nothing left to do.
                        let works = a.state == HerdrState::Working && o.turn_started_at.is_some_and(|t| now - t >= 3_000);
                        let moved = end_at.zip(o.session_file.as_deref()).is_some_and(|(end, file)| session_moved_on(file, end, o.pid));
                        if works || moved {
                            drop_plans.push(a.id.clone());
                            continue;
                        }
                    }
                    ("its previous process ended unexpectedly".to_string(), now, plan.restore_subagents.clone())
                }
                _ => continue,
            };
            let init = TicketInit {
                reason,
                session_file: o.session_file.clone().filter(|f| !f.is_empty()),
                root: true,
                subagent_ids: subs,
                resume_at: Some(at),
                ..Default::default()
            };
            if ended_card {
                // Whatever ticket the card had (a limit's) makes way: its omp is gone, so only a
                // relaunch brings it back.
                r.open_restart(session, sid, init, hold);
            } else if r.ticket(session, sid).is_none() {
                r.open(session, AutoResumeKind::Restart, sid, init);
            }
        }
        if !drop_plans.is_empty() {
            let mut b = ledger::open(&self.book);
            for id in drop_plans {
                if let Some(e) = b.entries.get_mut(&id) {
                    info!(agent = %id, "agent ledger: it went on by other means; its plan is dropped");
                    e.plan = None;
                    b.touch();
                }
            }
        }
    }

    /// The keepalive (`automations/systemd.rs`) follows whether the ledger has agents.
    fn sync_keepalive(&mut self) {
        let want = wants_keepalive(&self.ctx.paths.home);
        if self.keepalive == Some(want) {
            return;
        }
        self.keepalive = Some(want);
        if let Some(a) = crate::automations::get() {
            tokio::spawn(async move { a.sync_keepalive().await });
        }
    }
}

/// The running bash / eval jobs of a session (`jobs.list` through its bridge): their handles die
/// with omp, so a note names them.
async fn job_labels(ctx: &Ctx, session_id: Option<&str>) -> Vec<String> {
    let Some(sid) = session_id.filter(|s| ctx.bridge.by_session(s).is_some_and(|b| b.caps.jobs)) else { return Vec::new() };
    match tokio::time::timeout(Duration::from_secs(5), crate::ops::jobs::list(&ctx.bridge, sid, &[], false)).await {
        Ok(Ok(view)) => view
            .jobs
            .iter()
            .filter(|j| j.status == tf_proto::jobs::JobStatus::Running && j.kind != "task")
            .map(|j| crate::util::clip(&format!("{}: {}", j.kind, j.label), 120))
            .collect(),
        _ => Vec::new(),
    }
}

/// The host wants tf-hostd started at boot for its agents: auto-resume is on, the user did not turn
/// off "Bring agents back after a reboot" (it installs a boot service), and the ledger holds agents
/// to bring back (`automations::Automations::sync_keepalive`).
pub fn wants_keepalive(home: &std::path::Path) -> bool {
    keepalive_wanted(crate::recovery::get().map(|r| (r.enabled(), r.bring_back())), || ledger::any(home))
}

/// [`wants_keepalive`] from the settings (`None`: not loaded yet, both default on).
fn keepalive_wanted(settings: Option<(bool, bool)>, has_agents: impl FnOnce() -> bool) -> bool {
    let (enabled, bring_back) = settings.unwrap_or((true, true));
    enabled && bring_back && has_agents()
}

/// Writes every loaded ledger book now, off the async threads, waiting at most `limit` (daemon
/// shutdown: the workers' last saves run detached and may not finish before the process exits).
pub async fn flush_ledger(home: &std::path::Path, limit: Duration) {
    let home = home.to_path_buf();
    let saving = tokio::task::spawn_blocking(move || ledger::save_all(&home, now_ms()));
    if tokio::time::timeout(limit, saving).await.is_err() {
        warn!("agent ledger: the final save did not finish in {limit:?}");
    }
}

#[cfg(test)]
mod keepalive_tests {
    use super::*;

    #[test]
    fn the_boot_service_needs_the_users_consent_and_agents() {
        assert!(keepalive_wanted(None, || true), "defaults: on");
        assert!(keepalive_wanted(Some((true, true)), || true));
        assert!(!keepalive_wanted(Some((true, false)), || true), "Bring agents back after a reboot: off");
        assert!(!keepalive_wanted(Some((false, true)), || true), "auto-resume off: nothing to bring back by itself");
        assert!(!keepalive_wanted(Some((true, true)), || false), "no agents to bring back");
        assert!(!keepalive_wanted(Some((true, false)), || unreachable!("settings decide first")));
    }

    #[tokio::test]
    async fn the_final_save_is_awaited() {
        let dir = tempfile::tempdir().unwrap();
        let b = ledger::book(dir.path(), "default");
        {
            let mut g = ledger::open(&b);
            g.entries.insert("t1".into(), ledger::Entry { record: crate::state::persist::ParkedRecord { agent_id: "t1".into(), session_file: "/s/a.jsonl".into(), ..Default::default() }, ..Default::default() });
            g.touch();
        }
        flush_ledger(dir.path(), Duration::from_secs(5)).await;
        assert_eq!(ledger::sessions(dir.path()), ["default"]);
    }
}

/// herdr's server went away with every pane process (`crate::herdr_health`, right before it drops
/// the board's herdr view, `StateHandle::herdr_gone`): every live omp agent the ledger holds
/// becomes its ended card at once, so the board's next update swaps the dead cards for ended ones
/// and none disappears in between. Their plans follow from their sessions (the worker).
pub fn herdr_down(ctx: &Ctx, h: &HerdrHealth) {
    let book = ledger::book(&ctx.paths.home, &ctx.herdr_session);
    let at = h.down_at.unwrap_or_else(now_ms);
    let reason = h.reason().unwrap_or("herdr stopped").to_string();
    let cause = herdr_cause(h);
    // What each was doing right now (the ledger's copy is up to one pass old).
    let live: HashMap<String, Agent> = ctx.state.snapshot().agents.into_iter().filter(|a| a.parked.is_none()).map(|a| (a.id.clone(), a)).collect();
    let mut b = ledger::open(&book);
    let mut done = Vec::new();
    for (id, e) in b.entries.iter_mut() {
        let Some(a) = live.get(id) else { continue };
        if e.record.ended.is_some() || ctx.state.parked(id).is_some() {
            continue;
        }
        let mut rec = e.record.clone();
        rec.agent_id = id.clone();
        rec.parked_at = at;
        if e.archived {
            // Marked done while it still had its pane: it waits in Done like any parked agent.
            rec.archived_at = at;
            ctx.state.park(rec);
            done.push(id.clone());
            continue;
        }
        // A session this worker never learned is taken from its rows when the plan is made
        // (`plan_ended`), judged there against the first sighting of that session and the launch.
        fileless_key(&mut rec);
        // The bridge's facts (its tool call, a reply being written) are gone with its link: the
        // last ones seen live stand.
        e.busy = e.busy || active(a) || a.live.streaming;
        if a.omp.as_ref().is_some_and(|o| o.link == LinkState::Live) {
            e.tool = a.live.tool.as_ref().map(|t| crate::util::clip(&t.label, 100));
            e.replying = a.live.streaming && a.live.tool.is_none();
        }
        let turn = if e.replying {
            EndedTurn::Replying
        } else if e.busy {
            EndedTurn::Working
        } else {
            EndedTurn::Idle
        };
        rec.ended = Some(AgentEnded { at, cause, reason: reason.clone(), turn, last_action: e.tool.clone() });
        ctx.state.park(rec.clone());
        ctx.state.record_activity_as(id, &rec.name, ActivityKind::Stopped, format!("{} ended ({reason})", rec.name), Some("It comes back once herdr runs again".into()));
        e.end = Some(ledger::End { at, reason: reason.clone(), busy: e.busy, jobs: e.jobs.clone() });
        e.record = rec;
        e.plan = None;
        e.hold = None;
        e.note_end(at, now_ms());
    }
    for id in &done {
        b.entries.remove(id);
    }
    b.touch();
    b.save(now_ms(), false, SAVE_EVERY_MS);
    info!(session = %ctx.herdr_session, %reason, "herdr went down: its agents' cards stay as ended cards");
}

/// The plan of an agent whose first turn ended before omp wrote its session: a new session with
/// its prompts (see [`Plan::fresh`]).
fn fresh_plan(e: &Entry) -> Plan {
    let turn = if e.replying {
        EndedTurn::Replying
    } else if e.busy {
        EndedTurn::Working
    } else {
        EndedTurn::Idle
    };
    Plan { turn, last_action: e.tool.clone(), fresh: true, ..Plan::idle() }
}

/// Its session file exists: the agent is not fileless, whatever the last sighting said. (The kept
/// prompt stays: only the observer drops it, for an agent that is live and has its file.)
fn mark_file_seen(book: &Arc<Mutex<Book>>, id: &str) {
    let mut b = ledger::open(book);
    if let Some(e) = b.entries.get_mut(id).filter(|e| !e.file_seen) {
        e.file_seen = true;
        b.touch();
    }
}

/// Why the restart ticket of an ended card waits for Continue instead of running by itself: the
/// reason it was ended with (stopped on purpose, lost unseen), an omp that never saved its session
/// (its first turn was cut off: it is never started again by itself), else a crash loop.
fn restart_hold(e: &Entry, now: Millis) -> Option<String> {
    e.hold
        .clone()
        .or_else(|| (e.record.ended.is_some() && !e.file_seen).then(|| e.fresh_hold()))
        .or_else(|| e.crash_looping(now).then(|| CRASH_LOOP_HOLD.to_string()))
}

/// An ended entry's card is missing from state.json: the entry itself is only dropped when omp had
/// written the session file once and that file is certainly gone now (its folder is there, see
/// `state::parked::check_file`). A first turn that never reached the file, an unmounted home, an
/// unreadable folder: none of those is a deletion.
fn session_deleted(file_seen: bool, check: Option<&FileCheck>) -> bool {
    file_seen && matches!(check, Some(FileCheck::Missing))
}

/// What the ledger's launch marker says about the new session of an ended card (see
/// [`start_fresh`]).
enum Launched<'a> {
    /// No earlier launch, or one that never showed up on the board for [`LAUNCH_SETTLE_MS`].
    No,
    /// An agent of that name runs: the earlier launch went through.
    Adopt(&'a Agent),
    /// Started a moment ago and not on the board yet.
    Wait,
}

/// What Continue on an ended fileless card does about the launch it may have made before.
enum ContinueRoute<'a> {
    /// No launch pending: start the agent.
    Start,
    /// A start is pending (its agent lives, or was started a moment ago): `busy`.
    Busy(String),
    /// Its kept prompt was not confirmed: send it again to that agent (`send_again`), else `busy`.
    Resend(&'a Agent),
}

fn continue_route<'a>(launching: Option<&ledger::Launching>, agents: &'a [Agent], now: Millis) -> ContinueRoute<'a> {
    let l = launching.filter(|l| !l.settled);
    match earlier_launch(l, agents, now) {
        Launched::Adopt(a) if l.is_some_and(|l| l.unconfirmed) => ContinueRoute::Resend(a),
        Launched::Adopt(a) => ContinueRoute::Busy(a.name.clone()),
        Launched::Wait => ContinueRoute::Busy(l.map(|l| l.name.clone()).unwrap_or_default()),
        Launched::No => ContinueRoute::Start,
    }
}

fn earlier_launch<'a>(launching: Option<&ledger::Launching>, agents: &'a [Agent], now: Millis) -> Launched<'a> {
    let Some(l) = launching else { return Launched::No };
    if let Some(a) = agents.iter().find(|a| a.parked.is_none() && a.kind == "omp" && a.name == l.name) {
        Launched::Adopt(a)
    } else if now - l.at < LAUNCH_SETTLE_MS {
        Launched::Wait
    } else {
        Launched::No
    }
}

// ───────────────────────────── bringing back ─────────────────────────────

/// Continue on a card whose kept prompt could not be confirmed: the launch is reset so the worker
/// sends the prompt once more to the same agent (no second agent is started). True when it was saved.
fn send_again(book: &Arc<Mutex<Book>>, id: &str) -> bool {
    let mut b = ledger::open(book);
    let Some(e) = b.entries.get_mut(id) else { return false };
    let Some(l) = e.launching.as_mut().filter(|l| l.unconfirmed) else { return false };
    l.sent_at = None;
    l.unconfirmed = false;
    e.hold = None;
    b.touch();
    b.save(now_ms(), false, 0)
}

/// The `restart` executor (`crate::recovery`): brings session `session_id` back and has it go on.
pub async fn continue_session(ctx: &Arc<Ctx>, session_id: &str, ticket: &Ticket) -> Result<RetryResult, ApiError> {
    if let Some(h) = crate::herdr_health::current(&ctx.herdr_session).filter(|h| !h.is_up()) {
        // Nothing starts while herdr is down: again once it runs (not counted as a try).
        return Err(wait_a_moment(ctx, session_id, ticket, format!("{}; waiting for herdr", h.reason().unwrap_or("herdr is not running"))));
    }
    // The board is built from a loaded herdr snapshot first: an empty board says nothing about
    // which agents exist (a slow herdr after a reboot), and a card not found would end the ticket.
    if ctx.state.agent_ids_in_use().is_none() {
        return Err(wait_a_moment(ctx, session_id, ticket, "not_connected: the board is not built yet; waiting for herdr".to_string()));
    }
    let book = ledger::book(&ctx.paths.home, &ctx.herdr_session);
    let snap = ctx.state.snapshot();
    let matches = |a: &&Agent| {
        a.omp.as_ref().is_some_and(|o| crate::recovery::names_session(o, session_id, ticket.session_file.as_deref()))
    };
    if let Some(a) = snap.agents.iter().filter(|a| a.parked.is_none()).find(matches) {
        // It runs again: brought back before, herdr's own restore, a resume by hand.
        if active(a) {
            return Err(ApiError::new("busy", format!("{} is working again", a.name)).retryable());
        }
        let a = full_launch(ctx, &book, a).await?;
        let started = go_on(ctx, &book, &a).await?;
        return Ok(RetryResult { started, via: RetryVia::Restore });
    }
    let Some(p) = snap.agents.iter().filter(|a| a.parked.is_some()).find(matches).cloned() else {
        // Its card is hidden behind the agent a Continue started for it (herdr gives that agent the
        // card's agent id when it takes the same pane): busy, not "not found"; or, when its first
        // prompt could not be confirmed, Continue sends it again.
        if let Some((id, e)) = ledger::find(&ctx.paths.home, &ctx.herdr_session, ticket.session_file.as_deref(), Some(session_id))
            && let Some(l) = e.launching.as_ref().filter(|l| !l.settled)
            && snap.agents.iter().any(|a| a.parked.is_none() && a.kind == "omp" && a.name == l.name)
        {
            if l.unconfirmed && send_again(&book, &id) {
                return Ok(RetryResult { started: true, via: RetryVia::Restore });
            }
            return Err(ApiError::new("busy", format!("It is starting again as {}", l.name)).retryable());
        }
        return Err(ApiError::new("not_found", "no agent here runs or ran this session"));
    };
    // Its live copy runs on another host (`ops::moves`): bringing it back here would fork it.
    if p.parked.as_ref().is_some_and(|x| x.moved.is_some()) {
        return Err(ApiError::new("invalid_params", format!("{} moved to another host; continue it there", p.name)));
    }
    let file = session_file(&p).map(str::to_string).or_else(|| ticket.session_file.clone()).unwrap_or_default();
    // Never while some omp runs the session: one a process names, or the one the ledger recorded
    // (a fresh start has no `--resume` argument to find; herdr may have been taken down around
    // omps that still live).
    if let Some(pid) = still_running(ctx, &p.id, &file, Some(session_id)) {
        return Err(ApiError::new("busy", format!("omp already runs this session (pid {pid}); it shows up on the board in a moment")).retryable());
    }
    let entry = ledger::open(&book).entries.get(&p.id).cloned();
    // Its own pane, when herdr restored it as a shell (else where a parked agent reopens).
    let pane = entry.as_ref().map(|e| e.pane_id.clone()).filter(|pane| {
        snap.workspaces
            .iter()
            .flat_map(|w| w.tabs.iter())
            .flat_map(|t| t.panes.iter())
            .any(|x| &x.id == pane && x.agent_id.is_none() && x.process.as_deref().is_none_or(crate::herdr_health::idle::is_shell))
            && !snap.agents.iter().any(|a| &a.pane_id == pane)
    });
    // Its first turn ended before omp wrote the session: a new session with its prompts (unless
    // omp wrote it on its way out after all; then `--resume` and the plan read from it).
    if let Some(e) = entry.filter(|e| !e.file_seen) {
        match check_session_file(&file).await {
            Ok(FileCheck::Present) => {}
            Ok(FileCheck::Missing) => {
                let claim = ctx.state.claim_resume(&p.id).ok_or_else(|| ApiError::new("busy", format!("{} is already being resumed", p.name)).retryable())?;
                let target = pane.map(|pane_id| StartTarget::Pane { pane_id });
                start_fresh(ctx, &book, &p.id, e, target, None, claim).await?;
                return Ok(RetryResult { started: true, via: RetryVia::Restore });
            }
            Ok(FileCheck::Unknown(why)) => {
                return Err(ApiError::new("io_error", format!("cannot tell whether the omp session file is there: {why}")).with_hint("The card stays; it is tried again").retryable());
            }
            Err(e) => return Err(ApiError::new("internal", format!("checking the session file: {e}"))),
        }
    }
    let started = relaunch(ctx, &p.id, pane).await?;
    let new_id = started.agent_id.clone().unwrap_or_default();
    {
        // The entry follows the agent to its new id (with its plan).
        let mut b = ledger::open(&book);
        if let Some(mut e) = b.entries.remove(&p.id) {
            e.record.ended = None;
            e.hold = None;
            e.launching = None;
            e.record.agent_id = new_id.clone();
            b.entries.insert(new_id.clone(), e);
            b.touch();
        }
        b.save(now_ms(), false, SAVE_EVERY_MS);
    }
    info!(agent = %new_id, was = %p.id, name = %p.name, pane = ?started.pane_id, "brought back");
    let Some(a) = wait_live(ctx, &new_id, Some(session_id)).await else {
        return Err(ApiError::new("not_connected", format!("{} is back, but its bridge did not connect yet", p.name)).retryable());
    };
    go_on(ctx, &book, &a).await?;
    Ok(RetryResult { started: true, via: RetryVia::Restore })
}

/// What a session file check says; a card that never had a file (omp ended before it wrote one,
/// before it even told its session) has nothing to check: `Missing`, which starts its kept prompt
/// as a new session, never `Unknown` (`check_file("")` could not tell).
async fn check_session_file(file: &str) -> Result<FileCheck, tokio::task::JoinError> {
    if file.is_empty() {
        return Ok(FileCheck::Missing);
    }
    let path = PathBuf::from(file);
    tokio::task::spawn_blocking(move || check_file(&path)).await
}

/// A restart ticket that cannot run yet (herdr is down, the board is not built): it is opened
/// again for a moment later, and the run is not counted as a try ([`RESCHEDULED`]).
fn wait_a_moment(ctx: &Ctx, session_id: &str, ticket: &Ticket, why: String) -> ApiError {
    if let Some(r) = crate::recovery::get() {
        let init = TicketInit {
            reason: ticket.reason.clone(),
            session_file: ticket.session_file.clone(),
            root: ticket.root,
            subagent_ids: ticket.subagent_ids.clone(),
            resume_at: Some(now_ms() + 15_000),
            ..Default::default()
        };
        r.open(&ctx.herdr_session, AutoResumeKind::Restart, session_id, init);
    }
    ApiError::new(RESCHEDULED, why).retryable()
}

/// `agent.resume` of an ended card under its name, model, thinking, its own omp settings and
/// policy: in `pane` (its restored shell) when given, else where a parked agent reopens. A pane
/// whose shell is still starting is tried again for [`PANE_WAIT`].
async fn relaunch(ctx: &Ctx, agent_id: &str, pane: Option<String>) -> Result<tf_proto::methods::Started, ApiError> {
    let Some(pane_id) = pane else {
        return crate::ops::agent::resume_parked(ctx, agent_id, None, None, Vec::new()).await;
    };
    let deadline = tokio::time::Instant::now() + PANE_WAIT;
    loop {
        let target = Some(StartTarget::Pane { pane_id: pane_id.clone() });
        match crate::ops::agent::resume_parked(ctx, agent_id, target, None, Vec::new()).await {
            Err(e) if e.code == "busy" && tokio::time::Instant::now() < deadline => tokio::time::sleep(Duration::from_secs(1)).await,
            other => return other,
        }
    }
}

/// A launch recorded in the ledger (`Entry::launching`) whose agent is not on the board yet waits
/// this long before the launch is believed lost and made again.
const LAUNCH_SETTLE_MS: Millis = 60_000;

/// Text or images typed on a fileless ended card are not taken: the card starts its kept prompt,
/// nothing else, and the client keeps the draft to send to the new agent once it is back.
fn refuse_typed(typed: &Option<(String, Vec<ImageInput>)>) -> Result<(), ApiError> {
    match typed {
        Some(_) => Err(ApiError::new("busy", "Press Continue first — this card starts its kept prompt; send this to the new agent once it is back").retryable()),
        None => Ok(()),
    }
}

/// An ended card whose omp never wrote its session (its first turn was cut off), on Continue: a
/// new agent through the normal start path (`start_agent`) under its name, folder, model,
/// thinking, own settings and policy. It is started WITHOUT a prompt: the kept prompt and images
/// reach it from `Worker::launched`, once, through its link, from the ledger's record (a task
/// that dies with hostd would lose it). Nothing else is taken (`typed` is refused). `target`:
/// where it starts (a restored shell pane), else its workspace, else its folder. Never automatic:
/// the card's ticket is manual.
///
/// The card and its ledger entry (prompt, images) stay until the new agent's session file exists
/// and proves the prompt ([`Worker::launched`]). The launch is written to the ledger first, and
/// while an agent of that name lives (or was started a moment ago and is not on the board yet) a
/// second start is refused (`busy`): no double starts. A launch whose send was not confirmed in
/// time is sent again by Continue (to the same agent), not started a second time.
async fn start_fresh(
    ctx: &Ctx,
    book: &Arc<Mutex<Book>>,
    agent_id: &str,
    e: Entry,
    target: Option<StartTarget>,
    typed: Option<(String, Vec<ImageInput>)>,
    claim: ResumeClaim,
) -> Result<tf_proto::methods::Started, ApiError> {
    refuse_typed(&typed)?;
    let snap = ctx.state.snapshot();
    let rec = &e.record;
    match continue_route(e.launching.as_ref(), &snap.agents, now_ms()) {
        ContinueRoute::Start => {}
        ContinueRoute::Resend(a) if send_again(book, agent_id) => {
            drop(claim);
            return Ok(tf_proto::methods::Started { agent_id: Some(a.id.clone()), pane_id: a.pane_id.clone(), workspace_id: a.workspace_id.clone() });
        }
        ContinueRoute::Resend(a) => return Err(ApiError::new("busy", format!("It is starting again as {}", a.name)).retryable()),
        ContinueRoute::Busy(name) => return Err(ApiError::new("busy", format!("It is starting again as {name}")).retryable()),
    }
    let taken: Vec<String> = snap.agents.iter().filter(|a| a.parked.is_none()).map(|a| a.name.clone()).collect();
    let own = Store::new(&ctx.paths).get(&ctx.herdr_session, agent_id).map(|r| r.omp).unwrap_or_else(|| e.settings.clone());
    let launch_name = unique_name(&rec.name, &taken);
    // The kept images come back whole or the start does not happen: never the text alone by
    // surprise (an entry that could not keep them says so, `images_lost`, and starts with the
    // text alone only because the person pressed Continue).
    let (home, kept) = (ctx.paths.home.clone(), e.images.clone());
    let images = tokio::task::spawn_blocking(move || images::load_all(&home, &kept))
        .await
        .map_err(|e| ApiError::new("internal", format!("reading the kept images: {e}")))?
        .map_err(|why| ApiError::new("io_error", format!("the images of {}'s first prompt cannot be given again: {why}", rec.name)).with_hint("Dismiss the card; the prompt's images are not there any more"))?;
    drop(images);
    let spec = tf_proto::methods::AgentSpec {
        name: Some(launch_name.clone()),
        kind: "omp".into(),
        model: rec.model.as_ref().map(|m| format!("{}/{}", m.provider, m.id)),
        thinking: rec.thinking,
        plan: false,
        prompt: None,
        images: Vec::new(),
        role_models: own.role_models,
        fallback_chains: own.fallback_chains,
        auto_answer: crate::autoanswer::own(ctx, agent_id).or_else(|| e.auto_answer.clone()),
    };
    let cwd = rec.cwd.clone().or_else(|| rec.workspace_cwd.clone()).ok_or_else(|| ApiError::new("not_found", format!("no folder is known for {}", rec.name)))?;
    let open_ws = rec.workspace_id.clone().filter(|id| snap.workspaces.iter().any(|w| &w.id == id && Some(&w.cwd) == rec.workspace_cwd.as_ref()));
    {
        let mut b = ledger::open(book);
        if let Some(entry) = b.entries.get_mut(agent_id) {
            entry.launching = Some(ledger::Launching { at: now_ms(), name: launch_name, ..Default::default() });
            entry.hold = None;
            b.touch();
        }
        // A launch the ledger does not know about could be made twice after a crash: not made.
        if !b.save(now_ms(), false, 0) {
            return Err(ApiError::new("io_error", "the agent ledger cannot be written; the new session is not started until it can").retryable());
        }
    }
    let pane_target = matches!(target, Some(StartTarget::Pane { .. }));
    let deadline = tokio::time::Instant::now() + PANE_WAIT;
    let started = loop {
        let place = target.clone().unwrap_or_else(|| match &open_ws {
            Some(ws) => StartTarget::Workspace { workspace_id: ws.clone(), split: Some(tf_proto::term::Split::Tab) },
            None => StartTarget::Cwd { cwd: cwd.clone(), label: None },
        });
        match crate::ops::agent::start_agent(ctx, place, &spec, None).await {
            Err(err) if err.code == "busy" && pane_target && tokio::time::Instant::now() < deadline => tokio::time::sleep(Duration::from_secs(1)).await,
            other => break other?,
        }
    };
    // herdr gives the new agent the card's agent id when it takes the same pane: `record_into`
    // (in `start_agent`) already moved the card's entry to a key of its own and installed the new
    // agent's launch entry under the live id — nothing is moved again here (that entry is the
    // live agent's own).
    let new_id = started.agent_id.clone().unwrap_or_default();
    // The card stays (and its claim is released): see above.
    drop(claim);
    let name = &rec.name;
    info!(agent = %new_id, was = %agent_id, %name, prompts = e.prompts.len(), images = e.images.len(), "started again as a new agent (its first turn ended before omp saved the session)");
    let detail = if e.first_prompt().is_none() && e.images.is_empty() {
        "Its first turn ended before omp saved the session and no prompt was recorded; it starts again empty"
    } else if e.images_lost.is_some() {
        "Its first turn ended before omp saved the session; its prompt text is sent once it is live (its images could not be kept). The ended card goes once it has replied"
    } else {
        "Its first turn ended before omp saved the session; its prompt is sent once it is live. The ended card goes once it has replied"
    };
    ctx.state.record_activity_as(&new_id, name, ActivityKind::Started, format!("{name} is back"), Some(detail.to_string()));
    Ok(started)
}

/// `ops::agent::resume_parked` found no session file for the ended card of `agent_id`: when omp
/// never wrote one (its first turn was cut off) that is a new session with the prompts it had
/// been given and what was typed now; when the file was there once, nothing can be resumed and
/// the card stays for the user to dismiss (never pruned: its prompts and settings are not lost).
pub(crate) async fn resume_without_file(
    ctx: &Ctx,
    agent_id: &str,
    claim: ResumeClaim,
    target: Option<StartTarget>,
    prompt: Option<String>,
    images: Vec<ImageInput>,
) -> Result<tf_proto::methods::Started, ApiError> {
    let book = ledger::book(&ctx.paths.home, &ctx.herdr_session);
    let entry = ledger::open(&book).entries.get(agent_id).cloned();
    match entry.filter(|e| !e.file_seen) {
        Some(e) => {
            let typed = (prompt.is_some() || !images.is_empty()).then(|| (prompt.unwrap_or_default(), images));
            start_fresh(ctx, &book, agent_id, e, target, typed, claim).await
        }
        None => Err(ApiError::new("not_found", "its omp session file is gone").with_hint("Dismiss the card; there is nothing left to resume")),
    }
}

/// What the ledger kept of the prompts an ended card's agent was given before omp saved its
/// session (the card's transcript while there is no file to read).
pub(crate) fn kept_prompts(ctx: &Ctx, agent_id: &str) -> Vec<String> {
    let book = ledger::book(&ctx.paths.home, &ctx.herdr_session);
    let b = ledger::open(&book);
    b.entries.get(agent_id).map(|e| e.prompts.clone()).unwrap_or_default()
}

/// An omp that runs the session of parked agent `agent_id` (`file` / `session_id`): a process
/// naming the session, or the one its ledger entry recorded. A second omp on the same session
/// would fork it.
pub(crate) fn still_running(ctx: &Ctx, agent_id: &str, file: &str, session_id: Option<&str>) -> Option<u32> {
    if let Some(pid) = herdr::omp_running(file, session_id, &[]) {
        return Some(pid);
    }
    let book = ledger::book(&ctx.paths.home, &ctx.herdr_session);
    let b = ledger::open(&book);
    let e = b.entries.get(agent_id)?;
    (ledger::alive(e.pid, &e.argv) == Some(true)).then_some(e.pid).flatten()
}

/// An adopted agent whose omp runs without TeleFlock's launch (herdr's own restore typed a plain
/// `omp --resume`) although TeleFlock launched it: started again in its pane with it.
async fn full_launch(ctx: &Ctx, book: &Arc<Mutex<Book>>, a: &Agent) -> Result<Agent, ApiError> {
    let entry = ledger::open(book).entries.get(&a.id).cloned();
    let pid = a.omp.as_ref().and_then(|o| o.pid);
    let Some(args) = pid.and_then(herdr::cmdline) else { return Ok(a.clone()) };
    if herdr::launched_by_us(&ctx.paths, &args) || !entry.as_ref().is_some_and(|e| e.ours) {
        return Ok(a.clone());
    }
    let Some(file) = session_file(a).map(str::to_string) else { return Ok(a.clone()) };
    let e = entry.unwrap_or_default();
    let own = Store::new(&ctx.paths).get(&ctx.herdr_session, &a.id).map(|r| r.omp).unwrap_or(e.settings.clone());
    let spec = tf_proto::methods::AgentSpec {
        name: Some(if a.name.is_empty() { e.record.name.clone() } else { a.name.clone() }),
        kind: "omp".into(),
        model: e.record.model.as_ref().map(|m| format!("{}/{}", m.provider, m.id)),
        thinking: e.record.thinking,
        plan: false,
        prompt: None,
        images: Vec::new(),
        role_models: own.role_models,
        fallback_chains: own.fallback_chains,
        auto_answer: crate::autoanswer::own(ctx, &a.id).or(e.auto_answer.clone()),
    };
    info!(agent = %a.id, "its omp runs without TeleFlock's launch; starting it again with it");
    let started = launch::restart_in_place(ctx, a, &file, spec, &args).await?;
    let new_id = started.agent_id.unwrap_or_default();
    if let Err(err) = Store::new(&ctx.paths).forget(&ctx.herdr_session, &a.id) {
        warn!(agent = %a.id, "dropping the old agent's omp settings: {err}");
    }
    {
        let mut b = ledger::open(book);
        if let Some(mut moved) = b.entries.remove(&a.id) {
            moved.record.agent_id = new_id.clone();
            b.entries.insert(new_id.clone(), moved);
            b.touch();
        }
    }
    let sid = a.omp.as_ref().and_then(|o| o.session_id.clone());
    wait_live(ctx, &new_id, sid.as_deref())
        .await
        .ok_or_else(|| ApiError::new("not_connected", format!("{} is back, but its bridge did not connect yet", a.name)).retryable())
}

/// Waits until `agent_id` (or, after a relaunch under another id, the agent of session
/// `session_id`) is idle and live on its bridge.
async fn wait_live(ctx: &Ctx, agent_id: &str, session_id: Option<&str>) -> Option<Agent> {
    let deadline = tokio::time::Instant::now() + LIVE_WAIT;
    let mut tick = 0u32;
    loop {
        let snap = ctx.state.snapshot();
        let a = snap.agents.iter().find(|a| a.id == agent_id && a.parked.is_none()).or_else(|| {
            session_id.and_then(|sid| snap.agents.iter().find(|a| a.parked.is_none() && a.omp.as_ref().and_then(|o| o.session_id.as_deref()) == Some(sid)))
        });
        if let Some(a) = a
            && let Some(o) = &a.omp
            && let Some(sid) = o.session_id.as_deref()
        {
            let idle = matches!(a.state, HerdrState::Idle | HerdrState::Done) && a.needs.is_none();
            if idle && o.link == LinkState::Live && ctx.bridge.by_session(sid).is_some() && now_ms() - a.state_since >= 1_500 {
                return Some(a.clone());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        if tick.is_multiple_of(4) {
            ctx.omp.repoll();
        }
        tick += 1;
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Goes on by the plan of `a` (live on its bridge, idle): the plan leaves the ledger first, then
/// omp's restore, its retry, the note. True when something started.
async fn go_on(ctx: &Ctx, book: &Arc<Mutex<Book>>, a: &Agent) -> Result<bool, ApiError> {
    let Some(o) = &a.omp else { return Ok(false) };
    let Some(sid) = o.session_id.clone() else { return Ok(false) };
    let planned = ledger::open(book).entries.get(&a.id).and_then(|e| e.plan.clone());
    let Some(planned) = planned.filter(Plan::any) else {
        clear_plan(book, &a.id);
        return Ok(false);
    };
    let caps = ctx.bridge.by_session(&sid).map(|b| b.caps).unwrap_or_default();
    let can = Can { restore: caps.restore, select: caps.restore_select };
    // The steps follow from the session as it is now (`--resume` closed a cut-off turn the way
    // omp's exit recovery does) and what this bridge can do; the note keeps its time and reason.
    let plan = match session_file(a).map(PathBuf::from) {
        Some(file) => match tokio::task::spawn_blocking(move || detect::ended(&file)).await {
            Ok(Ok(now)) => {
                let end = ledger::open(book).entries.get(&a.id).and_then(|e| e.end.clone());
                let (at, reason, busy, jobs) = match end {
                    Some(end) => (end.at, end.reason, end.busy || planned.turn != EndedTurn::Idle, end.jobs),
                    None => {
                        let (at, reason) = ended_of(a).unwrap_or((now_ms(), "its previous process ended".into()));
                        (at, reason, planned.turn != EndedTurn::Idle, Vec::new())
                    }
                };
                let mut p = decide::decide(&now, &Seen { busy, jobs }, at, &reason, can);
                // A turn the plan did not see as cut off (decided before) keeps its first verdict.
                if planned.turn == EndedTurn::Idle && p.turn != EndedTurn::Idle {
                    p = planned.clone();
                }
                p
            }
            _ => planned.clone(),
        },
        None => planned.clone(),
    };
    // At most once: nothing is sent twice, even if tf-hostd stops right after.
    clear_plan(book, &a.id);
    ledger::open(book).save(now_ms(), false, SAVE_EVERY_MS);
    let mut done: Vec<String> = Vec::new();
    // Set once a call may have reached omp (anything but an error that proves it did not).
    let mut sent = false;
    let result = async {
        if plan.restore_turn || !plan.restore_subagents.is_empty() {
            let v = if can.select {
                bridge_call(ctx, &sid, "restore", json!({ "turn": plan.restore_turn, "subagentIds": plan.restore_subagents }), &mut sent).await?
            } else {
                bridge_call(ctx, &sid, "restore", json!({}), &mut sent).await?
            };
            let turn = v.get("turn").and_then(Value::as_bool).unwrap_or(false);
            let subs: Vec<String> = v.get("subagents").and_then(Value::as_array).map(|s| s.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
            info!(agent = %a.id, turn, subagents = ?subs, "brought back: omp's restore");
            if turn {
                done.push("its turn went on".into());
            }
            if !subs.is_empty() {
                done.push(format!("subagents {} went on", subs.join(", ")));
            }
        }
        if plan.retry {
            let started = if caps.retry {
                bridge_call(ctx, &sid, "retry", json!({}), &mut sent).await?.get("started").and_then(Value::as_bool).unwrap_or(false)
            } else {
                bridge_call(ctx, &sid, "slash", json!({ "command": "/retry" }), &mut sent).await?;
                true
            };
            info!(agent = %a.id, started, "brought back: omp's retry of its cut-off reply");
            if started {
                done.push("its reply is being written again".into());
            }
        }
        if let Some(text) = &plan.note {
            note(ctx, a, &sid, text, plan.note_follows(), &mut sent).await?;
            info!(agent = %a.id, follows = plan.note_follows(), "brought back: note delivered");
            done.push("it was told what happened".into());
        }
        Ok::<(), ApiError>(())
    }
    .await;
    let detail = if done.is_empty() { None } else { Some(done.join("; ")) };
    match result {
        Ok(()) => {
            ctx.state.record_activity(&a.id, ActivityKind::Started, format!("{} is back", a.name), detail);
            Ok(true)
        }
        Err(e) => {
            warn!(agent = %a.id, "going on after bringing it back: {e}");
            if !sent {
                // Nothing reached omp (the bridge was not there, omp refused): the plan is tried
                // again with the ticket. Once a call may have got there, a second try could do it
                // twice (a timed-out restore that went through), so the plan stays spent.
                if let Some(entry) = ledger::open(book).entries.get_mut(&a.id) {
                    entry.plan = Some(planned);
                }
                ledger::open(book).touch();
            }
            Err(e)
        }
    }
}

/// When and why the agent's card said it ended (`Parked.ended`, kept in the ledger record).
fn ended_of(a: &Agent) -> Option<(Millis, String)> {
    a.parked.as_ref().and_then(|p| p.ended.as_ref()).map(|e| (e.at, e.reason.clone()))
}

fn clear_plan(book: &Arc<Mutex<Book>>, agent_id: &str) {
    let mut b = ledger::open(book);
    if let Some(e) = b.entries.get_mut(agent_id)
        && e.plan.take().is_some()
    {
        b.touch();
    }
}

/// One bridge call of the plan. `sent` is set unless the failure proves the call never reached
/// omp: a timeout or a dropped link may have come after omp acted.
async fn bridge_call(ctx: &Ctx, sid: &str, op: &str, args: Value, sent: &mut bool) -> Result<Value, ApiError> {
    match ctx.bridge.call(sid, op, args, BRIDGE_TIMEOUT).await {
        Ok(v) => {
            *sent = true;
            Ok(v)
        }
        Err(e) => {
            *sent |= !never_reached(&e);
            Err(e.into())
        }
    }
}

/// The error says omp did not act on the request: no bridge to send it over, or omp refused it.
fn never_reached(e: &crate::bridge::BridgeError) -> bool {
    use crate::bridge::BridgeError;
    match e {
        BridgeError::NotConnected { .. } => true,
        BridgeError::Rejected { code, .. } => matches!(code.as_str(), "invalid_params" | "not_found" | "unsupported" | "auth_required" | "busy" | "not_ready" | "unknown_op"),
        BridgeError::Timeout { .. } | BridgeError::Disconnected { .. } | BridgeError::BadResponse { .. } => false,
    }
}

/// Delivers the note: the session's data plane (the row names TeleFlock), else the bridge's
/// follow-up, else typed into omp's TUI. `follows`: queued after the turn that goes on now.
/// `sent`: set once the note may have been delivered (see [`bridge_call`]).
async fn note(ctx: &Ctx, a: &Agent, sid: &str, text: &str, follows: bool, sent: &mut bool) -> Result<(), ApiError> {
    if let Some(s) = ctx.omp.session(sid).filter(|s| s.link().0 == LinkState::Live) {
        s.expect_prompt(text, DEVICE);
        *sent = true;
        if !follows {
            return s.prompt(text, Vec::new(), Delivery::Auto).await;
        }
        if s.follow_up_prompts() {
            s.prompt(text, Vec::new(), Delivery::FollowUp).await?;
            s.expect_queued(text, true);
            return Ok(());
        }
    }
    if ctx.bridge.by_session(sid).is_some() {
        return match ctx.bridge.follow_up(sid, text).await {
            Ok(_) => {
                *sent = true;
                Ok(())
            }
            Err(e) => {
                *sent |= !never_reached(&e);
                Err(e.into())
            }
        };
    }
    *sent = true;
    ctx.herdr.agent_prompt(&a.pane_id, text, None).await.map(|_| ()).map_err(crate::ops::herdr_err)
}

// ───────────────────────────── controls ─────────────────────────────

/// `agent.autoResumeCancel` dismissed a restart ticket: an ended card goes to Done.
pub fn dismissed(ctx: &Ctx, agent: &Agent) {
    if agent.parked.as_ref().is_some_and(|p| p.ended.is_some()) && ctx.state.finish_ended(&agent.id) {
        forget_agent(ctx, &agent.id);
        ctx.state.record_activity(&agent.id, ActivityKind::Archived, format!("{} will not be brought back", agent.name), Some("Moved to Done; resume it from there".into()));
    }
}

/// `agent.archive {archived: true}` on an ended card: Done, and its ticket goes.
pub fn mark_done(ctx: &Ctx, agent_id: &str) {
    let Some(rec) = ctx.state.parked(agent_id).filter(|r| r.ended.is_some()) else { return };
    if let (Some(r), Some(sid)) = (crate::recovery::get(), rec.session_id.as_deref()) {
        r.close(&ctx.herdr_session, sid, Some(AutoResumeKind::Restart));
    }
    if ctx.state.finish_ended(agent_id) {
        forget_agent(ctx, agent_id);
        ctx.state.record_activity(agent_id, ActivityKind::Archived, format!("{} marked done", rec.name), None);
    }
}

/// Someone took over (a prompt to an ended or brought-back agent): its plan is dropped.
pub fn intervened(ctx: &Ctx, agent_id: &str) {
    let book = ledger::book(&ctx.paths.home, &ctx.herdr_session);
    let mut b = ledger::open(&book);
    if let Some(e) = b.entries.get_mut(agent_id)
        && e.plan.take().is_some()
    {
        info!(agent = agent_id, "agent ledger: a prompt took over; its plan is dropped");
        b.touch();
    }
}

fn forget_agent(ctx: &Ctx, agent_id: &str) {
    let book = ledger::book(&ctx.paths.home, &ctx.herdr_session);
    let mut b = ledger::open(&book);
    if b.entries.remove(agent_id).is_some() {
        b.touch();
    }
}

/// The name an agent had in omp session `file` / `session_id` (`host.resume`): the ledger's.
pub fn name_for(ctx: &Ctx, file: &str, session_id: Option<&str>) -> Option<String> {
    ledger::find(&ctx.paths.home, &ctx.herdr_session, Some(file), session_id).map(|(_, e)| e.record.name).filter(|n| !n.is_empty())
}

/// `name` when it is a valid herdr name no live agent has, else one derived from it (`-2`, …).
pub fn unique_name(name: &str, taken: &[String]) -> String {
    if crate::ops::agent::valid_handle(name) && !taken.iter().any(|t| t == name) {
        name.to_string()
    } else {
        crate::ops::agent::derive_handle(name, taken)
    }
}

/// A herdr name from a session title ("Fix the board's drag & drop" → `fix-the-board-s-drag-dr`).
pub fn name_from_title(title: &str, taken: &[String]) -> Option<String> {
    let seed = title.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join("-");
    (!seed.is_empty()).then(|| crate::ops::agent::derive_handle(&seed, taken))
}

/// The ledger's copies of an agent's own omp settings and decide-for-me policy (when their own
/// stores lost them).
pub fn settings_of(ctx: &Ctx, agent_id: &str) -> Option<(AgentOmp, Option<tf_proto::autoanswer::AutoAnswer>)> {
    let book = ledger::book(&ctx.paths.home, &ctx.herdr_session);
    let b = ledger::open(&book);
    b.entries.get(agent_id).map(|e| (e.settings.clone(), e.auto_answer.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use detect::{Exit, ExitKind};

    fn exit(kind: ExitKind, reason: &str, at: Millis) -> Exit {
        Exit { kind, reason: reason.into(), at: Some(at) }
    }

    #[test]
    fn why_omp_ended_in_its_pane() {
        let seen = 1_000_000;
        assert_eq!(omp_cause(Some(&exit(ExitKind::Normal, "dispose", seen)), seen), None, "a clean exit is a close on purpose");
        assert_eq!(omp_cause(Some(&exit(ExitKind::Signal, "SIGHUP", seen + 5)), seen), Some((EndCause::OmpKilled, "omp was stopped (SIGHUP)".into())));
        assert_eq!(omp_cause(Some(&exit(ExitKind::Fatal, "uncaughtException", seen)), seen).map(|c| c.0), Some(EndCause::OmpCrashed));
        assert_eq!(omp_cause(Some(&exit(ExitKind::ProcessExit, "exit", seen)), seen).map(|c| c.1), Some("omp exited unexpectedly".into()));
        // SIGKILL, out of memory: nothing recorded; an exit from an earlier process says nothing.
        assert_eq!(omp_cause(None, seen).map(|c| c.0), Some(EndCause::OmpCrashed));
        assert_eq!(omp_cause(Some(&exit(ExitKind::Normal, "dispose", seen - STALE_EXIT_MS - 1)), seen).map(|c| c.0), Some(EndCause::OmpCrashed));
    }

    #[test]
    fn herdr_causes_map_to_card_causes() {
        let mut h = HerdrHealth::unknown(0, Default::default());
        assert_eq!(herdr_cause(&h), EndCause::HerdrStopped);
        h.cause = Some(HerdrDownCause::Crashed);
        assert_eq!(herdr_cause(&h), EndCause::HerdrCrashed);
        h.cause = Some(HerdrDownCause::Update);
        assert_eq!(herdr_cause(&h), EndCause::HerdrUpdate);
    }

    #[test]
    fn pane_exits_and_relaunches_are_remembered_briefly() {
        pane_exited("lab-x", "w1:p2");
        assert!(pane_died("lab-x", "w1:p2"));
        assert!(!pane_died("lab-x", "w1:p3") && !pane_died("other", "w1:p2"));
        relaunching("/s/a.jsonl");
        assert!(being_relaunched("/s/a.jsonl") && !being_relaunched("/s/b.jsonl"));
    }

    #[test]
    fn volatile_fields_do_not_count_as_changes() {
        let a = crate::state::persist::ParkedRecord { name: "fixer".into(), session_file: "/s/a.jsonl".into(), line: Some("Running tests".into()), turns: 3, ..Default::default() };
        let b = crate::state::persist::ParkedRecord { line: Some("All green".into()), turns: 4, parked_at: 9, ..a.clone() };
        assert_eq!(stable(&a), stable(&b));
        let renamed = crate::state::persist::ParkedRecord { name: "fixer-2".into(), ..a.clone() };
        assert_ne!(stable(&a), stable(&renamed));
    }

    #[test]
    fn names_come_back_unique() {
        let taken = vec!["fixer".to_string(), "scout".to_string()];
        assert_eq!(unique_name("lab-a", &taken), "lab-a", "its own name, when free");
        assert_eq!(unique_name("fixer", &taken), "fixer-2", "taken by a live agent meanwhile");
        assert_eq!(name_from_title("Fix the board's drag & drop", &taken).as_deref(), Some("fix-the-board-s-drag-drop"));
        assert_eq!(name_from_title("Scout", &taken).as_deref(), Some("scout-2"));
        assert_eq!(name_from_title("…", &taken), None);
        assert!(crate::ops::agent::valid_handle(&name_from_title("Ünïcode / slashes \\ 2026", &[]).unwrap()));
    }

    fn omp_agent(id: &str, name: &str) -> Agent {
        let mut a = crate::state::parked::parked_agent(&crate::state::persist::ParkedRecord { agent_id: id.into(), name: name.into(), kind: "omp".into(), session_file: "/s/a.jsonl".into(), ..Default::default() });
        a.parked = None;
        a.name = name.into();
        a
    }

    #[test]
    fn a_pane_that_went_unseen_is_not_taken_for_one_closed_on_purpose() {
        let seen = 1_000_000;
        // Watched: noticed missing a tick after it was last live, and herdr said nothing died.
        assert_eq!(pane_gone(false, seen + 2_000, seen), PaneGone::Closed, "closed on purpose while TeleFlock watched");
        // herdr said its process died: an end, however late the verdict comes.
        assert_eq!(pane_gone(true, seen + 120_000, seen), PaneGone::Died);
        // TeleFlock was not there (hostd restarted, the board was away): no way to tell, so a card.
        assert_eq!(pane_gone(false, seen + WATCH_GAP_MS + 1, seen), PaneGone::Missed);
    }

    #[test]
    fn an_omp_somebody_stopped_is_not_relaunched_by_itself() {
        // As omp 18.13.3 words it (seen in the lab), and upper case.
        assert!(stopped_on_purpose(EndCause::OmpKilled, "omp was stopped (sigterm)"));
        assert!(stopped_on_purpose(EndCause::OmpKilled, "omp was stopped (SIGTERM)"));
        assert!(stopped_on_purpose(EndCause::OmpKilled, "omp was stopped (sigint)"));
        assert!(!stopped_on_purpose(EndCause::OmpKilled, "omp was stopped (sighup)"), "the terminal went away");
        assert!(!stopped_on_purpose(EndCause::OmpCrashed, "omp crashed"));
        assert!(!stopped_on_purpose(EndCause::OmpCrashed, "omp ended without a word (killed or crashed)"), "SIGKILL, out of memory");
    }

    #[test]
    fn a_restart_waits_for_continue_when_it_was_held_or_keeps_crashing() {
        let now = 10 * 60_000;
        let mut e = Entry::default();
        assert_eq!(restart_hold(&e, now), None);
        for k in 0..4 {
            e.note_end(now - k, now);
        }
        assert_eq!(restart_hold(&e, now).as_deref(), Some("keeps crashing — continue when ready"));
        e.hold = Some("omp was stopped (SIGTERM); continue it when you are ready".into());
        assert_eq!(restart_hold(&e, now).as_deref(), Some("omp was stopped (SIGTERM); continue it when you are ready"), "its own reason first");
        assert_eq!(restart_hold(&e, now + ledger::CRASH_WINDOW_MS + 1), e.hold.clone(), "a hold stays; a crash loop ages out");
    }

    #[test]
    fn only_a_session_that_is_certainly_gone_loses_its_ledger_entry() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let slug = sessions.join("-tmp-x");
        std::fs::create_dir_all(&slug).unwrap();
        let file = slug.join("a.jsonl");
        // Deleted: its folder is there and the file is not.
        let gone = check_file(&file);
        assert_eq!(gone, FileCheck::Missing);
        assert!(session_deleted(true, Some(&gone)));
        // omp never wrote it (the first turn was cut off): nothing was deleted.
        assert!(!session_deleted(false, Some(&gone)), "a card without a session file keeps its prompts");
        // The folders are gone with an unmounted home: no verdict, so no deletion.
        std::fs::remove_dir(&slug).unwrap();
        let unmounted = check_file(&file);
        assert!(matches!(unmounted, FileCheck::Unknown(_)), "{unmounted:?}");
        assert!(!session_deleted(true, Some(&unmounted)));
        assert!(!session_deleted(true, None), "a check that did not run is no verdict either");
        std::fs::write(sessions.join("other.jsonl"), "{}").unwrap();
        std::fs::create_dir_all(&slug).unwrap();
        std::fs::write(&file, "{}").unwrap();
        assert!(!session_deleted(true, Some(&check_file(&file))), "present");
    }

    #[test]
    fn a_launch_that_went_through_is_adopted_and_never_made_twice() {
        let l = ledger::Launching { at: 1_000_000, name: "fixer".into(), ..Default::default() };
        let board = vec![omp_agent("t9", "fixer"), omp_agent("t2", "scout")];
        // The new session is on the board under the name it was started with: adopted.
        assert!(matches!(earlier_launch(Some(&l), &board, l.at + 5_000), Launched::Adopt(a) if a.id == "t9"));
        // Not there yet and just started: wait for it, no second launch.
        assert!(matches!(earlier_launch(Some(&l), &board[1..], l.at + 5_000), Launched::Wait));
        // Never showed up for a minute: the launch was lost.
        assert!(matches!(earlier_launch(Some(&l), &board[1..], l.at + LAUNCH_SETTLE_MS), Launched::No));
        assert!(matches!(earlier_launch(None, &board, l.at), Launched::No));
        // A parked card of the name is no running agent.
        let mut parked = omp_agent("t9", "fixer");
        parked.parked = Some(tf_proto::model::Parked { at: 1, session_file: "/s/a.jsonl".into(), worktree: None, moved: None, ended: None });
        assert!(matches!(earlier_launch(Some(&l), &[parked], l.at + 5_000), Launched::Wait));
    }

    #[test]
    fn a_call_that_may_have_reached_omp_is_not_repeated() {
        use crate::bridge::BridgeError;
        let op = || "restore".to_string();
        assert!(never_reached(&BridgeError::NotConnected { session_id: "s".into() }));
        for code in ["busy", "not_ready", "unsupported", "unknown_op", "invalid_params"] {
            assert!(never_reached(&BridgeError::Rejected { op: op(), code: code.into(), message: "no".into() }), "{code}: omp refused it");
        }
        // A timeout, a dropped link, an answer that cannot be read, a failure inside omp: it may
        // well have been done.
        assert!(!never_reached(&BridgeError::Timeout { op: op(), after: Duration::from_secs(30) }));
        assert!(!never_reached(&BridgeError::Disconnected { op: op() }));
        assert!(!never_reached(&BridgeError::BadResponse { op: op(), message: "x".into() }));
        assert!(!never_reached(&BridgeError::Rejected { op: op(), code: "omp_error".into(), message: "boom".into() }));
    }

    #[test]
    fn a_plan_is_dropped_only_when_the_session_moved_on_by_work_of_the_running_omp() {
        let end = 1_000_000;
        let started = Some(end + 600_000);
        // Written while the successor started up (a resume writes a little at once): not work.
        assert!(!moved_on(end + 600_000 + 3_000, end, started));
        // Written a minute into its run: somebody went on in it.
        assert!(moved_on(end + 600_000 + 60_000, end, started));
        // Not newer than the end: untouched.
        assert!(!moved_on(end + 1_000, end, started));
        assert!(!moved_on(end, end, None));
        // Where the start time is unknown the file's age alone speaks.
        assert!(moved_on(end + 60_000, end, None));
        #[cfg(target_os = "linux")]
        {
            let t = process_started(std::process::id()).expect("our own start time");
            assert!(t <= now_ms() && now_ms() - t < 48 * 3_600_000, "{t}");
        }
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.jsonl");
        std::fs::write(&file, "{}").unwrap();
        let written = now_ms();
        assert!(session_moved_on(file.to_str().unwrap(), written - 120_000, None), "a file written after the end");
        assert!(!session_moved_on(file.to_str().unwrap(), written + 120_000, None), "a file older than the end");
        assert!(!session_moved_on(dir.path().join("none.jsonl").to_str().unwrap(), 0, None), "no file, nothing moved on");
    }

    #[tokio::test]
    async fn a_herdr_session_that_does_not_start_never_holds_up_the_others() {
        let cancel = tokio_util::sync::CancellationToken::new();
        let tries = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let slow_tries = tries.clone();
        let slow = open_until_ready("broken", &cancel, Duration::from_millis(10), || {
            let t = slow_tries.clone();
            async move {
                let n = {
                    let mut g = t.lock().unwrap();
                    g.push("broken");
                    g.len()
                };
                if n < 5 { Err("herdr does not start") } else { Ok(()) }
            }
        });
        let fine_tries = tries.clone();
        let fine = open_until_ready("fine", &cancel, Duration::from_millis(10), || {
            let t = fine_tries.clone();
            async move {
                t.lock().unwrap().push("fine");
                Ok::<(), &str>(())
            }
        });
        // Each runs by itself (restart::start spawns one task per session): `fine` is up at its
        // first try while `broken` is still being retried.
        let (broken_up, fine_up) = tokio::join!(slow, fine);
        assert!(broken_up && fine_up);
        let order = tries.lock().unwrap().clone();
        assert_eq!(order.iter().filter(|t| **t == "fine").count(), 1);
        assert!(order.iter().filter(|t| **t == "broken").count() >= 4, "retried until it came up: {order:?}");
        assert!(order.iter().position(|t| *t == "fine").unwrap() < 3, "not behind the broken one: {order:?}");
        // A shutdown ends the retries.
        cancel.cancel();
        assert!(!open_until_ready("never", &cancel, Duration::from_secs(60), || async { Err::<(), &str>("down") }).await);
    }

    #[test]
    fn a_card_that_ended_before_its_first_reply_is_never_started_again_by_itself() {
        let ended = tf_proto::autoresume::AgentEnded { at: 1, cause: EndCause::OmpCrashed, reason: "omp crashed".into(), turn: EndedTurn::Working, last_action: None };
        let mut e = Entry { prompts: vec!["see the screenshot".into()], ..Default::default() };
        assert_eq!(restart_hold(&e, 0), None, "a live agent has no ticket to hold");
        e.record.ended = Some(ended);
        let why = restart_hold(&e, 0).expect("its ticket is manual: Continue starts it again");
        assert!(why.contains("before its first reply") && why.contains("its prompt is kept") && why.contains("continue it"), "{why}");
        // Whatever happened to the first prompt's images is said too.
        e.images_lost = Some("an image has no payload yet".into());
        assert!(restart_hold(&e, 0).unwrap().contains("not given again"));
        // Once omp saved the session (it replied), the card comes back by --resume as ever.
        e.file_seen = true;
        assert_eq!(restart_hold(&e, 0), None);
        // And a crash loop still holds.
        for k in 0..4 {
            e.note_end(10 * 60_000 - k, 10 * 60_000);
        }
        assert_eq!(restart_hold(&e, 10 * 60_000).as_deref(), Some(CRASH_LOOP_HOLD));
    }

    fn launching(sent_at: Option<Millis>) -> ledger::Launching {
        ledger::Launching { at: 1_000, name: "fixer".into(), sent_at, unconfirmed: false, settled: false }
    }

    #[test]
    fn inv4_the_kept_prompt_is_sent_once_to_a_live_idle_successor_without_a_file() {
        let l = launching(None);
        // Live, idle, no file: send.
        assert_eq!(launch_step(&l, 5_000, false, true, true, false, false), LaunchStep::Send);
        // Not live (no link), or busy: wait; nothing is typed into a pane.
        assert_eq!(launch_step(&l, 5_000, false, false, true, false, false), LaunchStep::Wait);
        assert_eq!(launch_step(&l, 5_000, false, false, false, false, false), LaunchStep::Wait);
        // Nothing kept: nothing to send.
        assert_eq!(launch_step(&l, 5_000, false, true, true, true, false), LaunchStep::Wait);
        // Sent (recorded before the send): never again by itself, however long the agent idles,
        // whatever restarted in between.
        let sent = launching(Some(2_000));
        assert_eq!(launch_step(&sent, 2_000 + 60_000, false, true, true, false, false), LaunchStep::Wait);
        assert_eq!(launch_step(&sent, 2_000 + CONFIRM_MS - 1, false, true, true, false, false), LaunchStep::Wait);
        // Still no session file 2 minutes after the send while idle: the card waits for Continue.
        assert_eq!(launch_step(&sent, 2_000 + CONFIRM_MS, false, true, true, false, false), LaunchStep::Unconfirmed);
        // Working: the file is written with its reply, so it is not yet "unconfirmed".
        assert_eq!(launch_step(&sent, 2_000 + CONFIRM_MS, false, true, false, false, false), LaunchStep::Wait);
        // Once unconfirmed it stays put until Continue resets it (and Continue sends again).
        let held = ledger::Launching { unconfirmed: true, ..sent.clone() };
        assert_eq!(launch_step(&held, 2_000 + 10 * CONFIRM_MS, false, true, true, false, false), LaunchStep::Wait);
        let reset = ledger::Launching { sent_at: None, unconfirmed: false, ..held };
        assert_eq!(launch_step(&reset, 9_000_000, false, true, true, false, false), LaunchStep::Send);
    }

    #[test]
    fn inv4_the_card_goes_when_the_file_proves_the_prompt_or_nothing_was_kept_else_it_stays() {
        let sent = launching(Some(2_000));
        assert_eq!(launch_step(&sent, 9_000, true, true, true, false, true), LaunchStep::Retire, "the file's first message is the kept prompt");
        assert_eq!(launch_step(&sent, 9_000, true, true, true, false, false), LaunchStep::Settle, "another first message, or images");
        assert_eq!(launch_step(&launching(None), 9_000, true, true, true, true, false), LaunchStep::Retire, "nothing was kept: nothing to protect");
    }

    #[test]
    fn an_agent_that_takes_the_id_of_an_ended_card_gets_its_own_entry_and_the_card_moves_with_everything() {
        // The card is fileless, its Continue launched a successor (pending send), its prompt had an image.
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let kept = images::keep(home, "image/png", b"\x89PNG shot").unwrap();
        let mut old = Entry { prompts: vec!["fix it".into()], images: vec![kept.clone()], recorded: true, plan: Some(fresh_plan(&ended_entry())), ..ended_entry() };
        old.record.session_id = Some("sid-old".into());
        old.launching = Some(launching(Some(5)));
        let b = ledger::book(home, "default");
        ledger::open(&b).entries.insert("t1".into(), old.clone());
        // herdr gave the successor the card's id and a new session.
        let mut a = omp_agent("t1", "fixer");
        a.omp.as_mut().unwrap().session_file = Some("/s/new.jsonl".into());
        a.omp.as_mut().unwrap().session_id = Some("sid-new".into());
        assert_eq!(entry_vs_agent(&old, &a, 0), Rel::Other);
        let mut back = omp_agent("t1", "fixer");
        back.omp.as_mut().unwrap().session_file = Some("/s/a.jsonl".into());
        back.omp.as_mut().unwrap().session_id = Some("sid-old".into());
        back.omp.as_mut().unwrap().link = tf_proto::model::LinkState::Live;
        assert_eq!(entry_vs_agent(&old, &back, 0), Rel::Same, "its own omp back (same file) is the genuine 'back without a relaunch'");
        let mut live_entry = old.clone();
        live_entry.record.ended = None;
        assert_eq!(entry_vs_agent(&live_entry, &a, 0), Rel::Other, "an entry not yet ended, whose omp is another session than the agent that has its id now, is a collision too");
        // One persisted step in the ledger, to a key made of the entry's identity.
        let moved = rekey_in_book(&mut ledger::open(&b), "t1").unwrap();
        assert_eq!(moved, rekey_name("t1", &old));
        assert!(moved.starts_with("t1~") && moved.len() == "t1~".len() + 8, "{moved}");
        // …the same for a copy of the entry in another book (a re-key repeated after a crash).
        let other = ledger::book(tempfile::tempdir().unwrap().path(), "default");
        ledger::open(&other).entries.insert("t1".into(), old.clone());
        assert_eq!(rekey_in_book(&mut ledger::open(&other), "t1").as_deref(), Some(moved.as_str()), "repeating a re-key lands on the same key");
        // A different entry sitting on that key is never overwritten.
        ledger::open(&other).entries.insert("t1".into(), Entry { prompts: vec!["x".into()], ..old.clone() });
        let second = rekey_in_book(&mut ledger::open(&other), "t1").unwrap();
        assert_eq!(second, format!("{moved}-2"));
        assert_eq!(ledger::open(&other).entries.get(&moved).unwrap().record.agent_id, moved);
        let g = ledger::open(&b);
        assert!(!g.entries.contains_key("t1"), "the id is free for the live agent's own entry");
        let card = g.entries.get(&moved).unwrap();
        assert_eq!(card.record.agent_id, moved);
        assert_eq!((card.first_prompt().as_deref(), card.images.len(), card.launching.as_ref().map(|l| l.sent_at)), (Some("fix it"), 1, Some(Some(5))), "prompt, images and launch state move along");
        assert_eq!(card.record.session_id.as_deref(), Some("sid-old"), "its ticket is keyed by omp session: it follows by itself");
        assert!(card.plan.is_some());
        drop(g);
        // The successor is an ordinary live entry: no ended record, no plan, nothing to plan or
        // drop in a loop (`plan_ended` and `tickets` look at ended entries and live ids apart).
        let mut g = ledger::open(&b);
        let (saved, none) = record_into(&mut g, "t1", FirstPrompt { text: Some("look".into()), images: Ok(vec![kept]), guard: None, card: None });
        assert!(saved && none.is_none(), "already moved");
        let live = g.entries.get("t1").unwrap();
        assert!(live.record.ended.is_none() && live.plan.is_none() && live.launching.is_none() && live.recorded);
        assert_eq!((live.first_prompt().as_deref(), live.images.len()), (Some("look"), 1), "an image prompt is recorded for it too");
        assert!(g.entries.values().filter(|e| e.record.ended.is_some() && e.plan.is_none()).count() == 0, "nothing ended without a plan: the live agent is not planned");
    }

    #[test]
    fn a_launch_recorded_while_the_observer_awaits_changes_the_entry_the_tick_saw() {
        let dir = tempfile::tempdir().unwrap();
        let b = ledger::book(dir.path(), "default");
        let mut g = ledger::open(&b);
        // A, an earlier agent under the id, ended with its prompt kept; the tick's snapshot has it.
        g.entries.insert("ca".into(), Entry { prompts: vec!["prompt of A".into()], ..ended_entry() });
        g.touch();
        let before = g.entries.clone();
        assert!(!changed_since(&g, &before, ["ca", "cz"]), "reads and unrelated ids change nothing");
        // …and it awaits (images, job labels). Meanwhile a launch records its entry under the reused id.
        let (saved, moved) = record_into(&mut g, "ca", FirstPrompt { text: Some("prompt of B".into()), images: Ok(Vec::new()), guard: None, card: None });
        assert!(saved && moved.is_some());
        // The observer's commit compares under the lock: changed, so it writes nothing.
        assert!(changed_since(&g, &before, ["ca"]), "the observer discards its stale observation");
        let entry = g.entries.get("ca").unwrap();
        assert_eq!((entry.first_prompt().as_deref(), entry.recorded), (Some("prompt of B"), true), "B's entry and prompt stand");
        assert_eq!(g.entries.get(&moved.unwrap()).unwrap().first_prompt().as_deref(), Some("prompt of A"));
        // Any other change to the entry by someone else counts too (Continue's marker, Dismiss, a re-key).
        for change in [0, 1] {
            let before = g.entries.clone();
            match change {
                0 => g.entries.get_mut("ca").unwrap().hold = Some("x".into()),
                _ => {
                    g.entries.remove("ca");
                }
            }
            assert!(changed_since(&g, &before, ["ca"]), "change {change}");
        }
    }

    #[test]
    fn two_fileless_agents_sharing_an_id_keep_both_prompts_without_any_session_file() {
        // ca was started by hostd with a prompt and died before its hello: its entry knows no
        // session and no process. cb is started in its pane and gets ca's id.
        let dir = tempfile::tempdir().unwrap();
        let b = ledger::book(dir.path(), "default");
        let mut g = ledger::open(&b);
        assert!(record_into(&mut g, "ca", FirstPrompt { text: Some("prompt of ca".into()), images: Ok(Vec::new()), guard: None, card: None }).0);
        assert!(!has_identity(g.entries.get("ca").unwrap()));
        let (saved, moved) = record_into(&mut g, "ca", FirstPrompt { text: Some("prompt of cb".into()), images: Ok(Vec::new()), guard: None, card: None });
        let moved = moved.expect("ca's entry moved away at once");
        assert!(saved);
        assert_eq!(g.entries.get("ca").unwrap().first_prompt().as_deref(), Some("prompt of cb"));
        let old = g.entries.get(&moved).unwrap();
        assert_eq!((old.first_prompt().as_deref(), old.record.agent_id.as_str()), (Some("prompt of ca"), moved.as_str()), "ca's prompt is kept");
        // The same when ca had said hello (it has a session path, no file) and is dead by now.
        let mut dead = Entry { prompts: vec!["prompt of cc".into()], pid: Some(4_000_000_000), ..Default::default() };
        dead.record.session_file = "/s/never-written.jsonl".into();
        g.entries.insert("cc".into(), dead.clone());
        let (_, moved) = record_into(&mut g, "cc", FirstPrompt { text: Some("prompt of cd".into()), images: Ok(Vec::new()), guard: None, card: None });
        assert!(moved.is_some(), "an entry that is not known to be the agent's own moves away (dead pid or not, on any OS)");
        // A live process or a matching session path in an old entry proves nothing about the NEW
        // agent: every entry that holds anything moves aside, prompt intact.
        g.entries.insert("ce".into(), Entry { record: crate::state::persist::ParkedRecord { session_file: "/s/new.jsonl".into(), ..Default::default() }, pid: Some(std::process::id()), prompts: vec!["prompt of ce".into()], ..Default::default() });
        let (_, moved) = record_into(&mut g, "ce", FirstPrompt { text: Some("p".into()), images: Ok(Vec::new()), guard: None, card: None });
        assert_eq!(g.entries.get(&moved.expect("moved")).unwrap().first_prompt().as_deref(), Some("prompt of ce"));
        assert_eq!(g.entries.get("ce").unwrap().first_prompt().as_deref(), Some("p"));
        // Only a completely empty stub is dropped (no key made for it).
        g.entries.insert("cg".into(), Entry::default());
        let before = g.entries.len();
        let (_, moved) = record_into(&mut g, "cg", FirstPrompt { text: Some("q".into()), images: Ok(Vec::new()), guard: None, card: None });
        assert!(moved.is_none() && g.entries.len() == before, "the stub was replaced by this launch's entry");
        // …but a stub that holds a launch, a pid, a plan, a kept image or an end is not empty.
        for e in [
            Entry { launching: Some(launching(None)), ..Default::default() },
            Entry { pid: Some(1), ..Default::default() },
            Entry { plan: Some(Plan::idle()), ..Default::default() },
            Entry { images_lost: Some("x".into()), ..Default::default() },
            ended_entry(),
        ] {
            assert!(!is_empty_stub(&e));
        }
        assert!(is_empty_stub(&Entry::default()));
        // An ended entry that never learned its session is never a return: any agent under its id is another.
        let ended = Entry { prompts: vec!["x".into()], ..ended_entry() };
        let mut ended_blank = ended.clone();
        ended_blank.record.session_file = String::new();
        assert_eq!(entry_vs_agent(&ended_blank, &omp_agent("ca", "fixer"), 0), Rel::Other);
    }

    #[test]
    fn only_a_change_to_the_agents_own_entry_discards_its_commit() {
        let dir = tempfile::tempdir().unwrap();
        let b = ledger::book(dir.path(), "default");
        {
            let mut g = ledger::open(&b);
            for id in ["t1", "t3", "t4"] {
                g.entries.insert(id.into(), Entry { prompts: vec![format!("prompt of {id}")], ..ended_entry() });
            }
            g.touch();
        }
        // The tick snapshots every entry before it takes the board snapshot.
        let mut before = ledger::open(&b).entries.clone();
        // Its own re-key goes on and takes the moved entry out of its copy.
        let moved = rekey_ledger(&b, "t1", Some(&mut before)).expect("nothing changed t1");
        assert!(ledger::open(&b).entries.contains_key(&moved) && !before.contains_key("t1"));
        // Launches of other agents meanwhile (entries appear where the tick saw none) never discard
        // the commits of the agents that were already there: no starvation.
        for id in ["t2", "t5"] {
            assert!(record_into(&mut ledger::open(&b), id, FirstPrompt { text: Some(format!("prompt of {id}")), images: Ok(Vec::new()), guard: None, card: None }).0);
        }
        assert!(!changed_since(&ledger::open(&b), &before, ["t3"]));
        assert!(rekey_ledger(&b, "t3", Some(&mut before)).is_some());
        // An entry that appeared under an id the tick saw none under (the snapshot shows the agent
        // that had the id before) discards that agent's commit…
        assert!(changed_since(&ledger::open(&b), &before, ["t2"]));
        // …and so does any change to the agent's own entry since (Continue, Dismiss, a re-key).
        ledger::open(&b).entries.get_mut("t4").unwrap().hold = Some("x".into());
        ledger::open(&b).touch();
        assert_eq!(rekey_ledger(&b, "t4", Some(&mut before)), None);
        let g = ledger::open(&b);
        assert_eq!(g.entries.get("t4").unwrap().first_prompt().as_deref(), Some("prompt of t4"), "t4 untouched");
        assert_eq!(g.entries.get("t2").unwrap().first_prompt().as_deref(), Some("prompt of t2"), "the new launch's entry stands");
        drop(g);
        // The next tick snapshots afresh and goes on.
        let mut next = ledger::open(&b).entries.clone();
        assert!(rekey_ledger(&b, "t4", Some(&mut next)).is_some());
    }

    #[test]
    fn an_agent_that_ends_after_foreign_launches_takes_its_session_from_the_board() {
        // C is launched; other agents launch (and the ledger changes) around it; C's own refinement
        // never ran. 3.4 s later it ends. The board had seen its session: not fileless.
        let dir = tempfile::tempdir().unwrap();
        let b = ledger::book(dir.path(), "default");
        let spec: tf_proto::methods::AgentSpec = serde_json::from_value(serde_json::json!({"kind": "omp", "plan": false})).unwrap();
        let at = LaunchAt { name: "c".into(), pane_id: "p1".into(), workspace_id: "w1".into(), cwd: Some("/work/c".into()) };
        let mut g = ledger::open(&b);
        let k = FirstPrompt { text: Some("task of c".into()), images: Ok(Vec::new()), guard: None, card: Some(launch_card(&[], &spec, at, 1_000)) };
        assert!(record_into(&mut g, "cc", k).0);
        for id in ["x1", "x2", "x3"] {
            assert!(record_into(&mut g, id, FirstPrompt { text: None, images: Ok(Vec::new()), guard: None, card: None }).0);
        }
        let mut rec = g.entries.get("cc").unwrap().record.clone();
        let launch = ledger::BootStamp { id: ledger::boot_id().unwrap_or_default(), ms: 1_000 };
        drop(g);
        assert!(!real_identity(&rec));
        // The omp process behind the board's row started at 1 050 on the boot clock, after the launch (1 000).
        let mut row = row_of(&omp_agent("cc", "c"), Some(500)).expect("the board showed its session");
        // A process from before the launch is an earlier agent's under the reused id: never taken.
        assert!(!learn_session(&mut rec.clone(), Some(&launch), Some(&row)));
        row.started = Some(1_050);
        // (Off Linux there is no boot clock and nothing is learned: the card stays fileless.)
        if cfg!(target_os = "linux") {
            assert!(learn_session(&mut rec, Some(&launch), Some(&row)));
            fileless_key(&mut rec);
            assert_eq!(rec.session_file, "/s/a.jsonl");
            assert!(!rec.session_id.as_deref().is_some_and(|s| s.starts_with("fresh:")), "no card key: it has its session");
            rec.ended = Some(tf_proto::autoresume::AgentEnded { at: 3_400, cause: tf_proto::autoresume::EndCause::HerdrStopped, reason: "herdr stopped".into(), turn: tf_proto::autoresume::EndedTurn::Idle, last_action: None });
            assert!(!is_fileless(&rec), "it comes back by --resume, not as a fresh session");
        }
        // With no session anywhere (the board never showed one) it is fileless, with its key.
        let mut nothing = ledger::open(&b).entries.get("cc").unwrap().record.clone();
        assert!(!learn_session(&mut nothing, Some(&launch), None));
        fileless_key(&mut nothing);
        assert_eq!(nothing.session_id.as_deref(), Some("fresh:cc:1000"));
    }

    /// A launch stamp on this boot's clock (off Linux there is no boot id: nothing is ever learned).
    fn stamp(ms: i64) -> ledger::BootStamp {
        ledger::BootStamp { id: ledger::boot_id().unwrap_or_default(), ms }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_session_is_learned_only_from_a_process_that_started_with_the_launch() {
        // A's row is first OBSERVED after B's launch (at 1 000 ms on the boot clock) — a hostd
        // restart emptied the rows, the cached board still publishes A — but A's omp process
        // started at 500.
        let mut rows = HashMap::new();
        let a = omp_agent("cc", "c");
        for _ in 0..3 {
            note_row(&mut rows, "cc", row_of(&a, Some(500)).unwrap());
        }
        let launch = stamp(1_000);
        let mut b_rec = crate::state::persist::ParkedRecord { agent_id: "cc".into(), ..Default::default() };
        assert!(!learn_session(&mut b_rec, Some(&launch), rows.get("cc")), "A's process predates B's launch: not B's session");
        assert!(!real_identity(&b_rec));
        // No evidence at all (no pid, an unreadable process): not learned either.
        let mut blind = rows.clone();
        blind.get_mut("cc").unwrap().started = None;
        assert!(!learn_session(&mut b_rec, Some(&launch), blind.get("cc")));
        // An entry with no boot stamp (older, not launch-made): nothing to compare with.
        let mut late = rows.clone();
        late.get_mut("cc").unwrap().started = Some(5_000);
        assert!(!learn_session(&mut b_rec, None, late.get("cc")));
        // A stamp from another boot is no evidence either.
        let other_boot = ledger::BootStamp { id: "another-boot".into(), ms: 0 };
        assert!(!learn_session(&mut b_rec, Some(&other_boot), late.get("cc")));
        // B's session shows up (another file, its process started at 1 050): a new row, learned.
        let mut b = omp_agent("cc", "c");
        b.omp.as_mut().unwrap().session_file = Some("/s/b.jsonl".into());
        b.omp.as_mut().unwrap().session_id = Some("sid-b".into());
        note_row(&mut rows, "cc", row_of(&b, Some(1_050)).unwrap());
        assert_eq!(rows["cc"].started, Some(1_050));
        assert!(learn_session(&mut b_rec, Some(&launch), rows.get("cc")));
        assert_eq!((b_rec.session_file.as_str(), b_rec.session_id.as_deref()), ("/s/b.jsonl", Some("sid-b")));
        // A row that only learned its id (or its process start) later is the same session.
        let mut part = omp_agent("cd", "d");
        part.omp.as_mut().unwrap().session_id = None;
        note_row(&mut rows, "cd", row_of(&part, None).unwrap());
        part.omp.as_mut().unwrap().session_id = Some("sid-d".into());
        note_row(&mut rows, "cd", row_of(&part, Some(70)).unwrap());
        assert_eq!((rows["cd"].sid.as_deref(), rows["cd"].started), (Some("sid-d"), Some(70)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn process_start_and_launch_are_compared_on_the_boot_clock_not_the_wall_clock() {
        let launch = stamp(10_000_000);
        // 200 ms after the launch: accepted. On the wall clock with `btime` cut to whole seconds it
        // would have come out up to a second EARLIER than the launch stamp and been refused.
        assert!(started_with_launch(Some(10_000_200), Some(&launch)));
        let truncated_wall = 10_000_200 - 999;
        assert!(truncated_wall < 10_000_000, "the old comparison refused it");
        // Within the tick granularity before the stamp: accepted; 5 s before: a predecessor's.
        assert!(started_with_launch(Some(10_000_000 - 40), Some(&launch)));
        assert!(!started_with_launch(Some(10_000_000 - 5_000), Some(&launch)));
        assert!(!started_with_launch(None, Some(&launch)) && !started_with_launch(Some(10_000_200), None));

        // Real processes against a stamp taken now: one started after it is the launch's own, one
        // that was already running 300 ms before it is not.
        let entry_with = |stamp: Option<ledger::BootStamp>| Entry { record: crate::state::persist::ParkedRecord { started_at: Some(1), ..Default::default() }, launch_boot: stamp, ..Default::default() };
        let agent_of = |pid: u32| {
            let mut a = omp_agent("ca", "fixer");
            a.omp.as_mut().unwrap().pid = Some(pid);
            a
        };
        let reap = |mut c: std::process::Child| {
            let _ = c.kill();
            let _ = c.wait();
        };
        let before = ledger::boot_stamp().expect("a boot clock on Linux");
        let mine = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        assert!(launch_proof(&entry_with(Some(before)), &agent_of(mine.id()), 0), "started after the stamp");
        reap(mine);
        let older = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let after = ledger::boot_stamp().unwrap();
        assert!(!launch_proof(&entry_with(Some(after.clone())), &agent_of(older.id()), i64::MAX / 2), "already running before the stamp: even a late snapshot does not make it the launch's");
        reap(older);
        // An entry from before the stamp existed falls back to the snapshot's time.
        assert!(launch_proof(&entry_with(None), &agent_of(std::process::id()), 5));
        assert!(!launch_proof(&entry_with(None), &agent_of(std::process::id()), 0));
    }

    #[tokio::test]
    async fn a_fileless_card_is_started_not_file_checked() {
        // Continue on a card that never had a session file: no `Unknown` from checking "".
        assert_eq!(check_session_file("").await.unwrap(), FileCheck::Missing);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("s.jsonl");
        std::fs::write(&file, "{}").unwrap();
        assert_eq!(check_session_file(file.to_str().unwrap()).await.unwrap(), FileCheck::Present);
    }

    #[test]
    fn continues_successor_keeps_its_launch_entry_under_its_live_id() {
        let dir = tempfile::tempdir().unwrap();
        let b = ledger::book(dir.path(), "default");
        let spec: tf_proto::methods::AgentSpec = serde_json::from_value(serde_json::json!({"kind": "omp", "plan": false})).unwrap();
        let at = LaunchAt { name: "fixer".into(), pane_id: "p1".into(), workspace_id: "w1".into(), cwd: Some("/work".into()) };
        // The ended fileless card of agent "ca", with Continue's launch marker set by `start_fresh`.
        let mut old = Entry { prompts: vec!["its task".into()], launching: Some(launching(None)), ..ended_entry() };
        old.record.agent_id = "ca".into();
        let mut g = ledger::open(&b);
        g.entries.insert("ca".into(), old);
        // herdr gives the successor the card's id; `start_agent` records its launch entry.
        let (saved, moved) = record_into(&mut g, "ca", FirstPrompt { text: None, images: Ok(Vec::new()), guard: None, card: Some(launch_card(&[], &spec, at, 50)) });
        assert!(saved);
        let moved = moved.expect("the card's entry moved aside, once");
        // Nothing else moves it: the successor's entry is its own, under its live id, and the only
        // `~` entry is the card's, with the launch marker and the kept prompt.
        let mut a = omp_agent("ca", "fixer");
        a.pane_id = "p1".into();
        let live = g.entries.get("ca").unwrap();
        assert!(own_launch(live, &a) && entry_vs_agent(live, &a, 100) == Rel::Same);
        assert!(live.launching.is_none() && live.record.ended.is_none());
        let aside: Vec<&String> = g.entries.keys().filter(|k| k.contains('~')).collect();
        assert_eq!(aside, [&moved]);
        let card = g.entries.get(&moved).unwrap();
        assert!(card.launching.is_some() && card.record.ended.is_some());
        assert_eq!(card.first_prompt().as_deref(), Some("its task"));
    }

    #[test]
    fn a_launchs_entry_is_adopted_only_on_evidence_that_the_row_is_the_launchs_own() {
        let dir = tempfile::tempdir().unwrap();
        let b = ledger::book(dir.path(), "default");
        let spec: tf_proto::methods::AgentSpec = serde_json::from_value(serde_json::json!({"kind": "omp", "plan": false, "prompt": "B's task"})).unwrap();
        let at = LaunchAt { name: "fixer".into(), pane_id: "p1".into(), workspace_id: "w1".into(), cwd: None };
        let mut g = ledger::open(&b);
        // B's launch at 1 000 (a predecessor A had the id before).
        assert!(record_into(&mut g, "ca", FirstPrompt { text: Some("B's task".into()), images: Ok(Vec::new()), guard: None, card: Some(launch_card(&[], &spec, at, 1_000)) }).0);
        let e = g.entries.get("ca").unwrap().clone();
        drop(g);
        let mut a = omp_agent("ca", "fixer");
        a.pane_id = "p1".into();
        assert!(own_launch(&e, &a));
        assert!(!observer_waits(false, Some(&e), &a) && !observer_waits(true, Some(&e), &a));
        // The board is a cached view published (pulled from herdr) before the launch and still shows
        // A under the id: nothing is adopted, nothing touched until a later tick.
        assert_eq!(entry_vs_agent(&e, &a, 900), Rel::Stale, "stale snapshot");
        // A view pulled after the launch shows the launch's own agent (no pid to check): adopted.
        assert_eq!(entry_vs_agent(&e, &a, 1_000), Rel::Same, "post-launch snapshot");
        assert_eq!(entry_vs_agent(&e, &a, 50_000), Rel::Same, "a long-running agent is learned once a post-launch snapshot shows it");
        // Another name or pane is never its own: the entry (and its prompt) moves aside.
        let mut other = a.clone();
        other.pane_id = "p9".into();
        assert!(!own_launch(&e, &other) && observer_waits(true, Some(&e), &other));
        assert_eq!(entry_vs_agent(&e, &other, 50_000), Rel::Other);
        let mut renamed = a.clone();
        renamed.name = "other".into();
        assert_eq!(entry_vs_agent(&e, &renamed, 50_000), Rel::Other);
        // A stale cached row (the snapshot was pulled before B's launch at 1 000) of ANOTHER agent
        // under the id never re-keys B's live launch entry: skipped, retried next tick.
        assert_eq!(entry_vs_agent(&e, &renamed, 900), Rel::Stale, "stale row, another name");
        assert_eq!(entry_vs_agent(&e, &other, 900), Rel::Stale, "stale row, another pane");
        // …and only a row with post-launch evidence that still does not match is `Other`.
        assert_eq!(entry_vs_agent(&e, &renamed, 1_000), Rel::Other, "post-launch row, another name");
        #[cfg(target_os = "linux")]
        {
            // By the boot clock: A's process (this one) started before B's launch stamp.
            let mut predecessor = renamed.clone();
            predecessor.omp.as_mut().unwrap().pid = Some(std::process::id());
            let mut stamped = e.clone();
            stamped.launch_boot = Some(stamp(ledger::boot_stamp().unwrap().ms + 3_600_000));
            assert_eq!(entry_vs_agent(&stamped, &predecessor, i64::MAX / 2), Rel::Stale, "A's process predates B's launch, whatever the snapshot says");
            stamped.launch_boot = Some(stamp(0));
            assert_eq!(entry_vs_agent(&stamped, &predecessor, 0), Rel::Other, "a process started after the launch that is another agent's");
        }
        // An entry no launch made is never taken for the agent's — but an empty stub holds nothing.
        assert_eq!(entry_vs_agent(&Entry { prompts: vec!["x".into()], ..Default::default() }, &a, 50_000), Rel::Other);
        assert_eq!(entry_vs_agent(&Entry::default(), &a, 50_000), Rel::Same);
        // An ended entry is never taken for it.
        let mut ended = e.clone();
        ended.record.ended = ended_entry().record.ended;
        assert!(!own_launch(&ended, &a));
        // A launch with no time (an older entry) has no evidence.
        let mut untimed = e.clone();
        untimed.record.started_at = None;
        assert_eq!(entry_vs_agent(&untimed, &a, 50_000), Rel::Stale);
        // With a pid on Linux the process decides, whatever the snapshot says: one that started
        // after the launch is its own; one that started before it is a predecessor's.
        #[cfg(target_os = "linux")]
        {
            let mut with_pid = a.clone();
            with_pid.omp.as_mut().unwrap().pid = Some(std::process::id());
            let mut early = e.clone();
            early.launch_boot = Some(stamp(0));
            assert_eq!(entry_vs_agent(&early, &with_pid, 0), Rel::Same, "this process started after boot ms 0");
            let mut later = e.clone();
            later.launch_boot = Some(stamp(ledger::boot_stamp().unwrap().ms + 3_600_000));
            assert_eq!(entry_vs_agent(&later, &with_pid, i64::MAX / 2), Rel::Stale, "its process started before this launch: a post-launch snapshot does not make it B's");
            let mut gone = a.clone();
            gone.omp.as_mut().unwrap().pid = Some(4_000_000_000);
            assert_eq!(entry_vs_agent(&early, &gone, 50_000), Rel::Stale, "a process nobody can read is no evidence");
        }
    }

    #[test]
    fn an_ended_card_that_never_told_its_session_is_a_fileless_card_with_a_key() {
        let dir = tempfile::tempdir().unwrap();
        let b = ledger::book(dir.path(), "default");
        let spec: tf_proto::methods::AgentSpec = serde_json::from_value(serde_json::json!({"kind": "omp", "plan": false})).unwrap();
        let at = |name: &str| LaunchAt { name: name.into(), pane_id: "p1".into(), workspace_id: "w1".into(), cwd: Some("/work/app".into()) };
        let mut g = ledger::open(&b);
        let k = FirstPrompt { text: Some("fix the build".into()), images: Ok(Vec::new()), guard: None, card: Some(launch_card(&[], &spec, at("fixer"), 77)) };
        assert!(record_into(&mut g, "ca", k).0);
        // The agent ended before the observer saw it: `end` makes the card from the entry's record.
        let mut rec = g.entries.get("ca").unwrap().record.clone();
        rec.ended = Some(tf_proto::autoresume::AgentEnded { at: 1, cause: tf_proto::autoresume::EndCause::OmpCrashed, reason: "omp ended".into(), turn: tf_proto::autoresume::EndedTurn::Idle, last_action: None });
        assert!(rec.session_id.is_none() && rec.session_file.is_empty());
        fileless_key(&mut rec);
        let key = rec.session_id.clone().expect("a key for its ticket and its entry");
        assert_eq!(key, "fresh:ca:77");
        assert!(is_fileless(&rec), "resume_parked routes it to the fileless path, not to a file check");
        // The card shows it (the restart ticket's key is the card's omp session id) and the ledger finds the entry by it.
        assert_eq!(crate::state::parked::parked_agent(&rec).omp.unwrap().session_id.as_deref(), Some(key.as_str()));
        g.entries.get_mut("ca").unwrap().record = rec.clone();
        drop(g);
        assert_eq!(ledger::find(dir.path(), "default", None, Some(&key)).map(|(id, _)| id).as_deref(), Some("ca"));
        // Its ticket is manual (Continue starts the kept prompt) and typed input is refused.
        let e = ledger::open(&b).entries.get("ca").cloned().unwrap();
        assert!(restart_hold(&e, 0).unwrap().contains("its prompt is kept"));
        assert!(refuse_typed(&Some(("hello".into(), Vec::new()))).is_err());
        // Two launches that shared an agent id get two keys; a real session or a file is never replaced.
        let mut again = rec.clone();
        again.session_id = None;
        again.started_at = Some(78);
        fileless_key(&mut again);
        assert_ne!(again.session_id, rec.session_id);
        let mut known = rec.clone();
        known.session_id = Some("sid-1".into());
        fileless_key(&mut known);
        assert_eq!(known.session_id.as_deref(), Some("sid-1"));
        let mut with_file = rec.clone();
        with_file.session_id = None;
        with_file.session_file = "/s/a.jsonl".into();
        fileless_key(&mut with_file);
        assert!(with_file.session_id.is_none() && !is_fileless(&with_file));
    }

    #[test]
    fn a_launchs_entry_is_a_complete_card_before_any_observation() {
        let dir = tempfile::tempdir().unwrap();
        let b = ledger::book(dir.path(), "default");
        let mut g = ledger::open(&b);
        let spec: tf_proto::methods::AgentSpec = serde_json::from_value(serde_json::json!({"kind": "omp", "plan": false, "model": "anthropic/opus-5.5:high", "prompt": "fix the build"})).unwrap();
        let at = LaunchAt { name: "fixer".into(), pane_id: "p1".into(), workspace_id: "w1".into(), cwd: Some("/work/app".into()) };
        let card = launch_card(&[], &spec, at, 77);
        let k = FirstPrompt { text: Some("fix the build".into()), images: Ok(Vec::new()), guard: None, card: Some(card) };
        assert!(record_into(&mut g, "ca", k).0);
        // The agent ends right after its launch: the observer never saw it. What its ended card is
        // made of (`record`, cloned by `ends`) and what Continue needs are all there.
        let e = g.entries.get("ca").unwrap();
        let r = &e.record;
        assert_eq!((r.agent_id.as_str(), r.name.as_str(), r.title.as_str(), r.kind.as_str()), ("ca", "fixer", "fixer", "omp"));
        assert_eq!((r.cwd.as_deref(), r.workspace_id.as_deref(), r.started_at, e.pane_id.as_str()), (Some("/work/app"), Some("w1"), Some(77), "p1"));
        assert_eq!(r.model.as_ref().map(|m| (m.provider.as_str(), m.id.as_str())), Some(("anthropic", "opus-5.5")));
        assert!(r.session_file.is_empty() && !has_identity(e), "no session yet: a fileless card");
        assert_eq!(e.first_prompt().as_deref(), Some("fix the build"));
        assert!(e.fresh_hold().contains("its prompt is kept"));
        assert!(!is_empty_stub(e));
    }

    #[test]
    fn while_a_launch_is_in_flight_the_observer_creates_no_entry_and_the_guard_always_lets_go() {
        let stub = Entry::default();
        let known = Entry { record: crate::state::persist::ParkedRecord { session_file: "/s/a.jsonl".into(), ..Default::default() }, ..Default::default() };
        let mut a = omp_agent("ca", "fixer");
        a.pane_id = "p1".into();
        // Not gated: the observer works as ever.
        assert!(!observer_waits(false, None, &a) && !observer_waits(false, Some(&stub), &a));
        // Gated: no entry is created (so none can appear under the id being launched), and a stub
        // that knows no session is left alone; an entry with a session is updated as before.
        assert!(observer_waits(true, None, &a) && observer_waits(true, Some(&stub), &a));
        assert!(!observer_waits(true, Some(&known), &a));
        // An entry a launch made for THIS agent (its name and pane) is always observed and refined,
        // even while another launch is gated; another agent's (other name or pane) is not.
        let mut launch_made = launch_card(&[], &serde_json::from_value(serde_json::json!({"kind": "omp", "plan": false})).unwrap(), LaunchAt { name: "fixer".into(), pane_id: a.pane_id.clone(), workspace_id: "w1".into(), cwd: None }, 1);
        assert!(!observer_waits(true, Some(&launch_made), &a));
        launch_made.record.name = "other".into();
        assert!(observer_waits(true, Some(&launch_made), &a));
        // The gate is held by the launch's record and released on every path, the error path included.
        let before = LAUNCHES.load(std::sync::atomic::Ordering::SeqCst);
        let launch = |fail: bool| -> Result<(), ()> {
            let k = FirstPrompt { text: None, images: Ok(Vec::new()), guard: Some(LaunchGuard::new()), card: None };
            assert!(launch_in_flight());
            if fail {
                return Err(()); // agent start failed: `k` is dropped here
            }
            let mut k = k;
            let _gate = k.guard.take();
            Ok(())
        };
        assert!(launch(true).is_err());
        assert_eq!(LAUNCHES.load(std::sync::atomic::Ordering::SeqCst), before, "released after a failed launch");
        assert!(launch(false).is_ok());
        assert_eq!(LAUNCHES.load(std::sync::atomic::Ordering::SeqCst), before, "released after a recorded launch");
    }

    #[test]
    fn an_ended_entry_is_returned_to_only_with_proof_that_its_omp_is_alive() {
        use tf_proto::model::LinkState;
        let mut old = Entry { prompts: vec!["fix it".into()], ..ended_entry() };
        old.record.session_id = Some("sid-old".into());
        let mut a = omp_agent("t1", "fixer");
        {
            let o = a.omp.as_mut().unwrap();
            o.session_file = Some("/s/a.jsonl".into());
            o.session_id = Some("sid-old".into());
            o.pid = None;
            o.link = LinkState::NotShared;
        }
        // Same session, but liveness unknown (no pid, no live link): `Stale`: never unparked, never clears a launch.
        assert_eq!(entry_vs_agent(&old, &a, 0), Rel::Stale);
        // A pid that is confirmed gone is a NO even with a live bridge link (never falls through to the link).
        #[cfg(target_os = "linux")]
        {
            let mut dead = a.clone();
            dead.omp.as_mut().unwrap().pid = Some(4_000_000_000);
            dead.omp.as_mut().unwrap().link = LinkState::Live;
            assert_eq!(entry_vs_agent(&old, &dead, 0), Rel::Stale, "dead pid + live link");
        }
        // A live bridge link for that very session id is proof (the way off Linux, or without a pid).
        a.omp.as_mut().unwrap().link = LinkState::Live;
        assert_eq!(entry_vs_agent(&old, &a, 0), Rel::Same);
        a.omp.as_mut().unwrap().session_id = Some("other".into());
        a.omp.as_mut().unwrap().session_file = Some("/s/other.jsonl".into());
        assert_eq!(entry_vs_agent(&old, &a, 0), Rel::Other, "another session, link or not");
        #[cfg(target_os = "linux")]
        {
            // A live process whose command line names the session file: proof.
            let me = std::process::id();
            let cmdline = herdr::cmdline(me).unwrap();
            let mut named = old.clone();
            named.record.session_file = cmdline.iter().find(|s| s.len() > 3).cloned().unwrap();
            let mut b = omp_agent("t1", "fixer");
            {
                let o = b.omp.as_mut().unwrap();
                o.session_file = Some(named.record.session_file.clone());
                o.session_id = Some("sid-old".into());
                o.pid = Some(me);
                o.link = LinkState::NotShared;
            }
            assert_eq!(entry_vs_agent(&named, &b, 0), Rel::Same);
            // A live process that does not name it, a dead one: no proof.
            named.record.session_file = "/s/not-on-any-command-line.jsonl".into();
            b.omp.as_mut().unwrap().session_file = Some(named.record.session_file.clone());
            assert_eq!(entry_vs_agent(&named, &b, 0), Rel::Stale);
            b.omp.as_mut().unwrap().pid = Some(4_000_000_000);
            assert_eq!(entry_vs_agent(&named, &b, 0), Rel::Stale);
        }
    }

    #[test]
    fn a_fresh_successor_under_the_same_id_is_never_the_return_and_never_clears_the_launch() {
        let mut old = Entry { prompts: vec!["fix it".into()], ..ended_entry() };
        old.launching = Some(launching(None));
        // The successor: another session path, no file yet.
        let mut fresh = omp_agent("t1", "fixer");
        fresh.omp.as_mut().unwrap().session_file = Some("/s/new-never-written.jsonl".into());
        assert_eq!(entry_vs_agent(&old, &fresh, 0), Rel::Other, "re-key, not 'back without a relaunch': the launch stays on the card's entry");
        // The same session coming back, with a live bridge link for it, is still "back without a relaunch".
        let mut back = omp_agent("t1", "fixer");
        {
            let o = back.omp.as_mut().unwrap();
            o.session_file = Some("/s/a.jsonl".into());
            o.session_id = Some("sid-old".into());
            o.link = tf_proto::model::LinkState::Live;
        }
        old.record.session_id = Some("sid-old".into());
        assert_eq!(entry_vs_agent(&old, &back, 0), Rel::Same);
        // A registry that still shows the dead omp under a reused id (no live link) is no return either.
        back.omp.as_mut().unwrap().link = tf_proto::model::LinkState::NotShared;
        assert_eq!(entry_vs_agent(&old, &back, 0), Rel::Stale);
        // The launch then sends the kept prompt once, to the successor (see `launch_step`).
        assert_eq!(launch_step(old.launching.as_ref().unwrap(), 9_000, false, true, true, false, false), LaunchStep::Send);
        // An agent not ended yet and the same process after a session switch: not a collision.
        let mut live = Entry { pid: Some(7), ..ended_entry() };
        live.record.ended = None;
        let mut switched = fresh.clone();
        switched.omp.as_mut().unwrap().pid = Some(7);
        assert_eq!(entry_vs_agent(&live, &switched, 0), Rel::Same);
    }

    #[test]
    fn a_failed_ledger_save_moves_nothing_so_no_card_moves_either() {
        let dir = tempfile::tempdir().unwrap();
        let b = ledger::book(dir.path(), "default");
        let mut old = Entry { prompts: vec!["fix it".into()], ..ended_entry() };
        old.record.session_id = Some("sid-old".into());
        ledger::open(&b).entries.insert("t1".into(), old.clone());
        // The ledger file cannot be read, so it cannot be written: the save fails.
        std::fs::create_dir(ledger::path(dir.path())).unwrap();
        let mut g = ledger::open(&b);
        let (saved, moved) = record_into(&mut g, "t1", FirstPrompt { text: Some("look".into()), images: Ok(Vec::new()), guard: None, card: None });
        assert!(!saved && moved.is_none(), "nothing for the caller to move in state.json");
        assert_eq!(g.entries.keys().collect::<Vec<_>>(), ["t1"], "everything put back: the ended entry under its old key, no live entry");
        assert_eq!(g.entries.get("t1"), Some(&old));
        // The same for a re-key on its own: undone, and the caller (`rekey_ended`) stops there.
        let moved = rekey_in_book(&mut g, "t1").unwrap();
        assert!(!g.save(1, false, 0));
        undo_rekey(&mut g, "t1", &moved);
        assert_eq!(g.entries.get("t1").map(|e| e.record.agent_id.as_str()), Some("t1"));
        assert!(!g.entries.contains_key(&moved));
    }

    #[test]
    fn a_card_left_behind_by_a_crash_after_the_ledger_save_is_the_entrys_card() {
        // The ledger says `t1~xxxx`; state.json still has the card under `t1` (same session).
        let mut old = ended_entry();
        old.record.session_id = Some("sid-old".into());
        let key = rekey_name("t1", &old);
        let card = |agent: &str, sid: Option<&str>, file: &str| crate::state::persist::ParkedRecord {
            agent_id: agent.into(),
            session_id: sid.map(Into::into),
            session_file: file.into(),
            ended: old.record.ended.clone(),
            ..Default::default()
        };
        assert!(same_card(&card("t1", Some("sid-old"), "/s/other.jsonl"), &old), "by omp session id");
        assert!(same_card(&card("t1", None, "/s/a.jsonl"), &old), "or by session file");
        assert!(!same_card(&card("t1", Some("sid-other"), "/s/other.jsonl"), &old), "a different session's card is never moved");
        let live = crate::state::persist::ParkedRecord { ended: None, ..card("t1", Some("sid-old"), "/s/a.jsonl") };
        assert!(!same_card(&live, &old), "only an ended card");
        assert!(key.starts_with("t1~"), "stale splits the key at '~' to find the old id");
        assert_eq!(key.split_once('~').map(|(b, _)| b), Some("t1"));
    }

    #[test]
    fn a_request_to_the_original_id_after_the_re_key_is_busy_or_resends() {
        // The successor is live under "t1"; the ended card (with the launch) lives under "t1~…".
        let mut old = Entry { prompts: vec!["fix it".into()], ..ended_entry() };
        old.launching = Some(launching(Some(5)));
        let key = rekey_name("t1", &old);
        let mut entries = std::collections::BTreeMap::new();
        entries.insert(key.clone(), old.clone());
        entries.insert("t2".into(), ended_entry());
        let (k, l) = launch_of_successor(&entries, "t1", "fixer").expect("t1 is the successor of a pending launch");
        assert_eq!(k, &key);
        let agents = vec![omp_agent("t1", "fixer")];
        assert!(matches!(continue_route(Some(l), &agents, 10_000), ContinueRoute::Busy(n) if n == "fixer"));
        // Unconfirmed: resend by id.
        old.launching = Some(ledger::Launching { unconfirmed: true, ..launching(Some(5)) });
        entries.insert(key, old);
        let (_, l) = launch_of_successor(&entries, "t1", "fixer").unwrap();
        assert!(matches!(continue_route(Some(l), &agents, 10_000), ContinueRoute::Resend(a) if a.id == "t1"));
        // Another agent under another id, another name, a settled launch: not a successor.
        assert!(launch_of_successor(&entries, "t3", "fixer").is_none());
        assert!(launch_of_successor(&entries, "t1", "scout").is_none());
        let mut settled = entries.clone();
        for e in settled.values_mut() {
            if let Some(l) = e.launching.as_mut() {
                l.settled = true;
            }
        }
        assert!(launch_of_successor(&settled, "t1", "fixer").is_none());
    }

    #[test]
    fn inv4_a_second_continue_is_busy_while_the_launch_is_pending_and_resends_when_unconfirmed() {
        let successor = omp_agent("t9", "fixer");
        let agents = vec![successor];
        let pending = launching(Some(5));
        assert!(matches!(continue_route(Some(&pending), &agents, 10_000), ContinueRoute::Busy(n) if n == "fixer"));
        // Started a moment ago, not on the board yet: busy too.
        assert!(matches!(continue_route(Some(&launching(None)), &[], 1_000 + 5_000), ContinueRoute::Busy(n) if n == "fixer"));
        // Unconfirmed: sent again to that very agent.
        let unconfirmed = ledger::Launching { unconfirmed: true, ..pending.clone() };
        assert!(matches!(continue_route(Some(&unconfirmed), &agents, 10_000), ContinueRoute::Resend(a) if a.id == "t9"));
        // No launch, a lost one, or a settled one: start.
        assert!(matches!(continue_route(None, &agents, 10_000), ContinueRoute::Start));
        assert!(matches!(continue_route(Some(&launching(None)), &[], 1_000 + LAUNCH_SETTLE_MS), ContinueRoute::Start));
        let settled = ledger::Launching { settled: true, ..pending };
        assert!(matches!(continue_route(Some(&settled), &agents, 10_000), ContinueRoute::Start));
    }

    #[test]
    fn a_kept_prompt_with_images_is_never_retired_automatically() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.jsonl");
        let image = "{\"type\":\"image\",\"data\":\"aGk=\",\"mimeType\":\"image/png\"}";
        let msg = |blocks: &str| format!("{{\"type\":\"session\",\"id\":\"s1\"}}\n{{\"type\":\"message\",\"id\":\"u\",\"message\":{{\"role\":\"user\",\"content\":[{blocks}]}}}}\n");
        // Text only, the very prompt: the card goes.
        std::fs::write(&file, msg("{\"type\":\"text\",\"text\":\"fix it\"}")).unwrap();
        assert!(may_retire(&file, " fix it ", 0));
        assert!(!may_retire(&file, "fix it again", 0));
        // A kept prompt with images: even a first message with the same text and image count is
        // no proof the right images went with it; the card stays for the user.
        std::fs::write(&file, msg(&format!("{{\"type\":\"text\",\"text\":\"fix it\"}},{image}"))).unwrap();
        assert!(!may_retire(&file, "fix it", 1));
        assert!(!may_retire(&file, "fix it", 0), "and text alone does not match a message that has an image");
    }

    #[test]
    fn the_old_card_goes_only_when_the_new_sessions_first_user_message_is_the_kept_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.jsonl");
        let header = "{\"type\":\"session\",\"id\":\"s1\"}\n";
        let user = |content: &str| format!("{{\"type\":\"message\",\"id\":\"u\",\"message\":{{\"role\":\"user\",\"content\":{content}}}}}\n");
        let text = |t: &str| format!("{{\"type\":\"text\",\"text\":\"{t}\"}}");
        let image = "{\"type\":\"image\",\"data\":\"aGk=\",\"mimeType\":\"image/png\"}";
        assert!(!first_user_message_is(&file, "fix it", 0), "no file");
        std::fs::write(&file, header).unwrap();
        assert!(!first_user_message_is(&file, "fix it", 0), "a header alone");
        // The kept prompt (as a string, or as blocks; trimmed).
        std::fs::write(&file, format!("{header}{}", user("\"  fix it\\n\""))).unwrap();
        assert!(first_user_message_is(&file, "fix it", 0));
        std::fs::write(&file, format!("{header}{}", user(&format!("[{}]", text("fix it"))))).unwrap();
        assert!(first_user_message_is(&file, "fix it\n", 0));
        // Somebody typed something else into the new agent first: not the kept prompt, even if the
        // kept prompt follows as a later message.
        std::fs::write(&file, format!("{header}{}{}", user("\"hello?\""), user("\"fix it\""))).unwrap();
        assert!(!first_user_message_is(&file, "fix it", 0));
        // The same text with another number of images is another prompt.
        std::fs::write(&file, format!("{header}{}", user(&format!("[{},{image}]", text("fix it"))))).unwrap();
        assert!(!first_user_message_is(&file, "fix it", 0));
        assert!(!first_user_message_is(&file, "fix it", 2));
        assert!(first_user_message_is(&file, "fix it", 1));
        std::fs::write(&file, format!("{header}{}", user(&format!("[{image}]")))).unwrap();
        assert!(first_user_message_is(&file, "", 1), "an image-only prompt");
    }

    #[test]
    fn text_typed_on_a_fileless_card_is_refused_so_the_client_keeps_its_draft() {
        let e = refuse_typed(&Some(("more".to_string(), Vec::new()))).unwrap_err();
        assert_eq!((e.code.as_str(), e.retryable), ("busy", true));
        assert!(e.message.starts_with("Press Continue first"), "{}", e.message);
        assert!(refuse_typed(&None).is_ok(), "Continue carries only the kept prompt");
    }

    fn ended_entry() -> Entry {
        let mut e = Entry::default();
        e.record.agent_id = "t1".into();
        e.record.name = "fixer".into();
        e.record.session_file = "/s/a.jsonl".into();
        e.record.ended = Some(tf_proto::autoresume::AgentEnded { at: 1, cause: EndCause::HerdrStopped, reason: "herdr stopped".into(), turn: EndedTurn::Idle, last_action: None });
        e
    }

    #[test]
    fn inv1_an_agent_whose_file_exists_when_its_end_is_planned_is_never_fileless() {
        // omp writes the file at its SIGHUP exit, after hostd's last sighting (file_seen false).
        let dir = tempfile::tempdir().unwrap();
        let book = ledger::book(dir.path(), "default");
        ledger::open(&book).entries.insert("t1".into(), ended_entry());
        let fileless = |book: &Arc<Mutex<Book>>| restart_hold(ledger::open(book).entries.get("t1").unwrap(), 0);
        assert!(fileless(&book).unwrap().contains("before its first reply"), "no file found yet: fileless");
        // The plan (`ends`, `plan_ended`) finds the file:
        mark_file_seen(&book, "t1");
        assert_eq!(fileless(&book), None, "it comes back by --resume, by itself");
        assert!(ledger::open(&book).entries.get("t1").unwrap().file_seen);
        assert!(ledger::open(&book).is_dirty());
    }

    #[test]
    fn inv2_the_first_prompt_is_recorded_when_hostd_starts_the_agent_and_is_not_replaced_by_the_replica() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let given = vec![ImageInput { mime: "image/png".into(), data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\x89PNG shot") }];
        let kept = images::keep_inputs(home, &given);
        let b = ledger::book(home, "default");
        {
            let mut g = ledger::open(&b);
            assert!(record_into(&mut g, "t5", FirstPrompt { text: Some("look at this".into()), images: kept, guard: None, card: None }).0);
        }
        // Saved already (hostd may die now): the prompt, the image's file, the flag.
        let e = ledger::open(&b).entries.get("t5").cloned().unwrap();
        assert_eq!((e.prompts.clone(), e.recorded, e.images_lost.clone()), (vec!["look at this".to_string()], true, None));
        assert!(images::load(home, &e.images[0]).is_ok());
        assert_eq!(ledger::sessions(home), ["default"]);
        // Killed while fileless: the card says its prompt is kept, and Continue has it.
        let mut ended = e.clone();
        ended.record = ended_entry().record;
        assert!(restart_hold(&ended, 0).unwrap().contains("its prompt is kept"));
        assert_eq!(ended.first_prompt().as_deref(), Some("look at this"));
        assert_eq!(ended.images.len(), 1);
        // Images that cannot be kept: the text is, and the entry says why.
        let mut g = ledger::open(&b);
        assert!(record_into(&mut g, "t6", FirstPrompt { text: Some("and this".into()), images: Err("too big".into()), guard: None, card: None }).0);
        let e6 = g.entries.get("t6").unwrap();
        assert_eq!((e6.first_prompt().as_deref(), e6.images.len(), e6.images_lost.as_deref()), (Some("and this"), 0, Some("too big")));
        // The ended card of a reused agent id moves to a key of its own (see the re-key test).
        let old = Entry { prompts: vec!["old task".into()], ..ended_entry() };
        let key = rekey_name("t7", &old);
        g.entries.insert("t7".into(), old);
        let (saved, moved) = record_into(&mut g, "t7", FirstPrompt { text: Some("other".into()), images: Ok(Vec::new()), guard: None, card: None });
        assert!(saved && moved.as_deref() == Some(key.as_str()));
        assert_eq!(g.entries.get("t7").unwrap().first_prompt().as_deref(), Some("other"));
        assert_eq!(g.entries.get(&key).unwrap().first_prompt().as_deref(), Some("old task"));
    }

    #[test]
    fn inv3_a_card_never_claims_a_kept_prompt_when_none_is() {
        let mut e = ended_entry();
        let why = restart_hold(&e, 0).unwrap();
        assert!(why.contains("before its first reply") && why.contains("no prompt was recorded") && !why.contains("prompt is kept"), "{why}");
        e.prompts = vec!["  ".into()];
        assert!(!restart_hold(&e, 0).unwrap().contains("prompt is kept"), "a blank prompt is no prompt");
        e.prompts = vec!["fix it".into()];
        assert!(restart_hold(&e, 0).unwrap().contains("its prompt is kept"));
        e.prompts.clear();
        e.images_lost = Some("an image has no payload".into());
        let why = restart_hold(&e, 0).unwrap();
        assert!(why.contains("no prompt was recorded") && why.contains("no payload") && !why.contains("prompt is kept"), "{why}");
    }

    #[test]
    fn inv4_continue_sends_an_unconfirmed_prompt_again_to_the_same_agent() {
        let dir = tempfile::tempdir().unwrap();
        let b = ledger::book(dir.path(), "default");
        let mut e = Entry { prompts: vec!["fix it".into()], hold: Some("couldn't confirm its first prompt was taken".into()), ..ended_entry() };
        e.launching = Some(ledger::Launching { at: 1, name: "fixer".into(), sent_at: Some(2), unconfirmed: true, settled: false });
        ledger::open(&b).entries.insert("t1".into(), e);
        assert!(!send_again(&b, "nope"));
        assert!(send_again(&b, "t1"));
        let g = ledger::open(&b);
        let e = g.entries.get("t1").unwrap();
        assert_eq!(e.launching.as_ref().map(|l| (l.sent_at, l.unconfirmed)), Some((None, false)), "the worker sends it once more");
        assert_eq!(e.hold, None);
        assert_eq!(e.first_prompt().as_deref(), Some("fix it"), "the kept prompt is still there");
        drop(g);
        assert!(!send_again(&b, "t1"), "nothing unconfirmed any more: a second Continue is `busy`");
    }
}
