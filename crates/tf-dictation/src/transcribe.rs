//! A recording to timed text, offline, with the user's chosen model.

use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

use crate::VoiceError;

#[derive(Debug, Clone)]
pub struct TranscribeOpts {
    /// The app's data dir (the models and the user's choice live under `dictation/`).
    pub data_dir: PathBuf,
    /// `auto` or an ISO 639-1 code; `None`: the language chosen in Settings.
    pub language: Option<String>,
}

/// Speech from `start_ms` to `end_ms` (from the start of the file).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// Transcribes a WAV file (any rate and channel count): speech segments found by the voice
/// activity detector (split at 20 s), each decoded on its own. The file is read half a second
/// at a time, so an hour of voice is never in memory whole. `progress` gets 0–1. Blocking.
pub fn transcribe(path: &Path, opts: &TranscribeOpts, progress: &dyn Fn(f32), cancel: &AtomicBool) -> Result<Vec<Segment>, VoiceError> {
    #[cfg(feature = "engine")]
    {
        use std::sync::atomic::Ordering;

        use crate::{SAMPLE_RATE, audio::Wav16k, engine, segment::Detector};

        let (store, model, language) = crate::chosen(&opts.data_dir, opts.language.as_deref(), None)?;
        let mut wav = Wav16k::open(path)?;
        let recognizer = crate::recognizer(&store, model, language)?;
        let mut vad = engine::Vad::new(&crate::vad_model(&store)?, engine::TRANSCRIBE_VAD)?;
        let ms = |samples: u64| samples * 1000 / u64::from(SAMPLE_RATE);
        let mut out = Vec::new();
        let decode = |vad: &mut engine::Vad, out: &mut Vec<Segment>| -> Result<(), VoiceError> {
            while let Some((start, samples)) = vad.pop() {
                if cancel.load(Ordering::Acquire) {
                    return Err(VoiceError::Cancelled);
                }
                let text = recognizer.decode(&samples);
                if !text.is_empty() {
                    out.push(Segment { start_ms: ms(start), end_ms: ms(start + samples.len() as u64), text });
                }
            }
            Ok(())
        };
        let (total, half) = (wav.len_16k().max(1) as f32, (wav.rate() / 2) as usize);
        let (mut piece, mut read) = (Vec::with_capacity(SAMPLE_RATE as usize), 0u64);
        // Segments are decoded while the detector works through the rest.
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(VoiceError::Cancelled);
            }
            piece.clear();
            if !wav.read(half, &mut piece)? {
                break;
            }
            vad.accept(&piece);
            decode(&mut vad, &mut out)?;
            read += piece.len() as u64;
            progress((read as f32 / total).min(1.0));
        }
        vad.flush();
        decode(&mut vad, &mut out)?;
        progress(1.0);
        Ok(out)
    }
    #[cfg(not(feature = "engine"))]
    {
        let _ = (path, opts, progress, cancel);
        Err(VoiceError::NoEngine)
    }
}
