//! On-device speech recognition for TeleFlock: the desktop apps and lab devservers, through the app
//! core (tf-client feature `voice`; docs/architecture.md §6.16). The Android app keeps the system
//! speech recognizer and doesn't build this crate.
//!
//! - [`catalog`]: the models on offer, pinned by commit and sha256; [`store`]: the ones on this
//!   device under `<data_dir>/dictation/`, downloads (resumable, verified) and the user's choice.
//! - [`mic`]: one microphone capture per process at 16 kHz mono, shared by every consumer.
//! - [`Session`]: live dictation; utterances cut by a voice activity detector, each decoded once
//!   it ends (final text), with interim decodes while it is spoken.
//! - [`MicRecorder`] and [`transcribe`]: record the microphone to a WAV, then transcribe it into
//!   timed segments.
//!
//! The engine is sherpa-onnx (offline recognizers + Silero VAD) on onnxruntime, prebuilt and
//! pinned by `build.rs` (feature `engine`).

pub mod audio;
pub mod catalog;
mod error;
pub mod mic;
mod record;
pub mod segment;
mod session;
pub mod store;
mod transcribe;

#[cfg(feature = "engine")]
mod engine;
#[cfg(feature = "engine")]
mod sys;

#[cfg(feature = "engine")]
use std::path::Path;
#[cfg(any(feature = "engine", test))]
use std::{
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::{Duration, Instant},
};

pub use error::VoiceError;
pub use record::{MicRecorder, Recorded};
pub use session::{Event, Session, SessionOpts};
pub use transcribe::{Segment, TranscribeOpts, transcribe};

/// The rate everything here works at.
pub const SAMPLE_RATE: u32 = 16_000;

/// Whether this build carries the speech engine.
pub const ENGINE: bool = cfg!(feature = "engine");

/// Engine name and version for Settings.
pub fn engine_version() -> String {
    #[cfg(feature = "engine")]
    return engine::version();
    #[cfg(not(feature = "engine"))]
    String::from("none")
}

/// Threads a decode may use: half the cores (the UI and the rest of the app keep the others),
/// at most 4 (more brought nothing measurable for these models).
#[cfg(feature = "engine")]
fn threads() -> usize {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    (cores / 2).clamp(1, 4)
}

/// A loaded model stays loaded this long after its last use (loading the large ones takes
/// seconds; keeping one in memory costs its RAM).
#[cfg(feature = "engine")]
const KEEP_LOADED: Duration = Duration::from_secs(300);

/// One value at a time by key (the recognizer of a model and language), shared by everyone who
/// asks for that key. A load in progress makes every other caller wait for it, whatever key it
/// wants: the same model is never loaded twice, nor are two loaded at once. Another key frees the
/// loaded value before its load; a caller still holding the old one (a transcription running, a
/// session listening) keeps it until it lets go.
#[cfg(any(feature = "engine", test))]
struct OneLoaded<K, V> {
    slot: Mutex<Slot<K, V>>,
    /// A load ended (`Slot::loading` went back to false).
    load_ended: Condvar,
}

#[cfg(any(feature = "engine", test))]
struct Slot<K, V> {
    held: Option<Held<K, V>>,
    loading: bool,
}

#[cfg(any(feature = "engine", test))]
struct Held<K, V> {
    key: K,
    value: Arc<V>,
    used: Instant,
}

#[cfg(any(feature = "engine", test))]
impl<K, V> OneLoaded<K, V> {
    const fn new() -> Self {
        Self { slot: Mutex::new(Slot { held: None, loading: false }), load_ended: Condvar::new() }
    }

    fn lock(&self) -> MutexGuard<'_, Slot<K, V>> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The slot once no load is in progress.
    fn settled(&self) -> MutexGuard<'_, Slot<K, V>> {
        let mut slot = self.lock();
        while slot.loading {
            slot = self.load_ended.wait(slot).unwrap_or_else(|e| e.into_inner());
        }
        slot
    }

    /// The value for `key`: the loaded one, else `load`'s once a load in progress ended.
    fn get<E>(&self, key: K, load: impl FnOnce() -> Result<V, E>) -> Result<Arc<V>, E>
    where
        K: PartialEq,
    {
        let mut slot = self.settled();
        if let Some(h) = slot.held.as_mut().filter(|h| h.key == key) {
            h.used = Instant::now();
            return Ok(Arc::clone(&h.value));
        }
        // Another key: the old value goes first (two large models may not fit).
        let old = slot.held.take();
        slot.loading = true;
        drop(slot);
        drop(old);
        let _ended = LoadEnded(self);
        let value = Arc::new(load()?);
        self.lock().held = Some(Held { key, value: Arc::clone(&value), used: Instant::now() });
        Ok(value)
    }

    /// Frees the value if it is `which`'s, after a load in progress (it may be loading it).
    #[cfg_attr(not(feature = "engine"), allow(dead_code))]
    fn unload(&self, which: impl Fn(&K) -> bool) {
        let old = self.settled().held.take_if(|h| which(&h.key));
        drop(old);
    }

    /// Frees the value nobody used for `after` and nobody holds; its key.
    #[cfg_attr(not(feature = "engine"), allow(dead_code))]
    fn unload_unused(&self, after: Duration) -> Option<K> {
        let old = self.lock().held.take_if(|h| h.used.elapsed() >= after && Arc::strong_count(&h.value) == 1);
        old.map(|h| h.key)
    }
}

/// Ends a load however it ends (an error, a panic): the callers waiting for it look again.
#[cfg(any(feature = "engine", test))]
struct LoadEnded<'a, K, V>(&'a OneLoaded<K, V>);

#[cfg(any(feature = "engine", test))]
impl<K, V> Drop for LoadEnded<'_, K, V> {
    fn drop(&mut self) {
        self.0.lock().loading = false;
        self.0.load_ended.notify_all();
    }
}

#[cfg(feature = "engine")]
static LOADED: OneLoaded<(String, Option<String>), engine::Recognizer> = OneLoaded::new();

/// The recognizer for `model` and `language`, loaded once and shared.
#[cfg(feature = "engine")]
fn recognizer(store: &store::Store, model: &'static catalog::Model, language: Option<&str>) -> Result<Arc<engine::Recognizer>, VoiceError> {
    let rec = LOADED.get((model.id.to_owned(), language.map(str::to_owned)), || {
        let t0 = Instant::now();
        let rec = engine::Recognizer::load(model, &store.model_dir(model), language, threads())?;
        log::info!("tf-dictation: loaded {} ({language:?}) in {} ms", model.id, t0.elapsed().as_millis());
        Ok(rec)
    })?;
    start_janitor();
    Ok(rec)
}

/// Frees the loaded model once it has been unused for [`KEEP_LOADED`].
#[cfg(feature = "engine")]
fn start_janitor() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let _ = std::thread::Builder::new().name("tf-dictation-janitor".into()).spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(30));
                if let Some((id, _)) = LOADED.unload_unused(KEEP_LOADED) {
                    log::info!("tf-dictation: unloaded {id} (unused)");
                }
            }
        });
    });
}

/// Drops the loaded model if it is `model_id` (before its files are deleted), after a load in
/// progress.
pub fn unload(model_id: &str) {
    #[cfg(feature = "engine")]
    LOADED.unload(|(id, _)| id == model_id);
    #[cfg(not(feature = "engine"))]
    let _ = model_id;
}

/// Writes the embedded voice activity model next to the models (the engine opens files), once:
/// first uses at the same time (a dictation and a transcription) wait for the one writing it. A
/// file of the right size is it; another process writes under a name of its own.
#[cfg(feature = "engine")]
fn vad_model(store: &store::Store) -> Result<std::path::PathBuf, VoiceError> {
    static WRITING: Mutex<()> = Mutex::new(());
    let path = store.root().join("silero_vad.onnx");
    let whole = || std::fs::metadata(&path).is_ok_and(|m| m.len() == engine::SILERO_VAD.len() as u64);
    let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    if whole() {
        return Ok(path);
    }
    let io = |e: std::io::Error| VoiceError::Other(format!("can't write the voice activity model: {e}"));
    std::fs::create_dir_all(store.root()).map_err(io)?;
    let tmp = store.root().join(format!("silero_vad.onnx.{}.tmp", std::process::id()));
    std::fs::write(&tmp, engine::SILERO_VAD).map_err(io)?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        // Another process put it in place (Windows refuses to replace a file in use).
        if !whole() {
            return Err(io(e));
        }
    }
    Ok(path)
}

/// The installed model the user chose, and the language to give it.
#[cfg(feature = "engine")]
fn chosen(data_dir: &Path, language: Option<&str>, locale: Option<&str>) -> Result<(store::Store, &'static catalog::Model, Option<&'static str>), VoiceError> {
    let store = store::Store::new(data_dir);
    let model = store.selected().ok_or(VoiceError::NoModel)?;
    let prefs = store.prefs();
    let lang = model.language_for(language.unwrap_or(&prefs.language), locale);
    Ok((store, model, lang))
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        thread::JoinHandle,
    };

    use super::*;

    type Models = Arc<OneLoaded<&'static str, String>>;

    /// Asks for `key` on a thread of its own, counting loads; the load waits for `hold`, if any.
    fn ask(one: &Models, loads: &Arc<AtomicUsize>, key: &'static str, hold: Option<mpsc::Receiver<()>>) -> JoinHandle<Result<Arc<String>, VoiceError>> {
        let (one, loads) = (Arc::clone(one), Arc::clone(loads));
        std::thread::spawn(move || {
            one.get(key, || {
                loads.fetch_add(1, Ordering::SeqCst);
                if let Some(h) = hold {
                    h.recv().unwrap();
                }
                Ok(key.to_string())
            })
        })
    }

    /// Starts loading `key` and holds the load until the returned sender lets go.
    fn held(one: &Models, loads: &Arc<AtomicUsize>, key: &'static str) -> (mpsc::Sender<()>, JoinHandle<Result<Arc<String>, VoiceError>>) {
        let (release, hold) = mpsc::channel();
        let thread = ask(one, loads, key, Some(hold));
        while loads.load(Ordering::SeqCst) == 0 {
            std::thread::sleep(Duration::from_millis(1));
        }
        (release, thread)
    }

    /// A transcription (or a second start) asks for the model a session is loading: it waits,
    /// and both get the one copy.
    #[test]
    fn callers_of_a_model_that_loads_share_that_load() {
        let (one, loads): (Models, _) = (Arc::new(OneLoaded::new()), Arc::new(AtomicUsize::new(0)));
        let (release, first) = held(&one, &loads, "parakeet");
        let second = ask(&one, &loads, "parakeet", None);
        std::thread::sleep(Duration::from_millis(50));
        release.send(()).unwrap();
        let (a, b) = (first.join().unwrap().unwrap(), second.join().unwrap().unwrap());
        assert!(Arc::ptr_eq(&a, &b), "one copy in memory");
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

    /// Another model waits for the load in progress (never two loads at once), then frees the
    /// loaded one before its own load; a failed load doesn't keep the next caller waiting.
    #[test]
    fn another_model_loads_after_and_instead() {
        let (one, loads): (Models, _) = (Arc::new(OneLoaded::new()), Arc::new(AtomicUsize::new(0)));
        let (release, first) = held(&one, &loads, "canary-de");
        let other = ask(&one, &loads, "whisper", None);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(loads.load(Ordering::SeqCst), 1, "waits for the load in progress");
        release.send(()).unwrap();
        let canary = Arc::downgrade(&first.join().unwrap().unwrap());
        assert_eq!(*other.join().unwrap().unwrap(), "whisper");
        assert!(canary.upgrade().is_none(), "freed before the other model loaded");
        assert_eq!(one.get("moonshine", || Err(VoiceError::Model("broken".into()))), Err(VoiceError::Model("broken".into())));
        assert_eq!(*ask(&one, &loads, "moonshine", None).join().unwrap().unwrap(), "moonshine");
    }

    /// First uses of the voice activity model at the same time (a dictation start and a
    /// transcription) all get the whole file, and no temporary file is left.
    #[cfg(feature = "engine")]
    #[test]
    fn the_voice_activity_model_is_written_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(store::Store::new(dir.path()));
        let firsts: Vec<_> = (0..8)
            .map(|_| {
                let store = Arc::clone(&store);
                std::thread::spawn(move || vad_model(&store))
            })
            .collect();
        for t in firsts {
            assert_eq!(t.join().unwrap().unwrap(), store.root().join("silero_vad.onnx"));
        }
        assert_eq!(std::fs::read(store.root().join("silero_vad.onnx")).unwrap(), engine::SILERO_VAD);
        let names: Vec<String> = std::fs::read_dir(store.root()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["silero_vad.onnx"]);
    }
}
