//! The microphone and the speech engine for recordings: tf-dictation (feature `voice`). Without
//! the feature a recording's voice is `unavailable` and so is its transcript.

use std::path::Path;
use std::sync::atomic::AtomicBool;

/// Whether this build records voice.
pub const AVAILABLE: bool = cfg!(feature = "voice");
/// Why a recording has no voice in a build without the feature.
#[cfg_attr(feature = "voice", allow(dead_code))]
pub const UNAVAILABLE: &str = "This build records no voice";

/// The microphone, recording into a WAV file (16 kHz mono 16-bit, its header refreshed about every
/// second, samples dropped while paused).
pub struct Mic {
    #[cfg(feature = "voice")]
    rec: tf_dictation::MicRecorder,
}

/// A stopped microphone.
pub struct MicStopped {
    pub duration_ms: u64,
    /// Epoch ms of the first sample (0: no audio came).
    pub started_at_ms: u64,
    /// Why the microphone stopped before the recording did (unplugged): the file holds what came
    /// before.
    pub interrupted: Option<String>,
}

impl Mic {
    /// Starts recording the microphone into `path`. `Err`: why it can't (no device, permission
    /// denied, this build has no microphone capture).
    #[cfg(feature = "voice")]
    pub fn start(path: &Path) -> Result<Mic, String> {
        tf_dictation::MicRecorder::start(path).map(|rec| Mic { rec }).map_err(|e| e.to_string())
    }

    #[cfg(not(feature = "voice"))]
    pub fn start(_path: &Path) -> Result<Mic, String> {
        Err(UNAVAILABLE.into())
    }

    /// Epoch ms of the first sample written (0 until audio flows).
    pub fn started_at_ms(&self) -> u64 {
        #[cfg(feature = "voice")]
        return self.rec.started_at_ms();
        #[cfg(not(feature = "voice"))]
        0
    }

    pub fn pause(&mut self) {
        #[cfg(feature = "voice")]
        self.rec.pause();
    }

    pub fn resume(&mut self) {
        #[cfg(feature = "voice")]
        self.rec.resume();
    }

    /// Stops the microphone and finishes the file.
    pub fn stop(self) -> Result<MicStopped, String> {
        #[cfg(feature = "voice")]
        return self
            .rec
            .stop()
            .map(|r| MicStopped { duration_ms: r.duration_ms, started_at_ms: r.started_at_ms, interrupted: r.interrupted.map(|e| e.to_string()) })
            .map_err(|e| e.to_string());
        #[cfg(not(feature = "voice"))]
        Err(UNAVAILABLE.into())
    }
}

/// A stretch of speech, ms from the start of the WAV file.
#[derive(Debug, Clone, PartialEq)]
pub struct Said {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

// Without the speech engine only `Unavailable` happens.
#[cfg_attr(not(feature = "voice"), allow(dead_code))]
pub enum Transcribed {
    Done(Vec<Said>),
    NoModel,
    /// This build has no speech engine.
    Unavailable,
    Cancelled,
    Failed(String),
}

/// Transcribes a WAV file with the model chosen in Settings → Dictation (models live in
/// `<data_dir>/dictation`). `progress`: 0–1. Blocks; `cancel` stops it.
pub fn transcribe(wav: &Path, data_dir: &Path, progress: &(dyn Fn(f32) + Sync), cancel: &AtomicBool) -> Transcribed {
    #[cfg(feature = "voice")]
    {
        use tf_dictation::{TranscribeOpts, VoiceError};
        let opts = TranscribeOpts { data_dir: data_dir.to_path_buf(), language: None };
        match tf_dictation::transcribe(wav, &opts, progress, cancel) {
            Ok(segments) => Transcribed::Done(segments.into_iter().map(|s| Said { start_ms: s.start_ms, end_ms: s.end_ms, text: s.text }).collect()),
            Err(VoiceError::NoModel) => Transcribed::NoModel,
            Err(VoiceError::NoEngine) => Transcribed::Unavailable,
            Err(VoiceError::Cancelled) => Transcribed::Cancelled,
            Err(e) => Transcribed::Failed(e.to_string()),
        }
    }
    #[cfg(not(feature = "voice"))]
    {
        let _ = (wav, data_dir, progress, cancel);
        Transcribed::Unavailable
    }
}
