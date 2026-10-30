//! The moves this daemon runs, in either role, and what `move.status` reports about them. One
//! registry per daemon (move ids are unique); every job belongs to one herdr session's context.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use tf_proto::{ApiError, MovePhase, MoveRole, MoveStatus, MoveStep, MoveStepState};

use crate::util::now_ms;

/// Finished jobs answer `move.status` this long.
const KEEP_FINISHED: Duration = Duration::from_secs(3600);

pub struct Job {
    pub id: String,
    pub role: MoveRole,
    /// The herdr session (context) it runs in.
    pub herdr_session: String,
    /// Source: the moving agent.
    pub agent_id: String,
    status: Mutex<MoveStatus>,
    /// `move.abort` asked for a rollback.
    pub cancel: CancellationToken,
    /// When the app last asked about this job (a source waiting in `ready` gives up on a silent app).
    touched: Mutex<Instant>,
    finished: Mutex<Option<Instant>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Job {
    pub fn new(id: &str, role: MoveRole, herdr_session: &str, agent_id: &str, steps: &[(&str, String)]) -> Arc<Job> {
        let now = now_ms();
        let steps = steps
            .iter()
            .map(|(id, label)| MoveStep { id: (*id).to_string(), label: label.clone(), state: MoveStepState::Pending, detail: None })
            .collect();
        Arc::new(Job {
            id: id.to_string(),
            role,
            herdr_session: herdr_session.to_string(),
            agent_id: agent_id.to_string(),
            status: Mutex::new(MoveStatus {
                move_id: id.to_string(),
                role,
                phase: MovePhase::Running,
                steps,
                parts: Vec::new(),
                source: None,
                agent_id: None,
                session_file: None,
                cwd: None,
                error: None,
                notes: Vec::new(),
                started_at: now,
                updated_at: now,
            }),
            cancel: CancellationToken::new(),
            touched: Mutex::new(Instant::now()),
            finished: Mutex::new(None),
        })
    }

    pub fn status(&self) -> MoveStatus {
        lock(&self.status).clone()
    }

    pub fn phase(&self) -> MovePhase {
        lock(&self.status).phase
    }

    pub fn update(&self, f: impl FnOnce(&mut MoveStatus)) {
        let mut s = lock(&self.status);
        f(&mut s);
        s.updated_at = now_ms();
        if matches!(s.phase, MovePhase::Done | MovePhase::Failed) {
            lock(&self.finished).get_or_insert_with(Instant::now);
        }
    }

    pub fn step(&self, id: &str, state: MoveStepState, detail: Option<String>) {
        self.update(|s| {
            if let Some(step) = s.steps.iter_mut().find(|st| st.id == id) {
                step.state = state;
                if detail.is_some() {
                    step.detail = detail;
                }
            }
        });
    }

    pub fn label(&self, id: &str, label: String) {
        self.update(|s| {
            if let Some(step) = s.steps.iter_mut().find(|st| st.id == id) {
                step.label = label;
            }
        });
    }

    pub fn set_phase(&self, phase: MovePhase) {
        self.update(|s| s.phase = phase);
    }

    pub fn note(&self, note: String) {
        tracing::warn!(id = %self.id, "move: {note}");
        self.update(|s| s.notes.push(note));
    }

    /// Ends the job as failed (after its rollback): the running step is marked failed.
    pub fn fail(&self, err: ApiError) {
        self.update(|s| {
            for step in s.steps.iter_mut().filter(|st| st.state == MoveStepState::Running) {
                step.state = MoveStepState::Failed;
            }
            s.phase = MovePhase::Failed;
            s.error = Some(err);
        });
    }

    pub fn touch(&self) {
        *lock(&self.touched) = Instant::now();
    }

    pub fn idle_for(&self) -> Duration {
        lock(&self.touched).elapsed()
    }

    pub fn is_active(&self) -> bool {
        !matches!(self.phase(), MovePhase::Done | MovePhase::Failed)
    }

    fn expired(&self) -> bool {
        lock(&self.finished).is_some_and(|at| at.elapsed() > KEEP_FINISHED)
    }
}

static JOBS: LazyLock<Mutex<HashMap<String, Arc<Job>>>> = LazyLock::new(Default::default);

pub fn get(id: &str) -> Option<Arc<Job>> {
    let mut jobs = lock(&JOBS);
    jobs.retain(|_, j| !j.expired());
    jobs.get(id).cloned()
}

/// Registers a job; `busy` while another active move of the same agent runs in this role.
pub fn insert(job: Arc<Job>) -> Result<Arc<Job>, ApiError> {
    let mut jobs = lock(&JOBS);
    jobs.retain(|_, j| !j.expired());
    if job.role == MoveRole::Source
        && let Some(other) = jobs.values().find(|j| {
            j.role == MoveRole::Source && j.herdr_session == job.herdr_session && j.agent_id == job.agent_id && j.is_active()
        })
    {
        return Err(ApiError::new("busy", "this agent is already being moved").with_hint(format!("Move {} is still running.", other.id)));
    }
    if jobs.contains_key(&job.id) {
        return Err(ApiError::new("busy", format!("move {} already runs here", job.id)));
    }
    jobs.insert(job.id.clone(), job.clone());
    Ok(job)
}

/// Active jobs of one herdr session.
pub fn active(herdr_session: &str) -> Vec<Arc<Job>> {
    lock(&JOBS).values().filter(|j| j.herdr_session == herdr_session && j.is_active()).cloned().collect()
}

/// Whether any move (of any herdr session) is unfinished: its packing and unpacking write omp
/// blobs before their session file lands, so a storage cleanup waits.
pub fn any_active() -> bool {
    lock(&JOBS).values().any(|j| j.is_active())
}

/// A fresh move id (`mv_<16 hex>`).
pub fn new_id() -> String {
    let mut b = [0u8; 8];
    match getrandom::fill(&mut b) {
        Ok(()) => format!("mv_{}", b.iter().map(|b| format!("{b:02x}")).collect::<String>()),
        Err(_) => crate::util::new_id("mv_"),
    }
}

/// Ids name staging folders: `mv_` and hex only.
pub fn valid_id(id: &str) -> bool {
    id.strip_prefix("mv_").is_some_and(|h| !h.is_empty() && h.len() <= 64 && h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_bookkeeping() {
        let job = Job::new("mv_t1", MoveRole::Source, "s", "a1", &[("push", "Push".into()), ("pack", "Pack".into())]);
        job.step("push", MoveStepState::Running, None);
        assert_eq!(job.status().steps[0].state, MoveStepState::Running);
        job.fail(ApiError::new("push_failed", "rejected"));
        let s = job.status();
        assert_eq!(s.phase, MovePhase::Failed);
        assert_eq!(s.steps[0].state, MoveStepState::Failed);
        assert_eq!(s.steps[1].state, MoveStepState::Pending);
        assert_eq!(s.error.unwrap().code, "push_failed");
        assert!(!job.is_active());
    }

    #[test]
    fn one_active_source_move_per_agent() {
        let a = Job::new(&new_id(), MoveRole::Source, "s-one", "agent-x", &[]);
        insert(a.clone()).unwrap();
        let b = Job::new(&new_id(), MoveRole::Source, "s-one", "agent-x", &[]);
        assert_eq!(insert(b.clone()).err().map(|e| e.code).as_deref(), Some("busy"));
        a.set_phase(MovePhase::Failed);
        insert(b).unwrap();
        assert!(valid_id(&new_id()));
        assert!(!valid_id("mv_../x"));
        assert!(!valid_id("up_1"));
    }
}
