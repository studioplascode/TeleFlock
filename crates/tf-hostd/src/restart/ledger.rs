//! The agent ledger, `<home>/ledger.json` (architecture §3.25): for every omp agent the board
//! shows live, what it takes to bring it back exactly when its omp ends without anyone closing
//! it, and (once it ended) how it goes on when it runs again. Per herdr session: agent id →
//! [`Entry`]. Owner-only, atomic writes; written when something that matters changes (the
//! last-seen time at most every minute); one lock for every herdr session of a daemon. Parked
//! agents (Mark done) keep their record in `state.json` instead (`state/parked.rs`).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tracing::warn;

use tf_proto::autoanswer::AutoAnswer;
use tf_proto::Millis;

use super::decide::Plan;
use super::images::{self, Kept};
use crate::agentcfg::AgentOmp;
use crate::paths::write_atomic;
use crate::state::persist::ParkedRecord;

pub const FILE: &str = "ledger.json";

/// One omp agent.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Entry {
    /// The card it becomes when its omp ends: name, title, folder, repo, branch, omp session id
    /// and file, model, thinking level, worktree, herdr workspace and its folder; `ended` once it
    /// ended.
    pub record: ParkedRecord,
    pub pane_id: String,
    pub tab_id: String,
    /// Marked done (archived) while it still had its pane: an end files it under Done.
    pub archived: bool,
    /// Its omp process and the command line it was started with (Linux `/proc`).
    pub pid: Option<u32>,
    pub argv: Vec<String>,
    /// TeleFlock launched it: its command line names this home's overlay or bridge.
    pub ours: bool,
    /// Its own omp settings (model roles, fallback chains) and decide-for-me policy, as their own
    /// stores (`agent-config/agents.json`, `auto-answer.json`) keep them by agent id.
    pub settings: AgentOmp,
    pub auto_answer: Option<AutoAnswer>,
    /// It was working (a turn, a dialog, a reply being written) when last seen.
    pub busy: bool,
    /// It was writing a reply (streaming, in no tool call) when last seen.
    pub replying: bool,
    /// The tool call it was in (`bash: cargo test`).
    pub tool: Option<String>,
    /// Background jobs (bash, eval) it had running (`bash: npm test`).
    pub jobs: Vec<String>,
    /// Subagents it had running.
    pub subagents: u32,
    /// Its bridge was linked when last seen. While a link that was live is down (omp ending
    /// drops it before herdr's state changes) the facts above stay as last seen live.
    pub linked: bool,
    /// omp has written its session file (it does with the first reply); until then the prompts
    /// it was given live only in hostd's replica and are kept here (`prompts`), so an agent that
    /// ends in its first turn can start again with them (Continue; never by itself).
    pub file_seen: bool,
    pub prompts: Vec<String>,
    /// The images of those prompts, kept under `<home>/ledger-images/` ([`images`]): a start of
    /// the card gives them again with the text.
    pub images: Vec<Kept>,
    /// `prompts` / `images` were recorded by hostd itself when it started the agent (`start_agent`):
    /// the replica's rows never replace them (they stand for prompts typed in the omp TUI only).
    pub recorded: bool,
    /// Why the images of its first turn could not be kept in full (none of them is kept then): a
    /// start that gave the text alone would be a different task, so the card says it.
    pub images_lost: Option<String>,
    /// When it was last seen live, and under which boot (`/proc/sys/kernel/random/boot_id`) and
    /// herdr server process.
    pub seen_at: Millis,
    pub boot: Option<String>,
    pub herdr_pid: Option<u32>,
    /// How it goes on once it runs again (decided when it ended), until that is done.
    pub plan: Option<Plan>,
    /// How its omp last ended and what it was doing then, for the plan decided again once it is
    /// back (`--resume` changed the session's tail).
    pub end: Option<End>,
    /// When its omp ended (ms, oldest first; only the last [`CRASH_WINDOW_MS`]): an agent that
    /// keeps ending is not brought back by itself ([`Entry::crash_looping`]).
    pub ends: Vec<Millis>,
    /// Its ended card's restart ticket waits for Continue, and why (an omp somebody stopped on
    /// purpose, a pane that went while TeleFlock was not watching).
    pub hold: Option<String>,
    /// A new agent is being started for this ended card (its first turn ended before omp saved
    /// the session): written before the launch, so a launch that went through is found on the
    /// board and not started twice. The card and this entry stay until that agent's session file
    /// exists (omp took the prompt and replied).
    pub launching: Option<Launching>,
    /// When the launch that made this entry began, on the boot's own clock (`BootStamp`): what a
    /// process's start time is compared with as launch evidence. `None` for older entries and off
    /// Linux (the board snapshot's time is the evidence then).
    pub launch_boot: Option<BootStamp>,
}

/// More than this many ends within [`CRASH_WINDOW_MS`] hold the restart ticket for Continue.
pub const CRASH_ENDS: usize = 3;
pub const CRASH_WINDOW_MS: Millis = 10 * 60_000;

/// A launch of a new agent for an ended fileless card that was started (see [`Entry::launching`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Launching {
    pub at: Millis,
    /// The agent name the launch asked for (herdr names are unique among live agents).
    pub name: String,
    /// When the kept prompt was sent to the new agent (through its link, written before the send):
    /// the only automatic send there is. Never again by itself.
    pub sent_at: Option<Millis>,
    /// The send was not confirmed by the session file in time: the card waits for Continue.
    pub unconfirmed: bool,
    /// Over: the successor's first message was not the kept prompt (or the prompt has images), so
    /// the card stays as it is, with the prompt and its images, for the user.
    pub settled: bool,
}

/// When and why an entry's omp ended, and what it was doing then.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct End {
    pub at: Millis,
    pub reason: String,
    pub busy: bool,
    /// Its background jobs (bash, eval) that ran then.
    pub jobs: Vec<String>,
}

impl Entry {
    /// It runs (or ran) omp session `file` / `id`.
    pub fn runs(&self, file: Option<&str>, id: Option<&str>) -> bool {
        (id.is_some() && self.record.session_id.as_deref() == id) || (file.is_some_and(|f| !f.is_empty()) && Some(self.record.session_file.as_str()) == file)
    }

    /// Its omp ended at `at`: remembered for [`Entry::crash_looping`] (older ends are dropped).
    pub fn note_end(&mut self, at: Millis, now: Millis) {
        self.ends.retain(|t| now - *t < CRASH_WINDOW_MS);
        self.ends.push(at);
    }

    /// It ended more than [`CRASH_ENDS`] times within [`CRASH_WINDOW_MS`] (a crash loop: bringing
    /// it back again by itself would repeat what crashes it, and what it costs).
    pub fn crash_looping(&self, now: Millis) -> bool {
        self.ends.iter().filter(|t| now - **t < CRASH_WINDOW_MS).count() > CRASH_ENDS
    }

    /// Why an ended card whose omp never wrote its session (its first turn was cut off) waits for
    /// Continue and is never started again by itself: nothing may be repeated that might have
    /// been taken (a task, paid requests), and a start without its images would be another task.
    /// Says a prompt is kept only when one is.
    pub fn fresh_hold(&self) -> String {
        let lost = self.images_lost.as_ref().map(|why| format!(" Its images could not be kept ({why}), so they are not given again.")).unwrap_or_default();
        if self.first_prompt().is_none() && self.images.is_empty() {
            return format!("it ended before its first reply (omp had not saved its session); no prompt was recorded, so Continue starts it again empty.{lost}");
        }
        format!("it ended before its first reply (omp had not saved its session); its prompt is kept, continue it to start it again.{lost}")
    }

    /// The first prompt of a new session: every prompt it was given, as one message.
    pub fn first_prompt(&self) -> Option<String> {
        let p = self.prompts.iter().filter(|p| !p.trim().is_empty()).cloned().collect::<Vec<_>>().join("\n\n");
        (!p.is_empty()).then_some(p)
    }

    /// The files of the images it keeps.
    pub fn image_files(&self) -> impl Iterator<Item = String> + '_ {
        self.images.iter().map(|k| k.file.clone())
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct FileData {
    sessions: BTreeMap<String, BTreeMap<String, Entry>>,
}

/// One herdr session's entries (agent id → entry), shared by its worker and the executor that
/// brings agents back.
#[derive(Debug)]
pub struct Book {
    file: PathBuf,
    session: String,
    pub entries: BTreeMap<String, Entry>,
    dirty: bool,
    saved_at: Millis,
}

static LOCK: Mutex<()> = Mutex::new(());
static BOOKS: LazyLock<Mutex<HashMap<(PathBuf, String), Arc<Mutex<Book>>>>> = LazyLock::new(Default::default);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn path(home: &Path) -> PathBuf {
    home.join(FILE)
}

/// The file's content; an unreadable or corrupt file is set aside (`ledger.json.bad-<ms>`) and the
/// ledger starts empty, so the next save never overwrites it.
fn read(file: &Path) -> FileData {
    crate::paths::load_json(file)
}

/// The book of `session` under `home` (loaded on first use).
pub fn book(home: &Path, session: &str) -> Arc<Mutex<Book>> {
    let file = path(home);
    lock(&BOOKS)
        .entry((file.clone(), session.to_string()))
        .or_insert_with(|| {
            let entries = {
                let _g = lock(&LOCK);
                read(&file).sessions.remove(session).unwrap_or_default()
            };
            Arc::new(Mutex::new(Book { file, session: session.to_string(), entries, dirty: false, saved_at: 0 }))
        })
        .clone()
}

/// Locks a book.
pub fn open(b: &Arc<Mutex<Book>>) -> MutexGuard<'_, Book> {
    lock(b)
}

/// The herdr sessions of `home` whose ledger holds agents (a daemon starting after a reboot opens
/// their contexts, so herdr runs again and they come back with no app connected).
pub fn sessions(home: &Path) -> Vec<String> {
    let file = path(home);
    let _g = lock(&LOCK);
    read(&file).sessions.into_iter().filter(|(_, e)| !e.is_empty()).map(|(s, _)| s).collect()
}

/// Some herdr session of `home` has agents to bring back after a reboot.
pub fn any(home: &Path) -> bool {
    let file = path(home);
    let loaded: Vec<Arc<Mutex<Book>>> = lock(&BOOKS).iter().filter(|((f, _), _)| *f == file).map(|(_, b)| b.clone()).collect();
    if loaded.iter().any(|b| !lock(b).entries.is_empty()) {
        return true;
    }
    !sessions(home).is_empty()
}

/// The entry that runs (or ran) omp session `file` / `id` in herdr session `session`.
pub fn find(home: &Path, session: &str, file: Option<&str>, id: Option<&str>) -> Option<(String, Entry)> {
    let b = book(home, session);
    let g = lock(&b);
    g.entries.iter().find(|(_, e)| e.runs(file, id)).map(|(k, e)| (k.clone(), e.clone()))
}

impl Book {
    /// Something that matters changed: written with the next [`Book::save`].
    pub fn touch(&mut self) {
        self.dirty = true;
    }

    /// Writes the book when it changed, or (`seen`: only last-seen times moved) at most every
    /// `every` ms. Replaces this session's part of the file. False when a write was due and did
    /// not happen (the book stays dirty and is written again).
    pub fn save(&mut self, now: Millis, seen: bool, every: Millis) -> bool {
        if !self.dirty && !(seen && now - self.saved_at >= every) {
            return true;
        }
        let changed = self.dirty;
        let _g = lock(&LOCK);
        // Other sessions' entries are in the file: a read that failed for any reason but "there is
        // no file" must not be taken for an empty file (the write would drop them). Try again later.
        let mut all = match std::fs::read(&self.file) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                crate::paths::set_aside_bad(&self.file, &e.to_string());
                FileData::default()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileData::default(),
            Err(e) => {
                warn!(file = %self.file.display(), "saving the agent ledger: cannot read it first ({e}); trying again later");
                return false;
            }
        };
        if self.entries.is_empty() {
            all.sessions.remove(&self.session);
        } else {
            all.sessions.insert(self.session.clone(), self.entries.clone());
        }
        match serde_json::to_vec(&all).map_err(std::io::Error::other).and_then(|b| write_atomic(&self.file, &b)) {
            Ok(()) => {
                self.dirty = false;
                self.saved_at = now;
                if changed && let Some(home) = self.file.parent() {
                    // The images of entries that are gone go with them.
                    let named: HashSet<String> = all.sessions.values().flat_map(BTreeMap::values).flat_map(Entry::image_files).collect();
                    images::sweep(home, &named);
                }
                true
            }
            Err(e) => {
                warn!(file = %self.file.display(), "saving the agent ledger: {e}");
                false
            }
        }
    }

    /// Something that matters changed and is not written yet.
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// The entry that runs (or ran) omp session `file` / `id`.
    pub fn by_session(&self, file: Option<&str>, id: Option<&str>) -> Option<(&String, &Entry)> {
        self.entries.iter().find(|(_, e)| e.runs(file, id))
    }

    pub fn by_session_mut(&mut self, file: Option<&str>, id: Option<&str>) -> Option<(&String, &mut Entry)> {
        self.entries.iter_mut().find(|(_, e)| e.runs(file, id))
    }
}

/// Writes every loaded book that holds entries or unsaved changes now (shutdown: the workers'
/// own last saves run detached from the daemon's exit).
pub fn save_all(home: &Path, now: Millis) {
    let file = path(home);
    let books: Vec<Arc<Mutex<Book>>> = lock(&BOOKS).iter().filter(|((f, _), _)| *f == file).map(|(_, b)| b.clone()).collect();
    for b in books {
        let mut g = lock(&b);
        if g.dirty || !g.entries.is_empty() {
            g.save(now, true, 0);
        }
    }
}

/// This boot (Linux `/proc/sys/kernel/random/boot_id`; `None` elsewhere): a ledger entry from
/// another boot ran before the host restarted.
pub fn boot_id() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// A moment on this boot's own clock (`CLOCK_BOOTTIME`, ms since the host booted) and which boot
/// that is. Comparable with a process's start time in `/proc/<pid>/stat` (ticks since boot), which
/// the wall clock is not: `/proc/stat`'s boot time is cut to whole seconds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BootStamp {
    pub id: String,
    pub ms: i64,
}

/// Now on this boot's clock; `None` where there is no such clock (not Linux).
pub fn boot_stamp() -> Option<BootStamp> {
    #[cfg(target_os = "linux")]
    {
        let id = boot_id()?;
        let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        // SAFETY: clock_gettime(2) writes the timespec it is given.
        if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut ts) } != 0 {
            return None;
        }
        Some(BootStamp { id, ms: ts.tv_sec as i64 * 1000 + ts.tv_nsec as i64 / 1_000_000 })
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Whether the omp process of an entry still runs: `pid` lives with the same command line
/// (Linux `/proc`; PIDs get reused). `None` where that cannot be told: another OS, or no process
/// was ever recorded (an entry whose pid is unknown says nothing about a running omp).
pub fn alive(pid: Option<u32>, argv: &[String]) -> Option<bool> {
    #[cfg(target_os = "linux")]
    {
        let pid = pid?;
        Some(match super::herdr::cmdline(pid) {
            Some(now) => argv.is_empty() || now == argv,
            None => false,
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (pid, argv);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(file: &str, name: &str) -> Entry {
        Entry {
            record: ParkedRecord { agent_id: "t1".into(), name: name.into(), session_id: Some(format!("id-{name}")), session_file: file.into(), ..Default::default() },
            pane_id: "w1:p1".into(),
            pid: Some(7),
            argv: vec!["omp".into(), format!("--resume={file}")],
            ours: true,
            busy: true,
            tool: Some("bash: sleep 30".into()),
            seen_at: 5,
            ..Default::default()
        }
    }

    #[test]
    fn books_persist_per_session_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        {
            let b = book(home, "default");
            let mut g = open(&b);
            g.entries.insert("t1".into(), entry("/s/a.jsonl", "fixer"));
            g.touch();
            g.save(10, false, 60_000);
        }
        {
            let b = book(home, "lab");
            let mut g = open(&b);
            g.entries.insert("t2".into(), entry("/s/b.jsonl", "scout"));
            g.touch();
            g.save(10, false, 60_000);
        }
        // A fresh daemon reads both back.
        let raw: FileData = serde_json::from_slice(&std::fs::read(path(home)).unwrap()).unwrap();
        assert_eq!(raw.sessions["default"]["t1"], entry("/s/a.jsonl", "fixer"));
        assert_eq!(raw.sessions["lab"]["t2"].record.name, "scout");
        let mut got = sessions(home);
        got.sort();
        assert_eq!(got, ["default", "lab"]);
        assert!(any(home));
        assert_eq!(find(home, "default", Some("/s/a.jsonl"), None).map(|(id, e)| (id, e.record.name)), Some(("t1".into(), "fixer".into())));
        assert_eq!(find(home, "default", None, Some("id-fixer")).map(|(id, _)| id), Some("t1".into()));
        assert!(find(home, "default", Some("/s/b.jsonl"), None).is_none(), "sessions are kept apart");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(path(home)).unwrap().permissions().mode() & 0o077, 0, "owner-only");
        }
        // Emptied: the session leaves the file.
        let b = book(home, "lab");
        let mut g = open(&b);
        g.entries.clear();
        g.touch();
        g.save(20, false, 60_000);
        assert_eq!(sessions(home), ["default"]);
    }

    #[test]
    fn last_seen_times_alone_are_written_at_most_every_minute() {
        let dir = tempfile::tempdir().unwrap();
        let b = book(dir.path(), "default");
        let mut g = open(&b);
        g.entries.insert("t1".into(), entry("/s/a.jsonl", "fixer"));
        g.touch();
        g.save(1_000, true, 60_000);
        g.entries.get_mut("t1").unwrap().seen_at = 30_000;
        g.save(30_000, true, 60_000);
        let read_seen = || serde_json::from_slice::<FileData>(&std::fs::read(path(dir.path())).unwrap()).unwrap().sessions["default"]["t1"].seen_at;
        assert_eq!(read_seen(), 5, "not yet");
        g.save(61_000, true, 60_000);
        assert_eq!(read_seen(), 30_000);
    }

    #[test]
    fn a_process_counts_as_alive_only_with_the_same_command_line() {
        #[cfg(target_os = "linux")]
        {
            let me = std::process::id();
            let argv = super::super::herdr::cmdline(me).unwrap();
            assert_eq!(alive(Some(me), &argv), Some(true));
            assert_eq!(alive(Some(me), &["omp".to_string(), "--resume=/x.jsonl".to_string()]), Some(false), "a reused pid");
            assert_eq!(alive(None, &argv), None, "no pid recorded: nothing is known");
            assert!(boot_id().is_some());
        }
    }

    #[test]
    fn more_than_three_ends_in_ten_minutes_are_a_crash_loop() {
        let mut e = entry("/s/a.jsonl", "fixer");
        let now = 100 * 60_000;
        for k in 0..3 {
            e.note_end(now - 60_000 + k, now);
        }
        assert!(!e.crash_looping(now), "three ends are still just bad luck");
        e.note_end(now, now);
        assert!(e.crash_looping(now), "the fourth within ten minutes");
        assert!(!e.crash_looping(now + CRASH_WINDOW_MS), "ends age out");
        // Old ends are dropped when the next one is noted.
        e.note_end(now + CRASH_WINDOW_MS, now + CRASH_WINDOW_MS);
        assert_eq!(e.ends, vec![now + CRASH_WINDOW_MS]);
    }

    #[test]
    fn a_corrupt_ledger_is_set_aside_and_other_sessions_survive_a_failed_read() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        std::fs::write(path(home), b"{\"sessions\":{\"default\":{\"t1\":").unwrap();
        assert!(sessions(home).is_empty(), "starts empty");
        assert!(!path(home).exists(), "set aside, not left to be overwritten");
        let aside = |home: &Path| std::fs::read_dir(home).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("ledger.json.bad-")).count();
        assert_eq!(aside(home), 1);

        let b = book(home, "default");
        let mut g = open(&b);
        g.entries.insert("t1".into(), entry("/s/a.jsonl", "fixer"));
        g.touch();
        g.save(10, false, 60_000);
        assert_eq!(sessions(home), ["default"]);
        assert_eq!(aside(home), 1, "the bad file stays for the user");

        // A file that exists but cannot be read is no empty file: the save waits instead of
        // rewriting it with this session's entries alone.
        std::fs::remove_file(path(home)).unwrap();
        std::fs::create_dir(path(home)).unwrap();
        g.touch();
        g.save(20, false, 60_000);
        assert!(g.is_dirty(), "still to be written");
        assert!(path(home).is_dir(), "not replaced");
        std::fs::remove_dir(path(home)).unwrap();
        g.save(30, false, 60_000);
        assert!(!g.is_dirty());
        assert_eq!(sessions(home), ["default"]);
    }

    #[test]
    fn save_all_writes_every_loaded_book() {
        let dir = tempfile::tempdir().unwrap();
        let b = book(dir.path(), "default");
        {
            let mut g = open(&b);
            g.entries.insert("t1".into(), entry("/s/a.jsonl", "fixer"));
            g.touch();
        }
        assert!(sessions(dir.path()).is_empty());
        save_all(dir.path(), 5);
        assert_eq!(sessions(dir.path()), ["default"]);
    }

    #[test]
    fn an_ended_card_that_never_saved_its_session_says_why_it_waits_for_continue() {
        let mut e = entry("/s/gone.jsonl", "fixer");
        e.prompts = vec!["fix the build".into()];
        let why = e.fresh_hold();
        assert!(why.contains("before its first reply") && why.contains("continue it"), "{why}");
        e.images_lost = Some("an image has no payload yet".into());
        let why = e.fresh_hold();
        assert!(why.contains("no payload yet") && why.contains("not given again"), "{why}");
        assert_eq!(e.first_prompt().as_deref(), Some("fix the build"));
        e.prompts = vec!["one".into(), " ".into(), "two".into()];
        assert_eq!(e.first_prompt().as_deref(), Some("one\n\ntwo"));
    }

    #[test]
    fn the_prompt_and_its_images_survive_hostd_dying_and_go_with_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let kept = images::keep(home, "image/png", b"\x89PNG screenshot").unwrap();
        let stray = images::keep(home, "image/png", b"\x89PNG forgotten").unwrap();
        let b = book(home, "default");
        let mut g = open(&b);
        let mut ended = entry("/s/gone.jsonl", "fixer");
        ended.prompts = vec!["look at the screenshot".into()];
        ended.images = vec![kept.clone()];
        g.entries.insert("t9".into(), ended);
        g.touch();
        assert!(g.save(10, false, 60_000));
        // hostd dies here: what the next daemon reads has the prompt and its images.
        let back = read(&path(home)).sessions.remove("default").unwrap().remove("t9").unwrap();
        assert_eq!(back.prompts, ["look at the screenshot"]);
        assert!(images::load(home, &back.images[0]).is_ok(), "the bytes are on disk, not in memory");
        // Old unreferenced files are swept with the next write; the one the entry names stays.
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        for k in [&kept, &stray] {
            std::fs::File::options().append(true).open(images::dir(home).join(&k.file)).unwrap().set_modified(old).unwrap();
        }
        g.touch();
        assert!(g.save(20, false, 60_000));
        assert!(images::dir(home).join(&kept.file).exists());
        assert!(!images::dir(home).join(&stray.file).exists());
        // The entry goes (its successor replied: omp has the task): its images go too.
        g.entries.clear();
        g.touch();
        assert!(g.save(30, false, 60_000));
        assert!(!images::dir(home).join(&kept.file).exists());
    }
}
