//! Background full-text searches over the host's omp session files (`search.start` / `poll` /
//! `cancel`, architecture §3.27).
//!
//! A search runs on the blocking pool, one file after another, newest first, and publishes each
//! matching session as it is found; requests only read its state, so no request ever waits on a
//! file. Polls are long polls: they answer as soon as there are hits the client lacks or the
//! search has ended, else after `waitMs`.
//!
//! **Caps.** A search ends after [`TIME_MAX`] or [`BYTES_MAX`] read or `limit` matching
//! sessions, whichever comes first (`SearchPage.stopped` says which). A client runs one search
//! at a time (a new one supersedes it), the daemon at most [`RUNNING_MAX`] (the oldest gives way).
//! **Cancellation.** `search.cancel`, the client disconnecting, or nobody polling for
//! [`IDLE_MAX`] stop it within one check (every 256 lines); ended searches are forgotten
//! [`KEEP_MAX`] after their last poll.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tf_proto::{PastSession, SearchPage, SearchStop, SessionSearchHit};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::scan::{scan_file, Budget};
use super::text::Needle;

pub const TIME_MAX: Duration = Duration::from_secs(20);
pub const BYTES_MAX: u64 = 2 << 30;
pub const LIMIT_DEFAULT: usize = 100;
pub const LIMIT_MAX: usize = 500;
pub const RUNNING_MAX: usize = 4;
pub const IDLE_MAX: Duration = Duration::from_secs(30);
pub const KEEP_MAX: Duration = Duration::from_secs(60);
pub const WAIT_MAX: Duration = Duration::from_secs(10);

/// One session file to search, with what the Past sessions list shows of it.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub path: PathBuf,
    pub session: PastSession,
}

/// What a search was asked for.
pub struct Spec {
    pub needle: Needle,
    pub limit: usize,
    /// Session files, newest first (resolved lazily: listing and reading headers runs on the
    /// search's thread too).
    pub files: Box<dyn FnOnce() -> Vec<Candidate> + Send>,
    pub time: Duration,
    pub bytes: u64,
    /// True once the requesting client is gone.
    pub client_gone: Box<dyn Fn() -> bool + Send + Sync>,
}

#[derive(Default)]
struct State {
    hits: Vec<SessionSearchHit>,
    files: u32,
    files_total: u32,
    bytes: u64,
    done: bool,
    stopped: Option<SearchStop>,
    elapsed: Duration,
}

struct Job {
    id: String,
    owner: String,
    started: Instant,
    cancel: CancellationToken,
    state: Mutex<State>,
    /// Bumped on every new hit and when the search ends.
    changed: watch::Sender<u64>,
    last_poll: Mutex<Instant>,
}

impl Job {
    fn page(&self, after: usize) -> SearchPage {
        let st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        SearchPage {
            search_id: self.id.clone(),
            hits: st.hits.iter().skip(after).cloned().collect(),
            total: st.hits.len() as u32,
            files: st.files,
            files_total: st.files_total,
            bytes: st.bytes,
            elapsed_ms: if st.done { st.elapsed } else { self.started.elapsed() }.as_millis() as u64,
            done: st.done,
            stopped: st.stopped,
        }
    }

    fn ready(&self, after: usize) -> bool {
        let st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        st.done || st.hits.len() > after
    }

    fn done(&self) -> bool {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).done
    }

    fn idle(&self) -> Duration {
        self.last_poll.lock().unwrap_or_else(|p| p.into_inner()).elapsed()
    }

    fn touch(&self) {
        *self.last_poll.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
    }
}

/// The daemon's searches.
#[derive(Default)]
pub struct Searches {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    seq: AtomicU64,
}

impl Searches {
    /// Starts a search for client `owner` (its earlier searches stop) and answers with its
    /// first page, after up to `wait`.
    pub async fn start(&self, owner: &str, spec: Spec, wait: Duration) -> SearchPage {
        let id = format!("s{}-{}", std::process::id(), self.seq.fetch_add(1, Ordering::Relaxed) + 1);
        let (changed, _) = watch::channel(0);
        let job = Arc::new(Job {
            id: id.clone(),
            owner: owner.to_owned(),
            started: Instant::now(),
            cancel: CancellationToken::new(),
            state: Mutex::new(State::default()),
            changed,
            last_poll: Mutex::new(Instant::now()),
        });
        {
            let mut jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
            jobs.retain(|_, j| !(j.done() && j.idle() > KEEP_MAX));
            for j in jobs.values().filter(|j| j.owner == owner) {
                j.cancel.cancel();
            }
            let mut running: Vec<&Arc<Job>> = jobs.values().filter(|j| !j.done() && !j.cancel.is_cancelled()).collect();
            running.sort_by_key(|j| j.started);
            let over = (running.len() + 1).saturating_sub(RUNNING_MAX);
            for j in running.into_iter().take(over) {
                j.cancel.cancel();
            }
            jobs.insert(id.clone(), job.clone());
        }
        let worker = job.clone();
        tokio::task::spawn_blocking(move || run(&worker, spec));
        self.wait(&job, 0, wait).await
    }

    /// The hits after `after` (waiting up to `wait` for some or the end); `None` for an unknown
    /// or forgotten search.
    pub async fn poll(&self, id: &str, after: usize, wait: Duration) -> Option<SearchPage> {
        let job = self.jobs.lock().unwrap_or_else(|p| p.into_inner()).get(id).cloned()?;
        Some(self.wait(&job, after, wait).await)
    }

    /// Stops a search (it stays readable until forgotten). False when unknown.
    pub fn cancel(&self, id: &str) -> bool {
        match self.jobs.lock().unwrap_or_else(|p| p.into_inner()).get(id) {
            Some(j) => {
                j.cancel.cancel();
                j.touch();
                true
            }
            None => false,
        }
    }

    async fn wait(&self, job: &Arc<Job>, after: usize, wait: Duration) -> SearchPage {
        job.touch();
        let mut rx = job.changed.subscribe();
        let deadline = tokio::time::Instant::now() + wait.min(WAIT_MAX);
        while !job.ready(after) {
            if tokio::time::timeout_at(deadline, rx.changed()).await.is_err() {
                break;
            }
        }
        job.touch();
        job.page(after)
    }
}

/// The search itself (blocking pool).
fn run(job: &Arc<Job>, spec: Spec) {
    let Spec { needle, limit, files, time, bytes, client_gone } = spec;
    let watched = job.clone();
    let mut budget = Budget {
        deadline: job.started + time,
        bytes_left: bytes,
        cancelled: Box::new(move || watched.cancel.is_cancelled() || client_gone() || watched.idle() > IDLE_MAX),
    };
    let candidates = files();
    set(job, |st| st.files_total = candidates.len() as u32);
    let mut pf = needle.prefilter();
    let mut stopped = None;
    for c in candidates {
        if let Err(stop) = budget.check() {
            stopped = Some(stop);
            break;
        }
        let before = budget.bytes_left;
        let (result, stop) = match scan_file(&c.path, &needle, &mut pf, &mut budget) {
            Ok(m) => (m, None),
            Err((stop, m)) => (m, Some(stop)),
        };
        let read = before - budget.bytes_left;
        let hit = result.matches > 0 && result.messages != Some(0);
        set(job, |st| {
            st.files += u32::from(stop.is_none());
            st.bytes += read;
            if hit {
                let mut session = c.session.clone();
                if result.messages.is_some() {
                    session.messages = result.messages;
                }
                st.hits.push(SessionSearchHit { session, matches: result.matches, snippets: result.snippets });
            }
        });
        if hit {
            job.changed.send_modify(|v| *v += 1);
        }
        if let Some(stop) = stop {
            stopped = Some(stop);
            break;
        }
        if job.state.lock().unwrap_or_else(|p| p.into_inner()).hits.len() >= limit {
            stopped = Some(SearchStop::Hits);
            break;
        }
    }
    if stopped.is_none() && (budget.cancelled)() && job.state.lock().unwrap_or_else(|p| p.into_inner()).files_total == 0 {
        // Cancelled while listing an empty folder: say so rather than "nothing found".
        stopped = Some(SearchStop::Cancelled);
    }
    let elapsed = job.started.elapsed();
    set(job, |st| {
        st.done = true;
        st.stopped = stopped;
        st.elapsed = elapsed;
    });
    job.changed.send_modify(|v| *v += 1);
    tracing::debug!(search = %job.id, files = job.page(usize::MAX).files, ?stopped, ms = elapsed.as_millis() as u64, "session search ended");
}

fn set(job: &Job, f: impl FnOnce(&mut State)) {
    f(&mut job.state.lock().unwrap_or_else(|p| p.into_inner()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::find::scan::tests::session_lines;
    use std::sync::atomic::AtomicBool;

    /// `n` session files (newest first), `word` in every `every`-th one.
    fn files(dir: &std::path::Path, n: usize, every: usize, word: &str) -> Vec<Candidate> {
        (0..n)
            .map(|i| {
                let path = dir.join(format!("s{i}.jsonl"));
                let w = if i % every == 0 { word } else { "other" };
                std::fs::write(&path, session_lines(&format!("id{i}"), "/w", w).join("\n")).unwrap();
                let session = PastSession { file: path.display().to_string(), id: format!("id{i}"), title: None, cwd: Some("/w".into()), updated_at: 0, messages: None, live: false, agent_id: None };
                Candidate { path, session }
            })
            .collect()
    }

    fn spec(word: &str, list: Vec<Candidate>, limit: usize) -> Spec {
        Spec { needle: Needle::new(word, false).unwrap(), limit, files: Box::new(move || list), time: TIME_MAX, bytes: BYTES_MAX, client_gone: Box::new(|| false) }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hits_stream_in_and_polls_read_on() {
        let dir = tempfile::tempdir().unwrap();
        let s = Searches::default();
        let page = s.start("c1", spec("gizmo", files(dir.path(), 12, 3, "Gizmo"), 100), Duration::from_secs(5)).await;
        assert!(!page.hits.is_empty(), "the first page waits for a hit");
        let mut all = page.hits.clone();
        let mut last = page;
        while !last.done {
            last = s.poll(&last.search_id, all.len(), Duration::from_secs(5)).await.unwrap();
            all.extend(last.hits.iter().cloned());
        }
        assert_eq!(all.iter().map(|h| h.session.id.as_str()).collect::<Vec<_>>(), ["id0", "id3", "id6", "id9"]);
        assert_eq!((last.total, last.files, last.files_total, last.stopped), (4, 12, 12, None));
        assert!(all.iter().all(|h| h.matches == 5 && h.snippets.len() == 3 && h.session.messages == Some(3)));
        // A finished search stays readable; an unknown one is not.
        assert_eq!(s.poll(&last.search_id, 0, Duration::ZERO).await.unwrap().total, 4);
        assert!(s.poll("s-nope", 0, Duration::ZERO).await.is_none());
    }

    /// Polls until the search has ended; the last page (with every hit's count in `total`).
    async fn finish(s: &Searches, mut p: SearchPage) -> SearchPage {
        while !p.done {
            p = s.poll(&p.search_id, p.total as usize, Duration::from_secs(5)).await.unwrap();
        }
        p
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn caps_end_a_search() {
        let dir = tempfile::tempdir().unwrap();
        let list = files(dir.path(), 10, 1, "gizmo");
        let s = Searches::default();
        let p = finish(&s, s.start("c1", spec("gizmo", list.clone(), 2), Duration::from_secs(5)).await).await;
        assert_eq!((p.stopped, p.total), (Some(SearchStop::Hits), 2));
        // One byte: the first file is read (budget is checked between lines), then nothing more.
        let p = finish(&s, s.start("c2", Spec { bytes: 1, ..spec("gizmo", list.clone(), 100) }, Duration::from_secs(5)).await).await;
        assert_eq!((p.stopped, p.files, p.total), (Some(SearchStop::Bytes), 1, 1));
        let p = finish(&s, s.start("c3", Spec { time: Duration::ZERO, ..spec("gizmo", list, 100) }, Duration::from_secs(5)).await).await;
        assert_eq!((p.stopped, p.files, p.total), (Some(SearchStop::Time), 0, 0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_supersede_and_a_gone_client_stop_it() {
        let dir = tempfile::tempdir().unwrap();
        let list = files(dir.path(), 4, 1, "gizmo");
        let s = Searches::default();
        // The file list takes a while: the search is still running when it is cancelled.
        let slow = |list: Vec<Candidate>| -> Box<dyn FnOnce() -> Vec<Candidate> + Send> {
            Box::new(move || {
                std::thread::sleep(Duration::from_millis(300));
                list
            })
        };
        let p = s.start("c1", Spec { files: slow(list.clone()), ..spec("gizmo", vec![], 100) }, Duration::ZERO).await;
        assert!(!p.done);
        assert!(s.cancel(&p.search_id));
        let p = s.poll(&p.search_id, 0, Duration::from_secs(5)).await.unwrap();
        assert_eq!((p.done, p.stopped, p.total), (true, Some(SearchStop::Cancelled), 0));
        assert!(!s.cancel("s-nope"));
        // A client's next search supersedes its running one.
        let first = s.start("c1", Spec { files: slow(list.clone()), ..spec("gizmo", vec![], 100) }, Duration::ZERO).await;
        let second = s.start("c1", spec("gizmo", list.clone(), 100), Duration::from_secs(5)).await;
        let first = s.poll(&first.search_id, 0, Duration::from_secs(5)).await.unwrap();
        assert_eq!(first.stopped, Some(SearchStop::Cancelled));
        assert_ne!(second.stopped, Some(SearchStop::Cancelled));
        // The client disconnecting stops its search too.
        let gone = Arc::new(AtomicBool::new(false));
        let flag = gone.clone();
        let p = s.start("c2", Spec { files: slow(list), client_gone: Box::new(move || flag.load(Ordering::Relaxed)), ..spec("gizmo", vec![], 100) }, Duration::ZERO).await;
        gone.store(true, Ordering::Relaxed);
        let p = s.poll(&p.search_id, 0, Duration::from_secs(5)).await.unwrap();
        assert_eq!((p.done, p.stopped), (true, Some(SearchStop::Cancelled)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_daemon_runs_a_bounded_number_of_searches() {
        let s = Searches::default();
        let mut ids = Vec::new();
        for i in 0..RUNNING_MAX + 1 {
            let files: Box<dyn FnOnce() -> Vec<Candidate> + Send> = Box::new(|| {
                std::thread::sleep(Duration::from_millis(300));
                vec![]
            });
            ids.push(s.start(&format!("c{i}"), Spec { files, ..spec("x", vec![], 1) }, Duration::ZERO).await.search_id);
        }
        let oldest = s.poll(&ids[0], 0, Duration::from_secs(5)).await.unwrap();
        assert_eq!(oldest.stopped, Some(SearchStop::Cancelled), "the oldest gave way");
        let newest = s.poll(&ids[RUNNING_MAX], 0, Duration::from_secs(5)).await.unwrap();
        assert_eq!((newest.done, newest.stopped), (true, None));
    }
}
