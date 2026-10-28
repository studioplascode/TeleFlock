//! Persistent session cache (architecture §5.2): what the session mirrors ([`crate::sessions`])
//! hold, one zstd-compressed JSON file per host and omp session under
//! `data_dir/sessions/<hostId>/<sessionId>.json.zst`, evicted least recently used first once the
//! files exceed the budget (64 MiB on Android, 256 MiB elsewhere).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tf_proto::session::SessionMeta;

use crate::sessions::{Data, Row};

/// Cache budget on Android.
pub const BUDGET_MOBILE: u64 = 64 << 20;
/// Cache budget elsewhere.
pub const BUDGET_DESKTOP: u64 = 256 << 20;
/// Format of the files; others are ignored (and replaced by the next write).
const VERSION: u32 = 1;
const SUFFIX: &str = ".json.zst";
const ZSTD_LEVEL: i32 = 3;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileOut<'a> {
    v: u32,
    session_id: &'a str,
    meta: &'a SessionMeta,
    meta_hash: Option<&'a str>,
    has_more: bool,
    rows: Vec<&'a Row>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIn {
    v: u32,
    session_id: String,
    meta: SessionMeta,
    meta_hash: Option<String>,
    has_more: bool,
    rows: Vec<Row>,
}

/// What a write stores (cheap to take under the mirror's lock: rows are shared).
pub struct Saved {
    pub session_id: String,
    pub meta: SessionMeta,
    pub meta_hash: Option<String>,
    pub has_more: bool,
    pub rows: Vec<Arc<Row>>,
}

impl Saved {
    pub fn of(d: &Data) -> Saved {
        Saved { session_id: d.session_id.clone(), meta: d.meta.clone(), meta_hash: d.meta_hash.clone(), has_more: d.has_more, rows: d.rows.clone() }
    }

    fn encode(&self) -> std::io::Result<Vec<u8>> {
        let file = FileOut {
            v: VERSION,
            session_id: &self.session_id,
            meta: &self.meta,
            meta_hash: self.meta_hash.as_deref(),
            has_more: self.has_more,
            rows: self.rows.iter().map(|r| &**r).collect(),
        };
        let json = serde_json::to_vec(&file).map_err(std::io::Error::other)?;
        zstd::bulk::compress(&json, ZSTD_LEVEL)
    }
}

fn decode(bytes: &[u8]) -> Option<Data> {
    let json = zstd::stream::decode_all(bytes).ok()?;
    let f: FileIn = serde_json::from_slice(&json).ok()?;
    (f.v == VERSION).then(|| Data {
        session_id: f.session_id,
        meta: f.meta,
        meta_hash: f.meta_hash,
        rows: f.rows.into_iter().map(Arc::new).collect(),
        has_more: f.has_more,
        ui: None,
    })
}

fn safe(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' }).collect()
}

#[derive(Default)]
struct Index {
    /// File → (size, last used).
    files: HashMap<PathBuf, (u64, SystemTime)>,
    total: u64,
}

impl Index {
    fn scan(root: &Path) -> Index {
        let mut index = Index::default();
        let Ok(hosts) = std::fs::read_dir(root) else { return index };
        for host in hosts.flatten() {
            let Ok(files) = std::fs::read_dir(host.path()) else { continue };
            for f in files.flatten() {
                let path = f.path();
                let name = f.file_name().to_string_lossy().into_owned();
                if !name.ends_with(SUFFIX) {
                    // A write that never finished.
                    if name.contains(".tmp") {
                        let _ = std::fs::remove_file(&path);
                    }
                    continue;
                }
                if let Ok(md) = f.metadata() {
                    index.put(path, md.len(), md.modified().unwrap_or(SystemTime::UNIX_EPOCH));
                }
            }
        }
        index
    }

    fn put(&mut self, path: PathBuf, size: u64, used: SystemTime) {
        if let Some((old, _)) = self.files.insert(path, (size, used)) {
            self.total -= old;
        }
        self.total += size;
    }

    fn forget(&mut self, path: &Path) {
        if let Some((size, _)) = self.files.remove(path) {
            self.total -= size;
        }
    }

    /// Least recently used files beyond `budget`, never `keep`.
    fn evict(&mut self, budget: u64, keep: &Path) -> Vec<PathBuf> {
        let mut by_age: Vec<(SystemTime, PathBuf)> = self.files.iter().filter(|(p, _)| p.as_path() != keep).map(|(p, (_, t))| (*t, p.clone())).collect();
        by_age.sort();
        let mut gone = Vec::new();
        for (_, p) in by_age {
            if self.total <= budget {
                break;
            }
            self.forget(&p);
            gone.push(p);
        }
        gone
    }
}

/// The session cache of one app data dir (shared by every host).
pub struct SessionCache {
    root: PathBuf,
    budget: u64,
    /// Serializes writes and evictions; the file index, scanned on first use.
    index: tokio::sync::Mutex<Option<Index>>,
}

impl SessionCache {
    /// `data_dir/sessions`, with the budget of `platform` (`android`: mobile).
    pub fn new(data_dir: &Path, platform: &str) -> SessionCache {
        SessionCache::with_budget(data_dir.join("sessions"), if platform == "android" { BUDGET_MOBILE } else { BUDGET_DESKTOP })
    }

    pub fn with_budget(root: PathBuf, budget: u64) -> SessionCache {
        SessionCache { root, budget, index: tokio::sync::Mutex::new(None) }
    }

    fn path(&self, host_id: &str, session_id: &str) -> PathBuf {
        self.root.join(safe(host_id)).join(format!("{}{SUFFIX}", safe(session_id)))
    }

    /// The cached session, if any (and readable); marks it used.
    pub async fn load(&self, host_id: &str, session_id: &str) -> Option<Data> {
        let path = self.path(host_id, session_id);
        let p = path.clone();
        let data = tokio::task::spawn_blocking(move || {
            let bytes = std::fs::read(&p).ok()?;
            let data = decode(&bytes);
            if data.is_none() {
                log::info!("session cache {}: unreadable; dropping it", p.display());
                let _ = std::fs::remove_file(&p);
            } else if let Ok(f) = std::fs::File::options().write(true).open(&p) {
                let _ = f.set_modified(SystemTime::now());
            }
            data
        })
        .await
        .ok()
        .flatten();
        let mut index = self.index.lock().await;
        if let Some(index) = index.as_mut() {
            match &data {
                Some(_) => {
                    if let Some(e) = index.files.get_mut(&path) {
                        e.1 = SystemTime::now();
                    }
                }
                None => index.forget(&path),
            }
        }
        data
    }

    /// Writes a session, then evicts the least recently used files beyond the budget.
    pub async fn store(&self, host_id: &str, saved: Saved) {
        let path = self.path(host_id, &saved.session_id);
        let mut index = self.index.lock().await;
        let root = self.root.clone();
        let budget = self.budget;
        let current = index.take();
        let p = path.clone();
        let done = tokio::task::spawn_blocking(move || {
            let mut index = current.unwrap_or_else(|| Index::scan(&root));
            let written = (|| {
                let bytes = saved.encode()?;
                if let Some(dir) = p.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                let tmp = p.with_extension(format!("tmp{}", std::process::id()));
                std::fs::write(&tmp, &bytes)?;
                std::fs::rename(&tmp, &p)?;
                Ok::<u64, std::io::Error>(bytes.len() as u64)
            })();
            match written {
                Ok(size) => index.put(p.clone(), size, SystemTime::now()),
                Err(e) => log::warn!("session cache {}: {e}", p.display()),
            }
            for gone in index.evict(budget, &p) {
                log::debug!("session cache: evicting {}", gone.display());
                let _ = std::fs::remove_file(gone);
            }
            index
        })
        .await;
        *index = done.ok();
    }

    /// Forgets every session of a removed host.
    pub async fn remove_host(&self, host_id: &str) {
        let dir = self.root.join(safe(host_id));
        let mut index = self.index.lock().await;
        if let Some(index) = index.as_mut() {
            let gone: Vec<PathBuf> = index.files.keys().filter(|p| p.starts_with(&dir)).cloned().collect();
            for p in gone {
                index.forget(&p);
            }
        }
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// Bytes the cache files take (scanning them on first use).
    #[cfg(test)]
    pub async fn total(&self) -> u64 {
        let mut index = self.index.lock().await;
        index.get_or_insert_with(|| Index::scan(&self.root)).total
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::tests::{data, user};

    #[tokio::test]
    async fn sessions_round_trip_compressed() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SessionCache::with_budget(dir.path().join("sessions"), BUDGET_DESKTOP);
        let mut d = data("s/1", (0..50).map(|i| user(&format!("u{i}"), &"lorem ipsum ".repeat(40))).collect());
        d.meta_hash = Some("m1".into());
        cache.store("host:1", Saved::of(&d)).await;
        let path = dir.path().join("sessions/host_1/s_1.json.zst");
        let size = std::fs::metadata(&path).unwrap().len();
        let raw = serde_json::to_vec(&d.rows.iter().map(|r| &**r).collect::<Vec<_>>()).unwrap().len() as u64;
        assert!(size * 10 < raw, "{size} bytes on disk for {raw} bytes of rows");
        let back = cache.load("host:1", "s/1").await.unwrap();
        assert_eq!(back, Data { ui: None, ..d.clone() });
        assert!(cache.load("host:1", "other").await.is_none());
        // A damaged file is dropped, not trusted.
        std::fs::write(&path, b"not zstd").unwrap();
        assert!(cache.load("host:1", "s/1").await.is_none());
        assert!(!path.exists());
        cache.store("host:1", Saved::of(&d)).await;
        cache.remove_host("host:1").await;
        assert!(!dir.path().join("sessions/host_1").exists());
        assert_eq!(cache.total().await, 0);
    }

    /// Over budget, the least recently used sessions go first; a read counts as a use, also
    /// across restarts (file times), and the file just written is never the one evicted.
    #[tokio::test]
    async fn evicts_least_recently_used_beyond_the_budget() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        // Incompressible rows, so sizes are predictable.
        let noise = |seed: u64| -> String {
            let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
            (0..20_000)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    char::from(b'a' + (x % 26) as u8)
                })
                .collect()
        };
        let one = Saved::of(&data("a", vec![user("u", &noise(1))]));
        let probe = SessionCache::with_budget(dir.path().join("probe"), u64::MAX);
        probe.store("h", one).await;
        let size = probe.total().await;
        let cache = SessionCache::with_budget(root.clone(), size * 3 + size / 2);
        for (i, sid) in ["a", "b", "c"].iter().enumerate() {
            cache.store("h", Saved::of(&data(sid, vec![user("u", &noise(i as u64 + 10))]))).await;
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        // `a` is read (used) after `b` and `c` were written: `b` is now the oldest.
        assert!(cache.load("h", "a").await.is_some());
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        cache.store("h", Saved::of(&data("d", vec![user("u", &noise(20))]))).await;
        let exists = |sid: &str| root.join("h").join(format!("{sid}{SUFFIX}")).exists();
        assert_eq!(["a", "b", "c", "d"].map(exists), [true, false, true, true]);
        assert!(cache.total().await <= size * 3 + size / 2);

        // Another process (an app restart) sees the same order through the file times.
        let again = SessionCache::with_budget(root.clone(), size * 2 + size / 2);
        assert!(again.load("h", "c").await.is_some());
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        again.store("h", Saved::of(&data("e", vec![user("u", &noise(30))]))).await;
        assert_eq!(["a", "c", "d", "e"].map(exists), [false, true, false, true]);
    }
}
