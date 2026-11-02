//! On-device dictation (`dictation.*` app methods, `tf_proto::dictation`; architecture §5.2 and
//! §6.16): the speech models of this device (catalog, verified downloads, the chosen model,
//! language and microphone) and live recognition sessions, on tf-dictation (feature `voice`: the
//! desktop app and lab devservers, [`voice`]). Without the feature every method answers
//! `unsupported`: the Android app keeps its system speech recognizer.
//!
//! Sessions: `dictation.start {session}` listens with the chosen model, and the session's events
//! go out as `AppEvent::DictationSession` under the id the page chose. One session runs at a time:
//! a start finishes the one running, as `dictation.stop` would. A session is known from the moment
//! its start is called, so a stop, a cancel or a closed page while the microphone opens reaches it
//! once it started. A page that goes away takes its sessions with it ([`Dictation::page_closed`];
//! the devserver cancels a closed tab's own). Model changes go out as `AppEvent::Dictation`
//! (downloads at most ~4 times a second), which is also part of the replay.

#[cfg(all(test, feature = "voice"))]
mod tests;
#[cfg(feature = "voice")]
mod voice;

use std::sync::Arc;

use serde_json::Value;
use tf_proto::{ApiError, AppEvent, AppMethod};

use crate::engine::{EngineConfig, Inner};

/// This device's dictation (`Inner::dictation`).
pub(crate) struct Dictation {
    #[cfg(feature = "voice")]
    voice: Arc<voice::Dictation>,
}

impl Dictation {
    pub(crate) fn new(cfg: &EngineConfig) -> Self {
        #[cfg(feature = "voice")]
        return Self { voice: voice::Dictation::new(&cfg.data_dir, format!("TeleFlock/{} ({})", cfg.version, cfg.platform_name)) };
        #[cfg(not(feature = "voice"))]
        {
            let _ = cfg;
            Self {}
        }
    }

    /// Serves a `dictation.*` app method (off the runtime's threads: opening the microphone and
    /// listing devices block).
    pub(crate) async fn call(&self, m: AppMethod) -> Result<Value, ApiError> {
        #[cfg(feature = "voice")]
        {
            let voice = Arc::clone(&self.voice);
            tokio::task::spawn_blocking(move || voice.call(m)).await.unwrap_or_else(|e| Err(ApiError::new("internal", format!("dictation: {e}"))))
        }
        #[cfg(not(feature = "voice"))]
        Err(ApiError::new(
            "unsupported",
            format!("{}: this TeleFlock has no on-device speech engine (the desktop app has it; Android uses its own speech recognizer)", m.name()),
        ))
    }

    /// The model state for a replay; none where there is no dictation.
    pub(crate) fn replay(&self) -> Option<AppEvent> {
        #[cfg(feature = "voice")]
        return Some(AppEvent::Dictation { state: self.voice.state() });
        #[cfg(not(feature = "voice"))]
        None
    }

    /// The (single) page that started sessions is gone: they end without it.
    pub(crate) fn page_closed(&self) {
        #[cfg(feature = "voice")]
        self.voice.cancel_sessions();
    }

    /// Process end: sessions and downloads stop (a download resumes from where it was).
    pub(crate) fn shutdown(&self) {
        #[cfg(feature = "voice")]
        self.voice.shutdown();
    }
}

/// Connects dictation to the app's event stream (in order with the replay) and does its start-up
/// work: leftovers of models the catalog dropped go, the chosen microphone is applied.
pub(crate) fn start(inner: &Arc<Inner>) {
    #[cfg(feature = "voice")]
    {
        let weak = Arc::downgrade(inner);
        inner.dictation.voice.connect(Box::new(move |make: &dyn Fn() -> AppEvent| {
            let Some(inner) = weak.upgrade() else { return };
            let _g = inner.emit_lock.lock().unwrap();
            inner.send(make());
        }));
    }
    #[cfg(not(feature = "voice"))]
    let _ = inner;
}

/// Tests: makes every microphone capture of this process play one fake recording, a 60 s tone in
/// real time. One file for all tests: the microphone is one per process.
#[cfg(all(test, feature = "voice"))]
pub(crate) fn test_microphone() {
    static PATH: std::sync::LazyLock<std::path::PathBuf> = std::sync::LazyLock::new(|| {
        let path = std::env::temp_dir().join(format!("tf-client-test-mic-{}.wav", std::process::id()));
        let samples: Vec<i16> = (0..16_000 * 60).map(|i| ((i as f32 * 0.17).sin() * 8000.0) as i16).collect();
        let data = (samples.len() * 2) as u32;
        let mut wav = Vec::with_capacity(44 + data as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        // PCM, mono, 16 kHz, 32000 bytes/s, 2-byte frames, 16 bits.
        for (v, n) in [(16u32, 4), (1, 2), (1, 2), (16_000, 4), (32_000, 4), (2, 2), (16, 2)] {
            wav.extend_from_slice(&v.to_le_bytes()[..n]);
        }
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data.to_le_bytes());
        for s in samples {
            wav.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(&path, wav).expect("write the test microphone's recording");
        path
    });
    tf_dictation::mic::set_fake(Some(vec![PATH.clone()]));
}
