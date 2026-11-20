//! A worktree's folders as its last listing saw them, so a size check `stat`s folders only and
//! lists again just those that changed (architecture §3.17 "Size").
//!
//! **What is kept** per folder: its stamp (identity and modification time, `size::stamp`) and what
//! it holds itself: its own blocks and those of the files in it, how many files, how many entries.
//! A folder's time moves when an entry in it is created, deleted or renamed, so while its stamp
//! holds, its listing does too. [`check`] `stat`s every folder it knows (parents first), lists
//! again only those whose stamp moved, walks new subfolders whole, and keeps every other folder's
//! counts as they were: a tree where nothing came or went costs one `stat` per folder and no
//! listing; one new file deep down costs the listing of its own folder. A file rewritten in place
//! moves no folder's time: the scans walk every tree whole again now and then (`scan.rs`).
//!
//! **Racy stamps.** File times come from a coarse clock (milliseconds on Linux, up to seconds
//! elsewhere): an entry made in the same tick right after its folder was listed leaves the time as
//! it was. A folder whose time was within [`RACY`] of its listing (or after it) is listed again by
//! the next check, whatever its stamp says; so is one that could not be read. A folder that
//! vanished although its parent's stamp held makes the check unsure ([`Outcome::Unsure`]): the tree
//! is walked whole instead.
//!
//! **Hard links** count once per walk, as in `size::measure`. A check counts the hard-linked files
//! of the folders it lists again unless another folder it listed counted them; a file linked into
//! a listed folder from an unlisted one counts twice until the next whole walk.
//!
//! **Kept** in the cleanup cache (`cache.rs`) as one compact string per tree ([`Blob`]), and in
//! memory in that form too: a check decodes it, which costs far less than the `stat`s.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::size::{self, Budget, DirSize, Fingerprint, Touched};

/// A tree with more folders than this is not kept: its checks list every folder (`size::fingerprint`).
pub(crate) const MAX_DIRS: usize = 250_000;
/// A folder whose time is this close to its listing is listed again by the next check.
pub(crate) const RACY: Duration = Duration::from_secs(2);
/// The encoding's format.
const FORMAT: u8 = 1;
const NONE: u32 = u32::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Node {
    /// Its parent's index; the root has none.
    parent: u32,
    /// Its name in [`DirTree::names`].
    name_at: u32,
    name_len: u16,
    /// Listed within [`RACY`] of its time, or unreadable: listed again next time.
    racy: bool,
    entries: u32,
    files: u32,
    ino: u64,
    time: u64,
    /// Its own blocks and those of the files in it (not its subfolders').
    bytes: u64,
}

/// A tree's folders, each after its parent and its subtree in one run (depth first).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DirTree {
    nodes: Vec<Node>,
    names: Vec<u8>,
}

impl DirTree {
    /// Its folders.
    #[cfg(test)]
    pub(crate) fn dirs(&self) -> usize {
        self.nodes.len()
    }

    /// What it holds altogether, and the fingerprint `size::measure` would take of it.
    pub(crate) fn size(&self) -> DirSize {
        let mut fingerprint = Fingerprint::default();
        let (mut bytes, mut files) = (0u64, 0u64);
        for n in &self.nodes {
            fingerprint.add_stamp(n.ino, n.time);
            bytes += n.bytes;
            files += u64::from(n.files);
        }
        DirSize { bytes, files, partial: false, fingerprint }
    }

    fn name(&self, i: usize) -> &OsStr {
        let n = &self.nodes[i];
        let at = n.name_at as usize;
        os_name(&self.names[at..at + usize::from(n.name_len)])
    }

    /// Adds a folder; `None` when its name can't be kept (not UTF-8 on Windows, too long).
    fn push(&mut self, parent: u32, name: &OsStr, n: Node) -> Option<u32> {
        let bytes = name_bytes(name)?;
        let len = u16::try_from(bytes.len()).ok()?;
        let at = u32::try_from(self.names.len()).ok()?;
        self.names.extend_from_slice(bytes);
        self.nodes.push(Node { parent, name_at: at, name_len: len, ..n });
        u32::try_from(self.nodes.len() - 1).ok()
    }

    /// For each folder, the index after its subtree.
    fn ends(&self) -> Vec<u32> {
        let mut ends: Vec<u32> = (1..=self.nodes.len() as u32).collect();
        for i in (1..self.nodes.len()).rev() {
            let p = self.nodes[i].parent as usize;
            ends[p] = ends[p].max(ends[i]);
        }
        ends
    }

    /// The compact form the cache keeps: varints, names as bytes.
    pub(crate) fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.names.len() + self.nodes.len() * 24 + 8);
        out.push(FORMAT);
        varint(&mut out, self.nodes.len() as u64);
        for (i, n) in self.nodes.iter().enumerate() {
            if i > 0 {
                varint(&mut out, (i as u64) - u64::from(n.parent));
            }
            let at = n.name_at as usize;
            varint(&mut out, u64::from(n.name_len));
            out.extend_from_slice(&self.names[at..at + usize::from(n.name_len)]);
            for v in [n.ino, n.time, n.bytes, u64::from(n.files), u64::from(n.entries)] {
                varint(&mut out, v);
            }
            out.push(u8::from(n.racy));
        }
        out
    }

    /// The tree [`DirTree::encode`] wrote; `None` when `bytes` don't add up (the tree is walked
    /// again).
    pub(crate) fn decode(bytes: &[u8]) -> Option<DirTree> {
        let mut r = Reader { bytes, at: 0 };
        if r.byte()? != FORMAT {
            return None;
        }
        let count = usize::try_from(r.varint()?).ok().filter(|&c| c > 0 && c <= MAX_DIRS)?;
        let mut tree = DirTree { nodes: Vec::with_capacity(count), names: Vec::new() };
        for i in 0..count {
            let parent = if i == 0 {
                NONE
            } else {
                let back = usize::try_from(r.varint()?).ok().filter(|&b| b >= 1 && b <= i)?;
                (i - back) as u32
            };
            let len = u16::try_from(r.varint()?).ok()?;
            let name = r.take(usize::from(len))?;
            let name_at = u32::try_from(tree.names.len()).ok()?;
            tree.names.extend_from_slice(name);
            let [ino, time, bytes, files, entries] = [r.varint()?, r.varint()?, r.varint()?, r.varint()?, r.varint()?];
            let racy = match r.byte()? {
                0 => false,
                1 => true,
                _ => return None,
            };
            tree.nodes.push(Node {
                parent,
                name_at,
                name_len: len,
                racy,
                entries: u32::try_from(entries).ok()?,
                files: u32::try_from(files).ok()?,
                ino,
                time,
                bytes,
            });
        }
        (r.at == bytes.len()).then_some(tree)
    }
}

/// The subfolders of folder `i`, in order (`ends`: [`DirTree::ends`]).
fn children(ends: &[u32], i: usize) -> impl Iterator<Item = usize> + '_ {
    let end = ends[i] as usize;
    std::iter::successors(Some(i + 1).filter(|&c| c < end), move |&c| Some(ends[c] as usize).filter(|&next| next < end))
}

fn varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn byte(&mut self) -> Option<u8> {
        let b = *self.bytes.get(self.at)?;
        self.at += 1;
        Some(b)
    }

    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.bytes.get(self.at..self.at.checked_add(n)?)?;
        self.at += n;
        Some(s)
    }

    fn varint(&mut self) -> Option<u64> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let b = self.byte()?;
            v |= u64::from(b & 0x7f).checked_shl(shift)?;
            if b & 0x80 == 0 {
                return Some(v);
            }
        }
        None
    }
}

#[cfg(unix)]
fn name_bytes(name: &OsStr) -> Option<&[u8]> {
    Some(std::os::unix::ffi::OsStrExt::as_bytes(name))
}

#[cfg(not(unix))]
fn name_bytes(name: &OsStr) -> Option<&[u8]> {
    name.to_str().map(str::as_bytes)
}

#[cfg(unix)]
fn os_name(bytes: &[u8]) -> &OsStr {
    std::os::unix::ffi::OsStrExt::from_bytes(bytes)
}

#[cfg(not(unix))]
fn os_name(bytes: &[u8]) -> &OsStr {
    // Written by `name_bytes` (UTF-8 only); a damaged cache entry gives an empty name, whose
    // folder then can't be found: the check is unsure and the tree is walked again.
    OsStr::new(std::str::from_utf8(bytes).unwrap_or(""))
}

/// A tree in its compact form, as the cache file keeps it (base64). One that doesn't decode is an
/// empty blob, never an error: it is only a cache.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Blob(pub Vec<u8>);

impl Serialize for Blob {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use base64::Engine as _;
        s.serialize_str(&base64::engine::general_purpose::STANDARD_NO_PAD.encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for Blob {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use base64::Engine as _;
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Text {
            S(String),
            Other(serde::de::IgnoredAny),
        }
        let text = match Text::deserialize(d)? {
            Text::S(s) => s,
            Text::Other(_) => String::new(),
        };
        Ok(Blob(base64::engine::general_purpose::STANDARD_NO_PAD.decode(text.trim_end_matches('=')).unwrap_or_default()))
    }
}

/// What a [`check`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// No folder came, went or changed: nothing was listed.
    Same,
    /// The tree as it is now.
    Changed(DirTree),
    /// It can't be told this way (the budget ran out, a folder vanished under a parent whose stamp
    /// held, a name or a size the tree can't keep): walk it whole.
    Unsure,
    /// The root is no folder (any more).
    Gone,
}

enum Task {
    /// A folder the old tree knows: its stamp first (`meta`: from its parent's listing, else a `stat`).
    Visit { old: u32, path: PathBuf, name: OsString, parent: u32, meta: Option<std::fs::Metadata> },
    /// A folder to list: one whose stamp moved (`old`), or a new one.
    List { old: Option<u32>, path: PathBuf, name: OsString, parent: u32, meta: std::fs::Metadata },
}

enum Stop {
    Gone,
    Unsure,
    Partial,
}

/// The walk and the check: one engine, with or without an old tree.
struct Engine<'a> {
    /// The old tree and its [`DirTree::ends`] (a check), or none (a walk).
    old: Option<(&'a DirTree, Vec<u32>)>,
    new: DirTree,
    /// The new tree is kept (no name it can't hold, not too big); a walk goes on measuring without.
    keep: bool,
    /// Something differs from the old tree.
    changed: bool,
    seen: HashSet<(u64, u64)>,
    root_dev: Option<u64>,
    budget: Budget,
    entries: u64,
    touched: &'a mut Touched,
    /// What the listings measured (a walk lists everything: its whole size, partial or not).
    bytes: u64,
    files: u64,
    fingerprint: Fingerprint,
}

impl<'a> Engine<'a> {
    fn new(old: Option<&'a DirTree>, budget: Budget, touched: &'a mut Touched) -> Self {
        Engine {
            old: old.map(|t| (t, t.ends())),
            new: DirTree::default(),
            keep: true,
            changed: false,
            seen: HashSet::new(),
            root_dev: None,
            budget,
            entries: 0,
            touched,
            bytes: 0,
            files: 0,
            fingerprint: Fingerprint::default(),
        }
    }

    fn run(&mut self, root: &Path) -> Result<(), Stop> {
        self.touched.stats += 1;
        let meta = std::fs::symlink_metadata(root).map_err(|_| Stop::Gone)?;
        if !meta.is_dir() {
            return Err(Stop::Gone);
        }
        self.root_dev = size::device(&meta);
        let first = match self.old {
            Some(_) => Task::Visit { old: 0, path: root.to_path_buf(), name: OsString::new(), parent: NONE, meta: Some(meta) },
            None => Task::List { old: None, path: root.to_path_buf(), name: OsString::new(), parent: NONE, meta },
        };
        let mut stack = vec![first];
        while let Some(task) = stack.pop() {
            match task {
                Task::Visit { old, path, name, parent, meta } => self.visit(old, path, name, parent, meta, &mut stack)?,
                Task::List { old, path, name, parent, meta } => self.list(old, path, name, parent, meta, &mut stack)?,
            }
        }
        Ok(())
    }

    /// A folder the new tree can't keep: a check can't go on, a walk goes on without the tree.
    fn drop_tree(&mut self) -> Result<(), Stop> {
        if self.old.is_some() {
            return Err(Stop::Unsure);
        }
        self.keep = false;
        self.new = DirTree::default();
        Ok(())
    }

    fn visit(&mut self, old: u32, path: PathBuf, name: OsString, parent: u32, meta: Option<std::fs::Metadata>, stack: &mut Vec<Task>) -> Result<(), Stop> {
        let meta = match meta {
            Some(m) => m,
            None => {
                self.touched.stats += 1;
                // Gone although its parent's stamp held: a listing missed it.
                std::fs::symlink_metadata(&path).map_err(|_| Stop::Unsure)?
            }
        };
        if !meta.is_dir() {
            return Err(Stop::Unsure);
        }
        if size::device(&meta) != self.root_dev {
            // A file system mounted on it since (a mount moves no folder time): not the tree's.
            self.changed = true;
            return Ok(());
        }
        let (tree, ends) = self.old.as_ref().expect("visits come from an old tree");
        let o = tree.nodes[old as usize];
        if size::stamp(&meta) != (o.ino, o.time) || o.racy {
            stack.push(Task::List { old: Some(old), path, name, parent, meta });
            return Ok(());
        }
        let kids: Vec<(u32, OsString)> = children(ends, old as usize).map(|c| (c as u32, tree.name(c).to_os_string())).collect();
        let Some(k) = self.new.push(parent, &name, o) else {
            return Err(Stop::Unsure);
        };
        for (c, n) in kids.into_iter().rev() {
            stack.push(Task::Visit { old: c, path: path.join(&n), name: n, parent: k, meta: None });
        }
        Ok(())
    }

    fn list(&mut self, old: Option<u32>, path: PathBuf, name: OsString, parent: u32, meta: std::fs::Metadata, stack: &mut Vec<Task>) -> Result<(), Stop> {
        self.changed = true;
        self.touched.reads += 1;
        let listed_at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
        let (ino, time) = size::stamp(&meta);
        self.fingerprint.add_stamp(ino, time);
        let own = size::disk_bytes(&meta);
        let rd = std::fs::read_dir(&path);
        let node = Node {
            parent,
            name_at: 0,
            name_len: 0,
            racy: rd.is_err() || time.saturating_add(RACY.as_nanos() as u64) >= listed_at,
            entries: 0,
            files: 0,
            ino,
            time,
            bytes: own,
        };
        let mut k = None;
        if self.keep {
            k = self.new.push(parent, &name, node).filter(|_| self.new.nodes.len() <= MAX_DIRS);
            if k.is_none() {
                self.drop_tree()?;
            }
        }
        let mut subdirs: Vec<(OsString, std::fs::Metadata)> = Vec::new();
        let (mut bytes, mut files, mut entries) = (own, 0u32, 0u32);
        for e in rd.into_iter().flatten().flatten() {
            self.entries += 1;
            self.touched.entries += 1;
            if self.budget.spent(self.entries) {
                return Err(Stop::Partial);
            }
            entries = entries.saturating_add(1);
            // `DirEntry::metadata` does not follow symlinks.
            let Ok(m) = e.metadata() else { continue };
            if let Some(key) = size::shared_inode(&m)
                && !self.seen.insert(key)
            {
                continue;
            }
            if m.is_dir() {
                if size::device(&m) == self.root_dev {
                    subdirs.push((e.file_name(), m));
                }
            } else {
                bytes += size::disk_bytes(&m);
                files = files.saturating_add(1);
            }
        }
        self.bytes += bytes;
        self.files += u64::from(files);
        if let Some(k) = k {
            let slot = &mut self.new.nodes[k as usize];
            (slot.bytes, slot.files, slot.entries) = (bytes, files, entries);
        }
        // The old tree's subfolders of this one, by name: the same folder (same identity) is
        // checked as usual, anything else is new and listed whole.
        let known: HashMap<OsString, (u32, u64)> = match (&self.old, old) {
            (Some((tree, ends)), Some(o)) => children(ends, o as usize).map(|c| (tree.name(c).to_os_string(), (c as u32, tree.nodes[c].ino))).collect(),
            _ => HashMap::new(),
        };
        let parent = k.unwrap_or(NONE);
        for (n, m) in subdirs.into_iter().rev() {
            let child = path.join(&n);
            stack.push(match known.get(&n) {
                Some(&(c, ino)) if ino == size::stamp(&m).0 => Task::Visit { old: c, path: child, name: n, parent, meta: Some(m) },
                _ => Task::List { old: None, path: child, name: n, parent, meta: m },
            });
        }
        Ok(())
    }
}

/// Checks `old` against the folders under `root` now (blocking).
pub(crate) fn check(root: &Path, old: &DirTree, budget: Budget, touched: &mut Touched) -> Outcome {
    if old.nodes.is_empty() {
        return Outcome::Unsure;
    }
    let mut e = Engine::new(Some(old), budget, touched);
    match e.run(root) {
        Err(Stop::Gone) => Outcome::Gone,
        Err(Stop::Unsure | Stop::Partial) => Outcome::Unsure,
        Ok(()) if !e.changed => Outcome::Same,
        Ok(()) => Outcome::Changed(e.new),
    }
}

/// Walks the tree under `root` whole (blocking): its size, and its folders when the walk was
/// complete and the tree can be kept.
pub(crate) fn walk(root: &Path, budget: Budget, touched: &mut Touched) -> (DirSize, Option<DirTree>) {
    let mut e = Engine::new(None, budget, touched);
    match e.run(root) {
        Err(Stop::Gone) => (DirSize::default(), None),
        Err(Stop::Unsure | Stop::Partial) => (DirSize { bytes: e.bytes, files: e.files, partial: true, fingerprint: Fingerprint::default() }, None),
        Ok(()) => {
            let size = DirSize { bytes: e.bytes, files: e.files, partial: false, fingerprint: e.fingerprint };
            (size, e.keep.then_some(e.new))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::cleanup::size::measure;

    fn roomy() -> Budget {
        Budget::new(u64::MAX, Duration::from_secs(60))
    }

    /// Folders dated long ago: a later change moves their time for sure.
    fn age(dirs: &[PathBuf]) {
        let old = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        for d in dirs {
            std::fs::File::open(d).unwrap().set_modified(old).unwrap();
        }
    }

    fn all_dirs(root: &Path) -> Vec<PathBuf> {
        let mut out = vec![root.to_path_buf()];
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                if e.file_type().unwrap().is_dir() {
                    out.push(e.path());
                    stack.push(e.path());
                }
            }
        }
        out
    }

    /// A node_modules-like tree: `dirs` folders of `files` files each, three levels deep, aged.
    fn tree(root: &Path, dirs: usize, files: usize) -> Vec<PathBuf> {
        for d in 0..dirs {
            let dir = root.join(format!("node_modules/pkg{}/lib{}", d % 7, d));
            std::fs::create_dir_all(&dir).unwrap();
            for f in 0..files {
                std::fs::write(dir.join(format!("f{f}.js")), vec![b'x'; 100 + f]).unwrap();
            }
        }
        let made = all_dirs(root);
        age(&made);
        made
    }

    /// The walk measures what `size::measure` measures, folder by folder, and its tree comes back
    /// from its compact form as it was; a damaged form is no tree, never an error.
    #[test]
    fn a_walk_measures_what_measure_does_and_round_trips() {
        let td = tempfile::tempdir().unwrap();
        let root = td.path().join("wt");
        tree(&root, 12, 5);
        std::fs::write(root.join("README.md"), "hello").unwrap();
        #[cfg(unix)]
        std::fs::hard_link(root.join("README.md"), root.join("node_modules/pkg1/lib1/README-link.md")).unwrap();
        let mut t = Touched::default();
        let (size, kept) = walk(&root, roomy(), &mut t);
        let tree = kept.expect("complete and small: kept");
        let m = measure(&root, roomy());
        assert_eq!((size.bytes, size.files, size.fingerprint), (m.bytes, m.files, m.fingerprint));
        assert_eq!(tree.size(), size);
        assert_eq!(tree.dirs() as u64, m.fingerprint.dirs);
        assert_eq!(t.reads, tree.dirs() as u64, "every folder listed once");
        let back = DirTree::decode(&tree.encode()).unwrap();
        assert_eq!(back, tree);
        for bad in [&b""[..], &[2, 1][..], &tree.encode()[..10]] {
            assert!(DirTree::decode(bad).is_none(), "{bad:?}");
        }
        for damaged in [serde_json::json!("not base64 at all!"), serde_json::json!(42)] {
            let blob: Blob = serde_json::from_value(damaged).unwrap();
            assert!(DirTree::decode(&blob.0).is_none(), "a damaged blob is no error, only no tree");
        }
        let blob: Blob = serde_json::from_value(serde_json::to_value(Blob(tree.encode())).unwrap()).unwrap();
        assert_eq!(DirTree::decode(&blob.0), Some(tree));
    }

    /// After the size TTL a quiet tree costs one `stat` per folder and no listing; one new file
    /// deep down lists its folder only; a new folder lists it and its parent; a folder removed
    /// lists its parent. The checked tree always measures what a whole walk measures.
    #[test]
    fn a_check_lists_only_folders_that_changed() {
        let td = tempfile::tempdir().unwrap();
        let root = td.path().join("wt");
        let dirs = tree(&root, 40, 3);
        let (_, kept) = walk(&root, roomy(), &mut Touched::default());
        let old = kept.unwrap();
        assert_eq!(old.dirs(), dirs.len());

        let mut t = Touched::default();
        assert_eq!(check(&root, &old, roomy(), &mut t), Outcome::Same);
        assert_eq!(t, Touched { stats: dirs.len() as u64, reads: 0, entries: 0 }, "quiet: stats only");

        let deep = root.join("node_modules/pkg3/lib10");
        std::fs::write(deep.join("new.js"), vec![b'y'; 5000]).unwrap();
        let mut t = Touched::default();
        let Outcome::Changed(now) = check(&root, &old, roomy(), &mut t) else { panic!("a file came") };
        assert_eq!((t.stats, t.reads, t.entries), (dirs.len() as u64, 1, 4), "only the new file's folder is listed (3 files + the new one)");
        assert_eq!(now.size().bytes, measure(&root, roomy()).bytes);
        assert_eq!(now.size().fingerprint, measure(&root, roomy()).fingerprint);

        // (the walks below settle the folders listed just now, which would be listed again as racy)
        age(&all_dirs(&root));
        let (_, settled) = walk(&root, roomy(), &mut Touched::default());
        let settled = settled.unwrap();
        std::fs::create_dir(deep.join("sub")).unwrap();
        std::fs::write(deep.join("sub/x.js"), "x").unwrap();
        let mut t = Touched::default();
        let Outcome::Changed(now) = check(&root, &settled, roomy(), &mut t) else { panic!("a folder came") };
        assert_eq!(t.reads, 2, "its parent and the new folder");
        assert_eq!(now.dirs(), settled.dirs() + 1);
        assert_eq!(now.size().bytes, measure(&root, roomy()).bytes);

        age(&all_dirs(&root));
        let (_, settled) = walk(&root, roomy(), &mut Touched::default());
        let settled = settled.unwrap();
        std::fs::remove_dir_all(root.join("node_modules/pkg5/lib5")).unwrap();
        let mut t = Touched::default();
        let Outcome::Changed(after) = check(&root, &settled, roomy(), &mut t) else { panic!("a folder went") };
        assert_eq!(t.reads, 1, "the removed folder's parent");
        assert_eq!(after.dirs(), settled.dirs() - 1);
        assert_eq!(after.size().bytes, measure(&root, roomy()).bytes);

        assert_eq!(check(&td.path().join("nope"), &after, roomy(), &mut Touched::default()), Outcome::Gone);
        std::fs::write(root.join("node_modules/pkg2/late.js"), "z").unwrap();
        assert_eq!(check(&root, &after, Budget { max_entries: 0, deadline: None }, &mut Touched::default()), Outcome::Unsure, "out of budget while listing");
    }

    /// A folder whose time was not clearly before its listing is listed again next time: an entry
    /// made in the same clock tick may have left its time as it was.
    #[test]
    fn racy_folders_are_listed_again() {
        let td = tempfile::tempdir().unwrap();
        let root = td.path().join("wt");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::write(root.join("a/one"), "1").unwrap();
        let soon = SystemTime::now() + Duration::from_secs(60);
        for d in [&root, &root.join("a")] {
            std::fs::File::open(d).unwrap().set_modified(soon).unwrap();
        }
        let (_, kept) = walk(&root, roomy(), &mut Touched::default());
        let mut t = Touched::default();
        let out = check(&root, &kept.unwrap(), roomy(), &mut t);
        assert_eq!(t.reads, 2, "both folders' times were not before their listing");
        let Outcome::Changed(again) = out else { panic!("listed again: {out:?}") };
        assert_eq!(again.size().files, 1);
        age(&[root.clone(), root.join("a")]);
        let (_, settled) = walk(&root, roomy(), &mut Touched::default());
        let mut t = Touched::default();
        assert_eq!(check(&root, &settled.unwrap(), roomy(), &mut t), Outcome::Same);
        assert_eq!(t.reads, 0);
    }

    /// A folder that vanished while its parent's stamp held (a listing missed it) makes the check
    /// unsure instead of trusting the old counts.
    #[test]
    fn a_folder_gone_under_an_unchanged_parent_is_unsure() {
        let td = tempfile::tempdir().unwrap();
        let root = td.path().join("wt");
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        age(&[root.clone(), root.join("a"), root.join("a/b")]);
        let (_, kept) = walk(&root, roomy(), &mut Touched::default());
        let old = kept.unwrap();
        std::fs::remove_dir(root.join("a/b")).unwrap();
        age(&[root.join("a")]);
        assert_eq!(check(&root, &old, roomy(), &mut Touched::default()), Outcome::Unsure);
    }
}
