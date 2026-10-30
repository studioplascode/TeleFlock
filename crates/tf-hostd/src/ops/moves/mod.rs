//! `move.*`: moving an agent to another host (architecture §3.28; wire types `tf_proto::moves`).
//!
//! Hosts never talk to each other; the app relays. This daemon plays either role:
//! * **source** (`source.rs`): `move.check` (preflight), `move.start` (push the branch, write the
//!   uncommitted changes as a patch, close the agent, `omp session pack`), `move.read` (the app
//!   copies the parts out), `move.finish` (`omp session moved --to`; the parked card says `moved`)
//!   and the rollback (`move.abort`, a failed step, an app that went silent);
//! * **target** (`target.rs`): `move.probe` (preflight), `move.receive` (clone, fetch, check out,
//!   apply the changes, `omp session unpack --cwd`, resume) with an undo journal on disk.
//!
//! Both report through `move.status`. Preflight facts and verdicts live in `facts.rs`, omp's
//! command lines in `ompcli.rs`, remote URL matching in `url.rs`.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use tf_proto::{ApiError, HostMethod, MoveRole, MoveStatus, ParkedMoveState};

use crate::clients::ClientHandle;
use crate::ops::{to_value, Ctx};

mod facts;
pub(crate) mod jobs;
mod ompcli;
mod source;
mod target;
mod url;

#[cfg(test)]
mod tests;

/// How often packed moves are checked for an app that stopped asking.
const SWEEP: Duration = Duration::from_secs(60);

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::MoveCheckReq(p) => to_value(facts::check(ctx, &p.agent_id, true).await?.0),
        HostMethod::MoveProbeReq(p) => to_value(facts::probe(ctx, p).await?),
        HostMethod::MoveStart(p) => to_value(source::start(ctx, p).await?),
        HostMethod::MoveStatusReq(r) => to_value(status(ctx, &r.move_id)?),
        HostMethod::MoveRead(p) => to_value(source::read(p).await?),
        HostMethod::MoveReceive(p) => to_value(target::receive(ctx, p).await?),
        HostMethod::MoveFinish(p) => to_value(source::finish(ctx, p).await?),
        HostMethod::MoveAbort(r) => to_value(abort(ctx, &r.move_id).await?),
        other => Err(ApiError::new("unknown_method", format!("{} is not a move method", other.name()))),
    }
}

/// `move.status`: a job of this daemon, else a receive it finished earlier (its journal).
fn status(ctx: &Ctx, id: &str) -> Result<MoveStatus, ApiError> {
    if let Some(job) = jobs::get(id) {
        job.touch();
        return Ok(job.status());
    }
    target::finished_status(ctx, id).ok_or_else(|| {
        ApiError::new("not_found", format!("no move {id} here")).with_hint("It ended over an hour ago, or tf-hostd restarted since.")
    })
}

/// `move.abort`: rolls back a source (the agent resumes where it was when the move closed it) or a
/// receive. Finished or failed moves answer their status.
async fn abort(ctx: &Ctx, id: &str) -> Result<MoveStatus, ApiError> {
    match jobs::get(id) {
        Some(job) if job.role == MoveRole::Source => Ok(source::abort(ctx, job).await),
        Some(job) => Ok(target::abort(&job)),
        None => match target::finished_status(ctx, id) {
            Some(s) => Ok(s),
            None => source::abort_orphan(ctx, id),
        },
    }
}

/// Context start: what a previous daemon left. Parked cards still marked `moving` become
/// `interrupted` (no move survives a restart; the target may run the agent now, so it is not
/// resumed here), its source staging folders go, its receives in the middle are rolled back.
/// Then packed moves the app stopped asking about expire, every minute.
pub fn start(ctx: &Arc<Ctx>) {
    let ctx = ctx.clone();
    tokio::spawn(async move {
        for r in ctx.state.parked_all() {
            if let Some(mut m) = r.moved.filter(|m| m.state == ParkedMoveState::Moving) {
                m.state = ParkedMoveState::Interrupted;
                ctx.state.set_parked_move(&r.agent_id, Some(m));
            }
        }
        clean_source_staging(&ctx);
        target::recover(&ctx).await;
        let mut tick = tokio::time::interval(SWEEP);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tokio::select! {
                () = ctx.cancel.cancelled() => break,
                _ = tick.tick() => source::expire_idle(&ctx).await,
            }
        }
    });
}

/// Deletes source staging folders (`source.json` names their herdr session) of this context.
fn clean_source_staging(ctx: &Ctx) {
    let Ok(rd) = std::fs::read_dir(&ctx.paths.moves) else { return };
    for e in rd.flatten() {
        let marker = e.path().join("source.json");
        let Some(v) = std::fs::read(&marker).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { continue };
        if v.get("herdrSession").and_then(Value::as_str) == Some(ctx.herdr_session.as_str()) {
            tracing::info!(dir = %e.path().display(), "move: deleting the staging of a move the previous daemon ran");
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}
