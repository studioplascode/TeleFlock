//! `state.json`: archive, turn counters, activity ring, parked agents and the prune list (per
//! herdr session) and the host's daily usage ledger. Written atomically, at most once per second.
//! Every field is `serde(default)`: files from older builds load unchanged, and older builds
//! ignore the fields they don't know.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use tf_proto::model::{ActivityEvent, CostInfo, DiffStat, ModelRef, PrunedAgent, ThinkingLevel, UsageTotals};
use tf_proto::Millis;

/// Activity events kept per herdr session.
pub const ACTIVITY_CAP: usize = 1000;
/// Days of usage history kept.
const USAGE_DAYS: usize = 90;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionData {
    /// Archived agents (agent id → archived at).
    pub archived: HashMap<String, Millis>,
    /// Archived omp sessions (omp session id → archived at); survives herdr restarts.
    pub archived_sessions: HashMap<String, Millis>,
    /// Completed turns per agent id.
    pub turns: HashMap<String, u32>,
    /// First time TeleFlock saw each agent.
    pub first_seen: HashMap<String, Millis>,
    /// Newest last.
    pub activity: VecDeque<ActivityEvent>,
    /// Agents marked done whose pane TeleFlock closed (agent id → record, architecture §3.5).
    pub parked: BTreeMap<String, ParkedRecord>,
    /// Agents removed because their omp session file was deleted; newest first, capped.
    pub pruned: Vec<PrunedAgent>,
}

/// Everything needed to show a parked agent as a Done card and to resume it
/// (`omp --resume=<session_file>`). A snapshot taken when its pane was closed.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ParkedRecord {
    pub agent_id: String,
    /// herdr agent name (reused on resume unless a live agent took it).
    pub name: String,
    pub kind: String,
    pub title: String,
    pub cwd: Option<String>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub session_id: Option<String>,
    pub session_file: String,
    pub model: Option<ModelRef>,
    pub thinking: Option<ThinkingLevel>,
    pub started_at: Option<Millis>,
    pub archived_at: Millis,
    pub parked_at: Millis,
    pub turns: u32,
    pub diff: Option<DiffStat>,
    pub cost: Option<CostInfo>,
    pub last_turn_ended_at: Option<Millis>,
    /// Last one-line activity summary.
    pub line: Option<String>,
    /// The agent ran in a linked git worktree (resume reopens it with herdr `worktree.open`).
    pub worktree: Option<ParkedWorktree>,
    /// herdr workspace the pane lived in, and its folder: resume adds a tab there when that
    /// workspace is still open at the same folder.
    pub workspace_id: Option<String>,
    pub workspace_cwd: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ParkedWorktree {
    /// Checkout path of the linked worktree.
    pub path: String,
    /// Main worktree root of its repository.
    pub repo_root: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageLedger {
    /// Host-local day → totals.
    pub days: BTreeMap<String, UsageTotals>,
    /// Highest cumulative cost seen per omp session (delta accounting).
    pub seen: HashMap<String, CostInfo>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistData {
    pub version: u32,
    pub sessions: BTreeMap<String, SessionData>,
    pub usage: UsageLedger,
    /// Image originals tf-hostd kept, linked to their user rows: omp session id → row id → one
    /// slot per image (`Signal::OriginalsKept`, handed back to the replica when it joins).
    pub originals: HashMap<String, BTreeMap<String, Vec<Option<String>>>>,
}

impl UsageLedger {
    /// Accounts the growth of one session's cumulative cost (main + subagents + advisor). The
    /// first observation of a session only sets the baseline (its earlier spend predates
    /// tracking). The baseline is a high-water mark: a total that dips (a resync before the
    /// artifact tree is read again) and recovers is not counted twice.
    pub fn observe(&mut self, session_id: &str, cost: &CostInfo, day: &str) -> bool {
        let Some(prev) = self.seen.get(session_id).cloned() else {
            self.seen.insert(session_id.to_string(), CostInfo { split: None, ..cost.clone() });
            return false;
        };
        let d_usd = (cost.usd - prev.usd).max(0.0);
        let d_in = cost.input.saturating_sub(prev.input);
        let d_out = cost.output.saturating_sub(prev.output);
        let d_cache = (cost.cache_read + cost.cache_write).saturating_sub(prev.cache_read + prev.cache_write);
        let high = CostInfo {
            usd: prev.usd.max(cost.usd),
            input: prev.input.max(cost.input),
            output: prev.output.max(cost.output),
            cache_read: prev.cache_read.max(cost.cache_read),
            cache_write: prev.cache_write.max(cost.cache_write),
            split: None,
        };
        self.seen.insert(session_id.to_string(), high);
        if d_usd == 0.0 && d_in == 0 && d_out == 0 && d_cache == 0 {
            return false;
        }
        let t = self.days.entry(day.to_string()).or_insert_with(zero);
        t.cost_usd += d_usd;
        t.input += d_in;
        t.output += d_out;
        t.tokens += d_in + d_out + d_cache;
        while self.days.len() > USAGE_DAYS {
            let first = self.days.keys().next().cloned();
            if let Some(k) = first {
                self.days.remove(&k);
            }
        }
        true
    }

    pub fn day(&self, day: &str) -> UsageTotals {
        self.days.get(day).cloned().unwrap_or_else(zero)
    }
}

pub fn zero() -> UsageTotals {
    UsageTotals { cost_usd: 0.0, tokens: 0, input: 0, output: 0 }
}

pub struct Persist {
    path: PathBuf,
    data: Mutex<PersistData>,
    dirty: AtomicBool,
    /// Held from snapshot to rename, so an older snapshot never lands after a newer one.
    saving: Mutex<()>,
}

impl Persist {
    pub fn load(path: PathBuf) -> Arc<Self> {
        // Saves replace the file owner-only; tighten a file written by an older build now.
        if let Err(e) = crate::paths::restrict_file(&path) {
            warn!("restrict {}: {e}", path.display());
        }
        let data = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<PersistData>(&bytes).unwrap_or_else(|e| {
                warn!("{}: unreadable ({e}); starting fresh", path.display());
                PersistData::default()
            }),
            Err(_) => PersistData::default(),
        };
        Arc::new(Self { path, data: Mutex::new(data), dirty: AtomicBool::new(false), saving: Mutex::new(()) })
    }

    /// Mutates and schedules a save.
    pub fn update<R>(&self, f: impl FnOnce(&mut PersistData) -> R) -> R {
        let r = f(&mut self.data.lock().unwrap_or_else(|p| p.into_inner()));
        self.dirty.store(true, Ordering::Relaxed);
        r
    }

    pub fn read<R>(&self, f: impl FnOnce(&PersistData) -> R) -> R {
        f(&self.data.lock().unwrap_or_else(|p| p.into_inner()))
    }

    /// Per-herdr-session view (mutating).
    pub fn session<R>(&self, session: &str, f: impl FnOnce(&mut SessionData) -> R) -> R {
        self.update(|d| f(d.sessions.entry(session.to_string()).or_default()))
    }

    pub fn save_now(&self) {
        let _one = self.saving.lock().unwrap_or_else(|p| p.into_inner());
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let bytes = {
            let mut d = self.data.lock().unwrap_or_else(|p| p.into_inner());
            d.version = 1;
            serde_json::to_vec_pretty(&*d)
        };
        match bytes {
            Ok(bytes) => {
                if let Err(e) = crate::paths::write_atomic(&self.path, &bytes) {
                    warn!("save {}: {e}", self.path.display());
                    self.dirty.store(true, Ordering::Relaxed);
                }
            }
            Err(e) => warn!("encode state.json: {e}"),
        }
    }

    /// Saves dirty state once per second until `cancel`, then a final time.
    pub fn spawn_saver(self: &Arc<Self>, cancel: CancellationToken) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                }
                let me2 = me.clone();
                let _ = tokio::task::spawn_blocking(move || me2.save_now()).await;
            }
            me.save_now();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cost(usd: f64, input: u64, output: u64) -> CostInfo {
        CostInfo { usd, input, output, cache_read: 0, cache_write: 0, split: None }
    }

    #[test]
    fn usage_counts_growth_only() {
        let mut l = UsageLedger::default();
        assert!(!l.observe("s1", &cost(5.0, 1000, 100), "2026-10-20"));
        assert_eq!(l.day("2026-10-20").cost_usd, 0.0);
        assert!(l.observe("s1", &cost(5.5, 1200, 150), "2026-10-20"));
        let t = l.day("2026-10-20");
        assert!((t.cost_usd - 0.5).abs() < 1e-9);
        assert_eq!((t.input, t.output, t.tokens), (200, 50, 250));
        assert!(!l.observe("s1", &cost(5.5, 1200, 150), "2026-10-20"));
    }

    #[test]
    fn usage_dip_and_recovery_counts_once() {
        let mut l = UsageLedger::default();
        l.observe("s1", &cost(1.0, 100, 10), "d");
        assert!(l.observe("s1", &cost(2.0, 200, 20), "d"));
        // Resync: the subagent tree is not re-read yet, then it is.
        assert!(!l.observe("s1", &cost(1.2, 120, 12), "d"));
        assert!(!l.observe("s1", &cost(2.0, 200, 20), "d"));
        assert!(l.observe("s1", &cost(2.5, 250, 25), "d"));
        assert!((l.day("d").cost_usd - 1.5).abs() < 1e-9);
    }

    #[test]
    fn roundtrip_file() {
        let dir = std::env::temp_dir().join(format!("tf-hostd-persist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let p = Persist::load(path.clone());
        p.session("lab", |s| {
            s.archived.insert("term_1".into(), 42);
        });
        p.save_now();
        let q = Persist::load(path);
        assert_eq!(q.read(|d| d.sessions["lab"].archived["term_1"]), 42);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn state_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let td = tempfile::tempdir().unwrap();
        let path = td.path().join("state.json");
        std::fs::write(&path, b"{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let p = Persist::load(path.clone());
        assert_eq!(mode(&path), 0o600);
        std::fs::remove_file(&path).unwrap();
        p.update(|d| d.version = 1);
        p.save_now();
        assert_eq!(mode(&path), 0o600);
    }
}
