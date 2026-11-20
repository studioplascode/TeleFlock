//! What a folder takes on disk: the Cleanup page's worktree sizes and omp's session store.
//!
//! A walk without following symlinks that stays on the folder's file system (a mount inside a
//! checkout is not the checkout's) and counts every inode once (hard links: `bun install` and pnpm
//! link packages from a shared store, so a `node_modules` tree may hold little of its own). Unix
//! counts allocated blocks, which is what deleting it frees; Windows the file lengths. Unreadable
//! entries are skipped. A budget (entries, time) bounds a huge tree: the result is then partial,
//! a lower bound.
//!
//! **Fingerprint.** The walk also hashes every folder it enters (its identity and modification
//! time). Creating, deleting or renaming anything changes the time of the folder it is in, so a
//! later [`fingerprint`] that comes out equal says no entry came or went anywhere in the tree.
//! It lists folders only and asks the file system about folders only (a file's type comes with
//! the listing): a fraction of a full walk's cost, but still one listing per folder. The scans
//! keep each tree's folders instead (`tree.rs`), which checks a tree with one `stat` per folder;
//! this is what is left for trees too big to keep. A file rewritten in place (a log growing) does
//! not change it, so a size confirmed this way is still measured again now and then.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};

/// Bytes and files under a folder.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct DirSize {
    pub bytes: u64,
    pub files: u64,
    /// The budget ran out first: at least this much.
    pub partial: bool,
    /// The folders the walk entered (complete only when it is not partial).
    pub fingerprint: Fingerprint,
}

/// How many folders a tree has, and a hash of each one's identity and modification time, summed
/// (the order a walk meets them in does not matter).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Fingerprint {
    pub dirs: u64,
    pub hash: u64,
}

/// What a walk or check asked the file system: folders looked at without listing them (`stat`),
/// folders listed (`read_dir`), and the entries those listings held.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Touched {
    pub stats: u64,
    pub reads: u64,
    pub entries: u64,
}

impl Fingerprint {
    fn add(&mut self, dir: &std::fs::Metadata) {
        let (ino, time) = stamp(dir);
        self.add_stamp(ino, time);
    }

    /// Adds a folder by its [`stamp`].
    pub(crate) fn add_stamp(&mut self, ino: u64, time: u64) {
        self.dirs += 1;
        self.hash = self.hash.wrapping_add(mix(stamp_hash(ino, time)));
    }
}

/// splitmix64's finalizer: nearby inputs (inode numbers, times) land far apart.
fn mix(mut x: u64) -> u64 {
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

/// A folder's identity and modification time (`ino`, nanoseconds; Windows has no inode: 0): an entry
/// created, deleted or renamed in it moves the time.
#[cfg(unix)]
pub(crate) fn stamp(meta: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.ino(), (meta.mtime() as u64).wrapping_mul(1_000_000_000).wrapping_add(meta.mtime_nsec() as u64))
}

#[cfg(not(unix))]
pub(crate) fn stamp(meta: &std::fs::Metadata) -> (u64, u64) {
    let time = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64);
    (0, time)
}

fn stamp_hash(ino: u64, time: u64) -> u64 {
    if cfg!(unix) { mix(ino) ^ time } else { time }
}

/// When a walk stops counting.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Budget {
    pub max_entries: u64,
    pub deadline: Option<Instant>,
}

impl Budget {
    pub(crate) fn new(max_entries: u64, time: std::time::Duration) -> Budget {
        Budget {
            max_entries,
            deadline: Some(Instant::now() + time),
        }
    }

    /// The walk has met `entries` entries: whether it stops here.
    pub(crate) fn spent(&self, entries: u64) -> bool {
        entries > self.max_entries
            || (entries.is_multiple_of(1024) && self.deadline.is_some_and(|d| Instant::now() >= d))
    }
}

#[cfg(unix)]
pub(crate) fn disk_bytes(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.blocks() * 512
}

#[cfg(not(unix))]
pub(crate) fn disk_bytes(meta: &std::fs::Metadata) -> u64 {
    meta.len()
}

/// `(device, inode)` of an entry other names may share; `None` when it has a single name.
#[cfg(unix)]
pub(crate) fn shared_inode(meta: &std::fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    (!meta.is_dir() && meta.nlink() > 1).then(|| (meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
pub(crate) fn shared_inode(_meta: &std::fs::Metadata) -> Option<(u64, u64)> {
    None
}

#[cfg(unix)]
pub(crate) fn device(meta: &std::fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.dev())
}

#[cfg(not(unix))]
pub(crate) fn device(_meta: &std::fs::Metadata) -> Option<u64> {
    None
}

/// Walks `root` (blocking). A missing or unreadable root measures nothing.
pub(crate) fn measure(root: &Path, budget: Budget) -> DirSize {
    let mut out = DirSize::default();
    let Ok(meta) = std::fs::symlink_metadata(root) else {
        return out;
    };
    out.bytes += disk_bytes(&meta);
    if !meta.is_dir() {
        out.files = 1;
        return out;
    }
    out.fingerprint.add(&meta);
    let root_dev = device(&meta);
    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut entries = 0u64;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            entries += 1;
            if budget.spent(entries) {
                out.partial = true;
                return out;
            }
            // `DirEntry::metadata` does not follow symlinks.
            let Ok(meta) = entry.metadata() else { continue };
            if let Some(key) = shared_inode(&meta)
                && !seen.insert(key)
            {
                continue;
            }
            if meta.is_dir() {
                if device(&meta) != root_dev {
                    continue;
                }
                out.bytes += disk_bytes(&meta);
                out.fingerprint.add(&meta);
                stack.push(entry.path());
            } else {
                out.bytes += disk_bytes(&meta);
                out.files += 1;
            }
        }
    }
    out
}

/// The [`Fingerprint`] [`measure`] would record for `root` now (blocking), from a walk that asks
/// the file system about folders only. `None` when `root` is no folder or the budget ran out.
pub(crate) fn fingerprint(root: &Path, budget: Budget, touched: &mut Touched) -> Option<Fingerprint> {
    let meta = std::fs::symlink_metadata(root).ok().filter(std::fs::Metadata::is_dir)?;
    touched.stats += 1;
    let root_dev = device(&meta);
    let mut fp = Fingerprint::default();
    fp.add(&meta);
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut entries = 0u64;
    while let Some(dir) = stack.pop() {
        touched.reads += 1;
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            entries += 1;
            touched.entries += 1;
            if budget.spent(entries) {
                return None;
            }
            // The listing says what an entry is (no symlink is a folder): files cost nothing more.
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if device(&meta) != root_dev {
                continue;
            }
            fp.add(&meta);
            stack.push(entry.path());
        }
    }
    Some(fp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn roomy() -> Budget {
        Budget::new(u64::MAX, Duration::from_secs(60))
    }

    #[test]
    fn counts_files_once_and_never_follows_links() {
        let td = tempfile::tempdir().unwrap();
        let root = td.path().join("wt");
        std::fs::create_dir_all(root.join("node_modules/a")).unwrap();
        std::fs::write(root.join("big.bin"), vec![7u8; 100_000]).unwrap();
        std::fs::write(root.join("node_modules/a/index.js"), vec![1u8; 10_000]).unwrap();
        let base = measure(&root, roomy());
        assert_eq!(base.files, 2);
        assert!(!base.partial);
        #[cfg(unix)]
        {
            // allocated blocks: at least the bytes written (tmpfs and ext4 round up to blocks)
            assert!(base.bytes >= 110_000, "{base:?}");

            // A hard link inside the tree counts once; one to a file outside adds that file once.
            std::fs::hard_link(
                root.join("big.bin"),
                root.join("node_modules/a/big-link.bin"),
            )
            .unwrap();
            assert_eq!(measure(&root, roomy()).bytes, base.bytes);
            assert_eq!(measure(&root, roomy()).files, 2);

            // A symlink to a big folder outside costs only the link itself.
            let outside = td.path().join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(outside.join("huge.bin"), vec![3u8; 500_000]).unwrap();
            std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
            let linked = measure(&root, roomy());
            assert!(
                linked.bytes < base.bytes + 100_000,
                "{linked:?} vs {base:?}"
            );
        }
    }

    #[test]
    fn budget_makes_it_partial() {
        let td = tempfile::tempdir().unwrap();
        for i in 0..10 {
            std::fs::write(td.path().join(format!("f{i}")), b"x").unwrap();
        }
        let all = measure(td.path(), roomy());
        assert_eq!((all.files, all.partial), (10, false));
        let some = measure(
            td.path(),
            Budget {
                max_entries: 3,
                deadline: None,
            },
        );
        assert!(some.partial);
        assert!(some.files <= 3 && some.bytes <= all.bytes);
    }

    #[test]
    fn missing_root_is_nothing() {
        let td = tempfile::tempdir().unwrap();
        assert_eq!(
            measure(&td.path().join("gone"), roomy()),
            DirSize::default()
        );
    }

    /// An equal fingerprint means no entry came or went anywhere in the tree; growing a file in
    /// place is not seen (the scan measures again after a while for that).
    #[cfg(unix)]
    #[test]
    fn fingerprint_sees_entries_come_and_go_anywhere() {
        let td = tempfile::tempdir().unwrap();
        let root = td.path().join("wt");
        let deep = root.join("node_modules/pkg/lib");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(deep.join("index.js"), "x").unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        // Folder times from long ago: a change made within the same clock tick still moves them.
        let old = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let age = |d: &Path| std::fs::File::open(d).unwrap().set_modified(old).unwrap();
        for d in [&root, &root.join("node_modules"), &root.join("node_modules/pkg"), &deep, &root.join("src")] {
            age(d);
        }
        let walked = measure(&root, roomy());
        assert_eq!(walked.fingerprint.dirs, 5);
        let fp = |root: &Path| fingerprint(root, roomy(), &mut Touched::default()).unwrap();
        assert_eq!(fp(&root), walked.fingerprint, "the folders-only walk sees what the full walk saw");

        let mut log = std::fs::OpenOptions::new().append(true).open(root.join("src/main.rs")).unwrap();
        std::io::Write::write_all(&mut log, &[b'/'; 50_000]).unwrap();
        assert_eq!(fp(&root), walked.fingerprint, "a file grown in place");
        assert!(measure(&root, roomy()).bytes > walked.bytes, "…which only a full walk measures");

        std::fs::write(deep.join("extra.js"), "y").unwrap();
        assert_ne!(fp(&root), walked.fingerprint, "a file added four folders down");
        age(&deep);
        std::fs::rename(deep.join("extra.js"), deep.join("moved.js")).unwrap();
        assert_ne!(fp(&root), walked.fingerprint, "renamed");
        age(&deep);
        std::fs::remove_file(deep.join("moved.js")).unwrap();
        assert_ne!(fp(&root), walked.fingerprint, "deleted");
        assert_eq!(fingerprint(&root, Budget { max_entries: 2, deadline: None }, &mut Touched::default()), None, "out of budget: unknown");
        assert_eq!(fingerprint(&root.join("gone"), roomy(), &mut Touched::default()), None);
    }

    /// Bench: a full size walk against the folders-only fingerprint walk, on copies of worktrees
    /// (each folder in `TF_BENCH_TREES` is one). Release build:
    /// `TF_BENCH_TREES=<dir> cargo test --release -p tf-hostd --lib walk_cost -- --ignored --nocapture`
    #[test]
    #[ignore = "bench"]
    fn walk_cost() {
        let Some(dir) = std::env::var_os("TF_BENCH_TREES").map(PathBuf::from) else {
            eprintln!("TF_BENCH_TREES is not set");
            return;
        };
        let mut trees: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        trees.sort();
        let ms = |t: Instant| t.elapsed().as_secs_f64() * 1e3;
        for tree in trees {
            measure(&tree, roomy()); // warm the cache: both walks below read the same metadata
            let (mut walk, mut check) = (f64::MAX, f64::MAX);
            let mut size = DirSize::default();
            for _ in 0..3 {
                let t = Instant::now();
                size = measure(&tree, roomy());
                walk = walk.min(ms(t));
                let t = Instant::now();
                assert_eq!(fingerprint(&tree, roomy(), &mut Touched::default()), Some(size.fingerprint));
                check = check.min(ms(t));
            }
            println!(
                "{}: {} files in {} folders, {:.0} MB: walk {walk:.0} ms, fingerprint {check:.0} ms ({:.1}x)",
                tree.file_name().unwrap().to_string_lossy(),
                size.files,
                size.fingerprint.dirs,
                size.bytes as f64 / 1e6,
                walk / check
            );
        }
    }
}
