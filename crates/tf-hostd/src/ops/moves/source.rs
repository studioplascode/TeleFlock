//! The source side of a move: `move.start` (push, carry the uncommitted changes, close the agent,
//! pack its session), `move.read` (the app copies the parts), `move.finish` (mark the copy left
//! here moved) and the rollback (`move.abort`, a failed step, a silent app).

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use sha2::Digest as _;
use tracing::{info, warn};

use tf_proto::model::{ActivityKind, Agent};
use tf_proto::{
    ApiError, MoveChunk, MoveFinishParams, MovePart, MovePhase, MoveReadParams, MoveRole, MoveStartParams, MoveStatus,
    MoveStepState, MoveTo, ParkedMove, ParkedMoveState,
};

use super::facts::{self, GitFacts, Subject};
use super::jobs::{self, Job};
use super::ompcli;
use crate::ops::git::{self, git_env, git_remote};
use crate::ops::{herdr_err, Ctx};
use crate::state::parked;
use crate::state::persist::ParkedWorktree;
use crate::util::now_ms;

/// `git push` of the branch (pre-push hooks run: the user asked for the move).
const PUSH: Duration = Duration::from_secs(180);
/// Building the changes patch (a temporary index: every tracked file is hashed once).
const CHANGES: Duration = Duration::from_secs(120);
/// `omp session pack` of a large session.
const PACK: Duration = Duration::from_secs(600);
/// omp gives its session lease up when it exits; a closed pane's omp takes a moment.
const EXIT_WAIT: Duration = Duration::from_secs(15);
/// A packed move waits this long for the app (`move.read`, `move.status`, `move.finish`) before
/// it counts as interrupted.
pub const READY_IDLE: Duration = Duration::from_secs(30 * 60);
/// `move.read` returns at most this much per call (`upload.chunk` takes the same).
pub const MAX_READ: u32 = 1 << 20;

/// What a source job keeps once it runs: the staging folder, the parts, and what to undo.
pub struct Data {
    pub staging: PathBuf,
    pub agent_id: String,
    pub name: String,
    pub session_file: String,
    pub to: MoveTo,
    /// The move closed the agent's pane (a rollback resumes it).
    pub closed: bool,
    /// The agent was in Done (archived) before the move closed it.
    pub was_archived: bool,
    /// The parked card's mark before this move (an `interrupted` one comes back on rollback).
    pub prev_mark: Option<ParkedMove>,
    /// The parked record carries this move's mark.
    pub marked: bool,
    pub parts: Vec<(MovePart, PathBuf)>,
}

struct Entry {
    data: Mutex<Data>,
    /// Serializes finish / abort / the silent-app timeout.
    op: tokio::sync::Mutex<()>,
}

static SOURCES: LazyLock<Mutex<HashMap<String, Arc<Entry>>>> = LazyLock::new(Default::default);

fn entry(id: &str) -> Option<Arc<Entry>> {
    SOURCES.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
}

fn forget(id: &str) {
    SOURCES.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn aborted() -> ApiError {
    ApiError::new("aborted", "the move was cancelled")
}

/// `move.start`: checks the agent (no network: the job asks the remote) and starts the job.
pub async fn start(ctx: &Ctx, p: MoveStartParams) -> Result<MoveStatus, ApiError> {
    let label = p.to.label.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.is_empty() {
        return Err(ApiError::new("invalid_params", "name the host the agent moves to (to.label)"));
    }
    let s = facts::subject(ctx, &p.agent_id)?;
    let omp_version = ctx.state.snapshot().info.omp.map(|v| v.version);
    if let Some(err) = facts::blocked(&facts::agent_issues(&s, omp_version.as_deref())) {
        return Err(err);
    }
    let session_file = s.session_file.clone().unwrap_or_default();
    let id = jobs::new_id();
    let steps = [
        ("push", "Push the branch".to_string()),
        ("changes", "Carry the uncommitted changes".to_string()),
        ("close", format!("Close {} here", s.name)),
        ("pack", "Pack the session".to_string()),
        ("finish", "Mark the copy left here moved".to_string()),
    ];
    let job = jobs::insert(Job::new(&id, MoveRole::Source, &ctx.herdr_session, &s.agent_id, &steps))?;
    let to = MoveTo { label, host_id: p.to.host_id.clone() };
    let data = Data {
        staging: ctx.paths.moves.join(&id),
        agent_id: s.agent_id.clone(),
        name: s.name.clone(),
        session_file,
        to,
        closed: false,
        was_archived: s.archived,
        prev_mark: s.parked.as_ref().and_then(|r| r.moved.clone()),
        marked: false,
        parts: Vec::new(),
    };
    let entry = Arc::new(Entry { data: Mutex::new(data), op: tokio::sync::Mutex::new(()) });
    SOURCES.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), entry.clone());
    info!(move_id = %id, agent = %s.agent_id, to = %p.to.label, "move: starting (source)");
    let ctx = ctx.arc();
    let status = job.status();
    tokio::spawn(async move {
        let res = run(&ctx, &job, &entry, s).await;
        match res {
            Ok(()) => {}
            Err(e) => {
                let _op = entry.op.lock().await;
                rollback(&ctx, &job, &entry, &e).await;
                job.fail(e);
            }
        }
    });
    Ok(status)
}

/// Runs `fut` unless `move.abort` comes first.
async fn or_abort<T>(job: &Job, fut: impl Future<Output = Result<T, ApiError>>) -> Result<T, ApiError> {
    tokio::select! {
        r = fut => r,
        () = job.cancel.cancelled() => Err(aborted()),
    }
}

fn check_abort(job: &Job) -> Result<(), ApiError> {
    if job.cancel.is_cancelled() { Err(aborted()) } else { Ok(()) }
}

async fn run(ctx: &Arc<Ctx>, job: &Arc<Job>, entry: &Arc<Entry>, s: Subject) -> Result<(), ApiError> {
    let staging = lock(&entry.data).staging.clone();
    crate::paths::create_private_dir(&staging).map_err(|e| ApiError::new("io_error", format!("creating {}: {e}", staging.display())))?;
    let marker = serde_json::json!({ "moveId": job.id, "role": "source", "agentId": s.agent_id, "herdrSession": ctx.herdr_session, "at": now_ms() });
    let _ = crate::paths::write_atomic(&staging.join("source.json"), marker.to_string().as_bytes());

    // The facts again, the remote asked this time: blockers that appeared since the preflight stop it.
    job.step("push", MoveStepState::Running, Some("checking the remote".into()));
    let (mut check, _, git) = or_abort(job, facts::check(ctx, &s.agent_id, true)).await?;
    if let Some(err) = facts::blocked(&check.issues) {
        return Err(err);
    }
    check_abort(job)?;

    // push
    match &git {
        Some(g) if g.needs_push() => {
            let (branch, remote) = (g.branch.clone().unwrap_or_default(), g.remote.clone().unwrap_or_default());
            let what = match g.ahead() {
                Some(n) => format!("{n} commit{}", if n == 1 { "" } else { "s" }),
                None => "the new branch".into(),
            };
            job.label("push", format!("Push {branch} to {remote}"));
            job.step("push", MoveStepState::Running, Some(what));
            or_abort(job, push(g)).await?;
            if let Some(cg) = check.git.as_mut() {
                cg.ahead = Some(0);
            }
            job.step("push", MoveStepState::Done, None);
        }
        Some(g) => {
            job.label("push", format!("Push {}", g.branch.as_deref().unwrap_or("the branch")));
            job.step("push", MoveStepState::Skipped, Some(format!("already on {}", g.remote.as_deref().unwrap_or("the remote"))));
        }
        None => job.step("push", MoveStepState::Skipped, Some("not a git repository".into())),
    }
    check_abort(job)?;

    // changes
    match &git {
        Some(g) if g.dirty > 0 => {
            job.label("changes", format!("Carry {} uncommitted file{}", g.dirty, if g.dirty == 1 { "" } else { "s" }));
            job.step("changes", MoveStepState::Running, None);
            let head = g.head.clone().unwrap_or_default();
            match or_abort(job, write_changes(&g.top, &head, &staging)).await? {
                Some(part) => {
                    job.step("changes", MoveStepState::Done, Some(facts::bytes(part.0.size)));
                    lock(&entry.data).parts.push(part);
                }
                None => job.step("changes", MoveStepState::Skipped, Some("nothing git would carry".into())),
            }
        }
        _ => job.step("changes", MoveStepState::Skipped, Some("no uncommitted changes".into())),
    }
    check_abort(job)?;

    // close (a live agent): park it now, marked moving, and wait for its omp to exit
    let mark = {
        let d = lock(&entry.data);
        ParkedMove { state: ParkedMoveState::Moving, move_id: job.id.clone(), to: d.to.label.clone(), host_id: d.to.host_id.clone(), agent_id: None, at: now_ms() }
    };
    if s.parked.is_some() {
        if !ctx.state.set_parked_move(&s.agent_id, Some(mark)) {
            return Err(ApiError::new("not_found", format!("{} is no longer in Done", s.name)));
        }
        lock(&entry.data).marked = true;
        job.step("close", MoveStepState::Skipped, Some("its pane was closed already".into()));
    } else {
        job.step("close", MoveStepState::Running, None);
        close(ctx, &s, mark, entry).await?;
        job.step("close", MoveStepState::Done, None);
    }
    check_abort(job)?;

    // pack
    job.step("pack", MoveStepState::Running, None);
    let file = lock(&entry.data).session_file.clone();
    let archive = staging.join("session.tar");
    let warnings = or_abort(job, pack(&file, &archive)).await?;
    if let Some(w) = warnings {
        job.note(w);
    }
    let (size, sha256) = tokio::task::spawn_blocking({
        let archive = archive.clone();
        move || hash_file(&archive)
    })
    .await
    .map_err(|e| ApiError::new("internal", e.to_string()))?
    .map_err(|e| ApiError::new("io_error", format!("reading the session archive: {e}")))?;
    job.step("pack", MoveStepState::Done, Some(facts::bytes(size)));
    lock(&entry.data).parts.insert(0, (MovePart { name: "session".into(), size, sha256 }, archive));

    let _op = entry.op.lock().await;
    check_abort(job)?;
    let parts: Vec<MovePart> = lock(&entry.data).parts.iter().map(|(p, _)| p.clone()).collect();
    job.touch();
    job.update(|st| {
        st.phase = MovePhase::Ready;
        st.parts = parts;
        st.source = Some(check);
    });
    info!(move_id = %job.id, "move: packed, waiting for the target");
    Ok(())
}

/// Pushes the agent's branch to its remote under its own name (tracking it when it tracked
/// nothing). Hooks run: the user asked for the move.
async fn push(g: &GitFacts) -> Result<(), ApiError> {
    let (Some(branch), Some(remote)) = (g.branch.as_deref(), g.remote.as_deref()) else {
        return Err(ApiError::new("move_blocked", "nothing to push"));
    };
    let tracks = git::git(&g.top, &["config", "--get", &format!("branch.{branch}.merge")], Duration::from_secs(10)).await.is_ok_and(|o| o.ok());
    let dst = format!("HEAD:refs/heads/{branch}");
    let mut args = vec!["push", "--porcelain"];
    if !tracks {
        args.push("--set-upstream");
    }
    args.extend([remote, dst.as_str()]);
    let out = git_remote(&g.top, &args, PUSH).await?;
    if out.ok() {
        Ok(())
    } else {
        let mut err = git::git_failure(&out, "push");
        if err.code == "git_error" {
            err.code = "push_failed".into();
        }
        Err(err)
    }
}

/// The uncommitted changes (staged, unstaged, untracked, minus what `.gitignore` excludes) as one
/// binary patch against `head`: a temporary index takes `git add -A`, `git diff --binary` compares
/// its tree with HEAD. The checkout and its index are not touched.
pub async fn write_changes(top: &Path, head: &str, staging: &Path) -> Result<Option<(MovePart, PathBuf)>, ApiError> {
    let index = staging.join("changes.index");
    let patch = staging.join("changes.patch");
    let index_s = index.display().to_string();
    let env = [("GIT_INDEX_FILE", index_s.as_str())];
    let res = async {
        let run = |args: Vec<String>| async move {
            let out = git_env(top, &args, &env, CHANGES).await?;
            if out.ok() { Ok(out) } else { Err(ApiError::new("changes_failed", format!("git {}: {}", args[0], out.message()))) }
        };
        run(vec!["read-tree".into(), head.into()]).await?;
        run(vec!["add".into(), "-A".into()]).await?;
        let tree = run(vec!["write-tree".into()]).await?.line();
        run(vec!["diff".into(), "--binary".into(), "--full-index".into(), format!("--output={}", patch.display()), head.into(), tree]).await?;
        Ok::<(), ApiError>(())
    }
    .await;
    let _ = std::fs::remove_file(&index);
    res?;
    let patch_c = patch.clone();
    let (size, sha256) = tokio::task::spawn_blocking(move || hash_file(&patch_c))
        .await
        .map_err(|e| ApiError::new("internal", e.to_string()))?
        .map_err(|e| ApiError::new("io_error", format!("reading the changes patch: {e}")))?;
    if size == 0 {
        let _ = std::fs::remove_file(&patch);
        return Ok(None);
    }
    Ok(Some((MovePart { name: "changes".into(), size, sha256 }, patch)))
}

/// Parks a live agent now (no undo window), its card marked moving, and waits for its omp to
/// let go of the session.
async fn close(ctx: &Ctx, s: &Subject, mark: ParkedMove, entry: &Entry) -> Result<(), ApiError> {
    let a: Agent = ctx.state.agent(&s.agent_id).filter(|a| a.parked.is_none()).ok_or_else(|| ApiError::new("not_found", format!("{} is gone", s.name)))?;
    let fresh = Subject::from_agent(&a);
    if let Some(err) = facts::blocked(&facts::agent_issues(&fresh, None)) {
        return Err(err);
    }
    if !a.archived && !ctx.state.set_archived(&a.id, true) {
        return Err(ApiError::new("not_found", format!("{} is gone", s.name)));
    }
    let undo_archive = |ctx: &Ctx| {
        if !a.archived {
            ctx.state.set_archived(&a.id, false);
        }
    };
    let snap = ctx.state.snapshot();
    let ws = snap.workspaces.iter().find(|w| w.id == a.workspace_id);
    let worktree = ws.and_then(|w| {
        let wt = w.worktree.as_ref()?;
        Some(ParkedWorktree { path: wt.path.clone(), repo_root: w.repo.as_ref().map(|r| r.root.clone()).unwrap_or_default() })
    });
    let Some(archived_at) = ctx.state.archived_at(&a.id) else {
        undo_archive(ctx);
        return Err(ApiError::new("busy", format!("{} changed meanwhile; try again", s.name)).retryable());
    };
    let Some(mut rec) = parked::record_from_agent(&a, archived_at, now_ms(), worktree, ws.map(|w| w.cwd.clone())) else {
        undo_archive(ctx);
        return Err(ApiError::new("not_found", format!("omp has not saved {}'s session yet", s.name)));
    };
    rec.moved = Some(mark);
    ctx.state.park(rec);
    let closed = parked::close_agent(ctx, &a, None).await;
    match closed {
        Ok(true) => {}
        Ok(false) => {
            ctx.state.unpark(&a.id);
            undo_archive(ctx);
            return Err(ApiError::new("busy", format!("{}'s pane changed meanwhile; try again", s.name)).retryable());
        }
        Err(e) => {
            ctx.state.unpark(&a.id);
            undo_archive(ctx);
            return Err(herdr_err(e));
        }
    }
    {
        let mut d = lock(&entry.data);
        d.closed = true;
        d.marked = true;
    }
    ctx.state.record_activity(&a.id, ActivityKind::Stopped, format!("Closed {} to move it", a.name), None);
    wait_exit(s.pid, EXIT_WAIT).await;
    Ok(())
}

/// Waits (bounded) for a process to exit.
async fn wait_exit(pid: Option<u32>, max: Duration) {
    let Some(pid) = pid else {
        tokio::time::sleep(Duration::from_secs(1)).await;
        return;
    };
    let deadline = Instant::now() + max;
    while alive(pid) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists and may be signalled.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn alive(_pid: u32) -> bool {
    false
}

/// `omp session pack`, retried while the closed agent's omp still holds the session. `Ok(Some)`:
/// omp's warnings (blobs missing from its store).
async fn pack(file: &str, archive: &Path) -> Result<Option<String>, ApiError> {
    let args = ompcli::pack_args(file, &archive.display().to_string());
    let deadline = Instant::now() + EXIT_WAIT;
    loop {
        let out = ompcli::run(&args, PACK).await?;
        if out.ok() {
            let warn = out.stderr.trim();
            return Ok((!warn.is_empty()).then(|| ompcli::error_text(&out)));
        }
        if ompcli::held_by_live_omp(&out.stderr) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }
        return Err(ApiError::new("pack_failed", format!("omp session pack: {}", ompcli::error_text(&out))));
    }
}

pub fn hash_file(path: &Path) -> std::io::Result<(u64, String)> {
    let mut f = std::fs::File::open(path)?;
    let mut h = sha2::Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf)?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        n += k as u64;
    }
    Ok((n, h.finalize().iter().map(|b| format!("{b:02x}")).collect()))
}

/// Undoes what the source did, newest first: the agent resumes where it was (when the move closed
/// it), its card mark is restored, the staging folder goes. A pushed branch stays pushed.
async fn rollback(ctx: &Arc<Ctx>, job: &Job, entry: &Entry, why: &ApiError) {
    job.set_phase(MovePhase::RollingBack);
    let (agent_id, name, staging, closed, marked, prev, was_archived, to) = {
        let d = lock(&entry.data);
        (d.agent_id.clone(), d.name.clone(), d.staging.clone(), d.closed, d.marked, d.prev_mark.clone(), d.was_archived, d.to.label.clone())
    };
    info!(move_id = %job.id, agent = %agent_id, "move: rolling back the source ({})", why.message);
    let cancelled = why.code == "aborted";
    let mut on = agent_id.clone();
    if closed {
        ctx.state.set_parked_move(&agent_id, None);
        match crate::ops::agent::resume_parked(ctx, &agent_id, None, None, Vec::new()).await {
            Ok(started) => {
                job.step("close", MoveStepState::Undone, Some(format!("{name} runs here again")));
                if let Some(new) = started.agent_id {
                    on = new.clone();
                    if was_archived {
                        rearchive(ctx, &new).await;
                    }
                }
            }
            Err(e) => {
                warn!(move_id = %job.id, "move: resuming {name} after a failed move: {e}");
                job.note(format!("{name} could not be resumed here ({}); resume it from Done.", e.message));
            }
        }
    } else if marked {
        ctx.state.set_parked_move(&agent_id, prev);
    }
    job.update(|s| s.agent_id = Some(on.clone()));
    if let Err(e) = std::fs::remove_dir_all(&staging)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        job.note(format!("could not delete {}: {e}", staging.display()));
    }
    forget(&job.id);
    let title = if cancelled { format!("Move of {name} to {to} cancelled") } else { format!("Moving {name} to {to} failed") };
    ctx.state.record_activity(&on, if cancelled { ActivityKind::Stopped } else { ActivityKind::Error }, title, (!cancelled).then(|| why.message.clone()));
}

/// Puts a resumed agent back in Done once the board knows it.
async fn rearchive(ctx: &Ctx, agent_id: &str) {
    for _ in 0..20 {
        if ctx.state.set_archived(agent_id, true) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// `move.read`: a piece of one packed part.
pub async fn read(p: MoveReadParams) -> Result<MoveChunk, ApiError> {
    let gone = || ApiError::new("not_found", format!("no packed move {} here", p.move_id)).with_hint("It was finished, cancelled, or tf-hostd restarted; start the move again.");
    let e = entry(&p.move_id).ok_or_else(gone)?;
    if let Some(job) = jobs::get(&p.move_id) {
        if job.phase() != MovePhase::Ready {
            return Err(gone());
        }
        job.touch();
    }
    let path = lock(&e.data).parts.iter().find(|(part, _)| part.name == p.part).map(|(_, path)| path.clone());
    let path = path.ok_or_else(|| ApiError::new("invalid_params", format!("move {} has no part `{}`", p.move_id, p.part)))?;
    let len = p.length.clamp(1, MAX_READ) as usize;
    let offset = p.offset;
    tokio::task::spawn_blocking(move || -> Result<MoveChunk, ApiError> {
        let mut f = std::fs::File::open(&path).map_err(|e| crate::ops::fs::io_error(e, &path))?;
        let size = f.metadata().map_err(|e| crate::ops::fs::io_error(e, &path))?.len();
        if offset > size {
            return Err(ApiError::new("invalid_params", format!("offset {offset} is past the end ({size} bytes)")));
        }
        f.seek(SeekFrom::Start(offset)).map_err(|e| crate::ops::fs::io_error(e, &path))?;
        let mut buf = vec![0u8; len.min((size - offset) as usize)];
        f.read_exact(&mut buf).map_err(|e| crate::ops::fs::io_error(e, &path))?;
        Ok(MoveChunk { data: base64::engine::general_purpose::STANDARD.encode(&buf), size })
    })
    .await
    .map_err(|e| ApiError::new("internal", e.to_string()))?
}

/// The idle sweep ended this job as `interrupted` ([`expire_idle`]): its card still says the agent
/// is moving and it is parked, so the target's `done` must still be able to finish the move.
pub fn was_interrupted(job: &Job) -> bool {
    let s = job.status();
    s.phase == MovePhase::Failed && s.error.is_some_and(|e| e.code == "interrupted")
}

/// `move.finish`: the target runs the agent now. Marks the session left here moved (`omp
/// session moved --to`: resuming it forks), the parked card `moved`, and deletes the staging.
/// Also for a move whose job the idle sweep ended (30 min without word from the app: a target that
/// took long to confirm): the card is `interrupted` and the agent still parked.
pub async fn finish(ctx: &Ctx, p: MoveFinishParams) -> Result<MoveStatus, ApiError> {
    let job = jobs::get(&p.move_id).filter(|j| j.role == MoveRole::Source).filter(|j| !was_interrupted(j));
    let e = entry(&p.move_id);
    let _op = match &e {
        Some(e) => Some(e.op.lock().await),
        None => None,
    };
    if let Some(job) = &job {
        match job.phase() {
            MovePhase::Done => return Ok(job.status()),
            MovePhase::Ready => {}
            other => return Err(ApiError::new("invalid_params", format!("move {} is {other:?}, not waiting to finish", p.move_id))),
        }
        job.touch();
    }
    // The parked card carrying this move (also after a restart, or once the move timed out).
    let rec = ctx
        .state
        .parked_all()
        .into_iter()
        .find(|r| r.moved.as_ref().is_some_and(|m| m.move_id == p.move_id))
        .ok_or_else(|| ApiError::new("not_found", format!("no agent here is moving with {}", p.move_id)))?;
    let Some(mark) = rec.moved.clone() else { return Err(ApiError::new("not_found", format!("no agent here is moving with {}", p.move_id))) };
    if mark.state == ParkedMoveState::Moved {
        // Finished before (the answer got lost, or tf-hostd restarted since).
        return Ok(match job {
            Some(job) => job.status(),
            None => done_status(&p.move_id, &rec, mark.at, Vec::new()),
        });
    }
    if let Some(job) = &job {
        job.step("finish", MoveStepState::Running, None);
    }
    let mut notes = Vec::new();
    let out = ompcli::run(&ompcli::moved_args(&rec.session_file, &mark.to), Duration::from_secs(30)).await;
    match out {
        Ok(o) if o.ok() => {}
        Ok(o) => notes.push(format!("omp did not mark the copy left here moved ({}); resuming it here would continue it, not fork it", ompcli::error_text(&o))),
        Err(e) => notes.push(format!("omp did not mark the copy left here moved ({}); resuming it here would continue it, not fork it", e.message)),
    }
    ctx.state.set_parked_move(&rec.agent_id, Some(ParkedMove { state: ParkedMoveState::Moved, agent_id: p.agent_id.clone(), at: now_ms(), ..mark.clone() }));
    if let Some(e) = &e {
        let staging = lock(&e.data).staging.clone();
        let _ = std::fs::remove_dir_all(&staging);
    } else {
        let _ = std::fs::remove_dir_all(ctx.paths.moves.join(&p.move_id));
    }
    forget(&p.move_id);
    ctx.state.record_activity_as(&rec.agent_id, &rec.name, ActivityKind::Stopped, format!("Moved {} to {}", rec.name, mark.to), None);
    info!(move_id = %p.move_id, agent = %rec.agent_id, to = %mark.to, "move: finished (source)");
    Ok(match job {
        Some(job) => {
            for n in notes {
                job.note(n);
            }
            job.step("finish", MoveStepState::Done, None);
            job.set_phase(MovePhase::Done);
            job.status()
        }
        None => done_status(&p.move_id, &rec, mark.at, notes),
    })
}

/// The status of a finished move no job here remembers.
fn done_status(move_id: &str, rec: &crate::state::persist::ParkedRecord, started_at: tf_proto::Millis, notes: Vec<String>) -> MoveStatus {
    MoveStatus {
        move_id: move_id.to_string(),
        role: MoveRole::Source,
        phase: MovePhase::Done,
        steps: vec![tf_proto::MoveStep { id: "finish".into(), label: "Mark the copy left here moved".into(), state: MoveStepState::Done, detail: None }],
        parts: Vec::new(),
        source: None,
        agent_id: None,
        session_file: Some(rec.session_file.clone()),
        cwd: rec.cwd.clone(),
        error: None,
        notes,
        started_at,
        updated_at: now_ms(),
    }
}

/// `move.abort` of a source job: a running one stops at its next step and rolls back; a packed
/// one rolls back now (the agent resumes here when the move closed it).
pub async fn abort(ctx: &Ctx, job: Arc<Job>) -> MoveStatus {
    job.cancel.cancel();
    let Some(e) = entry(&job.id) else { return job.status() };
    let _op = e.op.lock().await;
    if job.phase() == MovePhase::Ready {
        job.set_phase(MovePhase::RollingBack);
        let ctx = ctx.arc();
        let job2 = job.clone();
        let e2 = e.clone();
        tokio::spawn(async move {
            let err = aborted();
            let _op = e2.op.lock().await;
            rollback(&ctx, &job2, &e2, &err).await;
            job2.fail(err);
        });
    }
    job.status()
}

/// `move.abort` of a move no job here knows (tf-hostd restarted, or it timed out): its parked
/// card stops saying it is moving. The agent stays parked: the target may run it.
pub fn abort_orphan(ctx: &Ctx, move_id: &str) -> Result<MoveStatus, ApiError> {
    let rec = ctx
        .state
        .parked_all()
        .into_iter()
        .find(|r| r.moved.as_ref().is_some_and(|m| m.move_id == move_id && m.state != ParkedMoveState::Moved))
        .ok_or_else(|| ApiError::new("not_found", format!("no move {move_id} here")))?;
    ctx.state.set_parked_move(&rec.agent_id, None);
    let _ = std::fs::remove_dir_all(ctx.paths.moves.join(move_id));
    let now = now_ms();
    Ok(MoveStatus {
        move_id: move_id.to_string(),
        role: MoveRole::Source,
        phase: MovePhase::Failed,
        steps: Vec::new(),
        parts: Vec::new(),
        source: None,
        agent_id: None,
        session_file: Some(rec.session_file),
        cwd: rec.cwd,
        error: Some(aborted()),
        notes: vec![format!("{} stays closed here; resume it from Done", rec.name)],
        started_at: rec.moved.map(|m| m.at).unwrap_or(now),
        updated_at: now,
    })
}

/// A packed move the app stopped asking about: it counts as interrupted (the card says so, the
/// staging goes). The agent stays parked: the target may run it already.
pub async fn expire_idle(ctx: &Ctx) {
    for job in jobs::active(&ctx.herdr_session) {
        if job.role != MoveRole::Source || job.phase() != MovePhase::Ready || job.idle_for() < READY_IDLE {
            continue;
        }
        let Some(e) = entry(&job.id) else { continue };
        let _op = e.op.lock().await;
        if job.phase() != MovePhase::Ready {
            continue;
        }
        let (agent_id, staging) = {
            let d = lock(&e.data);
            (d.agent_id.clone(), d.staging.clone())
        };
        if let Some(mut m) = ctx.state.parked(&agent_id).and_then(|r| r.moved).filter(|m| m.move_id == job.id) {
            m.state = ParkedMoveState::Interrupted;
            ctx.state.set_parked_move(&agent_id, Some(m));
        }
        let _ = std::fs::remove_dir_all(&staging);
        forget(&job.id);
        warn!(move_id = %job.id, "move: no word from the app for {} min; interrupted", READY_IDLE.as_secs() / 60);
        job.fail(ApiError::new("interrupted", "the app stopped copying the move").with_hint("The agent stays closed here; check the target before resuming it."));
    }
}
