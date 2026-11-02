//! Recording the microphone to a WAV file (16 kHz mono PCM16), for screen recordings with voice.

use std::{
    fs,
    io::BufWriter,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    SAMPLE_RATE, VoiceError,
    audio::{to_i16, wav_spec_16k},
    mic::{self, Chunk},
};

/// A finished recording.
#[derive(Debug, Clone, PartialEq)]
pub struct Recorded {
    pub path: PathBuf,
    pub sample_rate: u32,
    pub duration_ms: u64,
    /// Epoch ms of the first sample in the file (0: no audio arrived).
    pub started_at_ms: u64,
    /// The microphone stopped before `stop` (unplugged, the app left the front on Android):
    /// the file holds what came before.
    pub interrupted: Option<VoiceError>,
}

pub struct MicRecorder {
    shared: Arc<Shared>,
    stop: mpsc::Sender<()>,
    worker: Option<JoinHandle<Result<Recorded, VoiceError>>>,
}

struct Shared {
    paused: AtomicBool,
    started_at_ms: AtomicU64,
}

/// The header is rewritten this often, so a crash leaves a playable file.
const FLUSH_EVERY: Duration = Duration::from_secs(1);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl MicRecorder {
    /// Opens the microphone (shared with dictation) and starts writing `path`.
    pub fn start(path: &Path) -> Result<Self, VoiceError> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| VoiceError::Other(format!("can't create {}: {e}", dir.display())))?;
        }
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        // What the microphone heard: this user's only (0600; the recording's folder is 0700).
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let file = opts.open(path).map_err(|e| VoiceError::Other(format!("can't create {}: {e}", path.display())))?;
        let writer = hound::WavWriter::new(BufWriter::new(file), wav_spec_16k()).map_err(|e| VoiceError::Other(e.to_string()))?;
        let stream = mic::open()?;
        let shared = Arc::new(Shared { paused: AtomicBool::new(false), started_at_ms: AtomicU64::new(0) });
        let (stop, stop_rx) = mpsc::channel();
        let path = path.to_path_buf();
        let worker_shared = Arc::clone(&shared);
        let worker = std::thread::Builder::new()
            .name("tf-record".into())
            .spawn(move || {
                let mut writer = writer;
                let mut written = 0u64;
                let mut interrupted = None;
                let mut last_flush = std::time::Instant::now();
                loop {
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }
                    match stream.recv_timeout(Duration::from_millis(50)) {
                        Ok(Chunk::Audio(samples)) => {
                            if worker_shared.paused.load(Ordering::Acquire) {
                                continue;
                            }
                            if written == 0 {
                                let dur = samples.len() as u64 * 1000 / u64::from(SAMPLE_RATE);
                                worker_shared.started_at_ms.store(now_ms().saturating_sub(dur), Ordering::Release);
                            }
                            for &s in samples.iter() {
                                writer.write_sample(to_i16(s)).map_err(|e| VoiceError::Other(e.to_string()))?;
                            }
                            written += samples.len() as u64;
                            if last_flush.elapsed() >= FLUSH_EVERY {
                                writer.flush().map_err(|e| VoiceError::Other(e.to_string()))?;
                                last_flush = std::time::Instant::now();
                            }
                        }
                        Ok(Chunk::Ended(e)) => {
                            interrupted = Some(e.unwrap_or_else(|| VoiceError::NoDevice("the microphone stopped".into())));
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                drop(stream);
                writer.finalize().map_err(|e| VoiceError::Other(e.to_string()))?;
                Ok(Recorded {
                    path,
                    sample_rate: SAMPLE_RATE,
                    duration_ms: written * 1000 / u64::from(SAMPLE_RATE),
                    started_at_ms: worker_shared.started_at_ms.load(Ordering::Acquire),
                    interrupted,
                })
            })
            .map_err(|e| VoiceError::Other(format!("can't start the recorder: {e}")))?;
        Ok(Self { shared, stop, worker: Some(worker) })
    }

    /// Epoch ms of the first written sample (0 until audio arrives).
    pub fn started_at_ms(&self) -> u64 {
        self.shared.started_at_ms.load(Ordering::Acquire)
    }

    /// Samples are dropped until `resume`: the file holds recording time without pauses.
    pub fn pause(&self) {
        self.shared.paused.store(true, Ordering::Release);
    }

    pub fn resume(&self) {
        self.shared.paused.store(false, Ordering::Release);
    }

    /// Stops and finishes the file.
    pub fn stop(mut self) -> Result<Recorded, VoiceError> {
        let _ = self.stop.send(());
        match self.worker.take().map(JoinHandle::join) {
            Some(Ok(r)) => r,
            _ => Err(VoiceError::Other("the recorder failed".into())),
        }
    }
}

impl Drop for MicRecorder {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}
