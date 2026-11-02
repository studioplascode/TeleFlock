//! Dictation on tf-dictation (feature `voice`): its model store (`<data_dir>/dictation/`), the
//! downloads, the microphone choice and the recognition sessions.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use serde_json::Value;
use tf_dictation::{
    Event, Session, SessionOpts, VoiceError,
    catalog::{self, DeviceClass, Model},
    mic,
    store::{ChosenMic, Downloader, Store},
};
use tf_proto::{
    ApiError, AppEvent, AppMethod, DictationEvent, DictationLanguage, DictationMicrophone, DictationMicrophones, DictationModel, DictationModelPhase,
    DictationStartParams, DictationState, Empty,
};

use crate::util::{invalid, to_value};

/// Sends the event `make` builds, under the app core's emit lock (in order with the replay).
pub(super) type Emit = Box<dyn Fn(&dyn Fn() -> AppEvent) + Send + Sync>;
/// Where a session reports.
pub(super) type Sink = Box<dyn Fn(Event) + Send + 'static>;
/// Starts listening: tf-dictation's [`Session`] (tests put a fake in). An error means nothing
/// started and no event follows; otherwise `End` always comes last.
pub(super) type Starter = Box<dyn Fn(SessionOpts, Sink) -> Result<Box<dyn Listening>, VoiceError> + Send + Sync>;

/// A running session.
pub(super) trait Listening: Send {
    /// Finish the utterance being spoken, then end.
    fn stop(&self);
    /// End now, dropping it.
    fn cancel(&self);
}

impl Listening for Session {
    fn stop(&self) {
        Session::stop(self);
    }
    fn cancel(&self) {
        Session::cancel(self);
    }
}

/// Removing the chosen model waits this long for its sessions to let go of the files (Windows
/// can't delete a file in use).
const RELEASE_WAIT: Duration = Duration::from_secs(3);

pub(super) struct Dictation {
    data_dir: PathBuf,
    store: Store,
    user_agent: String,
    /// Downloads in progress by model.
    downloads: Mutex<HashMap<&'static str, Download>>,
    /// The last failed download of each model, until the next attempt.
    errors: Mutex<HashMap<&'static str, String>>,
    /// Live sessions by the page's id.
    sessions: Mutex<HashMap<String, Live>>,
    serial: AtomicU64,
    emit: OnceLock<Emit>,
    starter: Starter,
    /// Shut down: nothing new starts.
    closed: AtomicBool,
}

struct Download {
    cancel: Arc<AtomicBool>,
    /// On disk so far.
    bytes: u64,
}

struct Live {
    /// Tells this start apart from a later one under the same id.
    serial: u64,
    /// `None` while it starts (the microphone opening, which may wait for the system's permission
    /// prompt): a stop or cancel meanwhile is kept in `then` and applied once it started.
    session: Option<Box<dyn Listening>>,
    then: Then,
}

/// What a starting session does once it started.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Then {
    Listen,
    Stop,
    Cancel,
}

impl Live {
    fn stop(&mut self) {
        match &self.session {
            Some(s) => s.stop(),
            None if self.then == Then::Listen => self.then = Then::Stop,
            None => {}
        }
    }

    fn cancel(&mut self) {
        match &self.session {
            Some(s) => s.cancel(),
            None => self.then = Then::Cancel,
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn api_error(e: VoiceError) -> ApiError {
    ApiError::new(e.code(), e.to_string())
}

/// Why a session didn't start, with where to grant the microphone when the system refused it.
fn start_error(e: VoiceError) -> ApiError {
    let hint = match &e {
        VoiceError::Permission(_) if cfg!(target_os = "macos") => Some("Allow TeleFlock in System Settings → Privacy & Security → Microphone."),
        VoiceError::Permission(_) if cfg!(windows) => Some("Turn on Settings → Privacy & security → Microphone → Let desktop apps access your microphone."),
        VoiceError::NoModel => Some("Download a speech model in Settings → Dictation."),
        _ => None,
    };
    let err = api_error(e);
    match hint {
        Some(h) => err.with_hint(h),
        None => err,
    }
}

impl Dictation {
    pub(super) fn new(data_dir: &Path, user_agent: String) -> Arc<Self> {
        Self::with_starter(data_dir, user_agent, Box::new(|opts, sink| Session::start(opts, sink).map(|s| Box::new(s) as Box<dyn Listening>)))
    }

    pub(super) fn with_starter(data_dir: &Path, user_agent: String, starter: Starter) -> Arc<Self> {
        Arc::new(Self {
            data_dir: data_dir.to_path_buf(),
            store: Store::new(data_dir),
            user_agent,
            downloads: Mutex::default(),
            errors: Mutex::default(),
            sessions: Mutex::default(),
            serial: AtomicU64::new(0),
            emit: OnceLock::new(),
            starter,
            closed: AtomicBool::new(false),
        })
    }

    /// Where events go; once, at start-up, which also sweeps what the catalog no longer owns (off
    /// the start-up path) and applies the chosen microphone.
    pub(super) fn connect(&self, emit: Emit) {
        if self.emit.set(emit).is_err() {
            return;
        }
        let sweep = Store::new(&self.data_dir);
        let _ = std::thread::Builder::new().name("tf-dictation-sweep".into()).spawn(move || sweep.sweep());
        mic::set_device(self.store.prefs().microphone.map(|m| m.id));
    }

    fn emit(&self, make: &dyn Fn() -> AppEvent) {
        if let Some(emit) = self.emit.get() {
            emit(make);
        }
    }

    fn changed(&self) {
        self.emit(&|| AppEvent::Dictation { state: self.state() });
    }

    pub(super) fn state(&self) -> DictationState {
        let device = DeviceClass::current();
        let downloads: HashMap<&'static str, u64> = lock(&self.downloads).iter().map(|(id, d)| (*id, d.bytes)).collect();
        let errors = lock(&self.errors).clone();
        let prefs = self.store.prefs();
        let models: Vec<DictationModel> = catalog::CATALOG
            .iter()
            .map(|m| {
                let (phase, downloaded) = if let Some(bytes) = downloads.get(m.id) {
                    (DictationModelPhase::Downloading, Some(*bytes))
                } else if self.store.installed(m) {
                    (DictationModelPhase::Installed, None)
                } else {
                    // An interrupted download shows how far it got (Settings offers to resume).
                    (DictationModelPhase::Available, Some(self.store.partial_bytes(m)).filter(|n| *n > 0))
                };
                DictationModel {
                    id: m.id.into(),
                    name: m.name.into(),
                    summary: m.summary.into(),
                    languages: m.languages.into(),
                    language_codes: m.language_codes.iter().map(|c| (*c).to_owned()).collect(),
                    auto_language: m.auto_language,
                    takes_language: m.takes_language(),
                    size: m.size(),
                    ram_mb: m.ram_mb,
                    speed: m.speed,
                    accuracy: m.accuracy,
                    notes: m.notes.into(),
                    recommended: m.recommended_for(device),
                    phase,
                    downloaded,
                    error: errors.get(m.id).cloned(),
                }
            })
            .collect();
        let selected = prefs.selected.filter(|id| models.iter().any(|m| m.id == *id && m.phase == DictationModelPhase::Installed));
        DictationState {
            supported: tf_dictation::ENGINE,
            device: device.as_str().into(),
            models,
            selected,
            language: prefs.language,
            languages: catalog::languages().into_iter().map(|(code, name)| DictationLanguage { code: code.into(), name: name.into() }).collect(),
            engine: tf_dictation::engine_version(),
            microphone: prefs.microphone.map(|m| DictationMicrophone { id: m.id, name: m.name, default: false }),
        }
    }

    pub(super) fn call(self: &Arc<Self>, m: AppMethod) -> Result<Value, ApiError> {
        let model = |id: &str| catalog::find(id).ok_or_else(|| ApiError::new("not_found", format!("no speech model `{id}`")));
        match m {
            AppMethod::DictationModels(_) => {}
            AppMethod::DictationInstall(p) => self.install(model(&p.model_id)?),
            AppMethod::DictationCancelInstall(p) => {
                if let Some(d) = lock(&self.downloads).get(model(&p.model_id)?.id) {
                    d.cancel.store(true, Ordering::Release);
                }
            }
            AppMethod::DictationRemove(p) => self.remove(model(&p.model_id)?)?,
            AppMethod::DictationSelect(p) => {
                if let Some(id) = &p.model_id
                    && !self.store.installed(model(id)?)
                {
                    return Err(invalid("Download the model first"));
                }
                self.store.update_prefs(|prefs| prefs.selected = p.model_id.clone()).map_err(api_error)?;
                self.changed();
            }
            AppMethod::DictationSetLanguage(p) => {
                if !catalog::languages().iter().any(|(c, _)| *c == p.language) {
                    return Err(invalid(format!("unknown language `{}`", p.language)));
                }
                self.store.update_prefs(|prefs| prefs.language = p.language.clone()).map_err(api_error)?;
                self.changed();
            }
            AppMethod::DictationMicrophonesReq(_) => {
                let microphones = mic::devices().map_err(api_error)?.into_iter().map(|m| DictationMicrophone { id: m.id, name: m.name, default: m.default }).collect();
                return to_value(&DictationMicrophones { microphones });
            }
            AppMethod::DictationSetMicrophone(p) => {
                let chosen = match p.id {
                    None => None,
                    Some(id) => {
                        let m = mic::devices().map_err(api_error)?.into_iter().find(|m| m.id == id).ok_or_else(|| invalid("That microphone isn't connected"))?;
                        Some(ChosenMic { id: m.id, name: m.name })
                    }
                };
                self.store.update_prefs(|prefs| prefs.microphone = chosen.clone()).map_err(api_error)?;
                mic::set_device(chosen.map(|c| c.id));
                self.changed();
            }
            AppMethod::DictationStart(p) => {
                self.start_session(p)?;
                return to_value(&Empty {});
            }
            AppMethod::DictationStop(p) => {
                if let Some(l) = lock(&self.sessions).get_mut(&p.session) {
                    l.stop();
                }
                return to_value(&Empty {});
            }
            AppMethod::DictationCancel(p) => {
                if let Some(l) = lock(&self.sessions).get_mut(&p.session) {
                    l.cancel();
                }
                return to_value(&Empty {});
            }
            m => return Err(ApiError::new("unknown_method", format!("{} is not a dictation method", m.name()))),
        }
        to_value(&self.state())
    }

    /// Starts (or resumes) downloading `model` on a thread of its own; the first model installed
    /// becomes the chosen one.
    fn install(self: &Arc<Self>, model: &'static Model) {
        if self.store.installed(model) || self.closed.load(Ordering::Acquire) {
            return;
        }
        let cancel = {
            let mut downloads = lock(&self.downloads);
            if downloads.contains_key(model.id) {
                return;
            }
            let cancel = Arc::new(AtomicBool::new(false));
            downloads.insert(model.id, Download { cancel: Arc::clone(&cancel), bytes: self.store.partial_bytes(model) });
            cancel
        };
        lock(&self.errors).remove(model.id);
        let this = Arc::clone(self);
        let spawned = std::thread::Builder::new().name("tf-dictation-download".into()).spawn(move || {
            let progress = |bytes: u64| {
                if let Some(d) = lock(&this.downloads).get_mut(model.id) {
                    d.bytes = bytes;
                }
                this.changed();
            };
            let result = Downloader::new(&this.user_agent).and_then(|dl| this.store.download(model, &dl, &cancel, &progress));
            lock(&this.downloads).remove(model.id);
            match result {
                Ok(()) => {
                    log::info!("dictation: {} installed", model.id);
                    let chose = this.store.update_prefs(|p| {
                        if p.selected.as_deref().and_then(catalog::find).is_none_or(|m| !this.store.installed(m)) {
                            p.selected = Some(model.id.into());
                        }
                    });
                    if let Err(e) = chose {
                        log::warn!("dictation: choosing {}: {e}", model.id);
                    }
                }
                Err(VoiceError::Cancelled) => log::info!("dictation: download of {} cancelled", model.id),
                Err(e) => {
                    log::warn!("dictation: download of {} failed: {e}", model.id);
                    lock(&this.errors).insert(model.id, e.to_string());
                }
            }
            this.changed();
        });
        if let Err(e) = spawned {
            lock(&self.downloads).remove(model.id);
            lock(&self.errors).insert(model.id, format!("can't start the download: {e}"));
        }
        self.changed();
    }

    /// Deletes `model`. When it was the chosen one, its sessions end first and another installed
    /// model takes over (the one recommended for this device first), else none.
    fn remove(&self, model: &'static Model) -> Result<(), ApiError> {
        if lock(&self.downloads).contains_key(model.id) {
            return Err(ApiError::new("busy", "Cancel the download first"));
        }
        let chosen = self.store.prefs().selected.as_deref() == Some(model.id);
        if chosen {
            self.cancel_sessions();
            let t0 = Instant::now();
            while !lock(&self.sessions).is_empty() && t0.elapsed() < RELEASE_WAIT {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        tf_dictation::unload(model.id);
        let removed = self.store.remove(model).map_err(api_error);
        lock(&self.errors).remove(model.id);
        if chosen && removed.is_ok() {
            let device = DeviceClass::current();
            let installed: Vec<&Model> = catalog::CATALOG.iter().filter(|m| m.id != model.id && self.store.installed(m)).collect();
            if let Some(next) = installed.iter().find(|m| m.recommended_for(device)).or(installed.first()) {
                self.store.update_prefs(|p| p.selected = Some(next.id.into())).map_err(api_error)?;
            }
        }
        self.changed();
        removed
    }

    fn start_session(self: &Arc<Self>, p: DictationStartParams) -> Result<(), ApiError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(ApiError::new("unavailable", "TeleFlock is shutting down"));
        }
        if p.session.is_empty() || p.session.len() > 64 {
            return Err(invalid("a dictation session needs an id of 1–64 characters"));
        }
        let serial = self.serial.fetch_add(1, Ordering::Relaxed);
        {
            let mut sessions = lock(&self.sessions);
            if sessions.contains_key(&p.session) {
                return Err(invalid(format!("dictation session `{}` is running", p.session)));
            }
            // One microphone, one dictation: the one running (or starting) finishes.
            for l in sessions.values_mut() {
                l.stop();
            }
            // Known from now on: a stop, a cancel or a closed page while the microphone opens
            // reaches it once it started.
            sessions.insert(p.session.clone(), Live { serial, session: None, then: Then::Listen });
        }
        let weak = Arc::downgrade(self);
        let id = p.session.clone();
        let sink: Sink = Box::new(move |ev: Event| {
            let Some(this) = weak.upgrade() else { return };
            let event = match ev {
                Event::Listening => DictationEvent::Listening,
                Event::Interim(text) => DictationEvent::Partial { text },
                Event::Final(text) => DictationEvent::Final { text },
                Event::Error(e) => DictationEvent::Error { code: e.code().into(), message: e.to_string() },
                Event::End => {
                    let mut sessions = lock(&this.sessions);
                    if sessions.get(&id).is_some_and(|l| l.serial == serial) {
                        sessions.remove(&id);
                    }
                    DictationEvent::End
                }
            };
            this.emit(&|| AppEvent::DictationSession { session: id.clone(), event: event.clone() });
        });
        let started = (self.starter)(SessionOpts { data_dir: self.data_dir.clone(), locale: p.locale }, sink);
        let mut sessions = lock(&self.sessions);
        match started {
            Ok(session) => {
                // Unless it ended while starting (its `End` forgot it).
                if let Some(live) = sessions.get_mut(&p.session).filter(|l| l.serial == serial) {
                    match live.then {
                        Then::Listen => {}
                        Then::Stop => session.stop(),
                        Then::Cancel => session.cancel(),
                    }
                    live.session = Some(session);
                }
                Ok(())
            }
            Err(e) => {
                if sessions.get(&p.session).is_some_and(|l| l.serial == serial) {
                    sessions.remove(&p.session);
                }
                Err(start_error(e))
            }
        }
    }

    pub(super) fn cancel_sessions(&self) {
        for l in lock(&self.sessions).values_mut() {
            l.cancel();
        }
    }

    pub(super) fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        self.cancel_sessions();
        for d in lock(&self.downloads).values() {
            d.cancel.store(true, Ordering::Release);
        }
    }

    #[cfg(test)]
    pub(super) fn live_sessions(&self) -> Vec<String> {
        let mut ids: Vec<String> = lock(&self.sessions).keys().cloned().collect();
        ids.sort();
        ids
    }

    #[cfg(test)]
    pub(super) fn store(&self) -> &Store {
        &self.store
    }
}
