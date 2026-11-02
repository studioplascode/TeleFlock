//! `dictation.*` over a fake recognition engine (sessions) and fake model files (sparse, the
//! catalog's sizes): what the app core adds to tf-dictation.

use std::{
    fs,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use serde_json::{Value, json};
use tf_dictation::{Event, SessionOpts, VoiceError, catalog, store::Store};
use tf_proto::{ApiError, AppEvent, AppMethod, DictationEvent, DictationMicrophones, DictationModelPhase, DictationState};

use super::voice::{Dictation, Listening, Sink, Starter};

#[derive(Default)]
struct Told {
    stops: AtomicUsize,
    cancels: AtomicUsize,
}

struct FakeSession(Arc<Told>);

impl Listening for FakeSession {
    fn stop(&self) {
        self.0.stops.fetch_add(1, Ordering::SeqCst);
    }
    fn cancel(&self) {
        self.0.cancels.fetch_add(1, Ordering::SeqCst);
    }
}

/// Starts sessions the way tf-dictation does (`listening` before the start returns), and lets the
/// test speak through them.
#[derive(Default)]
struct FakeEngine {
    started: Mutex<Vec<(SessionOpts, Sink, Arc<Told>)>>,
    /// The next start fails with this (nothing started).
    fail: Mutex<Option<VoiceError>>,
    /// Sessions fail and end before their start returns (a model the engine can't load).
    end_at_once: AtomicBool,
    /// Runs in the next start while the microphone opens (calls that cross a start).
    while_starting: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl FakeEngine {
    fn starter(self: &Arc<Self>) -> Starter {
        let me = Arc::clone(self);
        Box::new(move |opts, sink| {
            if let Some(e) = me.fail.lock().unwrap().take() {
                return Err(e);
            }
            let meanwhile = me.while_starting.lock().unwrap().take();
            if let Some(f) = meanwhile {
                f();
            }
            sink(Event::Listening);
            if me.end_at_once.load(Ordering::SeqCst) {
                sink(Event::Error(VoiceError::Model("the speech engine couldn't load it".into())));
                sink(Event::End);
            }
            let told = Arc::new(Told::default());
            me.started.lock().unwrap().push((opts, sink, Arc::clone(&told)));
            Ok(Box::new(FakeSession(told)))
        })
    }

    /// Session `n` (in start order) reports `ev`.
    fn say(&self, n: usize, ev: Event) {
        let started = self.started.lock().unwrap();
        (started[n].1)(ev);
    }

    fn told(&self, n: usize) -> (usize, usize) {
        let t = &self.started.lock().unwrap()[n].2;
        (t.stops.load(Ordering::SeqCst), t.cancels.load(Ordering::SeqCst))
    }
}

type Events = Arc<Mutex<Vec<AppEvent>>>;

fn dictation(dir: &Path, engine: &Arc<FakeEngine>) -> (Arc<Dictation>, Events) {
    let d = Dictation::with_starter(dir, "TeleFlock/test (linux)".into(), engine.starter());
    let events: Events = Arc::default();
    let sink = Arc::clone(&events);
    d.connect(Box::new(move |make: &dyn Fn() -> AppEvent| sink.lock().unwrap().push(make())));
    (d, events)
}

fn call(d: &Arc<Dictation>, method: &str, params: Value) -> Result<Value, ApiError> {
    d.call(AppMethod::parse(method, params)?)
}

fn state(d: &Arc<Dictation>, method: &str, params: Value) -> Result<DictationState, ApiError> {
    call(d, method, params).map(|v| serde_json::from_value(v).unwrap())
}

fn session_events(events: &Events, id: &str) -> Vec<DictationEvent> {
    events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            AppEvent::DictationSession { session, event } if session == id => Some(event.clone()),
            _ => None,
        })
        .collect()
}

fn last_state(events: &Events) -> DictationState {
    events
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find_map(|e| match e {
            AppEvent::Dictation { state } => Some(state.clone()),
            _ => None,
        })
        .expect("a dictation state event")
}

/// A model's files as the catalog pins them (sparse: sizes only), marked complete.
fn install_fake(store: &Store, id: &str) {
    let m = catalog::find(id).unwrap();
    let dir = store.model_dir(m);
    fs::create_dir_all(&dir).unwrap();
    for f in m.files {
        fs::File::create(dir.join(f.name)).unwrap().set_len(f.size).unwrap();
    }
    fs::write(dir.join(".complete"), m.commit).unwrap();
}

#[test]
fn a_session_reports_under_the_page_id_and_forgets_itself_at_its_end() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(FakeEngine::default());
    let (d, events) = dictation(dir.path(), &engine);

    call(&d, "dictation.start", json!({ "session": "s1", "locale": "de-DE" })).unwrap();
    {
        let started = engine.started.lock().unwrap();
        assert_eq!(started[0].0.locale.as_deref(), Some("de-DE"));
        assert_eq!(started[0].0.data_dir, dir.path());
    }
    assert_eq!(d.live_sessions(), ["s1"]);
    engine.say(0, Event::Interim("Hallo".into()));
    engine.say(0, Event::Final("Hallo Welt.".into()));
    engine.say(0, Event::End);
    assert_eq!(
        session_events(&events, "s1"),
        [
            DictationEvent::Listening,
            DictationEvent::Partial { text: "Hallo".into() },
            DictationEvent::Final { text: "Hallo Welt.".into() },
            DictationEvent::End,
        ]
    );
    assert!(d.live_sessions().is_empty());
    // A stop that crosses the end is a no-op, not an error.
    call(&d, "dictation.stop", json!({ "session": "s1" })).unwrap();
    assert_eq!(engine.told(0), (0, 0));
}

#[test]
fn stop_and_cancel_reach_the_running_session() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(FakeEngine::default());
    let (d, _) = dictation(dir.path(), &engine);
    call(&d, "dictation.start", json!({ "session": "s1" })).unwrap();
    call(&d, "dictation.stop", json!({ "session": "s1" })).unwrap();
    assert_eq!(engine.told(0), (1, 0));
    call(&d, "dictation.cancel", json!({ "session": "s1" })).unwrap();
    assert_eq!(engine.told(0), (1, 1));
    call(&d, "dictation.cancel", json!({ "session": "other" })).unwrap();
}

#[test]
fn one_dictation_at_a_time_and_ids_are_not_shared() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(FakeEngine::default());
    let (d, events) = dictation(dir.path(), &engine);
    call(&d, "dictation.start", json!({ "session": "a" })).unwrap();
    assert_eq!(call(&d, "dictation.start", json!({ "session": "a" })).unwrap_err().code, "invalid_params");
    assert_eq!(call(&d, "dictation.start", json!({ "session": "" })).unwrap_err().code, "invalid_params");
    // Another composer's mic: the first dictation finishes what is being said.
    call(&d, "dictation.start", json!({ "session": "b" })).unwrap();
    assert_eq!(engine.told(0), (1, 0));
    assert_eq!(d.live_sessions(), ["a", "b"]);
    engine.say(0, Event::Final("last words".into()));
    engine.say(0, Event::End);
    assert_eq!(d.live_sessions(), ["b"]);
    assert_eq!(session_events(&events, "a").last(), Some(&DictationEvent::End));
    assert_eq!(session_events(&events, "b"), [DictationEvent::Listening]);
}

#[test]
fn a_session_that_ends_while_starting_is_not_kept() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(FakeEngine::default());
    engine.end_at_once.store(true, Ordering::SeqCst);
    let (d, events) = dictation(dir.path(), &engine);
    call(&d, "dictation.start", json!({ "session": "s1" })).unwrap();
    assert!(d.live_sessions().is_empty());
    let got = session_events(&events, "s1");
    assert!(matches!(&got[..], [DictationEvent::Listening, DictationEvent::Error { code, .. }, DictationEvent::End] if code == "model"), "{got:?}");
    // The id is free again.
    engine.end_at_once.store(false, Ordering::SeqCst);
    call(&d, "dictation.start", json!({ "session": "s1" })).unwrap();
    assert_eq!(d.live_sessions(), ["s1"]);
}

#[test]
fn a_start_that_fails_says_why_and_nothing_follows() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(FakeEngine::default());
    *engine.fail.lock().unwrap() = Some(VoiceError::Permission("the user said no".into()));
    let (d, events) = dictation(dir.path(), &engine);
    let err = call(&d, "dictation.start", json!({ "session": "s1" })).unwrap_err();
    assert_eq!(err.code, "permission");
    assert!(session_events(&events, "s1").is_empty());
    assert!(d.live_sessions().is_empty());

    // The real engine without a model: refused before the microphone opens.
    let real = Dictation::new(dir.path(), "TeleFlock/test (linux)".into());
    let err = real.call(AppMethod::parse("dictation.start", json!({ "session": "s2" })).unwrap()).unwrap_err();
    assert_eq!((err.code.as_str(), err.hint.as_deref()), ("no_model", Some("Download a speech model in Settings → Dictation.")));
}

#[test]
fn a_closed_page_takes_its_sessions_along() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(FakeEngine::default());
    let (d, _) = dictation(dir.path(), &engine);
    call(&d, "dictation.start", json!({ "session": "s1" })).unwrap();
    d.cancel_sessions();
    assert_eq!(engine.told(0), (0, 1));
    d.shutdown();
    assert_eq!(call(&d, "dictation.start", json!({ "session": "s2" })).unwrap_err().code, "unavailable");
}

/// The next start runs `f` while the microphone opens: a call that crosses the start.
fn meanwhile(engine: &FakeEngine, d: &Arc<Dictation>, f: impl FnOnce(&Arc<Dictation>) + Send + 'static) {
    let page = Arc::downgrade(d);
    *engine.while_starting.lock().unwrap() = Some(Box::new(move || f(&page.upgrade().unwrap())));
}

/// Calls that cross a start (the microphone opening can wait for the system's permission prompt):
/// a quick second tap, a page closing, another composer's mic. Each reaches the session once it
/// started, so no microphone stays open with nobody listening.
#[test]
fn what_crosses_a_start_reaches_the_session_once_it_started() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(FakeEngine::default());
    let (d, _) = dictation(dir.path(), &engine);

    meanwhile(&engine, &d, |d| {
        call(d, "dictation.stop", json!({ "session": "s1" })).unwrap();
    });
    call(&d, "dictation.start", json!({ "session": "s1" })).unwrap();
    assert_eq!(engine.told(0), (1, 0));
    engine.say(0, Event::End);

    meanwhile(&engine, &d, |d| d.cancel_sessions());
    call(&d, "dictation.start", json!({ "session": "s2" })).unwrap();
    assert_eq!(engine.told(1), (0, 1));
    engine.say(1, Event::End);
    assert!(d.live_sessions().is_empty());

    // Two mics at once: "b" starts inside "a"'s start (session 2, "a" is 3); "a" finishes once it
    // started, one dictation at a time.
    meanwhile(&engine, &d, |d| {
        call(d, "dictation.start", json!({ "session": "b" })).unwrap();
    });
    call(&d, "dictation.start", json!({ "session": "a" })).unwrap();
    assert_eq!((engine.told(2), engine.told(3)), ((0, 0), (1, 0)));
    assert_eq!(d.live_sessions(), ["a", "b"]);

    // A start that fails while registered leaves nothing behind.
    *engine.fail.lock().unwrap() = Some(VoiceError::NoDevice("no microphone".into()));
    assert_eq!(call(&d, "dictation.start", json!({ "session": "c" })).unwrap_err().code, "no_device");
    assert_eq!(d.live_sessions(), ["a", "b"]);
}

#[test]
fn choosing_and_removing_models() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(FakeEngine::default());
    let (d, events) = dictation(dir.path(), &engine);
    install_fake(d.store(), "canary-180m-flash");
    install_fake(d.store(), "parakeet-tdt-0.6b-v3");

    let s = state(&d, "dictation.models", json!({})).unwrap();
    assert!(s.supported);
    assert_eq!(s.device, "desktop");
    let phase = |s: &DictationState, id: &str| s.models.iter().find(|m| m.id == id).unwrap().phase;
    assert_eq!(phase(&s, "parakeet-tdt-0.6b-v3"), DictationModelPhase::Installed);
    assert_eq!(phase(&s, "whisper-base"), DictationModelPhase::Available);
    assert!(s.models.iter().find(|m| m.id == "parakeet-tdt-0.6b-v3").unwrap().recommended);
    assert_eq!(s.selected, None);

    assert_eq!(state(&d, "dictation.select", json!({ "modelId": "whisper-base" })).unwrap_err().code, "invalid_params");
    assert_eq!(state(&d, "dictation.select", json!({ "modelId": "parakeet-tdt-0.6b-v3" })).unwrap().selected.as_deref(), Some("parakeet-tdt-0.6b-v3"));
    assert_eq!(last_state(&events).selected.as_deref(), Some("parakeet-tdt-0.6b-v3"));
    // Already there: nothing to download.
    let s = state(&d, "dictation.install", json!({ "modelId": "parakeet-tdt-0.6b-v3" })).unwrap();
    assert_eq!(phase(&s, "parakeet-tdt-0.6b-v3"), DictationModelPhase::Installed);

    // Deleting the chosen model: the other one takes over.
    call(&d, "dictation.start", json!({ "session": "s1" })).unwrap();
    engine.say(0, Event::End);
    let s = state(&d, "dictation.remove", json!({ "modelId": "parakeet-tdt-0.6b-v3" })).unwrap();
    assert!(!d.store().model_dir(catalog::find("parakeet-tdt-0.6b-v3").unwrap()).exists());
    assert_eq!(phase(&s, "parakeet-tdt-0.6b-v3"), DictationModelPhase::Available);
    assert_eq!(s.selected.as_deref(), Some("canary-180m-flash"));
    // The last one: back to none (the system's recognition).
    assert_eq!(state(&d, "dictation.remove", json!({ "modelId": "canary-180m-flash" })).unwrap().selected, None);

    assert_eq!(state(&d, "dictation.setLanguage", json!({ "language": "xx" })).unwrap_err().code, "invalid_params");
    assert_eq!(state(&d, "dictation.setLanguage", json!({ "language": "de" })).unwrap().language, "de");
    assert_eq!(state(&d, "dictation.remove", json!({ "modelId": "nope" })).unwrap_err().code, "not_found");
}

#[test]
fn the_chosen_microphone_is_kept_with_its_name() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(FakeEngine::default());
    let (d, _) = dictation(dir.path(), &engine);
    super::test_microphone();
    let mics: DictationMicrophones = serde_json::from_value(call(&d, "dictation.microphones", json!({})).unwrap()).unwrap();
    assert_eq!(mics.microphones.len(), 1, "{mics:?}");
    let fake = &mics.microphones[0];
    assert!(fake.default && fake.name.starts_with("Fake microphone"), "{fake:?}");
    let s = state(&d, "dictation.setMicrophone", json!({ "id": fake.id })).unwrap();
    assert_eq!(s.microphone.as_ref().map(|m| (m.id.as_str(), m.name.as_str())), Some((fake.id.as_str(), fake.name.as_str())));
    assert_eq!(state(&d, "dictation.setMicrophone", json!({ "id": "alsa:gone" })).unwrap_err().code, "invalid_params");
    assert_eq!(state(&d, "dictation.setMicrophone", json!({})).unwrap().microphone, None);
}
