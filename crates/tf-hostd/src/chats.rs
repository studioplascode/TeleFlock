//! Chat tasks (architecture §3.31): agents started without a repository or a folder of the user's.
//!
//! Each chat gets a folder TeleFlock makes and owns, `<hostd home>/chats/<name>-<id>/` (empty, never
//! a repository). This module is the pure and file-system half: it tells whether a path is in a chat
//! folder ([`ChatRoot`]), names a new chat and makes its folder, says what a folder holds beyond
//! omp's own `.omp/` ([`inspect`]) and removes one that holds nothing else ([`remove_if_unused`]).
//! The launch (`ops::agent`), the board marker (`state`) and `chat.*` (`ops::chat`) use it.

use std::collections::{BTreeMap, BinaryHeap};
use std::ffi::OsStr;
use std::fs::{DirEntry, FileType, Metadata};
use std::io;
use std::path::{Component, Path, PathBuf};

use tf_herdr::{PaneInfo, WorkspaceInfo};
use tf_proto::model::{Agent, Workspace};
use tf_proto::Millis;
use tracing::warn;

/// The herdr label of a session's workspace for chats (one tab per chat).
pub const WORKSPACE_LABEL: &str = "Chats";
/// omp's own folder in a chat folder (autosaved plans, project config): it goes with the chat.
const OMP_DIR: &str = ".omp";
/// How many kept entries a result names (`ChatDeletion.kept`, `ChatFolder.kept`).
pub const KEPT_SHOWN: usize = 20;
/// Entries the walk of one folder looks at, at most (`bytes`, `modifiedAt`). Its top level, which
/// decides what is kept, is always read whole.
pub const WALK_MAX: usize = 20_000;
/// Characters of the random part of a folder name.
const ID_LEN: usize = 6;
/// Folder names tried before making one gives up.
const MAKE_TRIES: usize = 8;
/// A name made from a prompt takes its first words within this many characters (`derive_handle`
/// keeps 28).
const SEED_CHARS: usize = 28;

/// The chats folder (`<hostd home>/chats`). Paths are matched against it as given and as the file
/// system resolved it once (herdr reports real cwds, and the home may sit behind a symlink, such as
/// `/tmp` on macOS), with no file system access per match.
#[derive(Debug, Clone)]
pub struct ChatRoot {
    /// Absolute, as configured.
    path: PathBuf,
    /// The canonical form when it differs: the folder's own, else its parent's plus its name.
    real: Option<PathBuf>,
}

impl ChatRoot {
    pub fn new(path: &Path) -> Self {
        let path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
        let real = std::fs::canonicalize(&path)
            .ok()
            .or_else(|| Some(std::fs::canonicalize(path.parent()?).ok()?.join(path.file_name()?)))
            .filter(|real| *real != path);
        Self { path, real }
    }

    /// Absolute, as configured (`HostInfo.chats`, `ChatFolders.dir`).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `path` below the root, as given or resolved; `None` outside it or not absolute.
    fn below<'a>(&self, path: &'a Path) -> Option<&'a Path> {
        if !path.is_absolute() {
            return None;
        }
        path.strip_prefix(&self.path).ok().or_else(|| path.strip_prefix(self.real.as_deref()?).ok())
    }

    /// The name of the chat folder `path` is or is in, and whether it is deeper than that folder.
    /// `None` for the root itself, siblings (`chats-old`), relative paths and `..` on the way.
    fn locate<'a>(&self, path: &'a Path) -> Option<(&'a OsStr, bool)> {
        let mut parts = self.below(path)?.components();
        let Some(Component::Normal(name)) = parts.next() else { return None };
        let mut deeper = false;
        for part in parts {
            if !matches!(part, Component::Normal(_)) {
                return None;
            }
            deeper = true;
        }
        Some((name, deeper))
    }

    /// The chat folder `cwd` is or is in, under [`path`](Self::path).
    pub fn folder_of(&self, cwd: &Path) -> Option<PathBuf> {
        self.locate(cwd).map(|(name, _)| self.path.join(name))
    }

    /// `path` is in a chat folder (or is one).
    pub fn in_chat(&self, path: &Path) -> bool {
        self.locate(path).is_some()
    }

    /// `path` is a chat folder: a direct child of the root.
    pub fn is_folder(&self, path: &Path) -> bool {
        self.locate(path).is_some_and(|(_, deeper)| !deeper)
    }

    /// `path` is the root or below it: no repository facts are read there.
    pub fn holds(&self, path: &Path) -> bool {
        self.below(path).is_some_and(|rest| rest.components().all(|c| matches!(c, Component::Normal(_))))
    }
}

// ───────────────────────────── names and folders ─────────────────────────────

/// The herdr name of a new chat: the one asked for (kept while no agent on the board has it, else
/// `-2`, …), else one made from the first words of its prompt, else `chat`; unique among `taken`.
pub fn chat_name(asked: Option<&str>, prompt: Option<&str>, taken: &[String]) -> String {
    if let Some(name) = asked {
        return crate::restart::unique_name(name, taken);
    }
    // A prompt without a Latin letter or digit would leave nothing of itself in a herdr name.
    let seed = prompt.map(prompt_seed).filter(|s| s.bytes().any(|b| b.is_ascii_alphanumeric()));
    crate::ops::agent::derive_handle(seed.as_deref().unwrap_or("chat"), taken)
}

/// The first words of a prompt joined with `-`, within [`SEED_CHARS`] (the first word always).
fn prompt_seed(prompt: &str) -> String {
    let mut seed = String::new();
    for word in prompt.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
        if !seed.is_empty() {
            if seed.len() + 1 + word.len() > SEED_CHARS {
                break;
            }
            seed.push('-');
        }
        seed.push_str(word);
    }
    seed
}

/// Six random `[a-z0-9]`: what keeps a chat's folder apart from earlier chats of the same name.
pub fn random_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut bytes = [0u8; ID_LEN];
    if getrandom::fill(&mut bytes).is_err() {
        // No OS random source: the process's hash keys still differ on every call.
        use std::hash::{BuildHasher, Hasher};
        let x = std::collections::hash_map::RandomState::new().build_hasher().finish();
        bytes.copy_from_slice(&x.to_le_bytes()[..ID_LEN]);
    }
    bytes.iter().map(|b| char::from(ALPHABET[usize::from(*b) % ALPHABET.len()])).collect()
}

/// Makes a new chat's folder `<root>/<name>-<id>` (the root owner-only, made when missing). A name
/// that exists gets a new id, [`MAKE_TRIES`] times. `id`: [`random_id`] (tests pass their own).
pub fn make_folder(root: &Path, name: &str, mut id: impl FnMut() -> String) -> io::Result<PathBuf> {
    crate::paths::create_private_dir(root)?;
    for _ in 0..MAKE_TRIES {
        let folder = root.join(format!("{name}-{}", id()));
        match std::fs::create_dir(&folder) {
            Ok(()) => return Ok(folder),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{MAKE_TRIES} folder names for {name} in {} were taken", root.display())))
}

/// A chat started again or resumed at `cwd` finds its folder: one that went is made again, empty,
/// when it is a chat folder itself (a direct child of the root); a folder deeper in one must exist.
pub fn ensure_folder(root: &ChatRoot, cwd: &Path) -> io::Result<()> {
    if cwd.is_dir() {
        return Ok(());
    }
    let missing = || io::Error::new(io::ErrorKind::NotFound, format!("{} is not a folder", cwd.display()));
    if !root.is_folder(cwd) {
        return Err(missing());
    }
    crate::paths::create_private_dir(root.path())?;
    match std::fs::create_dir(cwd) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists && cwd.is_dir() => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(missing()),
        Err(e) => Err(e),
    }
}

/// The environment of a chat's pane: git stops looking for a repository at the chats folder, so
/// omp's git calls never find one above it (a home folder that is a repository).
pub fn pane_env(root: &ChatRoot) -> BTreeMap<String, String> {
    BTreeMap::from([("GIT_CEILING_DIRECTORIES".to_string(), root.path().display().to_string())])
}

/// The herdr session's workspace for chats: labelled [`WORKSPACE_LABEL`] with a pane in the chats
/// folder (a workspace someone named so without one is not taken), the first in herdr's order.
pub fn chats_workspace(root: &ChatRoot, workspaces: &[WorkspaceInfo], panes: &[PaneInfo]) -> Option<String> {
    let in_chats = |p: &PaneInfo| [&p.cwd, &p.foreground_cwd].into_iter().flatten().any(|c| root.holds(Path::new(c)));
    workspaces
        .iter()
        .filter(|w| w.label == WORKSPACE_LABEL && panes.iter().any(|p| p.workspace_id == w.workspace_id && in_chats(p)))
        .min_by_key(|w| w.number)
        .map(|w| w.workspace_id.clone())
}

// ───────────────────────────── board ─────────────────────────────

/// Board marker: an agent in a chat folder (live: where it runs; parked or ended: its record's
/// folder) is a chat, and a chat has no repository or branch.
pub fn mark_agents(root: &ChatRoot, agents: &mut [Agent]) {
    for a in agents.iter_mut().filter(|a| a.cwd.as_deref().is_some_and(|c| root.in_chat(Path::new(c)))) {
        a.chat = true;
        a.repo = None;
        a.branch = None;
    }
}

/// Workspaces in the chats folder have no repository or worktree: their folder is in it, or every
/// pane of theirs is (herdr names the checkout of a repository above, such as a home folder that
/// is one, as the folder of a workspace in it).
pub fn mark_workspaces(root: &ChatRoot, workspaces: &mut [Workspace]) {
    for w in workspaces.iter_mut() {
        let mut panes = w.tabs.iter().flat_map(|t| &t.panes).peekable();
        let panes_in = panes.peek().is_some() && panes.all(|p| p.cwd.as_deref().is_some_and(|c| root.holds(Path::new(c))));
        if panes_in || root.holds(Path::new(&w.cwd)) {
            w.repo = None;
            w.worktree = None;
        }
    }
}

/// The agent on the board that uses chat folder `folder` (its cwd is in it): a live one first,
/// else a parked or ended card.
pub fn agent_in<'a>(root: &ChatRoot, agents: &'a [Agent], folder: &Path) -> Option<&'a Agent> {
    let name = folder.file_name()?;
    agents
        .iter()
        .filter(|a| a.cwd.as_deref().and_then(|c| root.locate(Path::new(c))).is_some_and(|(n, _)| n == name))
        .min_by_key(|a| a.parked.is_some())
}

// ───────────────────────────── contents ─────────────────────────────

/// What a chat folder holds (`chat.list`, `chat.delete`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Contents {
    /// Its top-level entries other than omp's own `.omp/` folder (a real one; a `.omp` symlink or
    /// file is kept): sorted, the first [`KEPT_SHOWN`].
    pub kept: Vec<String>,
    /// How many such entries there are. The folder goes with its chat only while this is 0.
    pub kept_count: u32,
    /// Bytes of the regular files in it, as far as the walk got.
    pub bytes: u64,
    /// The newest modification time of the folder and what is in it, as far as the walk got.
    pub modified_at: Option<Millis>,
}

/// Reads what `folder` holds: its top level whole, then at most [`WALK_MAX`] entries in all for
/// `bytes` and `modified_at`. Never follows a symlink. A missing folder holds nothing.
pub fn inspect(folder: &Path) -> io::Result<Contents> {
    let meta = match std::fs::symlink_metadata(folder) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Contents::default()),
        Err(e) => return Err(e),
    };
    if !meta.is_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} is not a folder", folder.display())));
    }
    let mut out = Contents { modified_at: mtime(&meta), ..Contents::default() };
    let mut first: BinaryHeap<String> = BinaryHeap::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut budget = WALK_MAX;
    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        if !(name == OMP_DIR && kind.is_dir()) {
            out.kept_count = out.kept_count.saturating_add(1);
            keep_first(&mut first, name.to_string_lossy().into_owned());
        }
        if budget > 0 {
            budget -= 1;
            tally(&mut out, &entry, kind, &mut dirs);
        }
    }
    'walk: while let Some(dir) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if budget == 0 {
                break 'walk;
            }
            budget -= 1;
            if let Ok(kind) = entry.file_type() {
                tally(&mut out, &entry, kind, &mut dirs);
            }
        }
    }
    out.kept = first.into_sorted_vec();
    Ok(out)
}

/// Keeps the [`KEPT_SHOWN`] smallest names (a max-heap: its top is the largest one kept).
fn keep_first(first: &mut BinaryHeap<String>, name: String) {
    if first.len() < KEPT_SHOWN {
        first.push(name);
    } else if first.peek().is_some_and(|top| name < *top) {
        first.pop();
        first.push(name);
    }
}

/// Counts one entry (its own metadata: a symlink is never followed) and queues a folder.
fn tally(out: &mut Contents, entry: &DirEntry, kind: FileType, dirs: &mut Vec<PathBuf>) {
    if let Ok(m) = entry.metadata() {
        if kind.is_file() {
            out.bytes = out.bytes.saturating_add(m.len());
        }
        out.modified_at = out.modified_at.max(mtime(&m));
    }
    if kind.is_dir() {
        dirs.push(entry.path());
    }
}

fn mtime(m: &Metadata) -> Option<Millis> {
    let since = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Millis::try_from(since.as_millis()).ok()
}

/// Every chat folder (a direct child of the root that is a folder, not a symlink) with what it
/// holds, newest first. A folder that cannot be read is listed as holding nothing (logged).
pub fn list(root: &ChatRoot) -> io::Result<Vec<(PathBuf, Contents)>> {
    let entries = match std::fs::read_dir(root.path()) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out: Vec<(PathBuf, Contents)> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let folder = root.path().join(entry.file_name());
        let contents = inspect(&folder).unwrap_or_else(|e| {
            warn!(folder = %folder.display(), "reading a chat folder: {e}");
            Contents::default()
        });
        out.push((folder, contents));
    }
    out.sort_by(|a, b| b.1.modified_at.cmp(&a.1.modified_at).then_with(|| a.0.cmp(&b.0)));
    Ok(out)
}

/// Removes chat folder `folder` with everything in it when nothing in it is kept ([`inspect`]):
/// only a direct child of the root as the file system resolves it now, a folder and not a symlink;
/// never the root, never anything outside it. Returns what it found there and whether the folder
/// went (`false`: something is kept, it is no chat folder, or it is gone already).
pub fn remove_if_unused(root: &ChatRoot, folder: &Path) -> io::Result<(Contents, bool)> {
    let Some((name, false)) = root.locate(folder) else {
        warn!(folder = %folder.display(), "not a chat folder; not removed");
        return Ok((Contents::default(), false));
    };
    let real_root = match std::fs::canonicalize(root.path()) {
        Ok(r) => r,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((Contents::default(), false)),
        Err(e) => return Err(e),
    };
    let target = real_root.join(name);
    match std::fs::symlink_metadata(&target) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            warn!(folder = %target.display(), "a chat folder that is a symlink or a file is never removed");
            return Ok((Contents::default(), false));
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((Contents::default(), false)),
        Err(e) => return Err(e),
    }
    let contents = inspect(&target)?;
    if contents.kept_count > 0 {
        return Ok((contents, false));
    }
    std::fs::remove_dir_all(&target)?;
    Ok((contents, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root_in(dir: &Path) -> ChatRoot {
        ChatRoot::new(&dir.join("chats"))
    }

    #[test]
    fn names_come_from_the_ask_the_prompt_or_chat() {
        let taken = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        // An asked name stays while it is free; else it gets a number.
        assert_eq!(chat_name(Some("review"), Some("whatever"), &[]), "review");
        assert_eq!(chat_name(Some("review"), None, &taken(&["review"])), "review-2");
        // The prompt's first words, whole, within 28 characters.
        assert_eq!(chat_name(None, Some("Fix the parser's crash on empty input, then add a test"), &[]), "fix-the-parser-s-crash-on");
        assert_eq!(chat_name(None, Some("supercalifragilisticexpialidocious-ish words"), &[]), "supercalifragilisticexpialid");
        assert_eq!(chat_name(None, Some("123 go"), &[]), "a-123-go");
        assert_eq!(chat_name(None, Some("plan the trip"), &taken(&["plan-the-trip"])), "plan-the-trip-2");
        // Nothing usable: `chat`.
        for prompt in [None, Some(""), Some("   "), Some("Привет, мир")] {
            assert_eq!(chat_name(None, prompt, &[]), "chat", "{prompt:?}");
        }
        assert_eq!(chat_name(None, None, &taken(&["chat", "chat-2"])), "chat-3");
        for name in [chat_name(None, Some("Größe ändern"), &[]), chat_name(None, Some(&"word ".repeat(40)), &[])] {
            assert!(crate::ops::agent::valid_handle(&name), "{name}");
        }
    }

    #[test]
    fn ids_are_six_of_a_to_z_and_digits() {
        let ids: Vec<String> = (0..50).map(|_| random_id()).collect();
        assert!(ids.iter().all(|id| id.len() == 6 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())), "{ids:?}");
        let distinct: std::collections::HashSet<&String> = ids.iter().collect();
        assert!(distinct.len() > 45, "random: {ids:?}");
    }

    #[test]
    fn folders_are_name_dash_id_and_a_taken_one_gets_a_new_id() {
        let td = tempfile::tempdir().unwrap();
        let root = td.path().join("chats");
        let mut ids = ["aaaaaa", "aaaaaa", "bbbbbb"].into_iter().map(String::from);
        let first = make_folder(&root, "fix", || ids.next().unwrap()).unwrap();
        assert_eq!(first, root.join("fix-aaaaaa"));
        // The same id again: taken, so the next one.
        let second = make_folder(&root, "fix", || ids.next().unwrap()).unwrap();
        assert_eq!(second, root.join("fix-bbbbbb"));
        assert!(first.is_dir() && second.is_dir());
        assert_eq!(std::fs::read_dir(&first).unwrap().count(), 0, "a new chat's folder is empty");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700, "the root is owner-only");
        }
        // Every try taken: an error, nothing made.
        let err = make_folder(&root, "fix", || "aaaaaa".into()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
    }

    #[test]
    fn a_path_is_in_a_chat_only_below_the_root() {
        let root = ChatRoot::new(Path::new("/h/.teleflock/chats"));
        let p = Path::new;
        assert_eq!(root.folder_of(p("/h/.teleflock/chats/fix-abc123")), Some(p("/h/.teleflock/chats/fix-abc123").to_path_buf()));
        assert_eq!(root.folder_of(p("/h/.teleflock/chats/fix-abc123/src/deep/")), Some(p("/h/.teleflock/chats/fix-abc123").to_path_buf()));
        assert!(root.is_folder(p("/h/.teleflock/chats/fix-abc123/")));
        assert!(!root.is_folder(p("/h/.teleflock/chats/fix-abc123/src")));
        for no in ["/h/.teleflock/chats", "/h/.teleflock/chats/", "/h/.teleflock/chats-old/x", "/h/.teleflock", "chats/x", "/h/.teleflock/chats/../x", "/h/.teleflock/chats/x/../../y"] {
            assert_eq!(root.folder_of(p(no)), None, "{no}");
            assert!(!root.is_folder(p(no)), "{no}");
        }
        // The root itself holds (no repo facts there), its siblings don't.
        assert!(root.holds(p("/h/.teleflock/chats")) && root.holds(p("/h/.teleflock/chats/x/y")));
        assert!(!root.holds(p("/h/.teleflock/chats-old")) && !root.holds(p("/h/.teleflock")) && !root.holds(p("/h/.teleflock/chats/../x")));
    }

    #[cfg(unix)]
    #[test]
    fn a_root_behind_a_symlink_matches_the_real_cwds_herdr_reports() {
        let td = tempfile::tempdir().unwrap();
        let real = td.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, td.path().join("link")).unwrap();
        // The root does not exist yet: resolved through its parent.
        let root = ChatRoot::new(&td.path().join("link").join("chats"));
        let real_root = std::fs::canonicalize(&real).unwrap().join("chats");
        let herdr_cwd = real_root.join("fix-abc123").join("src");
        assert_eq!(root.folder_of(&herdr_cwd), Some(td.path().join("link/chats/fix-abc123")));
        assert!(root.is_folder(&real_root.join("fix-abc123")) && root.holds(&real_root));
        assert!(!root.in_chat(&std::fs::canonicalize(&real).unwrap().join("chats-old/x")));
    }

    #[test]
    fn a_missing_chat_folder_is_made_again_but_nothing_deeper() {
        let td = tempfile::tempdir().unwrap();
        let root = root_in(td.path());
        let folder = root.path().join("fix-abc123");
        ensure_folder(&root, &folder).unwrap();
        assert!(folder.is_dir());
        ensure_folder(&root, &folder).unwrap();
        let deeper = folder.join("gone");
        assert_eq!(ensure_folder(&root, &deeper).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(ensure_folder(&root, &td.path().join("elsewhere")).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert!(!td.path().join("elsewhere").exists() && !deeper.exists());
        // A file where the folder was is no folder.
        let file = root.path().join("file-abc123");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(ensure_folder(&root, &file).unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn only_omps_own_folder_is_not_kept() {
        let td = tempfile::tempdir().unwrap();
        let f = td.path().join("fix-abc123");
        assert_eq!(inspect(&f).unwrap(), Contents::default(), "missing: holds nothing");
        std::fs::create_dir(&f).unwrap();
        let empty = inspect(&f).unwrap();
        assert_eq!((empty.kept.len(), empty.kept_count, empty.bytes), (0, 0, 0));
        assert!(empty.modified_at.is_some(), "the folder's own time");
        // omp's plans: not kept, but counted.
        std::fs::create_dir_all(f.join(".omp/plans")).unwrap();
        std::fs::write(f.join(".omp/plans/x.md"), b"plan!").unwrap();
        let plans = inspect(&f).unwrap();
        assert_eq!((plans.kept_count, plans.bytes), (0, 5));
        // Anything else is kept.
        std::fs::write(f.join("notes.txt"), b"hello").unwrap();
        let file = inspect(&f).unwrap();
        assert_eq!((file.kept.clone(), file.kept_count, file.bytes), (vec!["notes.txt".to_string()], 1, 10));
        // A `.omp` that is a file is the user's.
        let g = td.path().join("other-abc123");
        std::fs::create_dir(&g).unwrap();
        std::fs::write(g.join(".omp"), b"").unwrap();
        assert_eq!(inspect(&g).unwrap().kept, vec![".omp".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_kept_and_never_followed() {
        let td = tempfile::tempdir().unwrap();
        let outside = td.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("big"), vec![0u8; 4096]).unwrap();
        let f = td.path().join("fix-abc123");
        std::fs::create_dir(&f).unwrap();
        std::os::unix::fs::symlink(&outside, f.join(".omp")).unwrap();
        let c = inspect(&f).unwrap();
        assert_eq!((c.kept.clone(), c.kept_count), (vec![".omp".to_string()], 1), "a `.omp` symlink is kept");
        assert!(c.bytes < 4096, "the link was not followed: {}", c.bytes);
    }

    #[test]
    fn many_entries_list_the_first_twenty_sorted_and_count_all() {
        let td = tempfile::tempdir().unwrap();
        let f = td.path().join("fix-abc123");
        std::fs::create_dir_all(f.join(".omp")).unwrap();
        for i in (0..30).rev() {
            std::fs::write(f.join(format!("file-{i:02}")), b"x").unwrap();
        }
        let c = inspect(&f).unwrap();
        assert_eq!(c.kept_count, 30);
        assert_eq!(c.kept, (0..20).map(|i| format!("file-{i:02}")).collect::<Vec<_>>());
        assert_eq!(c.bytes, 30);
    }

    #[test]
    fn removal_takes_only_an_unused_chat_folder() {
        let td = tempfile::tempdir().unwrap();
        let root = root_in(td.path());
        let used = make_folder(root.path(), "used", random_id).unwrap();
        std::fs::write(used.join("report.md"), b"keep me").unwrap();
        let (c, removed) = remove_if_unused(&root, &used).unwrap();
        assert!(!removed && used.join("report.md").is_file());
        assert_eq!((c.kept, c.kept_count), (vec!["report.md".to_string()], 1));

        let unused = make_folder(root.path(), "unused", random_id).unwrap();
        std::fs::create_dir_all(unused.join(".omp/plans")).unwrap();
        std::fs::write(unused.join(".omp/plans/x.md"), b"plan").unwrap();
        // Not through a path deeper in it.
        assert!(!remove_if_unused(&root, &unused.join(".omp")).unwrap().1);
        let (c, removed) = remove_if_unused(&root, &unused).unwrap();
        assert!(removed && !unused.exists());
        assert_eq!(c.kept_count, 0);
        // Gone already: nothing to do.
        assert_eq!(remove_if_unused(&root, &unused).unwrap(), (Contents::default(), false));

        // Never the root, never a folder outside it.
        let outside = td.path().join("chats-old");
        std::fs::create_dir(&outside).unwrap();
        for path in [root.path().to_path_buf(), outside.clone(), td.path().to_path_buf(), root.path().join("..").join("chats-old")] {
            assert!(!remove_if_unused(&root, &path).unwrap().1, "{}", path.display());
        }
        assert!(root.path().is_dir() && outside.is_dir() && used.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_chat_folder_is_never_removed() {
        let td = tempfile::tempdir().unwrap();
        let root = root_in(td.path());
        std::fs::create_dir(root.path()).unwrap();
        let elsewhere = td.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        let link = root.path().join("link-abc123");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        assert!(!remove_if_unused(&root, &link).unwrap().1);
        assert!(link.exists() && elsewhere.is_dir());
        // `chat.list` does not list it either.
        assert!(list(&root).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_list_has_every_chat_folder_newest_first() {
        let td = tempfile::tempdir().unwrap();
        let root = root_in(td.path());
        assert!(list(&root).unwrap().is_empty(), "no chats folder yet");
        let old = make_folder(root.path(), "old", random_id).unwrap();
        let new = make_folder(root.path(), "new", random_id).unwrap();
        std::fs::write(root.path().join("stray-file"), b"x").unwrap();
        let past = std::fs::File::open(&old).unwrap();
        past.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600)).unwrap();
        let listed: Vec<PathBuf> = list(&root).unwrap().into_iter().map(|(f, _)| f).collect();
        assert_eq!(listed, vec![new, old]);
    }

    fn pane(ws: &str, cwd: &str) -> PaneInfo {
        PaneInfo { pane_id: format!("{ws}:p1"), workspace_id: ws.into(), cwd: Some(cwd.into()), ..Default::default() }
    }

    fn workspace(id: &str, label: &str, number: u32) -> WorkspaceInfo {
        WorkspaceInfo { workspace_id: id.into(), label: label.into(), number, ..Default::default() }
    }

    #[test]
    fn the_chats_workspace_is_found_by_label_and_a_pane_in_the_chats_folder() {
        let root = ChatRoot::new(Path::new("/h/.teleflock/chats"));
        // A workspace the user named "Chats" somewhere else is not taken.
        let ws = [workspace("w1", "Chats", 1), workspace("w2", "repo", 2)];
        let panes = [pane("w1", "/h/src/app"), pane("w2", "/h/.teleflock/chats/a-abc123")];
        assert_eq!(chats_workspace(&root, &ws, &panes), None);
        let ws = [workspace("w3", "Chats", 3), workspace("w1", "Chats", 1), workspace("w2", "repo", 2)];
        let panes = [pane("w1", "/h/src/app"), pane("w3", "/h/.teleflock/chats/a-abc123"), pane("w2", "/h/.teleflock/chats/b-abc123")];
        assert_eq!(chats_workspace(&root, &ws, &panes).as_deref(), Some("w3"));
        // A shell someone left at the chats folder itself counts; the first in herdr's order wins.
        let panes = [pane("w1", "/h/.teleflock/chats"), pane("w3", "/h/.teleflock/chats/a-abc123")];
        assert_eq!(chats_workspace(&root, &ws, &panes).as_deref(), Some("w1"));
        assert_eq!(pane_env(&root).get("GIT_CEILING_DIRECTORIES").map(String::as_str), Some("/h/.teleflock/chats"));
    }

    #[test]
    fn the_agent_of_a_folder_is_a_live_one_first() {
        let root = ChatRoot::new(Path::new("/h/.teleflock/chats"));
        let card = |id: &str, cwd: &str, parked: bool| {
            let mut a = crate::state::parked::parked_agent(&crate::state::persist::ParkedRecord {
                agent_id: id.into(),
                kind: "omp".into(),
                cwd: Some(cwd.into()),
                session_file: format!("/s/{id}.jsonl"),
                ..Default::default()
            });
            if !parked {
                a.parked = None;
            }
            a
        };
        let agents = [card("t1", "/h/.teleflock/chats/a-abc123", true), card("t2", "/h/.teleflock/chats/a-abc123/sub", false), card("t3", "/h/.teleflock/chats/b-abc123", true)];
        let id = |folder: &str| agent_in(&root, &agents, Path::new(folder)).map(|a| a.id.clone());
        assert_eq!(id("/h/.teleflock/chats/a-abc123").as_deref(), Some("t2"));
        assert_eq!(id("/h/.teleflock/chats/b-abc123").as_deref(), Some("t3"));
        assert_eq!(id("/h/.teleflock/chats/c-abc123"), None);
    }
}
