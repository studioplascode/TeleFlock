//! Safe wrappers over sherpa-onnx (feature `engine`): an offline recognizer per model and the
//! Silero voice activity detector.

use std::{
    collections::VecDeque,
    ffi::{CStr, CString, c_char},
    path::Path,
};

use crate::{
    SAMPLE_RATE, VoiceError,
    catalog::{Kind, Model},
    segment::{Detector, WINDOW},
    sys,
};

/// The Silero VAD model, embedded (build.rs fetched it, sha256-pinned).
pub const SILERO_VAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/silero_vad.onnx"));

/// `sherpa-onnx <version>`.
pub fn version() -> String {
    // SAFETY: a static NUL-terminated string owned by the library.
    let v = unsafe { CStr::from_ptr(sys::SherpaOnnxGetVersionStr()) };
    format!("sherpa-onnx {}", v.to_string_lossy())
}

/// C strings a config points at; they must outlive the create call only (the library copies).
#[derive(Default)]
struct Strings(Vec<CString>);

impl Strings {
    fn add(&mut self, s: &str) -> *const c_char {
        let c = CString::new(s).unwrap_or_default();
        let p = c.as_ptr();
        self.0.push(c);
        p
    }
    fn path(&mut self, dir: &Path, name: &str) -> *const c_char {
        self.add(&dir.join(name).to_string_lossy())
    }
}

pub struct Recognizer {
    ptr: *const sys::OfflineRecognizer,
}

// SAFETY: sherpa-onnx's offline recognizer is immutable after creation; decoding works on a
// stream created per call, and onnxruntime sessions may run from several threads.
unsafe impl Send for Recognizer {}
unsafe impl Sync for Recognizer {}

impl Recognizer {
    /// Loads `model` from `dir`. `language`: an ISO 639-1 code for models that take one (none
    /// = let the model detect it, where it can).
    pub fn load(model: &Model, dir: &Path, language: Option<&str>, threads: usize) -> Result<Self, VoiceError> {
        let mut s = Strings::default();
        // SAFETY: an all-zero config is the documented "unset" state of every field.
        let mut c: sys::OfflineRecognizerConfig = unsafe { std::mem::zeroed() };
        c.feat_config.sample_rate = SAMPLE_RATE as i32;
        c.feat_config.feature_dim = 80;
        c.model_config.num_threads = threads.clamp(1, 8) as i32;
        c.model_config.provider = s.add("cpu");
        c.decoding_method = s.add("greedy_search");
        let m = &mut c.model_config;
        match model.kind {
            Kind::NemoTransducer => {
                m.transducer.encoder = s.path(dir, "encoder.int8.onnx");
                m.transducer.decoder = s.path(dir, "decoder.int8.onnx");
                m.transducer.joiner = s.path(dir, "joiner.int8.onnx");
                m.tokens = s.path(dir, "tokens.txt");
                m.model_type = s.add("nemo_transducer");
            }
            Kind::Canary => {
                let lang = language.filter(|l| model.language_codes.contains(l)).unwrap_or(model.language_codes[0]);
                m.canary.encoder = s.path(dir, "encoder.int8.onnx");
                m.canary.decoder = s.path(dir, "decoder.int8.onnx");
                m.canary.src_lang = s.add(lang);
                m.canary.tgt_lang = s.add(lang);
                m.canary.use_pnc = 1;
                m.tokens = s.path(dir, "tokens.txt");
            }
            Kind::Whisper { prefix } => {
                m.whisper.encoder = s.path(dir, &format!("{prefix}-encoder.int8.onnx"));
                m.whisper.decoder = s.path(dir, &format!("{prefix}-decoder.int8.onnx"));
                m.whisper.language = s.add(language.unwrap_or(""));
                m.whisper.task = s.add("transcribe");
                m.whisper.tail_paddings = -1;
                m.tokens = s.path(dir, &format!("{prefix}-tokens.txt"));
            }
            Kind::MoonshineV2 => {
                m.moonshine.encoder = s.path(dir, "encoder_model.ort");
                m.moonshine.merged_decoder = s.path(dir, "decoder_model_merged.ort");
                m.tokens = s.path(dir, "tokens.txt");
            }
        }
        // SAFETY: `c` and every string it points at live until the call returns.
        let ptr = unsafe { sys::SherpaOnnxCreateOfflineRecognizer(&c) };
        drop(s);
        if ptr.is_null() {
            return Err(VoiceError::Model(format!("the speech engine couldn't load {} (files in {})", model.name, dir.display())));
        }
        Ok(Self { ptr })
    }

    /// Text of one utterance (16 kHz mono).
    pub fn decode(&self, samples: &[f32]) -> String {
        if samples.is_empty() {
            return String::new();
        }
        // SAFETY: the stream is created, used and destroyed here; the samples outlive the calls;
        // the JSON string is freed with its own destroy function after it was copied.
        unsafe {
            let stream = sys::SherpaOnnxCreateOfflineStream(self.ptr);
            if stream.is_null() {
                return String::new();
            }
            sys::SherpaOnnxAcceptWaveformOffline(stream, SAMPLE_RATE as i32, samples.as_ptr(), samples.len() as i32);
            sys::SherpaOnnxDecodeOfflineStream(self.ptr, stream);
            let json = sys::SherpaOnnxGetOfflineStreamResultAsJson(stream);
            let text = if json.is_null() {
                String::new()
            } else {
                let parsed = serde_json::from_slice::<serde_json::Value>(CStr::from_ptr(json).to_bytes()).ok();
                sys::SherpaOnnxDestroyOfflineStreamResultJson(json);
                parsed.and_then(|v| v.get("text").and_then(|t| t.as_str()).map(str::to_owned)).unwrap_or_default()
            };
            sys::SherpaOnnxDestroyOfflineStream(stream);
            clean(&text)
        }
    }
}

impl Drop for Recognizer {
    fn drop(&mut self) {
        // SAFETY: created by SherpaOnnxCreateOfflineRecognizer, destroyed once.
        unsafe { sys::SherpaOnnxDestroyOfflineRecognizer(self.ptr) };
    }
}

/// Trims, and drops what is no speech: punctuation alone, a model's silence markers.
pub(crate) fn clean(text: &str) -> String {
    let t = text.trim();
    if t.chars().all(|c| !c.is_alphanumeric()) {
        return String::new();
    }
    t.to_owned()
}

/// Voice activity settings.
#[derive(Debug, Clone, Copy)]
pub struct VadOpts {
    /// A pause this long ends an utterance (seconds).
    pub min_silence: f32,
    /// Shorter sounds are not speech (seconds).
    pub min_speech: f32,
    /// Longer speech is split (seconds).
    pub max_speech: f32,
}

/// Live dictation: text within about a second of a pause.
pub const DICTATION_VAD: VadOpts = VadOpts { min_silence: 0.5, min_speech: 0.25, max_speech: 20.0 };
/// Recordings: whisper-sized segments.
pub const TRANSCRIBE_VAD: VadOpts = VadOpts { min_silence: 0.5, min_speech: 0.25, max_speech: 20.0 };

/// Silero hears a soft start (a vowel: "Öffne", "Add") only some windows into it, and
/// sherpa-onnx starts an utterance just a window before the speech it heard: each utterance
/// takes this much of the audio before it along (never reaching into the one before).
const LEAD_IN: u64 = SAMPLE_RATE as u64 * 3 / 10;

pub struct Vad {
    ptr: *const sys::VoiceActivityDetector,
    /// The audio accepted lately, from stream sample `recent_from`, as far back as the
    /// detector's own buffer: where lead-ins come from.
    recent: VecDeque<f32>,
    recent_from: u64,
    keep: usize,
    /// Where the last utterance handed out ended.
    last_end: u64,
}

// SAFETY: used from one thread at a time (owned by a session or a transcription).
unsafe impl Send for Vad {}

impl Vad {
    /// `model`: the Silero model file.
    pub fn new(model: &Path, opts: VadOpts) -> Result<Self, VoiceError> {
        let mut s = Strings::default();
        // SAFETY: all-zero = unset, as for the recognizer.
        let mut c: sys::VadModelConfig = unsafe { std::mem::zeroed() };
        c.silero_vad.model = s.add(&model.to_string_lossy());
        c.silero_vad.threshold = 0.5;
        c.silero_vad.min_silence_duration = opts.min_silence;
        c.silero_vad.min_speech_duration = opts.min_speech;
        c.silero_vad.window_size = WINDOW as i32;
        c.silero_vad.max_speech_duration = opts.max_speech;
        c.sample_rate = SAMPLE_RATE as i32;
        c.num_threads = 1;
        c.provider = s.add("cpu");
        // Buffer: the longest utterance plus slack.
        let keep = opts.max_speech + 10.0;
        // SAFETY: `c` and its strings live until the call returns.
        let ptr = unsafe { sys::SherpaOnnxCreateVoiceActivityDetector(&c, keep) };
        drop(s);
        if ptr.is_null() {
            return Err(VoiceError::Model("the voice activity detector couldn't load".into()));
        }
        Ok(Self { ptr, recent: VecDeque::new(), recent_from: 0, keep: (keep * SAMPLE_RATE as f32) as usize, last_end: 0 })
    }
}

impl Detector for Vad {
    fn accept(&mut self, samples: &[f32]) {
        // A window per call: sherpa-onnx judges a call's audio as one (speech if any window
        // of it is) and starts an utterance two windows plus the minimum speech before the
        // call's end, so audio that piled up (a model loading, a decode running) would lose
        // the words spoken early in it.
        for window in samples.chunks(WINDOW) {
            // SAFETY: valid detector and slice.
            unsafe { sys::SherpaOnnxVoiceActivityDetectorAcceptWaveform(self.ptr, window.as_ptr(), window.len() as i32) };
        }
        self.recent.extend(samples);
        if self.recent.len() > self.keep {
            let n = self.recent.len() - self.keep;
            self.recent.drain(..n);
            self.recent_from += n as u64;
        }
    }

    fn speaking(&self) -> bool {
        // SAFETY: valid detector.
        unsafe { sys::SherpaOnnxVoiceActivityDetectorDetected(self.ptr) != 0 }
    }

    fn pop(&mut self) -> Option<(u64, Vec<f32>)> {
        // SAFETY: Front is only read while the queue is not empty; the segment is copied, then
        // destroyed and popped.
        let (start, samples) = unsafe {
            if sys::SherpaOnnxVoiceActivityDetectorEmpty(self.ptr) != 0 {
                return None;
            }
            let seg = sys::SherpaOnnxVoiceActivityDetectorFront(self.ptr);
            let out = if seg.is_null() {
                (0, Vec::new())
            } else {
                let s = &*seg;
                let samples = if s.samples.is_null() || s.n <= 0 { Vec::new() } else { std::slice::from_raw_parts(s.samples, s.n as usize).to_vec() };
                let start = s.start.max(0) as u64;
                sys::SherpaOnnxDestroySpeechSegment(seg);
                (start, samples)
            };
            sys::SherpaOnnxVoiceActivityDetectorPop(self.ptr);
            out
        };
        if samples.is_empty() {
            return Some((start, samples));
        }
        // The detector counts samples from the first one accepted, as `recent_from` does.
        let from = start.saturating_sub(LEAD_IN).max(self.last_end).max(self.recent_from);
        self.last_end = start + samples.len() as u64;
        if from >= start || start > self.recent_from + self.recent.len() as u64 {
            return Some((start, samples));
        }
        let mut out: Vec<f32> = self.recent.range((from - self.recent_from) as usize..(start - self.recent_from) as usize).copied().collect();
        out.extend_from_slice(&samples);
        Some((from, out))
    }

    fn flush(&mut self) {
        // SAFETY: valid detector.
        unsafe { sys::SherpaOnnxVoiceActivityDetectorFlush(self.ptr) };
    }
}

impl Drop for Vad {
    fn drop(&mut self) {
        // SAFETY: created by SherpaOnnxCreateVoiceActivityDetector, destroyed once.
        unsafe { sys::SherpaOnnxDestroyVoiceActivityDetector(self.ptr) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_drops_non_speech() {
        assert_eq!(clean("  Hello world. "), "Hello world.");
        assert_eq!(clean(" . "), "");
        assert_eq!(clean("…"), "");
        assert_eq!(clean("Grüß dich"), "Grüß dich");
    }

    #[test]
    fn engine_links_and_reports_its_version() {
        assert!(version().starts_with("sherpa-onnx 2."), "{}", version());
    }

    /// A detector for live dictation (its model file lives as long as the directory).
    fn dictation_vad() -> (tempfile::TempDir, Vad) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("silero_vad.onnx");
        std::fs::write(&path, SILERO_VAD).unwrap();
        let vad = Vad::new(&path, DICTATION_VAD).unwrap();
        (dir, vad)
    }

    /// `src/testdata/<name>`: speech by Piper's Thorsten voice (CC0), starting 0.5 s in.
    fn speech(name: &str) -> Vec<f32> {
        crate::audio::read_wav_16k(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src/testdata").join(name)).unwrap()
    }

    const ONSET: u64 = SAMPLE_RATE as u64 / 2;

    #[test]
    fn vad_finds_no_speech_in_silence() {
        let (_dir, mut vad) = dictation_vad();
        vad.accept(&vec![0.0; SAMPLE_RATE as usize * 2]);
        vad.flush();
        assert!(!vad.speaking());
        assert!(vad.pop().is_none());
    }

    /// Audio that piled up (the model loading as a session starts, a decode running) reaches
    /// the detector in one call: the utterance in it still starts where the speech does.
    /// `speech-de.wav`: "Bitte schreib einen Test." (1.1 s), then 0.8 s of silence.
    #[test]
    fn speech_that_arrives_at_once_keeps_its_first_words() {
        let (_dir, mut vad) = dictation_vad();
        let audio = speech("speech-de.wav");
        // The silence and the first second of speech at once, then 20 ms at a time.
        let batch = (ONSET + SAMPLE_RATE as u64) as usize;
        vad.accept(&audio[..batch]);
        for c in audio[batch..].chunks(320) {
            vad.accept(c);
        }
        vad.flush();
        let (start, samples) = vad.pop().expect("an utterance");
        let late = (start as f32 - ONSET as f32) / SAMPLE_RATE as f32;
        assert!(late <= 0.1, "the utterance starts {late:.2} s after the speech: its first words are lost");
        assert!(samples.len() >= SAMPLE_RATE as usize, "{} samples", samples.len());
        assert!(vad.pop().is_none());
    }

    /// Silero hears this "Öffne" only 0.2 s in; the utterance still starts before it.
    /// `soft-start-de.wav`: "Öffne die Datei." (0.84 s), then 0.8 s of silence.
    #[test]
    fn an_utterance_keeps_its_soft_start() {
        let (_dir, mut vad) = dictation_vad();
        for c in speech("soft-start-de.wav").chunks(320) {
            vad.accept(c);
        }
        vad.flush();
        let (start, samples) = vad.pop().expect("an utterance");
        let late = (start as f32 - ONSET as f32) / SAMPLE_RATE as f32;
        assert!(late <= 0.0, "the utterance starts {late:.2} s after its first sound");
        assert!(start + samples.len() as u64 >= ONSET + SAMPLE_RATE as u64 * 8 / 10, "it ends at sample {}", start + samples.len() as u64);
        assert!(vad.pop().is_none());
    }
}
