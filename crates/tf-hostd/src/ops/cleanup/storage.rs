//! `cleanup.storage` / `cleanup.storageRun`: omp's own storage maintenance (`omp gc`), limited to
//! what is not a session.
//!
//! `omp gc` without a category flag runs omp's configured categories, and omp's defaults include
//! archiving cold sessions (`gc.archive`, moved to `archive/` and their history rows deleted), so
//! every run here names its categories, and only these exist: `--blobs` (unreferenced blobs past
//! omp's 5 min write grace), `--wal` (`PRAGMA wal_checkpoint(TRUNCATE)` of `history.db` and
//! `models.db`), `--compress` (idle session files stored with the file system's transparent
//! compression in place, APFS and NTFS only: same paths, bytes and mtimes, still resumable).
//! Never `--archive`, never `--stale` (it deletes collab guest replicas, which are sessions, and
//! debug reports).
//!
//! A check is one dry run of all three (`omp gc --json --blobs --wal --compress`, nothing changes)
//! plus the size of omp's session store, shown as kept. Apply runs the chosen categories one
//! `omp gc --json --apply --<category>` at a time, so a failure in one (a WAL checkpoint omp
//! reports busy while sessions write) neither hides nor stops the others' results. One run per
//! daemon at a time (omp's own `gc.lock` guards the agent dir too); a request for the same run
//! joins it, another kind is `busy`. Requests answer once the run is done or after 20 s with
//! `running`; `cleanup.storage {waitMs}` follows it. Each `omp gc` runs without a shell, stdin
//! closed, in its own process group, killed with it after 15 min.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::Value;
use tf_proto::{
    ApiError, CleanupStorage, CleanupStorageRunParams, GcBlobs, GcCategory, GcCompress, GcRun,
    GcUsage, GcWal, GcWalDb,
};
use tokio::sync::watch;

use super::size::{self, Budget};
use crate::ops::host::{omp_agent_dir, omp_bin};
use crate::ops::tools;
use crate::util::now_ms;

const TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Longest wait before a request answers with the run still going (the app's timeout is 30 s).
const WAIT_MAX_MS: u32 = 20_000;
/// Every category, in the order a run applies them.
pub(crate) const ALL: [GcCategory; 3] = [GcCategory::Blobs, GcCategory::Compress, GcCategory::Wal];

#[derive(Default)]
struct State {
    running: Option<GcRun>,
    check: Option<GcRun>,
    applied: Option<GcRun>,
    sessions: Option<GcUsage>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Default::default);
/// Bumped when a run ends.
static DONE: LazyLock<watch::Sender<u64>> = LazyLock::new(Default::default);

fn flag(c: GcCategory) -> &'static str {
    match c {
        GcCategory::Blobs => "--blobs",
        GcCategory::Wal => "--wal",
        GcCategory::Compress => "--compress",
    }
}

/// The categories asked for, each once, in [`ALL`]'s order.
pub(crate) fn normalize(categories: &[GcCategory]) -> Vec<GcCategory> {
    ALL.into_iter().filter(|c| categories.contains(c)).collect()
}

/// `omp gc` arguments. Never without a category: omp would then run its configured defaults,
/// which archive sessions.
pub(crate) fn gc_args(
    apply: bool,
    categories: &[GcCategory],
) -> Result<Vec<&'static str>, ApiError> {
    let categories = normalize(categories);
    if categories.is_empty() {
        return Err(ApiError::new(
            "invalid_params",
            "name at least one storage category (blobs, wal, compress)",
        ));
    }
    let mut args = vec!["gc", "--json"];
    if apply {
        args.push("--apply");
    }
    args.extend(categories.into_iter().map(flag));
    Ok(args)
}

fn u32_at(v: &Value, key: &str) -> u32 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0) as u32
}

fn u64_at(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn bool_at(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// What one `omp gc --json` printed (`GcResult`), into `run`.
pub(crate) fn merge_result(run: &mut GcRun, v: &Value) {
    if let Some(b) = v.get("blobs") {
        run.blobs = Some(GcBlobs {
            referenced: u32_at(b, "referenced"),
            would_delete: u32_at(b, "wouldDelete"),
            deleted: u32_at(b, "deleted"),
            bytes: u64_at(b, "bytes"),
        });
    }
    if let Some(w) = v.get("wal") {
        let databases = w
            .get("databases")
            .and_then(Value::as_array)
            .map(|dbs| {
                dbs.iter()
                    .map(|d| GcWalDb {
                        path: d
                            .get("dbPath")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        wal_bytes: u64_at(d, "walBytes"),
                        checkpointed: bool_at(d, "checkpointed"),
                    })
                    .collect()
            })
            .unwrap_or_default();
        run.wal = Some(GcWal {
            databases,
            wal_bytes: u64_at(w, "walBytes"),
            checkpointed: bool_at(w, "checkpointed"),
        });
    }
    if let Some(c) = v.get("compress") {
        run.compress = Some(GcCompress {
            supported: bool_at(c, "supported"),
            method: c.get("method").and_then(Value::as_str).map(str::to_string),
            sessions: u32_at(c, "sessions"),
            would_compress: u32_at(c, "wouldCompress"),
            compressed: u32_at(c, "compressed"),
            bytes: u64_at(c, "bytes"),
            allocated_before: u64_at(c, "allocatedBefore"),
            allocated_after: u64_at(c, "allocatedAfter"),
            skipped_live: u32_at(c, "skippedLive"),
            probe_failure: c
                .get("probeFailure")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    for cat in ["blobs", "compress"] {
        for e in v
            .get(cat)
            .and_then(|c| c.get("errors"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(e) = e.as_str() {
                run.errors.push(format!("{cat}: {e}"));
            }
        }
    }
}

/// One `omp gc --json …`: its result into `run`, or why it printed none.
async fn once(bin: &Path, apply: bool, categories: &[GcCategory], run: &mut GcRun) {
    let label = normalize(categories)
        .into_iter()
        .map(|c| flag(c).trim_start_matches('-'))
        .collect::<Vec<_>>()
        .join(", ");
    let args = match gc_args(apply, categories) {
        Ok(a) => a,
        Err(e) => return run.errors.push(e.message),
    };
    match tools::run(bin, &args, TIMEOUT, &[], &[]).await {
        Ok(out) => match serde_json::from_str::<Value>(out.stdout.trim()) {
            Ok(v) => merge_result(run, &v),
            Err(_) => {
                let stderr = out.text.get(out.stdout.len()..).unwrap_or_default();
                let msg = stderr
                    .trim()
                    .lines()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("no output")
                    .trim();
                run.errors.push(format!(
                    "{label}: omp gc failed (exit {}): {}",
                    out.code,
                    clip(msg)
                ));
            }
        },
        Err(e) => run.errors.push(format!("{label}: {e}")),
    }
}

fn clip(s: &str) -> String {
    if s.chars().count() <= 300 {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(300).collect::<String>())
    }
}

fn snapshot(st: &State) -> CleanupStorage {
    CleanupStorage {
        agent_dir: omp_agent_dir().display().to_string(),
        running: st.running.clone(),
        check: st.check.clone(),
        applied: st.applied.clone(),
        sessions: st.sessions.clone(),
        unavailable: omp_bin()
            .is_none()
            .then(|| "omp is not installed on this host".to_string()),
    }
}

/// `cleanup.storage`: the last check and apply, and the run in progress (waited for up to `wait_ms`).
pub async fn status(wait_ms: Option<u32>) -> CleanupStorage {
    let mut rx = DONE.subscribe();
    let wait = Duration::from_millis(u64::from(wait_ms.unwrap_or(0).min(WAIT_MAX_MS)));
    if !wait.is_zero() {
        let _ = tokio::time::timeout(wait, async {
            loop {
                let running = STATE.lock().unwrap().running.is_some();
                if !running || rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
    }
    snapshot(&STATE.lock().unwrap())
}

/// `cleanup.storageRun`: starts (or joins) a check or an apply, answers when it ends or after 20 s.
pub async fn run(p: &CleanupStorageRunParams) -> Result<CleanupStorage, ApiError> {
    let categories = if p.apply {
        normalize(&p.categories)
    } else {
        ALL.to_vec()
    };
    gc_args(p.apply, &categories)?;
    if p.apply && crate::ops::moves::jobs::any_active() {
        return Err(ApiError::new("busy", "an agent is being moved: omp's storage cleanup waits until the move is done (it could remove blobs the move just wrote)").retryable());
    }
    let Some(bin) = omp_bin() else {
        return Ok(snapshot(&STATE.lock().unwrap()));
    };
    {
        let mut st = STATE.lock().unwrap();
        match &st.running {
            Some(r) if r.apply == p.apply && r.categories == categories => {}
            Some(r) => {
                let what = if r.apply {
                    "applying omp's storage cleanup"
                } else {
                    "checking omp's storage"
                };
                return Err(ApiError::new(
                    "busy",
                    format!("TeleFlock is already {what} on this host"),
                )
                .retryable());
            }
            None => {
                let run = GcRun {
                    apply: p.apply,
                    categories: categories.clone(),
                    started_at: now_ms(),
                    finished_at: None,
                    blobs: None,
                    wal: None,
                    compress: None,
                    errors: Vec::new(),
                };
                st.running = Some(run.clone());
                tokio::spawn(execute(bin, run));
            }
        }
    }
    Ok(status(Some(WAIT_MAX_MS)).await)
}

async fn execute(bin: PathBuf, mut run: GcRun) {
    let started = std::time::Instant::now();
    let mut sessions = None;
    if run.apply {
        for c in run.categories.clone() {
            once(&bin, true, &[c], &mut run).await;
        }
    } else {
        let categories = run.categories.clone();
        once(&bin, false, &categories, &mut run).await;
        let dir = omp_agent_dir().join("sessions");
        sessions = tokio::task::spawn_blocking(move || {
            let s = size::measure(&dir, Budget::new(5_000_000, Duration::from_secs(30)));
            GcUsage {
                bytes: s.bytes,
                files: s.files as u32,
            }
        })
        .await
        .ok();
    }
    run.finished_at = Some(now_ms());
    tracing::info!(apply = run.apply, categories = ?run.categories, errors = run.errors.len(), ms = started.elapsed().as_millis() as u64, "omp gc");
    {
        let mut st = STATE.lock().unwrap();
        st.running = None;
        if run.apply {
            st.applied = Some(run);
        } else {
            st.check = Some(run);
            st.sessions = sessions.or(st.sessions.take());
        }
    }
    DONE.send_modify(|n| *n += 1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_run_names_its_categories_and_never_sessions() {
        let all = [
            GcCategory::Wal,
            GcCategory::Blobs,
            GcCategory::Compress,
            GcCategory::Blobs,
        ];
        assert_eq!(
            gc_args(false, &all).unwrap(),
            ["gc", "--json", "--blobs", "--compress", "--wal"]
        );
        assert_eq!(
            gc_args(true, &[GcCategory::Wal]).unwrap(),
            ["gc", "--json", "--apply", "--wal"]
        );
        assert_eq!(
            gc_args(true, &[GcCategory::Compress, GcCategory::Blobs]).unwrap(),
            ["gc", "--json", "--apply", "--blobs", "--compress"]
        );
        // No category would run omp's configured defaults, which archive cold sessions.
        assert_eq!(gc_args(true, &[]).unwrap_err().code, "invalid_params");
        assert_eq!(gc_args(false, &[]).unwrap_err().code, "invalid_params");
        for apply in [false, true] {
            let args = gc_args(apply, &all).unwrap();
            assert!(
                !args.iter().any(|a| matches!(*a, "--archive" | "--stale")
                    || a.contains("retain")
                    || a.contains("cold")),
                "{args:?}"
            );
        }
    }

    /// `omp gc --json --blobs --wal --compress` of omp 18.13.3 (dry run, Linux).
    #[test]
    fn parses_a_dry_run() {
        let v = json!({
            "agentDir": "/home/u/.omp/agent", "apply": false,
            "blobs": { "referenced": 12, "candidates": 20, "wouldDelete": 8, "deleted": 0, "bytes": 4_194_304, "errors": [] },
            "compress": { "supported": false, "scanned": 0, "skippedLive": 0, "sessions": 0, "wouldCompress": 0, "compressed": 0, "bytes": 0,
                          "allocatedBefore": 0, "allocatedAfter": 0, "leftoverScratchDirs": 0, "errors": [] },
            "wal": { "databases": [
                { "dbPath": "/home/u/.omp/agent/history.db", "walBytes": 1_048_576, "wouldCheckpoint": true, "checkpointed": false, "busy": 0, "log": 0, "checkpointedFrames": 0 },
                { "dbPath": "/home/u/.omp/agent/models.db", "walBytes": 0, "wouldCheckpoint": false, "checkpointed": false, "busy": 0, "log": 0, "checkpointedFrames": 0 }
            ], "walBytes": 1_048_576, "wouldCheckpoint": true, "checkpointed": false },
            "lockPath": "/home/u/.omp/agent/gc.lock"
        });
        let mut run = GcRun {
            apply: false,
            categories: ALL.to_vec(),
            started_at: 0,
            finished_at: None,
            blobs: None,
            wal: None,
            compress: None,
            errors: Vec::new(),
        };
        merge_result(&mut run, &v);
        assert_eq!(
            run.blobs,
            Some(GcBlobs {
                referenced: 12,
                would_delete: 8,
                deleted: 0,
                bytes: 4_194_304
            })
        );
        let wal = run.wal.unwrap();
        assert_eq!(
            (wal.wal_bytes, wal.checkpointed, wal.databases.len()),
            (1_048_576, false, 2)
        );
        assert_eq!(wal.databases[0].path, "/home/u/.omp/agent/history.db");
        let c = run.compress.unwrap();
        assert!(!c.supported && c.method.is_none());
        assert!(run.errors.is_empty());
    }

    #[test]
    fn category_errors_are_kept() {
        let v = json!({ "apply": true, "blobs": { "referenced": 0, "wouldDelete": 1, "deleted": 0, "bytes": 5, "errors": ["/b/x: EACCES"] } });
        let mut run = GcRun {
            apply: true,
            categories: vec![GcCategory::Blobs],
            started_at: 0,
            finished_at: None,
            blobs: None,
            wal: None,
            compress: None,
            errors: Vec::new(),
        };
        merge_result(&mut run, &v);
        assert_eq!(run.errors, ["blobs: /b/x: EACCES"]);
        assert_eq!(run.blobs.unwrap().would_delete, 1);
    }
}
