//! `jobs.*` (architecture §3.18): an omp agent's background jobs, through its bridge (≥ 2.1.0
//! with `caps.jobs`, `docs/bridge-protocol.md` "Background jobs"): background `bash` / `eval`
//! commands and subagents running as `task` jobs, of the session and of every subagent below it.
//!
//! * The board card's [`JobsSummary`] (`OmpInfo.jobs`) comes from the bridge's `jobs` event, sent
//!   at most once a second when something changed ([`crate::bridge`] keeps it on the session).
//! * `jobs.list` asks the bridge for the jobs themselves; the jobs the client names in `inspect`
//!   come with their output tail, pids, exit code, folder and artifact.
//! * `jobs.cancel` cancels one through omp's own session API (its process is killed, a subagent
//!   aborted) and answers with the jobs after it.
//!
//! While a session waits for background jobs (its turn is over, only a job's result can resume
//! it), the board shows that instead of "quiet", and no "has been quiet" notification fires
//! ([`waiting`]).

use std::time::Duration;

use serde_json::{json, Value};
use tf_proto::{Agent, ApiError, HostMethod, JobsSummary, JobsView};
use tracing::info;

use crate::bridge::BridgeHandle;
use crate::ops::agent::{bridge_sid, omp_agent};
use crate::ops::{to_value, Ctx};
use crate::util::now_ms;

/// How to get a bridge that has the jobs ops.
const RESTART_HINT: &str =
    "Restart the agent so its omp loads the current TeleFlock bridge: Mark done, then Resume it, or start a new agent";
/// Reading jobs and cancelling one are in-memory work in omp.
const QUICK: Duration = Duration::from_secs(10);
/// Jobs inspected per call (omp runs at most 15 jobs at once and lists 10 settled ones).
const MAX_INSPECT: usize = 32;
/// Longest job id accepted (omp's are `bg_<n>` or a subagent id).
const MAX_ID: usize = 200;

pub async fn handle(ctx: &Ctx, req: HostMethod) -> Result<Value, ApiError> {
    match req {
        HostMethod::JobsList(p) => {
            let Some(sid) = jobs_bridge(ctx, &p.agent_id)? else { return to_value(none()) };
            let mut inspect = p.inspect;
            inspect.retain(|id| !id.is_empty() && id.len() <= MAX_ID);
            inspect.dedup();
            inspect.truncate(MAX_INSPECT);
            to_value(list(&ctx.bridge, &sid, &inspect, p.inspect_all.unwrap_or(false)).await?)
        }
        HostMethod::JobsCancel(p) => {
            if p.job_id.is_empty() || p.job_id.len() > MAX_ID {
                return Err(ApiError::new("invalid_params", "jobs.cancel: bad jobId"));
            }
            let a = omp_agent(ctx, &p.agent_id)?;
            let sid = jobs_bridge(ctx, &p.agent_id)?
                .ok_or_else(|| ApiError::new("not_found", format!("{} is closed: it runs no background jobs", a.name)))?;
            let view = cancel(&ctx.bridge, &sid, &p.job_id).await?;
            info!(agent = %p.agent_id, job = %p.job_id, "background job cancelled");
            to_value(view)
        }
        other => Err(ApiError::new("unknown_method", format!("unknown method `{}`", other.name()))),
    }
}

/// `jobs` on the session's bridge.
pub(crate) async fn list(bridge: &BridgeHandle, sid: &str, inspect: &[String], inspect_all: bool) -> Result<JobsView, ApiError> {
    let v = bridge.call(sid, "jobs", json!({ "inspect": inspect, "inspectAll": inspect_all }), QUICK).await?;
    decode(v)
}

/// `jobCancel` on the session's bridge: the jobs after the cancel.
pub(crate) async fn cancel(bridge: &BridgeHandle, sid: &str, job_id: &str) -> Result<JobsView, ApiError> {
    let v = bridge.call(sid, "jobCancel", json!({ "id": job_id }), QUICK).await?;
    decode(v)
}

fn decode(v: Value) -> Result<JobsView, ApiError> {
    serde_json::from_value(v).map_err(|e| ApiError::new("omp_error", format!("bridge jobs: bad response: {e}")))
}

/// No jobs (a closed agent).
fn none() -> JobsView {
    JobsView { jobs: vec![], waiting: false, at: now_ms() }
}

/// The bridge session of an omp agent whose bridge has the jobs ops; `None` for a closed (parked)
/// agent, which has no omp process and so no jobs.
fn jobs_bridge(ctx: &Ctx, agent_id: &str) -> Result<Option<String>, ApiError> {
    let a = omp_agent(ctx, agent_id)?;
    if a.parked.is_some() {
        return Ok(None);
    }
    let sid = bridge_sid(ctx, agent_id).ok_or_else(|| {
        ApiError::new("unsupported", format!("{}'s omp has no TeleFlock bridge, which lists background jobs", a.name)).with_hint(RESTART_HINT)
    })?;
    if !ctx.bridge.by_session(&sid).is_some_and(|b| b.caps.jobs) {
        return Err(ApiError::new(
            "unsupported",
            format!("{} runs a TeleFlock bridge older than 2.1.0, which can't list background jobs", a.name),
        )
        .with_hint(RESTART_HINT));
    }
    Ok(Some(sid))
}

/// What a `jobs` event leaves on the board: nothing while there are no jobs.
pub fn board_summary(s: JobsSummary) -> Option<JobsSummary> {
    (s.running > 0 || s.recent > 0 || s.waiting).then_some(s)
}

/// The agent's turn is over and only a background job's result can resume it.
pub fn waiting(agent: &Agent) -> bool {
    agent.omp.as_ref().and_then(|o| o.jobs.as_ref()).is_some_and(|j| j.waiting)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::{JobGlance, JobStatus};

    fn summary(running: u32, recent: u32, waiting: bool) -> JobsSummary {
        JobsSummary { running, recent, waiting, glance: None, glance_job: None }
    }

    #[test]
    fn board_summary_drops_an_empty_one() {
        assert_eq!(board_summary(summary(0, 0, false)), None);
        assert_eq!(board_summary(summary(2, 0, false)).map(|s| s.running), Some(2));
        assert_eq!(board_summary(summary(0, 1, false)).map(|s| s.recent), Some(1));
        // A delivery in flight: no job runs any more, but the result is about to wake the agent.
        assert!(board_summary(summary(0, 0, true)).is_some_and(|s| s.waiting));
    }

    #[test]
    fn decodes_the_bridge_view() {
        let v = json!({
            "jobs": [
                { "id": "bg_1", "kind": "bash", "status": "running", "label": "bun test", "command": "bun test --watch",
                  "startedAt": 1000, "cancellable": true,
                  "widget": { "title": "bun test", "glance": { "text": "140/190", "label": "tests" }, "progress": 0.73,
                              "progressText": "140/190 tests", "state": "live", "updatedAt": 2000 },
                  "output": "ok 140\n", "outputCut": true, "pids": [41, 42], "cwd": "/w" },
                { "id": "0-Explore", "kind": "task", "status": "completed", "label": "Explore the router", "startedAt": 500,
                  "endedAt": 900, "agentId": "0-Explore", "agentName": "Explore", "cancellable": false, "exitCode": 0 },
            ],
            "waiting": true,
            "at": 3000,
        });
        let view = decode(v).unwrap();
        assert!(view.waiting);
        assert_eq!(view.jobs.len(), 2);
        let bash = &view.jobs[0];
        assert_eq!((bash.status, bash.cancellable, bash.pids.as_deref()), (JobStatus::Running, true, Some(&[41u32, 42][..])));
        let w = bash.widget.as_ref().unwrap();
        assert_eq!(w.glance, Some(JobGlance { text: "140/190".into(), label: Some("tests".into()), trend: None, trend_tone: None }));
        assert_eq!(w.progress, Some(0.73));
        assert_eq!(view.jobs[1].status, JobStatus::Completed);
        assert_eq!(view.jobs[1].ended_at, Some(900));
        assert!(decode(json!({ "jobs": [{ "id": "x" }], "waiting": false, "at": 1 })).is_err_and(|e| e.code == "omp_error"));
    }

    #[test]
    fn waiting_reads_the_card_summary() {
        let mut agent: Agent = serde_json::from_value(json!({
            "id": "t1", "name": "a", "kind": "omp", "paneId": "w1:p1", "tabId": "w1:t1", "workspaceId": "w1",
            "state": "working", "stateSince": 0, "column": "running", "archived": false, "turns": 1, "title": "t",
            "live": { "streaming": false, "thinking": false },
            "omp": { "link": "live", "bridge": true, "fast": false, "mode": "normal", "queue": { "steering": [], "followUp": [] } },
        }))
        .unwrap();
        assert!(!waiting(&agent));
        agent.omp.as_mut().unwrap().jobs = Some(summary(1, 0, true));
        assert!(waiting(&agent));
        agent.omp.as_mut().unwrap().jobs = Some(summary(1, 0, false));
        assert!(!waiting(&agent));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn jobs_ops_and_event_through_the_bridge() {
        use crate::bridge::fake::{handle, FakeExt};
        use crate::bridge::BridgeEvent;

        let (h, dir) = handle();
        let mut events = h.subscribe();
        let mut ext = FakeExt::connect(&h).await;
        ext.hello_caps(7, "s1", "2.1.0", Some(json!({ "live": 1, "jobs": true }))).await;
        assert!(h.by_session("s1").unwrap().caps.jobs);
        assert_eq!(h.by_session("s1").unwrap().jobs, None);

        // The throttled change event lands on the session (and HostdCore hears of it).
        ext.send(json!({ "t": "event", "event": "jobs", "sessionId": "s1",
            "data": { "running": 2, "recent": 1, "waiting": true, "glance": { "text": "140/190", "label": "tests" }, "glanceJob": "bun test" } }))
            .await;
        loop {
            if let BridgeEvent::Jobs { session_id } = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap().unwrap() {
                assert_eq!(session_id, "s1");
                break;
            }
        }
        let s = h.by_session("s1").unwrap().jobs.unwrap();
        assert_eq!((s.running, s.recent, s.waiting, s.glance_job.as_deref()), (2, 1, true, Some("bun test")));
        // Everything settled and evicted: the card loses its summary.
        ext.send(json!({ "t": "event", "event": "jobs", "sessionId": "s1", "data": { "running": 0, "recent": 0, "waiting": false } })).await;
        loop {
            if let BridgeEvent::Jobs { .. } = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap().unwrap() {
                break;
            }
        }
        assert_eq!(h.by_session("s1").unwrap().jobs, None);

        // jobs: inspect ids pass through, the view comes back typed.
        let (h2, inspect) = (h.clone(), vec!["bg_1".to_string()]);
        let call = tokio::spawn(async move { list(&h2, "s1", &inspect, false).await });
        let req = ext.recv_req().await;
        assert_eq!((req["op"].as_str(), &req["params"]), (Some("jobs"), &json!({ "inspect": ["bg_1"], "inspectAll": false })));
        ext.ok(&req, json!({ "jobs": [{ "id": "bg_1", "kind": "bash", "status": "running", "label": "sleep 60", "startedAt": 1, "cancellable": true, "output": "tick 3\n" }], "waiting": false, "at": 5 })).await;
        let view = call.await.unwrap().unwrap();
        assert_eq!(view.jobs[0].output.as_deref(), Some("tick 3\n"));

        // jobCancel: a job that is no longer running is the bridge's `not_found`.
        let h3 = h.clone();
        let call = tokio::spawn(async move { cancel(&h3, "s1", "bg_9").await });
        let req = ext.recv_req().await;
        assert_eq!((req["op"].as_str(), &req["params"]), (Some("jobCancel"), &json!({ "id": "bg_9" })));
        ext.send(json!({ "t": "res", "id": req["id"], "ok": false, "error": { "code": "not_found", "message": "job bg_9 already completed" } })).await;
        let err = call.await.unwrap().unwrap_err();
        assert_eq!((err.code.as_str(), err.message.as_str()), ("not_found", "job bg_9 already completed"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
