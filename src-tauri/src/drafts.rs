//! Unsent drafts when the shell ends the process itself.
//!
//! Pages keep what the user typed or attached and hasn't sent in browser storage (text in
//! localStorage with an IndexedDB copy, images, large pastes and uploaded videos' references in
//! IndexedDB: `src/core/drafts.ts`, `mirrored.ts`, `draftSlots.ts`, `draftVideos.ts`; Quick
//! capture's box likewise) and write it shortly after each change (text after a 300 ms pause in
//! typing) and when they are hidden. No page code runs when the shell ends the process: an
//! update's restart, the Windows installer (which exits the process), Quit (the AppImage installs
//! a waiting update then), the Android installer (the system kills the app to replace it). Before
//! each of those the shell asks every page that listens (`drafts_listen`) to write out everything
//! now (`src/core/draftFlush.ts`: resolved once IndexedDB has it) and waits for each answer
//! (`drafts_flushed`), at most [`FLUSH_TIMEOUT`]: a page that doesn't answer never holds an update
//! or a quit up for longer.
//!
//! What can't be written out, a video upload in flight (the page reads the picked file only while
//! it lives), the page reports instead (`drafts_busy`): an automatic update waits while any page
//! holds such work, as it does while the user is in front.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Runtime, Webview};
use tokio::sync::oneshot;

/// The request pages listen for; its payload is the request's id.
pub const FLUSH_EVENT: &str = "tf-drafts://flush";

/// How long the shell waits for the pages' answers. A page waits at most 1.5 s of that for draft
/// work in flight, such as an image being read (`WORK_WAIT_MS` in `src/core/draftFlush.ts`).
pub const FLUSH_TIMEOUT: Duration = Duration::from_secs(3);

/// Which pages answer flush requests, and which requests wait for which pages.
#[derive(Default)]
pub struct Drafts {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Webview labels whose page said it answers (since that page loaded).
    listening: BTreeSet<String>,
    /// Webview labels whose page holds work a restart would lose (an upload in flight).
    busy: BTreeSet<String>,
    next: u64,
    open: HashMap<u64, Open>,
}

struct Open {
    /// Pages that still owe an answer.
    left: BTreeSet<String>,
    done: Option<oneshot::Sender<()>>,
}

/// How a flush ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Flushed {
    /// Every page asked answered; 0 when none listens.
    Saved { pages: usize },
    /// These pages didn't answer within the timeout.
    TimedOut { missing: Vec<String> },
    /// The request couldn't be sent to the pages.
    NotSent(String),
}

impl Drafts {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The page of webview `label` answers flush requests from now on (`drafts_listen`).
    pub fn listen(&self, label: &str) {
        self.lock().listening.insert(label.to_owned());
    }

    /// The page of webview `label` starts loading: it doesn't answer until it says so again, no
    /// request waits for it any longer (its old page wrote its drafts when it unloaded), and the
    /// work it held is gone with it.
    pub fn page_loading(&self, label: &str) {
        let mut inner = self.lock();
        inner.listening.remove(label);
        inner.busy.remove(label);
        let ids: Vec<u64> = inner.open.keys().copied().collect();
        for id in ids {
            inner.answered(id, label);
        }
    }

    /// The page of webview `label` wrote out its drafts for request `id` (`drafts_flushed`).
    pub fn answered(&self, id: u64, label: &str) {
        self.lock().answered(id, label);
    }

    /// The page of webview `label` holds work a restart would lose, or no longer does (`drafts_busy`).
    pub fn set_busy(&self, label: &str, busy: bool) {
        let mut inner = self.lock();
        if busy {
            inner.busy.insert(label.to_owned());
        } else {
            inner.busy.remove(label);
        }
    }

    /// Some page holds work a restart would lose: an automatic update waits (`update::Updater`).
    pub fn busy(&self) -> bool {
        !self.lock().busy.is_empty()
    }

    /// Asks the pages that listen, among the webviews in `live`, to write out their drafts: `emit`
    /// sends the request with its id. Resolves once each of them answered, or after `timeout`.
    pub async fn flush(&self, live: impl IntoIterator<Item = String>, emit: impl FnOnce(u64) -> Result<(), String>, timeout: Duration) -> Flushed {
        let (id, pages, rx) = {
            let mut inner = self.lock();
            let live: BTreeSet<String> = live.into_iter().collect();
            let left: BTreeSet<String> = inner.listening.intersection(&live).cloned().collect();
            if left.is_empty() {
                return Flushed::Saved { pages: 0 };
            }
            inner.next += 1;
            let id = inner.next;
            let (tx, rx) = oneshot::channel();
            let pages = left.len();
            inner.open.insert(id, Open { left, done: Some(tx) });
            (id, pages, rx)
        };
        if let Err(e) = emit(id) {
            self.lock().open.remove(&id);
            return Flushed::NotSent(e);
        }
        let answered = matches!(tokio::time::timeout(timeout, rx).await, Ok(Ok(())));
        let left = self.lock().open.remove(&id).map(|o| o.left).unwrap_or_default();
        if answered { Flushed::Saved { pages } } else { Flushed::TimedOut { missing: left.into_iter().collect() } }
    }
}

impl Inner {
    fn answered(&mut self, id: u64, label: &str) {
        if let Some(open) = self.open.get_mut(&id)
            && open.left.remove(label)
            && open.left.is_empty()
            && let Some(done) = open.done.take()
        {
            let _ = done.send(());
        }
    }
}

/// Asks every page that listens to write out its unsent drafts and waits for the answers, at most
/// [`FLUSH_TIMEOUT`]. `before` names what follows, for the log.
pub async fn flush<R: Runtime>(app: &AppHandle<R>, before: &str) {
    let Some(drafts) = app.try_state::<Drafts>() else { return };
    let live: Vec<String> = app.webview_windows().into_keys().collect();
    let started = Instant::now();
    match drafts.flush(live, |id| app.emit(FLUSH_EVENT, id).map_err(|e| e.to_string()), FLUSH_TIMEOUT).await {
        Flushed::Saved { pages } => log::info!("drafts: {pages} page(s) saved their drafts before {before} ({} ms)", started.elapsed().as_millis()),
        Flushed::TimedOut { missing } => log::warn!("drafts: {missing:?} didn't save their drafts within {FLUSH_TIMEOUT:?}; going on with {before}"),
        Flushed::NotSent(e) => log::warn!("drafts: couldn't ask the pages to save their drafts before {before}: {e}"),
    }
}

/// Quit (the tray menu): the pages write out their drafts first, then the app exits
/// (`RunEvent::Exit`, where the AppImage installs a waiting update).
#[cfg(desktop)]
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        flush(&app, "quitting").await;
        app.exit(0);
    });
}

/// The page answers flush requests ([`FLUSH_EVENT`]) from now on.
#[tauri::command]
pub fn drafts_listen<R: Runtime>(webview: Webview<R>, drafts: tauri::State<'_, Drafts>) {
    drafts.listen(webview.label());
}

/// The page wrote out its drafts for request `id`.
#[tauri::command]
pub fn drafts_flushed<R: Runtime>(webview: Webview<R>, drafts: tauri::State<'_, Drafts>, id: u64) {
    drafts.answered(id, webview.label());
}

/// The page holds work a restart would lose (a video upload in flight), or no longer does. While a
/// page does, an automatic update waits as if the user were in front (`update::Updater::in_front`).
#[tauri::command]
pub fn drafts_busy<R: Runtime>(webview: Webview<R>, drafts: tauri::State<'_, Drafts>, busy: bool) {
    drafts.set_busy(webview.label(), busy);
    #[cfg(desktop)]
    if let Some(u) = webview.try_state::<crate::update::UpdaterState>() {
        if busy { u.active() } else { u.left_front() }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    const TIMEOUT: Duration = Duration::from_millis(150);

    fn run<F: Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    fn labels(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| (*s).to_owned()).collect()
    }

    /// The pages answer through the event loop, after the request went out: here 30 ms later.
    fn answer_later(drafts: &Arc<Drafts>, id: u64, label: &'static str) {
        let drafts = Arc::clone(drafts);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            drafts.answered(id, label);
        });
    }

    #[test]
    fn the_wait_ends_when_every_listening_page_has_answered() {
        let drafts = Arc::new(Drafts::default());
        drafts.listen("main");
        drafts.listen("capture");
        let started = Instant::now();
        let out = run(drafts.flush(labels(&["main", "capture"]), |id| {
            answer_later(&drafts, id, "main");
            answer_later(&drafts, id, "capture");
            Ok(())
        }, Duration::from_secs(5)));
        assert_eq!(out, Flushed::Saved { pages: 2 });
        assert!(started.elapsed() < Duration::from_secs(1), "no waiting for the timeout");
    }

    #[test]
    fn a_page_that_never_answers_holds_the_wait_up_only_until_the_timeout() {
        let drafts = Arc::new(Drafts::default());
        drafts.listen("main");
        drafts.listen("capture");
        let started = Instant::now();
        let out = run(drafts.flush(labels(&["main", "capture"]), |id| {
            answer_later(&drafts, id, "main");
            Ok(())
        }, TIMEOUT));
        assert_eq!(out, Flushed::TimedOut { missing: labels(&["capture"]) });
        assert!(started.elapsed() >= TIMEOUT);
        assert!(started.elapsed() < TIMEOUT * 4);
    }

    /// Nothing waits for windows without a page that listens (one still loading, a capture
    /// window never opened, a webview whose script failed), nor for a page whose window is gone.
    #[test]
    fn only_listening_pages_of_existing_windows_are_waited_for() {
        let drafts = Drafts::default();
        drafts.listen("gone");
        let mut emitted = false;
        let out = run(drafts.flush(labels(&["main"]), |_| {
            emitted = true;
            Ok(())
        }, Duration::from_secs(5)));
        assert_eq!(out, Flushed::Saved { pages: 0 });
        assert!(!emitted, "no request without a page to answer it");
    }

    #[test]
    fn a_page_that_reloads_stops_listening_and_no_longer_holds_a_request() {
        let drafts = Arc::new(Drafts::default());
        drafts.listen("main");
        let started = Instant::now();
        let out = run(drafts.flush(labels(&["main"]), |_| {
            let drafts = Arc::clone(&drafts);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                drafts.page_loading("main");
            });
            Ok(())
        }, Duration::from_secs(5)));
        assert_eq!(out, Flushed::Saved { pages: 1 });
        assert!(started.elapsed() < Duration::from_secs(1));
        let out = run(drafts.flush(labels(&["main"]), |_| Ok(()), Duration::from_secs(5)));
        assert_eq!(out, Flushed::Saved { pages: 0 }, "not listening again until the new page says so");
    }

    #[test]
    fn answers_to_other_requests_or_from_pages_not_asked_count_for_nothing() {
        let drafts = Arc::new(Drafts::default());
        drafts.listen("main");
        let out = run(drafts.flush(labels(&["main"]), |id| {
            drafts.answered(id + 1, "main");
            drafts.answered(id, "capture");
            Ok(())
        }, TIMEOUT));
        assert_eq!(out, Flushed::TimedOut { missing: labels(&["main"]) });
    }

    #[test]
    fn a_request_that_cannot_be_sent_is_not_waited_for() {
        let drafts = Drafts::default();
        drafts.listen("main");
        let started = Instant::now();
        let out = run(drafts.flush(labels(&["main"]), |_| Err("no event loop".into()), Duration::from_secs(5)));
        assert_eq!(out, Flushed::NotSent("no event loop".into()));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    /// An upload in flight holds an automatic update until it ends, or until its page reloads
    /// (the upload went with the old page).
    #[test]
    fn work_in_flight_counts_until_it_ends_or_its_page_reloads() {
        let drafts = Drafts::default();
        assert!(!drafts.busy());
        drafts.set_busy("main", true);
        drafts.set_busy("capture", true);
        drafts.set_busy("capture", false);
        assert!(drafts.busy(), "the main page's upload still runs");
        drafts.page_loading("main");
        assert!(!drafts.busy());
    }
}
