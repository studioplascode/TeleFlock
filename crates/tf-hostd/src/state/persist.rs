//! `state.json`: archive, turn counters, activity ring, parked agents and the prune list (per
//! herdr session) and the host's daily usage ledger. Written atomically as compact JSON (pretty
//! files from older builds load the same), at most once per second after a change; changes to the
//! usage ledger alone (a working agent's cost moves with every reply) at most every
//! [`USAGE_SAVE_EVERY`] and at shutdown. Every field is `serde(default)`: files from older builds
//! load unchanged, and older builds ignore the fields they don't know.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use tf_proto::model::{ActivityEvent, CostInfo, DiffStat, ModelRef, PrunedAgent, ThinkingLevel, UsageTotals};
use tf_proto::Millis;

/// Activity events kept per herdr session.
pub const ACTIVITY_CAP: usize = 1000;
/// Days of usage history kept.
const USAGE_DAYS: usize = 90;
/// Changes to the usage ledger alone are written at most this often (and at shutdown).
pub const USAGE_SAVE_EVERY: Duration = Duration::from_secs(60);

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

impl SessionData {
    /// A copy without the activity ring (up to [`ACTIVITY_CAP`] events), for readers that never
    /// look at it: the board rebuild runs several times a second while agents stream.
    pub fn without_activity(&self) -> SessionData {
        let SessionData { archived, archived_sessions, turns, first_seen, activity: _, parked, pruned } = self;
        SessionData {
            archived: archived.clone(),
            archived_sessions: archived_sessions.clone(),
            turns: turns.clone(),
            first_seen: first_seen.clone(),
            activity: VecDeque::new(),
            parked: parked.clone(),
            pruned: pruned.clone(),
        }
    }
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
    /// Moving, or moved, to another host (`ops::moves`). `moving` is read back as `interrupted`
    /// after a restart: no move survives the daemon.
    pub moved: Option<tf_proto::ParkedMove>,
    /// Not marked done: its omp process ended without anyone closing it (herdr stopped or
    /// crashed, the host restarted, omp crashed or was killed) and nothing runs its session again
    /// (`crate::restart`). The card sits in Review and comes back where it stopped
    /// (`Parked.ended`).
    pub ended: Option<tf_proto::autoresume::AgentEnded>,
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
    /// artifact tree is read again) and recovers is not counted twice. True when the ledger changed
    /// (a new baseline or counted growth), i.e. when it needs saving.
    pub fn observe(&mut self, session_id: &str, cost: &CostInfo, day: &str) -> bool {
        let Some(prev) = self.seen.get(session_id).cloned() else {
            self.seen.insert(session_id.to_string(), CostInfo { split: None, ..cost.clone() });
            return true;
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
    /// Unsaved changes: the saver writes them within a second.
    dirty: AtomicBool,
    /// Unsaved usage-ledger changes: written with the next save, else after [`USAGE_SAVE_EVERY`].
    usage_dirty: AtomicBool,
    /// Last successful write (paces usage-only saves).
    saved_at: Mutex<Instant>,
    /// Held from snapshot to rename, so an older snapshot never lands after a newer one.
    saving: Mutex<()>,
}

impl Persist {
    pub fn load(path: PathBuf) -> Arc<Self> {
        // Saves replace the file owner-only; tighten a file written by an older build now.
        if let Err(e) = crate::paths::restrict_file(&path) {
            warn!("restrict {}: {e}", path.display());
        }
        // A torn write of an earlier crash leaves temp files behind (`write_atomic`).
        if let Some(home) = path.parent().filter(|h| !h.as_os_str().is_empty()) {
            let n = crate::paths::sweep_stale_tmp(home);
            if n > 0 {
                tracing::info!("removed {n} stale temp file(s) under {}", home.display());
            }
        }
        // An unreadable file is set aside (`state.json.bad-<ms>`), never overwritten by the next save.
        let data = crate::paths::load_json::<PersistData>(&path);
        Arc::new(Self {
            path,
            data: Mutex::new(data),
            dirty: AtomicBool::new(false),
            usage_dirty: AtomicBool::new(false),
            saved_at: Mutex::new(Instant::now()),
            saving: Mutex::new(()),
        })
    }

    /// Mutates and schedules a save.
    pub fn update<R>(&self, f: impl FnOnce(&mut PersistData) -> R) -> R {
        let r = f(&mut self.data.lock().unwrap_or_else(|p| p.into_inner()));
        self.dirty.store(true, Ordering::Relaxed);
        r
    }

    /// Mutates the usage ledger; `f` returns whether it changed anything. A change is saved with
    /// the next save of anything else, else after [`USAGE_SAVE_EVERY`] or at shutdown.
    pub fn update_usage(&self, f: impl FnOnce(&mut UsageLedger) -> bool) -> bool {
        let changed = f(&mut self.data.lock().unwrap_or_else(|p| p.into_inner()).usage);
        if changed {
            self.usage_dirty.store(true, Ordering::Relaxed);
        }
        changed
    }

    pub fn read<R>(&self, f: impl FnOnce(&PersistData) -> R) -> R {
        f(&self.data.lock().unwrap_or_else(|p| p.into_inner()))
    }

    /// tf-hostd's home: the directory `state.json` is in, where the other stores live too.
    pub fn home(&self) -> &Path {
        self.path.parent().unwrap_or(Path::new(""))
    }

    /// Per-herdr-session view (mutating).
    pub fn session<R>(&self, session: &str, f: impl FnOnce(&mut SessionData) -> R) -> R {
        self.update(|d| f(d.sessions.entry(session.to_string()).or_default()))
    }

    /// Writes every unsaved change now (shutdown, parking).
    pub fn save_now(&self) {
        self.save(true);
    }

    /// What the saver writes each second: any change, and usage-only changes once
    /// [`USAGE_SAVE_EVERY`] passed since the last write.
    fn save_due(&self) {
        self.save(false);
    }

    fn save(&self, usage_now: bool) {
        let _one = self.saving.lock().unwrap_or_else(|p| p.into_inner());
        let usage_due = || usage_now || self.saved_at.lock().unwrap_or_else(|p| p.into_inner()).elapsed() >= USAGE_SAVE_EVERY;
        let dirty = self.dirty.load(Ordering::Relaxed);
        if !dirty && !(self.usage_dirty.load(Ordering::Relaxed) && usage_due()) {
            return;
        }
        // Cleared before the snapshot: a change racing with this save marks it again for the next.
        self.dirty.store(false, Ordering::Relaxed);
        self.usage_dirty.store(false, Ordering::Relaxed);
        let bytes = {
            let mut d = self.data.lock().unwrap_or_else(|p| p.into_inner());
            d.version = 1;
            serde_json::to_vec(&*d)
        };
        match bytes {
            Ok(bytes) => match crate::paths::write_atomic(&self.path, &bytes) {
                Ok(()) => *self.saved_at.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now(),
                Err(e) => {
                    warn!("save {}: {e}", self.path.display());
                    self.dirty.store(true, Ordering::Relaxed);
                }
            },
            Err(e) => warn!("encode state.json: {e}"),
        }
    }

    /// Saves what is due once per second until `cancel`, then everything a final time.
    pub fn spawn_saver(self: &Arc<Self>, cancel: CancellationToken) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                }
                let me2 = me.clone();
                let _ = tokio::task::spawn_blocking(move || me2.save_due()).await;
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
        // The first observation is only the baseline (a change to save, no spend).
        assert!(l.observe("s1", &cost(5.0, 1000, 100), "2026-10-20"));
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
        assert!(l.observe("s1", &cost(1.0, 100, 10), "d"));
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
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains('\n'), "compact JSON: {raw}");
        let q = Persist::load(path.clone());
        assert_eq!(q.read(|d| d.sessions["lab"].archived["term_1"]), 42);
        // Files written pretty by older builds load the same.
        let pretty = serde_json::to_vec_pretty(&serde_json::from_str::<serde_json::Value>(&raw).unwrap()).unwrap();
        std::fs::write(&path, pretty).unwrap();
        assert_eq!(Persist::load(path).read(|d| d.sessions["lab"].archived["term_1"]), 42);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn usage_only_changes_wait_for_the_usage_interval() {
        let td = tempfile::tempdir().unwrap();
        let path = td.path().join("state.json");
        let p = Persist::load(path.clone());
        let observe = |usd: f64| p.update_usage(|u| u.observe("s1", &cost(usd, 0, 0), "d"));
        assert!(observe(1.0));
        assert!(!observe(1.0), "nothing changed, nothing to save");
        assert!(observe(2.0));
        p.save_due();
        assert!(!path.exists(), "usage alone waits for USAGE_SAVE_EVERY");
        // Any other change saves at once, the usage with it.
        p.session("lab", |s| s.turns.insert("t".into(), 1));
        p.save_due();
        let saved = |path: &std::path::Path| Persist::load(path.to_path_buf()).read(|d| d.usage.day("d").cost_usd);
        assert_eq!(saved(&path), 1.0);
        assert!(observe(3.5));
        p.save_due();
        assert_eq!(saved(&path), 1.0, "too soon after the last save");
        let last = *p.saved_at.lock().unwrap();
        *p.saved_at.lock().unwrap() = last.checked_sub(USAGE_SAVE_EVERY).unwrap();
        p.save_due();
        assert_eq!(saved(&path), 2.5);
        // Shutdown writes whatever is left.
        assert!(observe(4.0));
        p.save_now();
        assert_eq!(saved(&path), 3.0);
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

    #[test]
    fn a_corrupt_state_file_is_set_aside_and_a_save_leaves_it_alone() {
        let td = tempfile::tempdir().unwrap();
        let path = td.path().join("state.json");
        // An empty file under the final name: what a power loss leaves when nothing was synced.
        std::fs::write(&path, b"").unwrap();
        let p = Persist::load(path.clone());
        assert!(p.read(|d| d.sessions.is_empty()));
        assert!(!path.exists(), "moved aside, not left to be overwritten");
        p.session("lab", |s| s.turns.insert("t".into(), 1));
        p.save_now();
        assert_eq!(Persist::load(path.clone()).read(|d| d.sessions["lab"].turns["t"]), 1);
        let bad: Vec<_> = std::fs::read_dir(td.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("state.json.bad-")).collect();
        assert_eq!(bad.len(), 1, "{bad:?}");
    }
}
