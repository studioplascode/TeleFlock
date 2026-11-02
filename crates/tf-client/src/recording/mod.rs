//! Session recording (`tf_proto::recording`): the user records their own tabs in the TeleFlock
//! Browser panel; this module keeps the recordings (`<data_dir>/recordings/<id>/`, [`store`]),
//! records the microphone ([`voice`]), writes the video ([`mov`]), transcribes the voice, answers
//! the `recording.*` app methods and sends `AppEvent::Recordings`.
//!
//! One recording records at a time; its appends go straight to its files. `recording.stop` stops
//! the microphone and leaves the rest to a background pipeline: the video (`recording.mov` from
//! `frames.bin` and `voice.wav`; the frame index then points into it and `frames.bin` goes), the
//! transcription (one at a time, `waiting` until its turn), then `ready`. While it records, the
//! recording's limits are checked every second, appends or not (a still page sends none, the voice
//! still grows): one reached stops it the same way. A recording the app quit or crashed in the
//! middle of is finished the same way at the next start; quitting stops the microphone and leaves
//! the files for that. Each `recording.render` writes a folder of its own, `bundle/<render>`, which
//! `recording.release` removes once its upload ended (the next start removes what is left).
//!
//! Locks: `st` is held briefly, never across file work. Per recording, `files` is held shared by
//! whatever reads or writes its folder and exclusively by the switch to the video (index replaced,
//! `frames.bin` removed) and by its deletion; `io` puts `meta.json` writes in order; `turn` lets
//! one transcription run.

mod mov;
mod store;
#[cfg(test)]
mod tests;
mod voice;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::Value;
use tf_proto::{
    ApiError, AppEvent, AppMethod, Empty, Millis, RecordingAppendParams, RecordingAppended, RecordingBundle, RecordingBundleFile, RecordingBytes,
    RecordingDetail, RecordingFrameRef, RecordingInfo, RecordingList, RecordingReadParams, RecordingReleaseParams, RecordingRenderParams,
    RecordingShotRef, RecordingStartParams, RecordingState, RecordingTranscript, RecordingUpdateParams, RecordingVoice, TranscriptSegment,
    TranscriptState, VoiceState,
};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

use crate::engine::Inner;
use crate::util::{invalid, now_ms, private_dir, to_value, write_private};
use store::{Limits, Meta, Stop, Writer};

/// Transcription progress reaches the UI at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(500);
/// Longest `recording.read` slice.
const READ_MAX: u32 = 1 << 20;
/// Shutdown gives each background job this long to stop.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(5);
/// While a recording records, its limits are checked this often, appends or not.
const LIMITS_EVERY: Duration = Duration::from_secs(1);
/// A transcription the app ended in (quit or crashed, out of memory say) this many times is not
/// run again by itself.
const TRANSCRIBE_RUNS: u32 = 2;
const NO_AUDIO: &str = "The microphone delivered no audio";
const NO_MODEL: &str = "No speech model is installed: download one in Settings → Dictation";
const NO_ENGINE: &str = "This build has no speech engine";
const TRANSCRIBE_ENDED_APP: &str = "The app ended twice while transcribing this recording";

/// The recordings of this device (`Inner::recordings`).
pub(crate) struct Recordings {
    /// `<data_dir>/recordings`.
    root: PathBuf,
    /// Speech models live in `<data_dir>/dictation`.
    data_dir: PathBuf,
    limits: Limits,
    st: Mutex<St>,
    io: tokio::sync::Mutex<()>,
    turn: tokio::sync::Mutex<()>,
    /// Background jobs (stop pipelines, recovery, transcriptions), awaited at shutdown.
    tasks: Mutex<Vec<JoinHandle<()>>>,
    /// Sends `AppEvent::Recordings` ([`start`] sets it).
    emit: OnceLock<Box<dyn Fn() + Send + Sync>>,
}

#[derive(Default)]
struct St {
    recs: HashMap<String, Rec>,
    /// The recording that is recording or paused.
    active: Option<Active>,
    /// A `recording.start` is creating its recording.
    starting: bool,
    /// When transcription progress last went out.
    progress_at: Option<Instant>,
    /// Shut down: no new background work.
    closed: bool,
}

struct Rec {
    meta: Meta,
    /// The folder on disk.
    bytes: u64,
    files: Arc<RwLock<()>>,
    /// Set by `recording.delete` and shutdown: the recording's video and transcription stop.
    cancel: Arc<AtomicBool>,
    /// A transcription is queued or running.
    transcribing: bool,
    /// The app core stopped the recording at this limit: `recording.append` keeps answering it,
    /// `recording.stop` answers the stopped recording.
    limit: Option<Stop>,
}

impl Rec {
    fn new(meta: Meta, bytes: u64) -> Rec {
        Rec { meta, bytes, files: Arc::default(), cancel: Arc::default(), transcribing: false, limit: None }
    }

    fn info(&self, now: Millis) -> RecordingInfo {
        let mut info = self.meta.info.clone();
        info.duration_ms = self.meta.duration(now);
        info.bytes = self.bytes;
        info
    }
}

/// The recording being recorded.
struct Active {
    id: String,
    writer: Arc<Mutex<Writer>>,
    mic: Option<voice::Mic>,
}

fn not_found(id: &str) -> ApiError {
    ApiError::new("not_found", format!("no recording `{id}`"))
}

fn io_error(what: &str, e: impl std::fmt::Display) -> ApiError {
    ApiError::new("io_error", format!("{what}: {e}"))
}

fn state_name(s: RecordingState) -> &'static str {
    match s {
        RecordingState::Recording => "recording",
        RecordingState::Paused => "paused",
        RecordingState::Processing => "processing",
        RecordingState::Ready => "ready",
        RecordingState::Failed => "failed",
    }
}

/// Why `id` takes no appends, pauses or stop: it is not the recording that records.
fn not_recording(recs: &HashMap<String, Rec>, id: &str) -> ApiError {
    match recs.get(id).map(|r| r.meta.info.state) {
        None => not_found(id),
        // Left recording by an earlier run of the app: being finished.
        Some(RecordingState::Recording | RecordingState::Paused) => invalid("The recording was interrupted when the app quit; it is being finished"),
        Some(s) => invalid(format!("The recording is not recording (it is {})", state_name(s))),
    }
}

/// `recording.render` and `recording.transcribe` need a finished recording.
fn need_ready(rec: &Rec) -> Result<(), ApiError> {
    match rec.meta.info.state {
        RecordingState::Ready => Ok(()),
        RecordingState::Processing => Err(ApiError::new("busy", "The recording is still being processed").retryable()),
        s => Err(invalid(format!("The recording is not ready (it is {})", state_name(s)))),
    }
}

fn check_title(t: &str) -> Result<String, ApiError> {
    let t = t.trim();
    if t.is_empty() {
        return Err(invalid("title: a recording needs a title"));
    }
    if t.chars().count() > store::TITLE_MAX {
        return Err(invalid(format!("title: at most {} characters", store::TITLE_MAX)));
    }
    Ok(t.to_string())
}

/// Runs file work on the blocking pool.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, ApiError> + Send + 'static) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f).await.map_err(|e| ApiError::new("internal", format!("recording: {e}")))?
}

/// Replaces a recording's `meta.json` (atomically, this user's only like the rest of the folder).
async fn write_meta(path: &Path, meta: &Meta) -> Result<(), ApiError> {
    let bytes = serde_json::to_vec_pretty(meta).map_err(|e| ApiError::new("internal", e.to_string()))?;
    let path = path.to_path_buf();
    blocking(move || write_private(&path, &bytes).map_err(|e| io_error(store::META, e))).await
}

/// Transcribed speech in recording time, within the recording.
fn segments(said: Vec<voice::Said>, offset: u64, duration: u64) -> Vec<TranscriptSegment> {
    said.into_iter()
        .filter_map(|s| {
            let text = s.text.trim();
            let start = s.start_ms + offset;
            (!text.is_empty() && start < duration)
                .then(|| TranscriptSegment { start_ms: start, end_ms: (s.end_ms + offset).clamp(start, duration), text: text.to_string() })
        })
        .collect()
}

/// The voice file a video is made with: the microphone was on and recorded something.
fn voice_wav(dir: &Path, meta: &Meta) -> Option<PathBuf> {
    let path = dir.join(store::VOICE);
    let samples = fs::File::open(&path).and_then(|mut f| mov::wav_data(&mut f)).map_or(0, |d| d.samples);
    (meta.info.voice.state == VoiceState::On && samples > 0).then_some(path)
}

/// What [`make_video`] made.
struct Made {
    video_bytes: Option<u64>,
    voice_ms: Option<u64>,
}

/// The stop's video: `recording.mov` from `frames.bin` and the voice, every frame in it, and
/// `frames.idx.new` pointing into it (the switch then removes `frames.bin` and renames the
/// index). Without `frames.bin` the video was made already.
fn make_video(dir: &Path, meta: &Meta, cancel: &AtomicBool) -> std::io::Result<Made> {
    let (bin, video) = (dir.join(store::FRAMES_BIN), dir.join(store::VIDEO));
    let voice_ms = |wav: &Path| fs::File::open(wav).and_then(|mut f| mov::wav_data(&mut f)).map(|d| d.samples / mov::SAMPLES_PER_MS).ok();
    if !bin.exists() {
        let video_bytes = fs::metadata(&video).ok().map(|m| m.len());
        return Ok(Made { video_bytes, voice_ms: voice_wav(dir, meta).as_deref().and_then(voice_ms) });
    }
    if meta.info.voice.state == VoiceState::On && dir.join(store::VOICE).exists() {
        mov::repair_wav(&dir.join(store::VOICE))?;
    }
    let wav = voice_wav(dir, meta);
    let bin_len = fs::metadata(&bin)?.len();
    let mut records = store::read_index(&dir.join(store::FRAMES_IDX))?;
    records.retain(|r| r.offset + r.size as u64 <= bin_len);
    if (records.is_empty() && wav.is_none()) || meta.info.duration_ms == 0 {
        return Ok(Made { video_bytes: None, voice_ms: None });
    }
    let frames: Vec<mov::Frame> = records.iter().map(|r| mov::Frame { t: r.t, offset: r.offset, size: r.size }).collect();
    let (width, height) = records.first().map_or((0, 0), |r| (r.width, r.height));
    let input = mov::Input {
        frames: &frames,
        width,
        height,
        source: &bin,
        wav: wav.as_deref().map(|p| (p, meta.info.voice.offset_ms.unwrap_or(0))),
        duration_ms: meta.info.duration_ms,
        cuts: &[],
        all_frames: true,
        cancel,
    };
    let muxed = mov::write(&video, &input)?;
    for (r, at) in records.iter_mut().zip(&muxed.offsets) {
        r.offset = at.expect("every frame is written");
    }
    store::write_index(&dir.join(store::FRAMES_IDX_NEW), &records)?;
    Ok(Made { video_bytes: Some(muxed.bytes), voice_ms: wav.as_deref().and_then(voice_ms) })
}

/// `recording.render`'s files, in a folder of the render's own, `bundle/<render>`: renders for
/// uploads that run at once (the recording sent to two hosts) never write over a file one of
/// them reads. A render that fails leaves nothing behind.
fn render_bundle(
    dir: &Path,
    meta: &Meta,
    cuts: &[(u64, u64)],
    files: Vec<(String, String)>,
    cancel: &AtomicBool,
) -> Result<(RecordingBundle, u64), ApiError> {
    let io = |e: std::io::Error| io_error("render", e);
    let duration = meta.info.duration_ms;
    let kept = mov::kept(duration, cuts);
    let kept_ms: u64 = kept.iter().map(|(a, b)| b - a).sum();
    if kept_ms == 0 && duration > 0 {
        return Err(invalid("cuts: nothing of the recording is left"));
    }
    private_dir(&dir.join(store::BUNDLE)).map_err(io)?;
    let rel = loop {
        let rel = format!("{}/{}", store::BUNDLE, store::new_render());
        match fs::create_dir(dir.join(&rel)) {
            Ok(()) => break rel,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io(e)),
        }
    };
    let out = dir.join(&rel);
    let write = || -> Result<RecordingBundle, ApiError> {
        private_dir(&out).map_err(io)?;
        let entry = |file: &str| -> Result<RecordingBundleFile, ApiError> {
            let path = dir.join(file);
            let size = fs::metadata(&path).map_err(io)?.len();
            let path = std::path::absolute(&path).unwrap_or(path);
            Ok(RecordingBundleFile { file: file.to_string(), size, path: path.to_string_lossy().into_owned() })
        };
        let video = match &meta.info.video {
            None => None,
            Some(v) if kept == [(0, duration)] => Some(entry(v)?),
            Some(v) => {
                let records = store::read_index(&dir.join(store::FRAMES_IDX)).map_err(io)?;
                let frames: Vec<mov::Frame> = records.iter().map(|r| mov::Frame { t: r.t, offset: r.offset, size: r.size }).collect();
                let (width, height) = records.first().map_or((0, 0), |r| (r.width, r.height));
                let wav = voice_wav(dir, meta);
                let input = mov::Input {
                    frames: &frames,
                    width,
                    height,
                    source: &dir.join(v),
                    wav: wav.as_deref().map(|p| (p, meta.info.voice.offset_ms.unwrap_or(0))),
                    duration_ms: duration,
                    cuts,
                    all_frames: false,
                    cancel,
                };
                mov::write(&out.join(store::VIDEO), &input).map_err(io)?;
                Some(entry(&format!("{rel}/{}", store::VIDEO))?)
            }
        };
        let mut written = Vec::with_capacity(files.len());
        for (name, text) in files {
            store::write_file(&out.join(&name), text.as_bytes()).map_err(io)?;
            written.push(entry(&format!("{rel}/{name}"))?);
        }
        Ok(RecordingBundle { dir: Some(rel.clone()), video, files: written, duration_ms: kept_ms })
    };
    let bundle = write().inspect_err(|_| {
        let _ = fs::remove_dir_all(&out);
    })?;
    Ok((bundle, store::folder_size(dir)))
}

/// Connects the recordings to the app's event stream and finishes what the app left unfinished.
pub(crate) fn start(inner: &Arc<Inner>) {
    let weak = Arc::downgrade(inner);
    let _ = inner.recordings.emit.set(Box::new(move || {
        let Some(inner) = weak.upgrade() else { return };
        let _g = inner.emit_lock.lock().unwrap();
        inner.send(AppEvent::Recordings { recordings: inner.recordings.list() });
    }));
    inner.recordings.recover();
}

impl Recordings {
    /// Reads every recording's `meta.json` (unreadable ones are logged and left alone). Renders
    /// go: no upload outlives the app.
    pub(crate) async fn load(data_dir: &Path) -> Arc<Recordings> {
        Self::load_with(data_dir, Limits::default()).await
    }

    async fn load_with(data_dir: &Path, limits: Limits) -> Arc<Recordings> {
        let root = data_dir.join("recordings");
        let dir = root.clone();
        let recs = tokio::task::spawn_blocking(move || {
            let mut recs = HashMap::new();
            let Ok(entries) = fs::read_dir(&dir) else { return recs };
            for e in entries.flatten() {
                let id = e.file_name().to_string_lossy().into_owned();
                if !store::valid_id(&id) {
                    continue;
                }
                match store::read_meta(&e.path()) {
                    Ok(meta) if meta.info.id == id => {
                        if let Err(err) = fs::remove_dir_all(e.path().join(store::BUNDLE))
                            && err.kind() != std::io::ErrorKind::NotFound
                        {
                            log::warn!("recording {id}: bundle/: {err}");
                        }
                        recs.insert(id, Rec::new(meta, store::folder_size(&e.path())));
                    }
                    Ok(_) => log::warn!("recording {id}: meta.json names another recording; left alone"),
                    Err(err) => log::warn!("recording {id}: meta.json: {err}; left alone"),
                }
            }
            recs
        })
        .await
        .unwrap_or_default();
        Arc::new(Recordings {
            root,
            data_dir: data_dir.to_path_buf(),
            limits,
            st: Mutex::new(St { recs, ..St::default() }),
            io: tokio::sync::Mutex::new(()),
            turn: tokio::sync::Mutex::new(()),
            tasks: Mutex::default(),
            emit: OnceLock::new(),
        })
    }

    fn emit(&self) {
        if let Some(emit) = self.emit.get() {
            emit();
        }
    }

    fn with<T>(&self, id: &str, f: impl FnOnce(&Rec) -> T) -> Option<T> {
        self.st.lock().unwrap().recs.get(id).map(f)
    }

    fn with_mut<T>(&self, id: &str, f: impl FnOnce(&mut Rec) -> T) -> Option<T> {
        self.st.lock().unwrap().recs.get_mut(id).map(f)
    }

    /// Runs background work, awaited at shutdown (after shutdown: not at all).
    fn spawn(&self, job: impl Future<Output = ()> + Send + 'static) {
        let mut tasks = self.tasks.lock().unwrap();
        if self.st.lock().unwrap().closed {
            return;
        }
        tasks.retain(|t| !t.is_finished());
        tasks.push(tokio::spawn(job));
    }

    /// Writes the recording's `meta.json` as it is now (the folder's size follows). Holding the
    /// recording's files shared, after checking it is still there: a deleted recording stays
    /// deleted.
    async fn persist(&self, id: &str) {
        let _io = self.io.lock().await;
        let Some(files) = self.with(id, |r| r.files.clone()) else { return };
        let _shared = files.read().await;
        let Some(meta) = self.with(id, |r| r.meta.clone()) else { return };
        let path = self.root.join(id).join(store::META);
        let len = async || tokio::fs::metadata(&path).await.map_or(0, |m| m.len() as i64);
        let old = len().await;
        match write_meta(&path, &meta).await {
            Ok(()) => {
                let grew = len().await - old;
                self.with_mut(id, |r| r.bytes = r.bytes.saturating_add_signed(grew));
            }
            Err(e) => log::warn!("recording {id}: {e}"),
        }
    }

    /// Newest first, with the bytes on disk and the budget.
    pub(crate) fn list(&self) -> RecordingList {
        let st = self.st.lock().unwrap();
        let now = now_ms();
        let mut recordings: Vec<RecordingInfo> = st.recs.values().map(|r| r.info(now)).collect();
        recordings.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
        RecordingList { bytes: st.recs.values().map(|r| r.bytes).sum(), budget: self.limits.budget, recordings }
    }

    /// Serves a `recording.*` app method.
    pub(crate) async fn call(self: &Arc<Self>, m: AppMethod) -> Result<Value, ApiError> {
        match m {
            AppMethod::RecordingStart(p) => to_value(&self.start(p).await?),
            AppMethod::RecordingAppend(p) => to_value(&self.append(p).await?),
            AppMethod::RecordingPause(r) => to_value(&self.pause(&r.id, true).await?),
            AppMethod::RecordingResume(r) => to_value(&self.pause(&r.id, false).await?),
            AppMethod::RecordingStop(r) => to_value(&self.stop(&r.id).await?),
            AppMethod::RecordingListReq(_) => to_value(&self.list()),
            AppMethod::RecordingGet(r) => to_value(&self.get(&r.id).await?),
            AppMethod::RecordingFrameReq(p) => to_value(&self.frame(&p.id, p.index).await?),
            AppMethod::RecordingRead(p) => to_value(&self.read(p).await?),
            AppMethod::RecordingUpdate(p) => to_value(&self.update(p).await?),
            AppMethod::RecordingRender(p) => to_value(&self.render(p).await?),
            AppMethod::RecordingRelease(p) => to_value(&self.release(p).await?),
            AppMethod::RecordingTranscribe(r) => to_value(&self.transcribe(&r.id).await?),
            AppMethod::RecordingDelete(r) => to_value(&self.delete(&r.id).await?),
            other => Err(ApiError::new("unknown_method", format!("`{}` is not a recording method", other.name()))),
        }
    }

    // ───────────────────────────── recording ─────────────────────────────

    async fn start(self: &Arc<Self>, p: RecordingStartParams) -> Result<RecordingInfo, ApiError> {
        let title = match p.title.as_deref().map(str::trim) {
            Some(t) if !t.is_empty() => check_title(t)?,
            _ => chrono::Local::now().format("Recording %Y-%m-%d %H:%M").to_string(),
        };
        {
            let mut st = self.st.lock().unwrap();
            if st.active.is_some() || st.starting {
                return Err(ApiError::new("busy", "A recording is running already: stop it first"));
            }
            let used: u64 = st.recs.values().map(|r| r.bytes).sum();
            if used >= self.limits.budget {
                return Err(ApiError::new(
                    "budget_exceeded",
                    format!("Recordings use {} of {}; delete some in Recordings", store::gb(used), store::gb(self.limits.budget)),
                ));
            }
            st.starting = true;
        }
        let made = self.create(title, p.voice != Some(false)).await;
        let mut st = self.st.lock().unwrap();
        st.starting = false;
        let (rec, active) = made?;
        let info = rec.info(now_ms());
        st.active = Some(active);
        st.recs.insert(info.id.clone(), rec);
        drop(st);
        self.emit();
        self.spawn(Self::watch_limits(Arc::downgrade(self), info.id.clone()));
        Ok(info)
    }

    /// Stops recording `id` at a limit, checked every [`LIMITS_EVERY`] while it records: a still
    /// page sends no append whose checks would find one, and the voice keeps growing. Ends with
    /// the recording (or the recordings).
    async fn watch_limits(me: Weak<Self>, id: String) {
        loop {
            tokio::time::sleep(LIMITS_EVERY).await;
            let Some(me) = me.upgrade() else { return };
            let inputs = {
                let st = me.st.lock().unwrap();
                st.active.as_ref().filter(|a| a.id == id && !st.closed).map(|a| {
                    let others: u64 = st.recs.iter().filter(|(k, _)| **k != id).map(|(_, r)| r.bytes).sum();
                    (a.writer.clone(), others, st.recs.get(&id).map_or(0, |r| r.meta.duration(now_ms())))
                })
            };
            let Some((writer, others, duration)) = inputs else { return };
            let limits = me.limits;
            let stop = if duration >= limits.max_ms {
                Some(Stop::Duration)
            } else {
                blocking(move || Ok(writer.lock().unwrap().reached(others, &limits))).await.unwrap_or(None)
            };
            if let Some(stop) = stop {
                log::info!("recording {id}: {}; stopping it", stop.sentence(&limits));
                // Stopped meanwhile (the user, a delete, the app quitting): nothing left to do.
                if let Err(e) = me.finish(&id, Some(stop)).await {
                    log::debug!("recording {id}: {e}");
                }
                return;
            }
        }
    }

    /// A new recording's folder, files and microphone.
    async fn create(&self, title: String, want_voice: bool) -> Result<(Rec, Active), ApiError> {
        let id = loop {
            let id = store::new_id();
            if !self.st.lock().unwrap().recs.contains_key(&id) && !self.root.join(&id).exists() {
                break id;
            }
        };
        let dir = self.root.join(&id);
        let created_at = now_ms();
        let (root, d) = (self.root.clone(), dir.clone());
        let (voice, mic) = blocking(move || {
            // The recordings folder too: one made before recordings were private is tightened.
            private_dir(&root).and_then(|()| private_dir(&d)).map_err(|e| io_error("recording", e))?;
            let make = |state, message: Option<String>| RecordingVoice { state, message, offset_ms: None, duration_ms: None };
            Ok(if !want_voice {
                (make(VoiceState::Off, None), None)
            } else {
                match voice::Mic::start(&d.join(store::VOICE)) {
                    Ok(mic) => (make(VoiceState::On, None), Some(mic)),
                    Err(m) if !voice::AVAILABLE => (make(VoiceState::Unavailable, Some(m)), None),
                    Err(m) => (make(VoiceState::Failed, Some(m)), None),
                }
            })
        })
        .await?;
        let transcript = RecordingTranscript {
            state: if voice.state == VoiceState::Unavailable { TranscriptState::Unavailable } else { TranscriptState::None },
            progress: None,
            message: None,
            segments: Vec::new(),
        };
        let info = RecordingInfo {
            id: id.clone(),
            title,
            created_at,
            state: RecordingState::Recording,
            duration_ms: 0,
            frames: 0,
            shots: 0,
            events: 0,
            bytes: 0,
            width: None,
            height: None,
            voice,
            transcript,
            video: None,
            video_bytes: None,
            message: None,
            doc: None,
        };
        let meta = Meta { info, paused_at: None, paused_ms: 0, transcribe_runs: 0 };
        let d = dir.clone();
        let opened = match write_meta(&dir.join(store::META), &meta).await {
            Ok(()) => blocking(move || Writer::create(&d).map(|w| (w, store::folder_size(&d))).map_err(|e| io_error("recording", e))).await,
            Err(e) => Err(e),
        };
        match opened {
            Ok((writer, bytes)) => Ok((Rec::new(meta, bytes), Active { id, writer: Arc::new(Mutex::new(writer)), mic })),
            Err(e) => {
                let _ = tokio::task::spawn_blocking(move || {
                    if let Some(mic) = mic {
                        let _ = mic.stop();
                    }
                    let _ = fs::remove_dir_all(&dir);
                })
                .await;
                Err(e)
            }
        }
    }

    async fn append(self: &Arc<Self>, p: RecordingAppendParams) -> Result<RecordingAppended, ApiError> {
        let id = p.id.clone();
        let writer = {
            let st = self.st.lock().unwrap();
            match &st.active {
                Some(a) if a.id == id => a.writer.clone(),
                _ => return self.after_stop(&st.recs, &id),
            }
        };
        let me = self.clone();
        let wid = id.clone();
        let out = blocking(move || {
            let batch = store::Batch::decode(p)?;
            let mut w = writer.lock().unwrap();
            if w.closed {
                return Ok(None);
            }
            let others = me.st.lock().unwrap().recs.iter().filter(|(k, _)| **k != wid).map(|(_, r)| r.bytes).sum();
            w.append(batch, others, &me.limits).map(Some)
        })
        .await?;
        // It stopped while this append waited for the writer.
        let Some(out) = out else { return self.after_stop(&self.st.lock().unwrap().recs, &id) };
        let now = now_ms();
        let (res, persist) = {
            let mut st = self.st.lock().unwrap();
            let St { recs, active, .. } = &mut *st;
            let Some(rec) = recs.get_mut(&id) else { return Err(not_found(&id)) };
            let info = &mut rec.meta.info;
            info.frames += out.frames;
            info.events += out.events;
            info.shots += out.shots;
            if let Some((w, h)) = out.size {
                (info.width, info.height) = (Some(w as u32), Some(h as u32));
            }
            let mic = active.as_ref().filter(|a| a.id == id).and_then(|a| a.mic.as_ref());
            let persist = rec.meta.voice_started(mic.map_or(0, voice::Mic::started_at_ms));
            rec.bytes = out.bytes;
            let duration = rec.meta.duration(now);
            let stop = out.stop.or((duration >= self.limits.max_ms).then_some(Stop::Duration));
            (RecordingAppended { bytes: rec.bytes, duration_ms: duration, stop: stop.map(|s| s.sentence(&self.limits)) }, persist)
        };
        if persist {
            self.persist(&id).await;
        }
        Ok(res)
    }

    /// `recording.append` of a recording that no longer records. One a limit stopped gets the
    /// limit again: the UI's batches still on their way, and the one asking why it stopped.
    fn after_stop(&self, recs: &HashMap<String, Rec>, id: &str) -> Result<RecordingAppended, ApiError> {
        match recs.get(id) {
            Some(Rec { limit: Some(stop), bytes, meta, .. }) => {
                Ok(RecordingAppended { bytes: *bytes, duration_ms: meta.info.duration_ms, stop: Some(stop.sentence(&self.limits)) })
            }
            _ => Err(not_recording(recs, id)),
        }
    }

    /// `recording.pause` (`pause`) and `recording.resume`; the same again changes nothing.
    async fn pause(self: &Arc<Self>, id: &str, pause: bool) -> Result<RecordingInfo, ApiError> {
        let info = {
            let mut st = self.st.lock().unwrap();
            let St { recs, active, .. } = &mut *st;
            let Some(a) = active.as_mut().filter(|a| a.id == id) else { return Err(not_recording(recs, id)) };
            let rec = recs.get_mut(id).expect("the active recording is listed");
            let now = now_ms();
            if let Some(mic) = &a.mic {
                rec.meta.voice_started(mic.started_at_ms());
            }
            match (pause, rec.meta.info.state) {
                (true, RecordingState::Recording) => {
                    rec.meta.paused_at = Some(now);
                    rec.meta.info.state = RecordingState::Paused;
                    if let Some(mic) = &mut a.mic {
                        mic.pause();
                    }
                }
                (false, RecordingState::Paused) => {
                    let since = rec.meta.paused_at.take().unwrap_or(now);
                    rec.meta.paused_ms += (now - since).max(0) as u64;
                    rec.meta.info.state = RecordingState::Recording;
                    if let Some(mic) = &mut a.mic {
                        mic.resume();
                    }
                }
                _ => {}
            }
            rec.info(now)
        };
        self.persist(id).await;
        self.emit();
        Ok(info)
    }

    /// `recording.stop`: the recording is `processing`; its video and transcription follow. One a
    /// limit stopped already answers as it is.
    async fn stop(self: &Arc<Self>, id: &str) -> Result<RecordingInfo, ApiError> {
        self.finish(id, None).await
    }

    /// Stops recording `id`: the user did, or the app core at `limit`. It is `processing`; its
    /// video and transcription follow.
    async fn finish(self: &Arc<Self>, id: &str, limit: Option<Stop>) -> Result<RecordingInfo, ApiError> {
        let (active, live) = {
            let mut st = self.st.lock().unwrap();
            if !st.active.as_ref().is_some_and(|a| a.id == id) {
                return match st.recs.get(id) {
                    Some(rec) if limit.is_none() && rec.limit.is_some() => Ok(rec.info(now_ms())),
                    _ => Err(not_recording(&st.recs, id)),
                };
            }
            let active = st.active.take().expect("checked");
            let rec = st.recs.get_mut(id).expect("the active recording is listed");
            let live = rec.meta.duration(now_ms());
            (rec.meta.info.duration_ms, rec.meta.paused_at, rec.limit) = (live, None, limit);
            rec.meta.info.state = RecordingState::Processing;
            (active, live)
        };
        let Active { writer, mic, .. } = active;
        // An append in flight finishes first; later ones find the writer closed.
        let (last_t, stopped) = blocking(move || {
            let last_t = {
                let mut w = writer.lock().unwrap();
                w.closed = true;
                w.last_t
            };
            Ok((last_t, mic.map(voice::Mic::stop)))
        })
        .await?;
        let info = {
            let mut st = self.st.lock().unwrap();
            let Some(rec) = st.recs.get_mut(id) else { return Err(not_found(id)) };
            if let Some(Ok(s)) = &stopped {
                rec.meta.voice_started(s.started_at_ms);
            }
            let info = &mut rec.meta.info;
            // The video's last slot shows the last frame.
            info.duration_ms = last_t.map_or(live.min(self.limits.max_ms), |t| live.min(self.limits.max_ms).max(t + 1));
            match stopped {
                Some(Ok(s)) if s.started_at_ms > 0 => {
                    info.voice.duration_ms = Some(s.duration_ms);
                    info.voice.message = s.interrupted.map(|m| format!("The microphone stopped early: {m}"));
                    info.transcript.state = TranscriptState::Waiting;
                }
                Some(Ok(_)) => (info.voice.state, info.voice.message) = (VoiceState::Failed, Some(NO_AUDIO.into())),
                Some(Err(m)) => (info.voice.state, info.voice.message) = (VoiceState::Failed, Some(m)),
                None => {}
            }
            rec.info(now_ms())
        };
        self.persist(id).await;
        self.emit();
        let me = self.clone();
        let id = id.to_string();
        self.spawn(async move { me.process(&id).await });
        Ok(info)
    }

    // ───────────────────────────── after the stop ─────────────────────────────

    /// The stopped recording's video, then its transcription, then `ready`.
    async fn process(self: &Arc<Self>, id: &str) {
        self.video(id).await;
        let pending = self.with(id, |r| {
            !r.cancel.load(Ordering::Relaxed)
                && r.meta.info.state == RecordingState::Processing
                && matches!(r.meta.info.transcript.state, TranscriptState::Waiting | TranscriptState::Running)
        });
        if pending == Some(true) {
            self.transcribe_voice(id).await;
        }
        let ready = self.with_mut(id, |r| {
            let done = !r.cancel.load(Ordering::Relaxed)
                && r.meta.info.state == RecordingState::Processing
                && !matches!(r.meta.info.transcript.state, TranscriptState::Waiting | TranscriptState::Running);
            if done {
                r.meta.info.state = RecordingState::Ready;
            }
            done
        });
        if ready == Some(true) {
            self.persist(id).await;
            self.emit();
        }
    }

    /// Writes the video and switches the frame index to it (or marks the recording failed).
    async fn video(self: &Arc<Self>, id: &str) {
        let Some((files, cancel, meta)) = self.with(id, |r| (r.files.clone(), r.cancel.clone(), r.meta.clone())) else { return };
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let dir = self.root.join(id);
        let shared = files.clone().read_owned().await;
        let (d, c) = (dir.clone(), cancel.clone());
        let made = blocking(move || make_video(&d, &meta, &c).map_err(|e| io_error("Could not write the video", e))).await;
        drop(shared);
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let made = match made {
            Ok(made) => made,
            Err(e) => {
                log::warn!("recording {id}: {e}");
                self.with_mut(id, |r| {
                    r.meta.info.state = RecordingState::Failed;
                    r.meta.info.message = Some(e.message);
                    if r.meta.info.transcript.state == TranscriptState::Waiting {
                        r.meta.info.transcript.state = TranscriptState::None;
                    }
                });
                self.persist(id).await;
                self.emit();
                return;
            }
        };
        let switched = {
            let _x = files.write().await;
            if self.with(id, |_| ()).is_none() {
                return;
            }
            let d = dir.clone();
            let switched = blocking(move || {
                match fs::remove_file(d.join(store::FRAMES_BIN)) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(io_error("frames.bin", e)),
                    _ => {}
                }
                let new = d.join(store::FRAMES_IDX_NEW);
                if new.exists() {
                    fs::rename(&new, d.join(store::FRAMES_IDX)).map_err(|e| io_error("frames.idx", e))?;
                }
                Ok(store::folder_size(&d))
            })
            .await;
            if let Ok(bytes) = &switched {
                self.with_mut(id, |r| {
                    r.bytes = *bytes;
                    r.meta.info.video = made.video_bytes.map(|_| store::VIDEO.to_string());
                    r.meta.info.video_bytes = made.video_bytes;
                    if let Some(ms) = made.voice_ms {
                        r.meta.info.voice.duration_ms = Some(ms);
                    }
                });
            }
            switched
        };
        if let Err(e) = switched {
            log::warn!("recording {id}: {e}");
            self.with_mut(id, |r| (r.meta.info.state, r.meta.info.message) = (RecordingState::Failed, Some(e.message)));
        }
        self.persist(id).await;
        self.emit();
    }

    /// Transcribes the recording's voice when its turn comes: `running` with progress, then the
    /// result. Stops early when the recording is deleted or the app quits. One the app ended in
    /// [`TRANSCRIBE_RUNS`] times (quit or crashed in it: out of memory, say) fails instead of
    /// running at every start; `recording.transcribe` runs it again.
    async fn transcribe_voice(self: &Arc<Self>, id: &str) {
        let _turn = self.turn.lock().await;
        let refused = self.with_mut(id, |r| {
            let refuse = r.meta.transcribe_runs >= TRANSCRIBE_RUNS && !r.cancel.load(Ordering::Relaxed);
            if refuse {
                r.transcribing = false;
                let message = Some(TRANSCRIBE_ENDED_APP.into());
                r.meta.info.transcript = RecordingTranscript { state: TranscriptState::Failed, progress: None, message, segments: Vec::new() };
            }
            refuse
        });
        if refused == Some(true) {
            log::warn!("recording {id}: the app ended in its last {TRANSCRIBE_RUNS} transcriptions; not running it again");
            self.persist(id).await;
            self.emit();
            return;
        }
        let started = self.with_mut(id, |r| {
            if r.cancel.load(Ordering::Relaxed) {
                return None;
            }
            r.transcribing = true;
            // Counted on disk before it runs: a crash in it leaves the count.
            r.meta.transcribe_runs += 1;
            r.meta.info.transcript = RecordingTranscript { state: TranscriptState::Running, progress: Some(0.0), message: None, segments: Vec::new() };
            let voice = &r.meta.info.voice;
            Some((r.files.clone(), r.cancel.clone(), voice.offset_ms.unwrap_or(0), r.meta.info.duration_ms))
        });
        let Some(Some((files, cancel, offset, duration))) = started else { return };
        self.persist(id).await;
        self.emit();
        let shared = files.read_owned().await;
        let (me, rid) = (self.clone(), id.to_string());
        let wav = self.root.join(id).join(store::VOICE);
        let data_dir = self.data_dir.clone();
        let c = cancel.clone();
        let res = tokio::task::spawn_blocking(move || {
            let progress = move |p: f32| me.progress(&rid, p);
            voice::transcribe(&wav, &data_dir, &progress, &c)
        })
        .await;
        drop(shared);
        let make = |state, message: Option<&str>, segments| RecordingTranscript { state, progress: None, message: message.map(str::to_string), segments };
        let transcript = match res {
            Ok(voice::Transcribed::Cancelled) => None,
            _ if cancel.load(Ordering::Relaxed) => None,
            Ok(voice::Transcribed::Done(said)) => Some(make(TranscriptState::Done, None, segments(said, offset, duration))),
            Ok(voice::Transcribed::NoModel) => Some(make(TranscriptState::NoModel, Some(NO_MODEL), Vec::new())),
            Ok(voice::Transcribed::Unavailable) => Some(make(TranscriptState::Unavailable, Some(NO_ENGINE), Vec::new())),
            Ok(voice::Transcribed::Failed(m)) => Some(make(TranscriptState::Failed, Some(&m), Vec::new())),
            Err(e) => Some(make(TranscriptState::Failed, Some(&format!("The transcription stopped: {e}")), Vec::new())),
        };
        self.with_mut(id, |r| {
            r.transcribing = false;
            r.meta.transcribe_runs = 0;
            if let Some(t) = transcript {
                r.meta.info.transcript = t;
            }
        });
        self.persist(id).await;
        self.emit();
    }

    /// Transcription progress (0–1), to the UI at most every [`PROGRESS_EVERY`].
    fn progress(&self, id: &str, p: f32) {
        let due = {
            let mut guard = self.st.lock().unwrap();
            let st = &mut *guard;
            let Some(rec) = st.recs.get_mut(id) else { return };
            rec.meta.info.transcript.progress = Some(p.clamp(0.0, 1.0));
            let due = st.progress_at.is_none_or(|t| t.elapsed() >= PROGRESS_EVERY);
            if due {
                st.progress_at = Some(Instant::now());
            }
            due
        };
        if due {
            self.emit();
        }
    }

    // ───────────────────────────── recovery and shutdown ─────────────────────────────

    /// Finishes, oldest first, the recordings the app quit (or crashed) in the middle of
    /// recording, processing or transcribing.
    fn recover(self: &Arc<Self>) {
        let mut todo: Vec<(Millis, String)> = {
            let st = self.st.lock().unwrap();
            st.recs
                .values()
                .filter(|r| {
                    let i = &r.meta.info;
                    matches!(i.state, RecordingState::Recording | RecordingState::Paused | RecordingState::Processing)
                        || (i.state == RecordingState::Ready && matches!(i.transcript.state, TranscriptState::Waiting | TranscriptState::Running))
                })
                .map(|r| (r.meta.info.created_at, r.meta.info.id.clone()))
                .collect()
        };
        if todo.is_empty() {
            return;
        }
        todo.sort();
        let me = self.clone();
        self.spawn(async move {
            for (_, id) in todo {
                me.recover_one(&id).await;
            }
        });
    }

    async fn recover_one(self: &Arc<Self>, id: &str) {
        let Some(state) = self.with(id, |r| r.meta.info.state) else { return };
        match state {
            RecordingState::Recording | RecordingState::Paused => {
                let dir = self.root.join(id);
                let found = blocking(move || store::recover_files(&dir).map_err(|e| io_error("Could not recover the recording", e))).await;
                let limits = self.limits;
                self.with_mut(id, |r| match found {
                    Ok(f) => recovered(&mut r.meta, f, &limits),
                    Err(e) => (r.meta.info.state, r.meta.info.message) = (RecordingState::Failed, Some(e.message)),
                });
                self.persist(id).await;
                self.emit();
                self.process(id).await;
            }
            RecordingState::Processing => self.process(id).await,
            RecordingState::Ready => {
                self.with_mut(id, |r| (r.transcribing, r.meta.info.transcript.state) = (true, TranscriptState::Waiting));
                self.persist(id).await;
                self.emit();
                self.transcribe_voice(id).await;
            }
            RecordingState::Failed => {}
        }
    }

    /// The app quits: the microphone stops and background work ends. A recording that was
    /// recording stays so on disk (with the time it stopped) and is finished at the next start.
    pub(crate) async fn shutdown(&self) {
        let active = {
            let mut st = self.st.lock().unwrap();
            st.closed = true;
            for r in st.recs.values() {
                r.cancel.store(true, Ordering::Relaxed);
            }
            let active = st.active.take();
            if let Some(rec) = active.as_ref().and_then(|a| st.recs.get_mut(&a.id)) {
                rec.meta.paused_at.get_or_insert(now_ms());
            }
            active
        };
        if let Some(Active { id, writer, mic }) = active {
            let stopped = tokio::task::spawn_blocking(move || {
                writer.lock().unwrap().closed = true;
                mic.map(voice::Mic::stop)
            })
            .await;
            if let Ok(Some(Ok(s))) = stopped {
                self.with_mut(&id, |r| r.meta.voice_started(s.started_at_ms));
            }
            self.persist(&id).await;
        }
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
        for t in tasks {
            let _ = tokio::time::timeout(SHUTDOWN_WAIT, t).await;
        }
    }

    // ───────────────────────────── reading ─────────────────────────────

    async fn get(self: &Arc<Self>, id: &str) -> Result<RecordingDetail, ApiError> {
        let files = self.with(id, |r| r.files.clone()).ok_or_else(|| not_found(id))?;
        let _shared = files.read().await;
        let info = self.with(id, |r| r.info(now_ms())).ok_or_else(|| not_found(id))?;
        let dir = self.root.join(id);
        let (events, frames, shots) = blocking(move || {
            let io = |e: std::io::Error| io_error("recording", e);
            let events = match fs::read(dir.join(store::EVENTS)) {
                Ok(b) => b.split(|&c| c == b'\n').filter_map(|l| serde_json::from_slice::<Value>(l).ok()).collect(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(e) => return Err(io(e)),
            };
            let frames = store::read_index(&dir.join(store::FRAMES_IDX)).map_err(io)?;
            let frames = frames.iter().map(|r| RecordingFrameRef { t: r.t, size: r.size }).collect();
            let mut shots: Vec<RecordingShotRef> = match fs::read_dir(dir.join(store::SHOTS)) {
                Ok(entries) => entries
                    .flatten()
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().into_owned();
                        store::shot_name(&name).ok()?;
                        Some(RecordingShotRef { size: e.metadata().ok()?.len(), name })
                    })
                    .collect(),
                Err(_) => Vec::new(),
            };
            shots.sort_by(|a, b| a.name.cmp(&b.name));
            Ok((events, frames, shots))
        })
        .await?;
        Ok(RecordingDetail { info, events, frames, shots })
    }

    async fn frame(self: &Arc<Self>, id: &str, index: u32) -> Result<RecordingBytes, ApiError> {
        let files = self.with(id, |r| r.files.clone()).ok_or_else(|| not_found(id))?;
        let _shared = files.read().await;
        let in_video = self.with(id, |r| r.meta.info.video.is_some()).ok_or_else(|| not_found(id))?;
        let dir = self.root.join(id);
        blocking(move || {
            let io = |e: std::io::Error| io_error("frame", e);
            let rec = store::read_record(&dir.join(store::FRAMES_IDX), index)
                .map_err(io)?
                .ok_or_else(|| invalid(format!("index: the recording has no frame {index}")))?;
            let jpeg = store::read_at(&dir.join(if in_video { store::VIDEO } else { store::FRAMES_BIN }), rec.offset, rec.size as usize).map_err(io)?;
            Ok(RecordingBytes { data: B64.encode(&jpeg), size: rec.size as u64 })
        })
        .await
    }

    async fn read(self: &Arc<Self>, p: RecordingReadParams) -> Result<RecordingBytes, ApiError> {
        let rel = store::readable(&p.file)
            .ok_or_else(|| invalid(format!("file: `{}` is none of recording.mov, voice.wav, shots/<name>, bundle/<name>", p.file)))?;
        if p.length > READ_MAX {
            return Err(invalid(format!("length: at most {READ_MAX} bytes")));
        }
        let files = self.with(&p.id, |r| r.files.clone()).ok_or_else(|| not_found(&p.id))?;
        let _shared = files.read().await;
        let path = self.root.join(&p.id).join(rel);
        blocking(move || {
            let io = |e: std::io::Error| io_error(&p.file, e);
            let mut f = match fs::File::open(&path) {
                Ok(f) => f,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ApiError::new("not_found", format!("the recording has no {}", p.file))),
                Err(e) => return Err(io(e)),
            };
            let size = f.metadata().map_err(io)?.len();
            let mut data = vec![0u8; (p.length as u64).min(size.saturating_sub(p.offset)) as usize];
            if !data.is_empty() {
                f.seek(SeekFrom::Start(p.offset)).map_err(io)?;
                f.read_exact(&mut data).map_err(io)?;
            }
            Ok(RecordingBytes { data: B64.encode(&data), size })
        })
        .await
    }

    // ───────────────────────────── changing ─────────────────────────────

    async fn update(self: &Arc<Self>, p: RecordingUpdateParams) -> Result<RecordingInfo, ApiError> {
        let title = p.title.as_deref().map(check_title).transpose()?;
        let info = self
            .with_mut(&p.id, |r| {
                if let Some(t) = title {
                    r.meta.info.title = t;
                }
                if let Some(doc) = p.doc {
                    r.meta.info.doc = Some(doc);
                }
                r.info(now_ms())
            })
            .ok_or_else(|| not_found(&p.id))?;
        self.persist(&p.id).await;
        self.emit();
        Ok(info)
    }

    /// `recording.render`: a folder of this render's own (`bundle/<render>`), so the recording can
    /// be sent to several hosts at once.
    async fn render(self: &Arc<Self>, p: RecordingRenderParams) -> Result<RecordingBundle, ApiError> {
        let mut files = Vec::with_capacity(p.files.len());
        let mut names = HashSet::new();
        for f in p.files {
            let name = store::bundle_name(&f.name)?;
            if !names.insert(name.to_ascii_lowercase()) {
                return Err(invalid(format!("files: \"{name}\" is listed twice")));
            }
            files.push((name, f.text));
        }
        let cuts: Vec<(u64, u64)> = p.cuts.iter().map(|c| (c.start_ms, c.end_ms)).collect();
        let (lock, cancel, meta) = {
            let st = self.st.lock().unwrap();
            let rec = st.recs.get(&p.id).ok_or_else(|| not_found(&p.id))?;
            need_ready(rec)?;
            (rec.files.clone(), rec.cancel.clone(), rec.meta.clone())
        };
        let shared = lock.read_owned().await;
        let dir = self.root.join(&p.id);
        let (bundle, bytes) = blocking(move || render_bundle(&dir, &meta, &cuts, files, &cancel)).await?;
        drop(shared);
        self.with_mut(&p.id, |r| r.bytes = bytes);
        self.emit();
        Ok(bundle)
    }

    /// `recording.release`: the upload of a render ended; its folder goes.
    async fn release(self: &Arc<Self>, p: RecordingReleaseParams) -> Result<Empty, ApiError> {
        let render = p
            .dir
            .strip_prefix(store::BUNDLE)
            .and_then(|r| r.strip_prefix('/'))
            .filter(|r| store::valid_render(r))
            .ok_or_else(|| invalid(format!("dir: `{}` is not a render's folder (bundle/<render>)", p.dir)))?;
        let files = self.with(&p.id, |r| r.files.clone()).ok_or_else(|| not_found(&p.id))?;
        let _shared = files.read().await;
        let (dir, render) = (self.root.join(&p.id), render.to_string());
        let bytes = blocking(move || match fs::remove_dir_all(dir.join(store::BUNDLE).join(render)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io_error("Could not remove the render", e)),
            _ => Ok(store::folder_size(&dir)),
        })
        .await?;
        self.with_mut(&p.id, |r| r.bytes = bytes);
        self.emit();
        Ok(Empty {})
    }

    /// `recording.transcribe`: transcribes the voice again (after a model was installed).
    async fn transcribe(self: &Arc<Self>, id: &str) -> Result<RecordingInfo, ApiError> {
        let info = {
            let mut st = self.st.lock().unwrap();
            let rec = st.recs.get_mut(id).ok_or_else(|| not_found(id))?;
            if rec.meta.info.voice.state != VoiceState::On {
                return Err(invalid("The recording has no voice"));
            }
            need_ready(rec)?;
            if rec.transcribing {
                return Err(ApiError::new("busy", "The voice is being transcribed already").retryable());
            }
            rec.transcribing = true;
            rec.meta.transcribe_runs = 0;
            rec.meta.info.transcript = RecordingTranscript { state: TranscriptState::Waiting, progress: None, message: None, segments: Vec::new() };
            rec.info(now_ms())
        };
        self.persist(id).await;
        self.emit();
        let me = self.clone();
        let id = id.to_string();
        self.spawn(async move { me.transcribe_voice(&id).await });
        Ok(info)
    }

    /// `recording.delete`: stops the recording (or its video and transcription) and removes it.
    async fn delete(self: &Arc<Self>, id: &str) -> Result<RecordingList, ApiError> {
        let (files, active) = {
            let mut st = self.st.lock().unwrap();
            let rec = st.recs.get(id).ok_or_else(|| not_found(id))?;
            rec.cancel.store(true, Ordering::Relaxed);
            let files = rec.files.clone();
            let active = if st.active.as_ref().is_some_and(|a| a.id == id) { st.active.take() } else { None };
            (files, active)
        };
        if let Some(Active { writer, mic, .. }) = active {
            let _ = tokio::task::spawn_blocking(move || {
                writer.lock().unwrap().closed = true;
                mic.map(voice::Mic::stop)
            })
            .await;
        }
        let exclusive = files.write().await;
        let dir = self.root.join(id);
        let removed = blocking(move || match fs::remove_dir_all(&dir) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io_error("Could not delete the recording", e)),
            _ => Ok(()),
        })
        .await;
        // A folder that could not go (a file open elsewhere) stays listed: deleting it again works.
        if removed.is_ok() {
            self.st.lock().unwrap().recs.remove(id);
        }
        drop(exclusive);
        self.emit();
        removed.map(|_| self.list())
    }
}

/// A recording the app quit (or crashed) in while recording, from what its files hold: it ends at
/// its last write (or where it was paused), the voice gets its length, and it is `processing`.
fn recovered(meta: &mut Meta, f: store::Recovered, limits: &Limits) {
    let end = meta.paused_at.or(f.last_write).unwrap_or(meta.info.created_at);
    let live = ((end - meta.info.created_at).max(0) as u64).saturating_sub(meta.paused_ms);
    let info = &mut meta.info;
    let voice_ms = f.voice_samples.map(|s| s / mov::SAMPLES_PER_MS);
    let voice_end = voice_ms.map_or(0, |ms| ms + info.voice.offset_ms.unwrap_or(0));
    let duration = live.max(voice_end).min(limits.max_ms);
    info.duration_ms = f.last_t.map_or(duration, |t| duration.max(t + 1));
    (info.frames, info.events, info.shots) = (f.frames, f.events, f.shots);
    (info.width, info.height) = f.size.map_or((None, None), |(w, h)| (Some(w as u32), Some(h as u32)));
    if info.voice.state == VoiceState::On {
        match voice_ms {
            Some(ms) if ms > 0 => {
                info.voice.duration_ms = Some(ms);
                info.voice.offset_ms.get_or_insert(0);
                info.transcript.state = TranscriptState::Waiting;
            }
            _ => (info.voice.state, info.voice.message) = (VoiceState::Failed, Some(NO_AUDIO.into())),
        }
    }
    info.state = RecordingState::Processing;
    meta.paused_at = None;
}
