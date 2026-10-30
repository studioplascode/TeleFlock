//! What a folder takes on disk: the Cleanup page's worktree sizes and omp's session store.
//!
//! A walk without following symlinks that stays on the folder's file system (a mount inside a
//! checkout is not the checkout's) and counts every inode once (hard links: `bun install` and pnpm
//! link packages from a shared store, so a `node_modules` tree may hold little of its own). Unix
//! counts allocated blocks, which is what deleting it frees; Windows the file lengths. Unreadable
//! entries are skipped. A budget (entries, time) bounds a huge tree: the result is then partial,
//! a lower bound.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Bytes and files under a folder.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct DirSize {
    pub bytes: u64,
    pub files: u64,
    /// The budget ran out first: at least this much.
    pub partial: bool,
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
}

#[cfg(unix)]
fn disk_bytes(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.blocks() * 512
}

#[cfg(not(unix))]
fn disk_bytes(meta: &std::fs::Metadata) -> u64 {
    meta.len()
}

/// `(device, inode)` of an entry other names may share; `None` when it has a single name.
#[cfg(unix)]
fn shared_inode(meta: &std::fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    (!meta.is_dir() && meta.nlink() > 1).then(|| (meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn shared_inode(_meta: &std::fs::Metadata) -> Option<(u64, u64)> {
    None
}

#[cfg(unix)]
fn device(meta: &std::fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.dev())
}

#[cfg(not(unix))]
fn device(_meta: &std::fs::Metadata) -> Option<u64> {
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
            if entries > budget.max_entries
                || (entries % 1024 == 0 && budget.deadline.is_some_and(|d| Instant::now() >= d))
            {
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
                stack.push(entry.path());
            } else {
                out.bytes += disk_bytes(&meta);
                out.files += 1;
            }
        }
    }
    out
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
}
