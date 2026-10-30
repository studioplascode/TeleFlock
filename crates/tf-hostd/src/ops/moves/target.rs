//! The target side of a move: `move.receive` clones (when asked), fetches the branch, checks it
//! out (the checkout that holds it, fast-forwarded, else a new linked worktree), applies the
//! uncommitted changes, unpacks the session into that folder and resumes the agent. Every step
//! records how to undo itself in a journal on disk (`<home>/moves/<id>/target.json`), so a failed
//! step, `move.abort`, or a restart in the middle rolls back everything it did.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use tf_proto::model::{ActivityKind, Agent};
use tf_proto::term::Split;
use tf_proto::{AgentSpec, ApiError, Millis, MoveCheck, MoveGit, MovePhase, MoveReceiveParams, MoveRole, MoveStatus, MoveStepState, StartTarget, WorktreeCreateParams};

use super::facts::{commit_exists, is_ancestor, is_stale, live_cwds, occupants, remote_is_option, rev, stale_checkouts, worktrees};
use super::jobs::{self, Job};
use super::{ompcli, url};
use crate::ops::agent::{derive_handle, start_agent, valid_handle, LaunchPane, SessionArg};
use crate::ops::git::{self, git, git_remote};
use crate::ops::Ctx;
use crate::util::now_ms;

/// `git clone` of the whole repository.
const CLONE: Duration = Duration::from_secs(600);
/// `git fetch` of the branch the source just pushed.
const FETCH: Duration = Duration::from_secs(120);
const QUICK: Duration = Duration::from_secs(10);
const LOCAL: Duration = Duration::from_secs(60);
/// `omp session unpack` of a large session.
const UNPACK: Duration = Duration::from_secs(600);
/// A finished receive's journal answers `move.status` this long (also across restarts).
pub const KEEP_JOURNAL: Duration = Duration::from_secs(24 * 3600);

/// How to undo one step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Undo {
    /// A clone this move made: deleted.
    RemoveClone { path: String },
    /// A branch this move created at `sha`: deleted while it still points there.
    DeleteBranch { repo: String, branch: String, sha: String },
    /// A branch this move fast-forwarded from `old` to `new`: set back while it is at `new`.
    ResetBranch { repo: String, branch: String, old: String, new: String },
    /// A linked worktree this move created (with the herdr workspace holding it, if any).
    RemoveWorktree { repo: String, path: String, workspace_id: Option<String> },
    /// An existing checkout this move fast-forwarded from `old` to `new`.
    ResetCheckout { path: String, old: String, new: String },
    /// Stale changes this move stashed in an existing checkout.
    StashPop { path: String },
    /// The uncommitted changes applied in `path`.
    RevertPatch { path: String, patch: String },
    /// The session unpacked here (and its artifacts folder).
    RemoveSession { file: String },
}

/// One part of the move, uploaded here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    pub id: String,
    pub path: String,
}

/// The launch boundary, written to the journal before the agent starts (`start_agent` may have
/// reached herdr when hostd dies or the answer is lost). While it is there the agent may exist, so
/// nothing of the move is undone until the live board, herdr and the session file say it does not.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Launching {
    pub at: Millis,
    /// The agent name the launch asked for (herdr names are unique among live agents).
    pub name: String,
    /// The unpacked session the agent resumes, and its size before the launch: a changed file
    /// means omp ran.
    pub session_file: String,
    pub session_len: u64,
    pub cwd: String,
    /// The source host's label, for the activity entry.
    pub from: String,
}

/// `target.json`: the receive's status and undo journal (newest step last).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub herdr_session: String,
    pub status: MoveStatus,
    pub undo: Vec<Undo>,
    /// The parts' uploads (deleted when the receive ends).
    pub uploads: Vec<Upload>,
    /// Set from just before the agent starts until the receive ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launching: Option<Launching>,
    pub at: Millis,
}

/// What `run` stops with when the agent may run and nobody can tell yet: the receive goes on as
/// `confirming` (nothing is rolled back), see [`resolve`].
pub const HELD: &str = "launch_unconfirmed";

fn journal_path(moves: &Path, id: &str) -> PathBuf {
    moves.join(id).join("target.json")
}

/// Writes the journal durably. Callers go on only when it is on disk.
pub fn write_journal(path: &Path, j: &Journal) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(j).map_err(std::io::Error::other)?;
    path.parent().map_or(Ok(()), crate::paths::create_private_dir).and_then(|()| crate::paths::write_atomic(path, &bytes))
}

/// Saves `status` with the undo list: an error when the journal cannot be written, because a step
/// that cannot be undone after a crash must not run, and a result nobody saved must not be reported.
pub fn write_status(moves: &Path, ctx_session: &str, status: MoveStatus, undo: &[Undo], uploads: &[Upload], launching: Option<&Launching>) -> Result<(), ApiError> {
    let id = status.move_id.clone();
    let j = Journal { herdr_session: ctx_session.to_string(), status, undo: undo.to_vec(), uploads: uploads.to_vec(), launching: launching.cloned(), at: now_ms() };
    write_journal(&journal_path(moves, &id), &j).map_err(|e| {
        warn!(move_id = %id, "move: writing the undo journal: {e}");
        ApiError::new("io_error", format!("saving the move's undo journal failed: {e}")).with_hint("Check the disk and the permissions of tf-hostd's folder, then start the move again")
    })
}

fn save(ctx: &Ctx, job: &Job, undo: &[Undo], uploads: &[Upload], launching: Option<&Launching>) -> Result<(), ApiError> {
    write_status(&ctx.paths.moves, &ctx.herdr_session, job.status(), undo, uploads, launching)
}

pub fn load(path: &Path) -> Option<Journal> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// A receive this daemon ran before (also before a restart): its status.
pub fn finished_status(ctx: &Ctx, id: &str) -> Option<MoveStatus> {
    jobs::valid_id(id).then(|| load(&journal_path(&ctx.paths.moves, id))).flatten().map(|j| j.status)
}

/// What the receive works from.
struct Plan {
    from: String,
    session_archive: PathBuf,
    changes_patch: Option<PathBuf>,
    repo_path: Option<PathBuf>,
    clone_to: Option<PathBuf>,
    cwd: Option<PathBuf>,
}

/// `move.receive`: validates the request and starts the job. A repeated call answers the job's
/// status (the app may have lost the first answer).
pub async fn receive(ctx: &Ctx, p: MoveReceiveParams) -> Result<MoveStatus, ApiError> {
    if !jobs::valid_id(&p.move_id) {
        return Err(ApiError::new("invalid_params", format!("`{}` is not a move id", p.move_id)));
    }
    if let Some(job) = jobs::get(&p.move_id) {
        return match job.role {
            MoveRole::Target => Ok(job.status()),
            MoveRole::Source => Err(ApiError::new("invalid_params", "this host is the source of that move")),
        };
    }
    if let Some(done) = finished_status(ctx, &p.move_id) {
        return Ok(done);
    }
    let paths = ctx.paths.clone();
    let (su, cu) = (p.session_upload.clone(), p.changes_upload.clone());
    let (session, changes) = tokio::task::spawn_blocking(move || {
        let session = crate::ops::upload::finished_file(&paths, &su)?;
        let changes = cu.map(|c| crate::ops::upload::finished_file(&paths, &c)).transpose()?;
        Ok::<_, ApiError>((session, changes))
    })
    .await
    .map_err(|e| ApiError::new("internal", e.to_string()))?
    .map_err(|e| ApiError::new(e.code.clone(), format!("a part of the move is missing here: {}", e.message)).with_hint("Copy it again (start the move over)."))?;
    let pick = |s: &Option<String>| s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(crate::ops::fs::resolve_path).transpose();
    let (repo_path, clone_to, cwd) = (pick(&p.repo_path)?, pick(&p.clone_to)?, pick(&p.cwd)?);
    match (&p.source.git, &repo_path, &clone_to) {
        (Some(_), Some(_), None) | (Some(_), None, Some(_)) => {}
        (Some(_), _, _) => {
            return Err(ApiError::new("invalid_params", "pick the repository to check the branch out in (repoPath) or where to clone it (cloneTo)"));
        }
        (None, _, _) => match &cwd {
            Some(c) if c.is_dir() => {}
            Some(c) => return Err(ApiError::new("not_found", format!("{} does not exist", c.display()))),
            None => return Err(ApiError::new("invalid_params", "pick the folder the agent continues in (cwd)")),
        },
    }
    if changes.is_some() && p.source.git.is_none() {
        return Err(ApiError::new("invalid_params", "uncommitted changes need a repository"));
    }
    if let Some(dest) = clone_to.as_ref().filter(|d| d.exists()) {
        return Err(ApiError::new("already_exists", format!("{} exists already", dest.display())).with_hint("Pick that clone, or another folder."));
    }
    let job = jobs::insert(Job::new(&p.move_id, MoveRole::Target, &ctx.herdr_session, "", &steps(&p.source)))?;
    let uploads: Vec<Upload> = [Some((p.session_upload.clone(), session.path.clone())), p.changes_upload.clone().zip(changes.as_ref().map(|c| c.path.clone()))]
        .into_iter()
        .flatten()
        .map(|(id, path)| Upload { id, path })
        .collect();
    let plan = Plan {
        from: p.from.split_whitespace().collect::<Vec<_>>().join(" "),
        session_archive: PathBuf::from(&session.path),
        changes_patch: changes.map(|c| PathBuf::from(c.path)),
        repo_path,
        clone_to,
        cwd,
    };
    info!(move_id = %job.id, agent = %p.source.agent_id, from = %plan.from, "move: receiving");
    let status = job.status();
    let ctx = ctx.arc();
    let source = p.source;
    tokio::spawn(async move {
        let mut undo = Vec::new();
        // A move whose journal cannot be written does not start: a crash would leave what it did
        // with no record of how to undo it.
        if let Err(e) = save(&ctx, &job, &undo, &uploads, None) {
            job.fail(e);
            discard_uploads(&ctx, &uploads).await;
            return;
        }
        let res = run(&ctx, &job, &source, &plan, &mut undo, &uploads).await;
        match res {
            // The agent runs, but its result could not be saved before the daemon closed: the
            // journal still says `launching`, which the next start reconciles. Nothing is touched.
            Ok(()) if job.is_active() => return,
            Ok(()) => {}
            // The agent may run and nobody can tell yet: the move is `confirming` (neither done nor
            // failed, so no client rolls the source back), nothing is removed, and the launch is
            // looked for until the board answers, also after a restart.
            Err(e) if e.code == HELD => {
                warn!(move_id = %job.id, "move: {}", e.message);
                job.set_phase(MovePhase::Confirming);
                let path = journal_path(&ctx.paths.moves, &job.id);
                if let Some(j) = load(&path)
                    && let Err(err) = finish_recovered(Some(&ctx), &path, j, Verdict::Pending(e.message.clone())).await
                {
                    warn!(move_id = %job.id, "move: saving the confirming journal failed ({err}); the launch record on disk is looked at after a restart");
                }
                resolve(&ctx, &job.id, Some(job.clone()));
                return;
            }
            Err(e) => {
                job.set_phase(MovePhase::RollingBack);
                let _ = save(&ctx, &job, &undo, &uploads, None);
                warn!(move_id = %job.id, "move: receive failed ({}); rolling back", e.message);
                for n in undo_all(Some(&ctx), &undo).await {
                    job.note(n);
                }
                job.update(|s| {
                    for step in s.steps.iter_mut().filter(|st| st.state == MoveStepState::Done) {
                        step.state = MoveStepState::Undone;
                    }
                });
                job.fail(e);
                undo.clear();
                let _ = save(&ctx, &job, &undo, &uploads, None);
            }
        }
        discard_uploads(&ctx, &uploads).await;
        let _ = save(&ctx, &job, &undo, &[], None);
    });
    Ok(status)
}

/// The receive's steps and labels.
fn steps(src: &MoveCheck) -> Vec<(&'static str, String)> {
    let (clone, fetch, checkout) = match &src.git {
        Some(g) => (format!("Clone {}", g.remote_url), format!("Fetch {}", g.branch), format!("Check out {}", g.branch)),
        None => ("Clone the repository".to_string(), "Fetch the branch".to_string(), "Check out the branch".to_string()),
    };
    vec![
        ("clone", clone),
        ("fetch", fetch),
        ("checkout", checkout),
        ("changes", "Apply the uncommitted changes".to_string()),
        ("unpack", "Unpack the session".to_string()),
        ("start", format!("Resume {}", src.name)),
    ]
}

async fn discard_uploads(ctx: &Ctx, uploads: &[Upload]) {
    let paths = ctx.paths.clone();
    let uploads = uploads.to_vec();
    let _ = tokio::task::spawn_blocking(move || {
        for u in uploads {
            crate::ops::upload::discard(&paths, &u.id);
            // After a restart the registry no longer knows the id: the file goes by path.
            let _ = std::fs::remove_file(&u.path);
        }
    })
    .await;
}

/// Fails with `aborted` once `move.abort` asked for it (checked between steps).
fn check_abort(job: &Job) -> Result<(), ApiError> {
    if job.cancel.is_cancelled() { Err(super::source::aborted()) } else { Ok(()) }
}

async fn run(ctx: &Arc<Ctx>, job: &Arc<Job>, src: &MoveCheck, plan: &Plan, undo: &mut Vec<Undo>, uploads: &[Upload]) -> Result<(), ApiError> {
    let journal = |undo: &[Undo]| save(ctx, job, undo, uploads, None);
    let (agent_cwd, launch) = match &src.git {
        None => {
            for id in ["clone", "fetch", "checkout"] {
                job.step(id, MoveStepState::Skipped, Some("not a git repository".into()));
            }
            job.step("changes", MoveStepState::Skipped, None);
            let cwd = plan.cwd.clone().ok_or_else(|| ApiError::new("invalid_params", "no folder to continue in"))?;
            let launch = launch_in(ctx, &cwd);
            (cwd, launch)
        }
        Some(g) => {
            check_abort(job)?;
            let repo = match &plan.clone_to {
                Some(dest) => {
                    job.step("clone", MoveStepState::Running, Some(dest.display().to_string()));
                    claim_dir(dest)?;
                    undo.push(Undo::RemoveClone { path: dest.display().to_string() });
                    journal(undo)?;
                    clone(dest, &g.remote_url).await?;
                    job.step("clone", MoveStepState::Done, None);
                    dest.clone()
                }
                None => {
                    job.step("clone", MoveStepState::Skipped, Some("a clone is here".into()));
                    let picked = plan.repo_path.clone().unwrap_or_default();
                    git::repo_top(&picked).await?.ok_or_else(|| ApiError::new("not_git_repo", format!("{} is not a git repository", picked.display())))?.root
                }
            };
            let remote = remote_for(&repo, &g.remote_url).await?;
            check_abort(job)?;
            job.step("fetch", MoveStepState::Running, Some(format!("from {remote}")));
            fetch(&repo, &remote, g).await?;
            job.step("fetch", MoveStepState::Done, None);
            check_abort(job)?;
            job.step("checkout", MoveStepState::Running, None);
            let out = checkout(ctx, &repo, &remote, g, &src.name, &src.agent_id, undo).await;
            let saved = journal(undo);
            let co = out?;
            saved?;
            job.step("checkout", MoveStepState::Done, Some(co.how.clone()));
            let agent_cwd = if g.subdir.is_empty() { co.top.clone() } else { co.top.join(&g.subdir) };
            let launch = match co.root {
                // The new worktree's own shell, when the agent works at its top.
                Some((_, pane)) if g.subdir.is_empty() => Some(LaunchPane::New(pane)),
                Some((ws, _)) => {
                    // It worked in a subfolder: that folder gets its own workspace, and the
                    // worktree's (an idle shell) closes again; the checkout stays.
                    let _ = ctx.herdr.workspace_close(&ws, false).await;
                    for u in undo.iter_mut() {
                        if let Undo::RemoveWorktree { workspace_id, .. } = u
                            && workspace_id.as_deref() == Some(ws.as_str())
                        {
                            *workspace_id = None;
                        }
                    }
                    journal(undo)?;
                    launch_in(ctx, &agent_cwd)
                }
                None => launch_in(ctx, &agent_cwd),
            };
            check_abort(job)?;
            match &plan.changes_patch {
                Some(patch) => {
                    job.label("changes", format!("Apply {} uncommitted file{}", g.dirty, if g.dirty == 1 { "" } else { "s" }));
                    job.step("changes", MoveStepState::Running, None);
                    apply_patch(&co.top, patch).await?;
                    undo.push(Undo::RevertPatch { path: co.top.display().to_string(), patch: patch.display().to_string() });
                    journal(undo)?;
                    job.step("changes", MoveStepState::Done, None);
                }
                None => job.step("changes", MoveStepState::Skipped, Some("no uncommitted changes".into())),
            }
            (agent_cwd, launch)
        }
    };
    if !agent_cwd.is_dir() {
        return Err(ApiError::new("not_found", format!("{} does not exist", agent_cwd.display())));
    }
    check_abort(job)?;
    job.step("unpack", MoveStepState::Running, None);
    let (file, placed) = unpack(&plan.session_archive, &agent_cwd).await?;
    undo.push(Undo::RemoveSession { file: file.clone() });
    journal(undo)?;
    if placed == ompcli::Placed::Forked {
        job.note("This host had another copy of this session that went its own way: the moved one continues as a fork of it.".into());
    }
    job.step("unpack", MoveStepState::Done, None);
    check_abort(job)?;
    job.step("start", MoveStepState::Running, None);
    let spec = spec_for(ctx, src).await;
    let name = spec.name.clone().unwrap_or_default();
    // The launch boundary: from here on the agent may exist, so a restart reconciles with the
    // board before it undoes anything (`recover`). The record is on disk before herdr is asked.
    let launching = Launching {
        at: now_ms(),
        name: name.clone(),
        session_file: file.clone(),
        session_len: file_len(&file).unwrap_or_default(),
        cwd: agent_cwd.display().to_string(),
        from: plan.from.clone(),
    };
    save(ctx, job, undo, uploads, Some(&launching))?;
    let target = launch.unwrap_or_else(|| LaunchPane::Target(StartTarget::Cwd { cwd: agent_cwd.display().to_string(), label: None }));
    let new_id = match start_agent(ctx, target, &spec, Some(SessionArg::Resume(&file))).await {
        Ok(started) => started.agent_id.unwrap_or_default(),
        // herdr refused: nothing started, the rollback is safe.
        Err(e) if refused(&e) => return Err(e),
        // The answer is lost or late (timeout, connection, herdr down): herdr may have started it.
        Err(e) => match reconcile(&launching, || observe(ctx, &launching), POLL).await {
            Verdict::Started { agent_id } => {
                job.note(format!("Starting the agent reported an error ({}), but it runs; the move goes on.", e.message));
                agent_id.unwrap_or_default()
            }
            Verdict::Absent => return Err(e),
            Verdict::Pending(why) => return Err(ApiError::new(HELD, format!("{why} (starting it reported: {})", e.message))),
        },
    };
    job.step("start", MoveStepState::Done, None);
    let cwd = launching.cwd.clone();
    let mut done = job.status();
    done.phase = MovePhase::Done;
    done.agent_id = Some(new_id.clone());
    done.session_file = Some(file.clone());
    done.cwd = Some(cwd.clone());
    // Saved before the job says so (and before `discard_uploads`): a restart finding the move still
    // `launching` adopts the agent; a finished move reported from memory alone would be lost.
    let committed = retry_commit(
        &ctx.cancel,
        COMMIT_RETRY,
        || {
            done.updated_at = now_ms();
            write_status(&ctx.paths.moves, &ctx.herdr_session, done.clone(), &[], uploads, None)
        },
        |e| job.note(format!("The agent runs here, but saving the move's result failed ({}); trying again, and the agent is not rolled back", e.message)),
    )
    .await;
    if !committed {
        return Ok(());
    }
    job.update(|s| {
        s.phase = MovePhase::Done;
        s.agent_id = Some(new_id.clone());
        s.session_file = Some(file.clone());
        s.cwd = Some(cwd);
    });
    undo.clear();
    ctx.state.record_activity_as(&new_id, &name, ActivityKind::Started, format!("Moved {name} here from {}", plan.from), Some(file.clone()));
    info!(move_id = %job.id, agent = %new_id, %file, "move: received; the agent runs here");
    Ok(())
}

/// A new tab of the workspace already showing `cwd`, else (`None`) a new workspace there.
fn launch_in(ctx: &Ctx, cwd: &Path) -> Option<LaunchPane> {
    let same = |p: &str| match (std::fs::canonicalize(p), std::fs::canonicalize(cwd)) {
        (Ok(a), Ok(b)) => a == b,
        _ => Path::new(p) == cwd,
    };
    ctx.state
        .snapshot()
        .workspaces
        .iter()
        .find(|w| same(&w.cwd))
        .map(|w| LaunchPane::Target(StartTarget::Workspace { workspace_id: w.id.clone(), split: Some(Split::Tab) }))
}

/// The remote of `repo` whose URL names the source's remote.
async fn remote_for(repo: &Path, want: &str) -> Result<String, ApiError> {
    let out = git::git_ok(repo, &["remote", "-v"], QUICK).await?;
    out.stdout_str()
        .lines()
        .find_map(|l| {
            let mut it = l.split_whitespace();
            let (name, u) = (it.next()?, it.next()?);
            url::same_repo(u, want).then(|| name.to_string())
        })
        .ok_or_else(|| ApiError::new("not_found", format!("{} has no remote for {want}", repo.display())))
}

/// Makes the clone's folder. `create_dir` fails when anything is there already, so what a failed
/// clone (or a rollback) removes afterwards is surely this move's own.
pub(super) fn claim_dir(dest: &Path) -> Result<(), ApiError> {
    match std::fs::create_dir(dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(ApiError::new("already_exists", format!("{} exists already", dest.display())).with_hint("Pick that clone, or another folder."))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(ApiError::new("not_found", format!("{} has no parent folder", dest.display()))),
        Err(e) => Err(ApiError::new("io_error", format!("creating {}: {e}", dest.display()))),
    }
}

/// Clones into `dest`, a folder [`claim_dir`] just made: a failed clone leaves nothing of it.
pub(super) async fn clone(dest: &Path, remote_url: &str) -> Result<(), ApiError> {
    if remote_is_option(remote_url) {
        return Err(ApiError::new("invalid_params", format!("`{remote_url}` is not a repository address")));
    }
    let parent = dest.parent().filter(|p| p.is_dir()).ok_or_else(|| ApiError::new("not_found", format!("{} has no parent folder", dest.display())))?;
    let dest_s = dest.display().to_string();
    match git_remote(parent, &["clone", "--quiet", "--", remote_url, dest_s.as_str()], CLONE).await {
        Ok(o) if o.ok() => Ok(()),
        res => {
            let _ = std::fs::remove_dir_all(dest);
            Err(match res {
                Ok(o) => ApiError::new("clone_failed", format!("git clone {remote_url}: {}", o.message())),
                Err(e) => e,
            })
        }
    }
}

/// Fetches the branch the source pushed; its head must be here afterwards.
pub async fn fetch(repo: &Path, remote: &str, g: &MoveGit) -> Result<(), ApiError> {
    let refspec = format!("refs/heads/{}", g.branch);
    let out = git_remote(repo, &["fetch", "--quiet", remote, refspec.as_str()], FETCH).await?;
    if !out.ok() {
        return Err(ApiError::new("fetch_failed", format!("git fetch {remote} {}: {}", g.branch, out.message()))
            .with_hint(format!("This host needs to reach {} with its own git credentials.", g.remote_url)));
    }
    if !commit_exists(repo, &g.head).await {
        return Err(ApiError::new("head_missing", format!("{remote} has no commit {} on {}", short(&g.head), g.branch))
            .with_hint("The source's push did not reach this remote; check that both hosts use the same remote."));
    }
    Ok(())
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(10)]
}

/// Where the branch was checked out.
pub struct Checkout {
    pub top: PathBuf,
    pub how: String,
    /// A new worktree's herdr workspace and its root pane (an idle shell).
    pub root: Option<(String, String)>,
}

/// Puts the branch at the source's head: in the checkout that holds it (clean, or holding stale
/// changes of an agent that moved away: stashed; fast-forwarded), else in a new linked worktree
/// (the local branch created there, or fast-forwarded). Each change is journaled in `undo`. A live
/// agent (other than `agent_id`) working in that checkout refuses the move when files would change.
pub async fn checkout(ctx: &Ctx, repo: &Path, remote: &str, g: &MoveGit, name: &str, agent_id: &str, undo: &mut Vec<Undo>) -> Result<Checkout, ApiError> {
    let repo_s = repo.display().to_string();
    let holder = worktrees(repo).await.into_iter().find(|w| w.branch.as_deref() == Some(g.branch.as_str()));
    if let Some(w) = holder {
        let path = PathBuf::from(&w.path);
        prepare_holder(&path, repo, g, name, &stale_checkouts(&ctx.state.parked_all()), &live_cwds(&ctx.state.snapshot().agents, agent_id), undo).await?;
        return Ok(Checkout { top: path, how: format!("in {}", w.path), root: None });
    }
    prepare_branch(repo, remote, g, undo).await?;
    let params = WorktreeCreateParams { cwd: repo_s.clone(), branch: g.branch.clone(), base: None, path: None, label: None, existing: true, trust: false, agent: None };
    let (created, root_pane) = crate::ops::worktree::checkout(ctx, &params).await?;
    undo.push(Undo::RemoveWorktree { repo: repo_s, path: created.path.clone(), workspace_id: Some(created.workspace_id.clone()) });
    Ok(Checkout { top: PathBuf::from(&created.path), how: format!("new worktree {}", created.path), root: Some((created.workspace_id, root_pane)) })
}

/// The checkout at `path` already holds the branch: it must be clean (stale changes of an agent
/// that moved away from it are stashed) and fast-forward to the source's head.
pub async fn prepare_holder(path: &Path, repo: &Path, g: &MoveGit, name: &str, stale: &[PathBuf], live: &[(String, PathBuf)], undo: &mut Vec<Undo>) -> Result<(), ApiError> {
    let shown = path.display().to_string();
    let dirty = git::dirty_count(path, Duration::from_secs(30)).await.unwrap_or(0);
    let cur = rev(path, "HEAD").await.unwrap_or_default();
    // Files must not change under an agent working there (a stash or a fast-forward would).
    let here = occupants(live, path);
    if !here.is_empty() && (dirty > 0 || cur != g.head) {
        return Err(ApiError::new("agent_in_checkout", format!("{} works in {shown}, where {} is checked out: the branch would move under it", here.join(", "), g.branch))
            .with_hint("Close or move that agent first, or pick another clone."));
    }
    if dirty > 0 {
        if !is_stale(path, stale) {
            return Err(ApiError::new("dirty_checkout", format!("{} is checked out at {shown} with {dirty} uncommitted file(s)", g.branch))
                .with_hint("Commit, stash or discard them there first, or pick another clone."));
        }
        let msg = format!("TeleFlock: changes left in {shown} when an agent moved away (before {name} moved back)");
        let out = git(path, &["stash", "push", "--include-untracked", "-m", msg.as_str()], LOCAL).await?;
        if !out.ok() {
            return Err(ApiError::new("git_error", format!("git stash: {}", out.message())));
        }
        undo.push(Undo::StashPop { path: shown.clone() });
    }
    if cur != g.head {
        if !is_ancestor(repo, &cur, &g.head).await {
            return Err(ApiError::new("branch_diverged", format!("{} at {shown} has commits the moving branch does not have", g.branch))
                .with_hint("Merge or push them into the agent's branch first, or pick another clone."));
        }
        // A clean tree: `reset --keep` is a fast-forward that runs no hooks.
        let out = git(path, &["reset", "--keep", g.head.as_str()], LOCAL).await?;
        if !out.ok() {
            return Err(ApiError::new("git_error", format!("fast-forwarding {shown}: {}", out.message())));
        }
        undo.push(Undo::ResetCheckout { path: shown, old: cur, new: g.head.clone() });
    }
    Ok(())
}

/// No checkout holds the branch: the local branch is created at the source's head (tracking its
/// namesake on `remote`), or fast-forwarded to it.
pub async fn prepare_branch(repo: &Path, remote: &str, g: &MoveGit, undo: &mut Vec<Undo>) -> Result<(), ApiError> {
    let repo_s = repo.display().to_string();
    match rev(repo, &format!("refs/heads/{}", g.branch)).await {
        None => {
            let out = git(repo, &["branch", "--no-track", g.branch.as_str(), g.head.as_str()], QUICK).await?;
            if !out.ok() {
                return Err(ApiError::new("git_error", format!("git branch {}: {}", g.branch, out.message())));
            }
            undo.push(Undo::DeleteBranch { repo: repo_s, branch: g.branch.clone(), sha: g.head.clone() });
            let upstream = format!("--set-upstream-to={remote}/{}", g.branch);
            let _ = git(repo, &["branch", upstream.as_str(), g.branch.as_str()], QUICK).await;
        }
        Some(l) if l == g.head => {}
        Some(l) => {
            if !is_ancestor(repo, &l, &g.head).await {
                return Err(ApiError::new("branch_diverged", format!("the local branch {} here has commits the moving branch does not have", g.branch))
                    .with_hint("Merge or push them first, rename that branch, or pick another clone."));
            }
            let out = git(repo, &["branch", "-f", g.branch.as_str(), g.head.as_str()], QUICK).await?;
            if !out.ok() {
                return Err(ApiError::new("git_error", format!("git branch -f {}: {}", g.branch, out.message())));
            }
            undo.push(Undo::ResetBranch { repo: repo_s, branch: g.branch.clone(), old: l, new: g.head.clone() });
        }
    }
    Ok(())
}

pub async fn apply_patch(top: &Path, patch: &Path) -> Result<(), ApiError> {
    let patch_s = patch.display().to_string();
    let out = git(top, &["apply", "--binary", "--whitespace=nowarn", patch_s.as_str()], LOCAL).await?;
    if out.ok() { Ok(()) } else { Err(ApiError::new("changes_failed", format!("the uncommitted changes do not apply here: {}", out.message()))) }
}

async fn unpack(archive: &Path, cwd: &Path) -> Result<(String, ompcli::Placed), ApiError> {
    let out = ompcli::run(&ompcli::unpack_args(&archive.display().to_string(), &cwd.display().to_string()), UNPACK).await?;
    if !out.ok() {
        return Err(ApiError::new("unpack_failed", format!("omp session unpack: {}", ompcli::error_text(&out))));
    }
    ompcli::unpacked(&out.stdout_str(), &out.stderr)
        .ok_or_else(|| ApiError::new("unpack_failed", format!("omp session unpack printed no session file ({})", out.stdout_str().trim())))
}

/// The agent's launch: its name unless taken here, its model when this host has it (else omp's
/// default), its own roles, fallback chains and decide-for-me policy.
async fn spec_for(ctx: &Ctx, src: &MoveCheck) -> AgentSpec {
    let taken: Vec<String> = ctx.state.snapshot().agents.into_iter().filter(|a| a.parked.is_none()).map(|a| a.name).collect();
    let name = if valid_handle(&src.name) && !taken.contains(&src.name) { src.name.clone() } else { derive_handle(&src.name, &taken) };
    let model = match &src.model {
        Some(m) => match crate::ops::host::models().await {
            Ok(cat) if !cat.models.iter().any(|x| format!("{}/{}", x.provider, x.id) == *m) => None,
            _ => Some(m.clone()),
        },
        None => None,
    };
    AgentSpec {
        name: Some(name),
        kind: "omp".into(),
        thinking: if model.is_some() { src.thinking } else { None },
        model,
        plan: false,
        prompt: None,
        images: Vec::new(),
        role_models: src.role_models.clone(),
        fallback_chains: src.fallback_chains.clone(),
        auto_answer: src.auto_answer.clone(),
    }
}

/// Undoes a journal, newest first. Returns what could not be undone. Without a context (tests)
/// worktrees are removed with git.
pub async fn undo_all(ctx: Option<&Ctx>, undo: &[Undo]) -> Vec<String> {
    let mut notes = Vec::new();
    for u in undo.iter().rev() {
        if let Err(e) = undo_one(ctx, u).await {
            warn!("move: undo {u:?}: {e}");
            notes.push(e);
        }
    }
    notes
}

/// Undoes one step.
async fn undo_one(ctx: Option<&Ctx>, u: &Undo) -> Result<(), String> {
    let ok = |out: Result<git::CmdOut, ApiError>, what: &str| match out {
        Ok(o) if o.ok() => Ok(()),
        Ok(o) => Err(format!("{what}: {}", o.message())),
        Err(e) => Err(format!("{what}: {}", e.message)),
    };
    match u {
        Undo::RemoveSession { file } => {
            let res = std::fs::remove_file(file);
            if let Some(dir) = file.strip_suffix(".jsonl") {
                let _ = std::fs::remove_dir_all(dir);
            }
            match res {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("could not delete the unpacked session {file}: {e}")),
                _ => Ok(()),
            }
        }
        Undo::RevertPatch { path, patch } => {
            if !Path::new(patch).is_file() {
                return Err(format!("could not take the uncommitted changes back out of {path}: the patch is gone"));
            }
            let args = ["apply", "-R", "--binary", "--whitespace=nowarn", patch.as_str()];
            ok(git(Path::new(path), &args, LOCAL).await, &format!("taking the changes back out of {path}"))
        }
        Undo::StashPop { path } => ok(git(Path::new(path), &["stash", "pop"], LOCAL).await, &format!("restoring the stashed changes in {path} (git stash pop)")),
        Undo::ResetCheckout { path, old, new } => {
            if rev(Path::new(path), "HEAD").await.as_deref() != Some(new.as_str()) {
                return Err(format!("{path} moved on meanwhile; it stays at its new commit"));
            }
            ok(git(Path::new(path), &["reset", "--keep", old.as_str()], LOCAL).await, &format!("setting {path} back to {}", short(old)))
        }
        Undo::RemoveWorktree { repo, path, workspace_id } => {
            let held = match (ctx, workspace_id) {
                (Some(ctx), Some(id)) => ctx.state.snapshot().workspaces.iter().any(|w| &w.id == id).then(|| (ctx, id)),
                _ => None,
            };
            match held {
                Some((ctx, ws)) => ctx.herdr.worktree_remove(ws, true, false).await.map(drop).map_err(|e| format!("removing the worktree {path}: {e}"))?,
                None => crate::ops::worktree::remove_checkout(Path::new(path), Some(Path::new(repo)), true, false)
                    .await
                    .map_err(|e| format!("removing the worktree {path}: {}", e.message))?,
            }
            if let Some(ctx) = ctx {
                ctx.state.refresh();
            }
            Ok(())
        }
        Undo::ResetBranch { repo, branch, old, new } => {
            if rev(Path::new(repo), &format!("refs/heads/{branch}")).await.as_deref() != Some(new.as_str()) {
                return Ok(());
            }
            ok(git(Path::new(repo), &["branch", "-f", branch.as_str(), old.as_str()], QUICK).await, &format!("setting {branch} back"))
        }
        Undo::DeleteBranch { repo, branch, sha } => {
            if rev(Path::new(repo), &format!("refs/heads/{branch}")).await.as_deref() != Some(sha.as_str()) {
                return Ok(());
            }
            ok(git(Path::new(repo), &["branch", "-D", branch.as_str()], QUICK).await, &format!("deleting the branch {branch}"))
        }
        Undo::RemoveClone { path } => match std::fs::remove_dir_all(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("deleting the clone {path}: {e}")),
            _ => Ok(()),
        },
    }
}

/// `move.abort` of a receive: it stops before its next step and rolls back. A finished receive
/// stays (the agent runs here).
pub fn abort(job: &Job) -> MoveStatus {
    if job.is_active() {
        job.cancel.cancel();
    }
    job.status()
}

fn is_active(p: MovePhase) -> bool {
    matches!(p, MovePhase::Running | MovePhase::RollingBack | MovePhase::Confirming)
}

/// A finished receive's journal goes after [`KEEP_JOURNAL`]; one that is not finished (above all a
/// launch still unconfirmed) never does.
pub fn expired(j: &Journal, now: Millis) -> bool {
    !is_active(j.status.phase) && now - j.at > KEEP_JOURNAL.as_millis() as Millis
}

/// At context start: receives a previous daemon left in the middle are rolled back, except those
/// at the launch boundary (journal with `launching`): those are checked against the live agent
/// until the board answers ([`resolve`]) and never rolled back before; finished journals older
/// than [`KEEP_JOURNAL`] go.
pub async fn recover(ctx: &Ctx) {
    let Ok(rd) = std::fs::read_dir(&ctx.paths.moves) else { return };
    for e in rd.flatten() {
        let path = e.path().join("target.json");
        let Some(j) = load(&path) else { continue };
        if j.herdr_session != ctx.herdr_session {
            continue;
        }
        if is_active(j.status.phase) {
            if j.launching.is_some() {
                warn!(move_id = %j.status.move_id, "move: tf-hostd restarted while the agent was starting; looking for it before undoing anything");
                resolve(ctx, &j.status.move_id.clone(), None);
            } else if j.status.phase == MovePhase::Confirming {
                warn!(move_id = %j.status.move_id, "move: a confirming move without its launch record is left as it is");
            } else {
                warn!(move_id = %j.status.move_id, "move: tf-hostd restarted while receiving; rolling back");
                if let Err(err) = finish_recovered(Some(ctx), &path, j, Verdict::Absent).await {
                    warn!(path = %path.display(), "move: saving the rolled-back journal failed ({err})");
                }
            }
        } else if expired(&j, now_ms()) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// What is known about a launch at the boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// The agent started (`agent_id`: its card, when it shows on the board; none when only its
    /// session file's growth says it ran): the move is done.
    Started { agent_id: Option<String> },
    /// A built board without any sign of an agent, long after the launch: the rollback is safe.
    Absent,
    /// Cannot be told (board or herdr unreadable, an agent that may be it): nothing is removed.
    Pending(String),
}

/// What the board, herdr and the session file show.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observed {
    /// The board is built from a live herdr: absence means something.
    pub board: bool,
    /// An agent that runs this session or holds the launched name.
    pub agent: Option<String>,
    /// A live agent in the same folder that cannot be told from the launched one.
    pub neighbour: Option<String>,
    /// The session file changed since the launch began (omp wrote to it).
    pub touched: bool,
}

/// How long a launch that is not on the board yet may still show up.
const LAUNCH_SETTLE_MS: Millis = 60_000;
/// How long one look waits for a usable board before it answers `Pending`.
const BOARD_WAIT: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(1000);
/// An unconfirmed launch is looked at again this often.
const CONFIRM_EVERY: Duration = Duration::from_secs(30);
/// A result that cannot be saved is tried again this often.
const COMMIT_RETRY: Duration = Duration::from_secs(5);
/// Starts the note a `confirming` status carries (replaced when it ends).
const CONFIRMING_NOTE: &str = "Confirming whether the agent started here:";

/// Decides from one observation; `None` = look again. Anything that suggests the agent exists wins
/// over everything else: only a built board without any sign of it, `LAUNCH_SETTLE_MS` after the
/// launch began, counts as absent. `giving_up`: the board stayed unusable for [`BOARD_WAIT`].
pub fn judge(l: &Launching, o: &Observed, now: Millis, giving_up: bool) -> Option<Verdict> {
    if let Some(id) = &o.agent {
        return Some(Verdict::Started { agent_id: Some(id.clone()) });
    }
    // omp wrote to the session after the launch began: it ran (and may have ended since).
    if o.touched {
        return Some(Verdict::Started { agent_id: None });
    }
    if let Some(id) = &o.neighbour {
        return Some(Verdict::Pending(format!("an agent ({id}) works in {}, and it cannot be told whether it is the moved one", l.cwd)));
    }
    if !o.board {
        return giving_up.then(|| Verdict::Pending("herdr could not be asked whether the agent runs".to_string()));
    }
    if now - l.at < LAUNCH_SETTLE_MS {
        return None;
    }
    Some(Verdict::Absent)
}

/// Looks (`observe`, every `poll`) until [`judge`] decides.
pub async fn reconcile(l: &Launching, mut observe: impl FnMut() -> Observed, poll: Duration) -> Verdict {
    let began = tokio::time::Instant::now();
    loop {
        if let Some(v) = judge(l, &observe(), now_ms(), began.elapsed() >= BOARD_WAIT) {
            return v;
        }
        tokio::time::sleep(poll).await;
    }
}

/// The live observation for [`reconcile`]; also asks the board to refresh.
fn observe(ctx: &Ctx, l: &Launching) -> Observed {
    ctx.state.refresh();
    let board = ctx.state.agent_ids_in_use().is_some() && crate::herdr_health::current(&ctx.herdr_session).is_none_or(|h| h.is_up());
    let agents = ctx.state.snapshot().agents;
    seen(l, &agents, board, file_len(&l.session_file))
}

/// [`Observed`] from the board's agents and the session file's size now.
pub fn seen(l: &Launching, agents: &[Agent], board: bool, len_now: Option<u64>) -> Observed {
    fn file_of(a: &Agent) -> Option<&str> {
        a.omp.as_ref().and_then(|o| o.session_file.as_deref())
    }
    let ours = |a: &&Agent| file_of(a) == Some(l.session_file.as_str()) || (a.parked.is_none() && a.kind == "omp" && a.name == l.name && file_of(a).is_none_or(|f| f == l.session_file));
    let neighbour = |a: &&Agent| a.parked.is_none() && a.kind == "omp" && a.cwd.as_deref() == Some(l.cwd.as_str());
    Observed {
        board,
        agent: agents.iter().find(ours).map(|a| a.id.clone()),
        neighbour: agents.iter().find(neighbour).map(|a| a.id.clone()),
        touched: len_now.is_some_and(|n| n != l.session_len),
    }
}

fn file_len(path: &str) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

/// `start_agent` failed for a reason that means herdr never started anything (the request was
/// rejected or never made); every other failure may have come after it started.
pub fn refused(e: &ApiError) -> bool {
    const HERDR_REFUSALS: [&str; 6] = ["agent_name_taken", "unsupported_agent_kind", "invalid_request", "invalid_params", "pane_not_found", "agent_pane_busy"];
    matches!(e.code.as_str(), "invalid_params" | "busy" | "not_found" | "io_error") || (e.code == "herdr_error" && HERDR_REFUSALS.iter().any(|c| e.message.starts_with(c)))
}

/// Runs `write` until it succeeds (`false` when `cancel` fires first); `on_fail` hears each error.
pub async fn retry_commit(cancel: &tokio_util::sync::CancellationToken, every: Duration, mut write: impl FnMut() -> Result<(), ApiError>, mut on_fail: impl FnMut(&ApiError)) -> bool {
    let mut told = false;
    loop {
        match write() {
            Ok(()) => return true,
            Err(e) => {
                if !std::mem::replace(&mut told, true) {
                    on_fail(&e);
                }
                tokio::select! {
                    () = cancel.cancelled() => return false,
                    () = tokio::time::sleep(every) => {}
                }
            }
        }
    }
}

/// Applies `verdict` to a journal at the launch boundary (or one a previous daemon left in the
/// middle) and saves it: the agent started → done; surely absent → rolled back; undecided →
/// `confirming`: nothing is removed, the launch record, undo list and uploads stay as they are.
pub async fn finish_recovered(ctx: Option<&Ctx>, path: &Path, mut j: Journal, verdict: Verdict) -> std::io::Result<()> {
    let verdict = match (verdict, &j.launching) {
        (Verdict::Started { .. }, None) => Verdict::Pending("no launch was recorded".to_string()),
        (v, _) => v,
    };
    let mut activity = None;
    j.status.notes.retain(|n| !n.starts_with(CONFIRMING_NOTE));
    match verdict {
        Verdict::Pending(why) => {
            warn!(move_id = %j.status.move_id, "move: {why}; nothing is removed, the launch stays unconfirmed");
            j.status.phase = MovePhase::Confirming;
            j.status.error = None;
            j.status.notes.push(format!("{CONFIRMING_NOTE} {why}. Nothing is removed; TeleFlock keeps checking."));
            j.status.updated_at = now_ms();
            j.at = now_ms();
            return write_journal(path, &j);
        }
        Verdict::Started { agent_id } => {
            let l = j.launching.take().unwrap_or_default();
            warn!(move_id = %j.status.move_id, agent = ?agent_id, "move: the agent was started; the move is done");
            for step in j.status.steps.iter_mut().filter(|s| s.id == "start") {
                step.state = MoveStepState::Done;
            }
            j.status.phase = MovePhase::Done;
            j.status.error = None;
            j.status.agent_id = agent_id.clone();
            j.status.session_file = Some(l.session_file.clone());
            j.status.cwd = Some(l.cwd.clone());
            j.undo.clear();
            activity = agent_id.map(|id| (id, l));
        }
        Verdict::Absent => {
            let launched = j.launching.take().is_some();
            let notes = undo_all(ctx, &j.undo).await;
            j.status.phase = MovePhase::Failed;
            let why = if launched { "the agent did not start here" } else { "tf-hostd restarted while receiving the agent" };
            j.status.error = Some(ApiError::new("interrupted", format!("{why}; everything was rolled back")));
            j.status.notes.extend(notes);
            j.undo.clear();
        }
    }
    for u in &j.uploads {
        let _ = std::fs::remove_file(&u.path);
    }
    j.uploads.clear();
    j.status.updated_at = now_ms();
    j.at = now_ms();
    write_journal(path, &j)?;
    if let (Some(ctx), Some((agent_id, l))) = (ctx, activity) {
        ctx.state.record_activity_as(&agent_id, &l.name, ActivityKind::Started, format!("Moved {} here from {}", l.name, l.from), Some(l.session_file));
    }
    Ok(())
}

/// One pass over the journal at `path` while it is at the launch boundary: looks for the agent
/// ([`reconcile`]) and applies the verdict ([`finish_recovered`]). `None`: nothing to settle (the
/// journal is gone, finished, or has no launch record).
pub async fn settle_once(ctx: Option<&Ctx>, path: &Path, mut observe: impl FnMut(&Launching) -> Observed, poll: Duration) -> std::io::Result<Option<Verdict>> {
    let Some(j) = load(path) else { return Ok(None) };
    let Some(l) = j.launching.clone().filter(|_| is_active(j.status.phase)) else { return Ok(None) };
    let verdict = reconcile(&l, || observe(&l), poll).await;
    finish_recovered(ctx, path, j, verdict.clone()).await?;
    Ok(Some(verdict))
}

/// Checks the launch of move `id` until the board gives a definite answer: every [`CONFIRM_EVERY`]
/// (the first pass at once), also after a restart (`recover`). The move stays `confirming`, its
/// journal kept whole, until then; `job` (this daemon's own job, if any) follows the journal.
pub fn resolve(ctx: &Ctx, id: &str, job: Option<Arc<Job>>) {
    let ctx = ctx.arc();
    let path = journal_path(&ctx.paths.moves, id);
    tokio::spawn(async move {
        loop {
            let out = settle_once(Some(&ctx), &path, |l| observe(&ctx, l), POLL).await;
            if let (Some(job), Some(j)) = (&job, load(&path)) {
                job.update(|s| {
                    s.phase = j.status.phase;
                    s.error = j.status.error.clone();
                    s.agent_id = j.status.agent_id.clone();
                    s.session_file = j.status.session_file.clone();
                    s.cwd = j.status.cwd.clone();
                    s.steps = j.status.steps.clone();
                    s.notes.retain(|n| !n.starts_with(CONFIRMING_NOTE));
                    for n in j.status.notes {
                        if !s.notes.contains(&n) {
                            s.notes.push(n);
                        }
                    }
                });
            }
            match out {
                Ok(Some(Verdict::Pending(_))) => {}
                Ok(_) => return,
                Err(e) => warn!(move_id = %path.display(), "move: saving the settled journal failed ({e}); trying again"),
            }
            tokio::select! {
                () = ctx.cancel.cancelled() => return,
                () = tokio::time::sleep(CONFIRM_EVERY) => {}
            }
        }
    });
}
