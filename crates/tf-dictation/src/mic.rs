//! One microphone capture per process, shared by every consumer (dictation sessions and
//! recordings at the same time): 16 kHz mono chunks of 10–40 ms. The device opens with the first
//! consumer and closes after the last one.
//!
//! Source: the input device chosen with [`set_device`] (Settings → Dictation → Microphone), else
//! the system default, through cpal (ALSA, CoreAudio, WASAPI); [`devices`] lists them. Android
//! builds of the app keep the system speech recognizer and don't build this crate. Debug builds
//! play WAV files in real time instead, silence after their end, for labs and tests without a
//! sound card: `TF_DICTATION_FAKE_MIC` (one path, or several joined like `PATH`: each capture
//! plays the next one) or [`set_fake`].

use std::{
    sync::{
        Arc, LazyLock, Mutex,
        mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError},
    },
    time::Duration,
};

use crate::{SAMPLE_RATE, VoiceError, audio::Resampler};

#[derive(Debug, Clone)]
pub enum Chunk {
    Audio(Arc<[f32]>),
    /// The capture ended for every consumer: the device went away or failed (the error), or the
    /// app left the front (Android: none).
    Ended(Option<VoiceError>),
}

/// One consumer's feed. Dropping it lets the device close when nobody else listens.
pub struct MicStream {
    id: u64,
    rx: Receiver<Chunk>,
}

impl MicStream {
    pub fn recv_timeout(&self, timeout: Duration) -> Result<Chunk, RecvTimeoutError> {
        self.rx.recv_timeout(timeout)
    }
    pub fn try_recv(&self) -> Result<Chunk, TryRecvError> {
        self.rx.try_recv()
    }

    /// A stream outside the hub, fed by the returned sender.
    #[cfg(test)]
    pub(crate) fn test() -> (Self, Sender<Chunk>) {
        let (tx, rx) = mpsc::channel();
        (Self { id: u64::MAX, rx }, tx)
    }
}

impl Drop for MicStream {
    fn drop(&mut self) {
        hub().unsubscribe(self.id);
    }
}

/// Starts listening (opening the device if nobody listens yet).
pub fn open() -> Result<MicStream, VoiceError> {
    hub().subscribe()
}

/// An input device the system offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Microphone {
    /// cpal's device id (`alsa:sysdefault:CARD=PCH`), stable across runs where the system
    /// allows; what [`set_device`] takes.
    pub id: String,
    pub name: String,
    /// The system's default input right now.
    pub default: bool,
}

/// The input devices, the system default first. Blocking: the system may probe every device
/// (ALSA takes a moment). Debug builds playing a fake microphone list only that one.
pub fn devices() -> Result<Vec<Microphone>, VoiceError> {
    #[cfg(debug_assertions)]
    if let Some(files) = fake::files() {
        let names: Vec<String> = files.iter().filter_map(|f| f.file_name()).map(|n| n.to_string_lossy().into_owned()).collect();
        return Ok(vec![Microphone { id: fake::ID.into(), name: format!("Fake microphone ({})", names.join(", ")), default: true }]);
    }
    device::list()
}

/// The device captures open from now on (a capture already running keeps its device). `None`:
/// the system default; a device that is gone also falls back to it.
pub fn set_device(id: Option<String>) {
    *DEVICE.lock().unwrap_or_else(|e| e.into_inner()) = id;
}

static DEVICE: Mutex<Option<String>> = Mutex::new(None);

/// A running capture; `stop` only signals it (it may be called from the device's own threads).
trait Capture: Send {
    fn stop(self: Box<Self>);
}

#[derive(Default)]
struct Hub {
    state: Mutex<HubState>,
}

#[derive(Default)]
struct HubState {
    subs: Vec<(u64, Sender<Chunk>)>,
    next_id: u64,
    capture: Option<Box<dyn Capture>>,
    /// The device's rate and the converter to 16 kHz.
    resampler: Option<(u32, Resampler)>,
}

static HUB: LazyLock<Hub> = LazyLock::new(Hub::default);

fn hub() -> &'static Hub {
    &HUB
}

impl Hub {
    fn lock(&self) -> std::sync::MutexGuard<'_, HubState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn subscribe(&'static self) -> Result<MicStream, VoiceError> {
        let mut st = self.lock();
        if st.capture.is_none() {
            st.resampler = None;
            st.capture = Some(start_capture(self)?);
        }
        let (tx, rx) = mpsc::channel();
        let id = st.next_id;
        st.next_id += 1;
        st.subs.push((id, tx));
        Ok(MicStream { id, rx })
    }

    fn unsubscribe(&self, id: u64) {
        let capture = {
            let mut st = self.lock();
            st.subs.retain(|(i, _)| *i != id);
            if st.subs.is_empty() { st.capture.take() } else { None }
        };
        if let Some(c) = capture {
            c.stop();
        }
    }

    /// Mono samples at the device's `rate`.
    fn deliver(&self, rate: u32, mono: &[f32]) {
        let mut st = self.lock();
        if st.subs.is_empty() {
            return;
        }
        if st.resampler.as_ref().is_none_or(|(r, _)| *r != rate) {
            st.resampler = Some((rate, Resampler::to_16k(rate)));
        }
        let mut out = Vec::with_capacity(mono.len() * SAMPLE_RATE as usize / rate.max(1) as usize + 8);
        if let Some((_, rs)) = st.resampler.as_mut() {
            rs.process(mono, &mut out);
        }
        if out.is_empty() {
            return;
        }
        let chunk: Arc<[f32]> = out.into();
        st.subs.retain(|(_, tx)| tx.send(Chunk::Audio(Arc::clone(&chunk))).is_ok());
    }

    fn end(&self, error: Option<VoiceError>) {
        let capture = {
            let mut st = self.lock();
            for (_, tx) in st.subs.drain(..) {
                let _ = tx.send(Chunk::Ended(error.clone()));
            }
            st.capture.take()
        };
        if let Some(c) = capture {
            c.stop();
        }
    }
}

fn start_capture(hub: &'static Hub) -> Result<Box<dyn Capture>, VoiceError> {
    #[cfg(debug_assertions)]
    if let Some(path) = fake::next() {
        return fake::start(hub, path);
    }
    device::start(hub)
}

/// Debug builds: play these WAV files instead of a device, one per capture in turn (as
/// `TF_DICTATION_FAKE_MIC` does, which this overrides; `None` goes back to it). For tests.
#[cfg(debug_assertions)]
pub fn set_fake(files: Option<Vec<std::path::PathBuf>>) {
    *fake::FILES.lock().unwrap_or_else(|e| e.into_inner()) = files;
}

/// Signals a capture thread to finish (dropping its stream there).
struct ThreadCapture(Sender<()>);

impl Capture for ThreadCapture {
    fn stop(self: Box<Self>) {
        let _ = self.0.send(());
    }
}

mod device {
    use std::sync::mpsc;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    use super::{Capture, Hub, Microphone, ThreadCapture};
    use crate::{VoiceError, audio::downmix};

    fn classify(e: &cpal::Error) -> VoiceError {
        let message = e.to_string();
        match e.kind() {
            cpal::ErrorKind::PermissionDenied => VoiceError::Permission(message),
            _ => VoiceError::NoDevice(message),
        }
    }

    /// Stream errors that don't stop the capture: overruns, no realtime priority, the default
    /// device changing (the stream stays on the device it opened).
    fn harmless(e: &cpal::Error) -> bool {
        matches!(e.kind(), cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied | cpal::ErrorKind::DeviceChanged)
    }

    fn convert<T: Copy>(data: &[T], channels: usize, f: impl Fn(T) -> f32) -> Vec<f32> {
        let samples: Vec<f32> = data.iter().map(|&s| f(s)).collect();
        let mut mono = Vec::with_capacity(samples.len() / channels.max(1));
        downmix(&samples, channels, &mut mono);
        mono
    }

    /// The device [`super::set_device`] chose when it is there, else the system default.
    fn chosen(host: &cpal::Host) -> Option<cpal::Device> {
        let wanted = super::DEVICE.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let found = wanted.as_deref().and_then(|id| id.parse::<cpal::DeviceId>().ok()).and_then(|id| host.device_by_id(&id));
        if found.is_none()
            && let Some(id) = wanted
        {
            log::info!("tf-dictation: microphone {id} isn't there; using the default input");
        }
        found.or_else(|| host.default_input_device())
    }

    pub(super) fn list() -> Result<Vec<Microphone>, VoiceError> {
        let host = cpal::default_host();
        let default = host.default_input_device().and_then(|d| d.id().ok());
        let mut out: Vec<Microphone> = host
            .input_devices()
            .map_err(|e| classify(&e))?
            .filter_map(|d| {
                let id = d.id().ok()?;
                let name = d.description().map(|desc| desc.name().to_owned()).unwrap_or_else(|_| d.to_string());
                Some(Microphone { default: default.as_ref() == Some(&id), id: id.to_string(), name })
            })
            .collect();
        // The default first, the rest as the system lists them.
        out.sort_by_key(|m| !m.default);
        Ok(out)
    }

    pub(super) fn start(hub: &'static Hub) -> Result<Box<dyn Capture>, VoiceError> {
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), VoiceError>>(1);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        std::thread::Builder::new()
            .name("tf-mic".into())
            .spawn(move || {
                let open = || -> Result<cpal::Stream, VoiceError> {
                    let device = chosen(&cpal::default_host()).ok_or_else(|| VoiceError::NoDevice("no input device".into()))?;
                    let config = device.default_input_config().map_err(|e| classify(&e))?;
                    let rate = config.sample_rate();
                    let channels = usize::from(config.channels());
                    let format = config.sample_format();
                    let config: cpal::StreamConfig = config.into();
                    let on_error = move |e: cpal::Error| {
                        if harmless(&e) {
                            log::debug!("tf-dictation: microphone: {e}");
                        } else {
                            hub.end(Some(classify(&e)));
                        }
                    };
                    let stream = match format {
                        cpal::SampleFormat::F32 => device.build_input_stream(
                            config,
                            move |d: &[f32], _: &_| hub.deliver(rate, &convert(d, channels, |s| s)),
                            on_error,
                            None,
                        ),
                        cpal::SampleFormat::I16 => device.build_input_stream(
                            config,
                            move |d: &[i16], _: &_| hub.deliver(rate, &convert(d, channels, |s| f32::from(s) / 32768.0)),
                            on_error,
                            None,
                        ),
                        cpal::SampleFormat::I32 => device.build_input_stream(
                            config,
                            move |d: &[i32], _: &_| hub.deliver(rate, &convert(d, channels, |s| s as f32 / 2_147_483_648.0)),
                            on_error,
                            None,
                        ),
                        cpal::SampleFormat::U16 => device.build_input_stream(
                            config,
                            move |d: &[u16], _: &_| hub.deliver(rate, &convert(d, channels, |s| (f32::from(s) - 32768.0) / 32768.0)),
                            on_error,
                            None,
                        ),
                        other => return Err(VoiceError::NoDevice(format!("unsupported sample format {other}"))),
                    }
                    .map_err(|e| classify(&e))?;
                    stream.play().map_err(|e| classify(&e))?;
                    Ok(stream)
                };
                match open() {
                    Ok(stream) => {
                        let _ = ready_tx.send(Ok(()));
                        let _ = stop_rx.recv();
                        drop(stream);
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
            })
            .map_err(|e| VoiceError::Other(format!("can't start the microphone thread: {e}")))?;
        match ready_rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(Ok(())) => Ok(Box::new(ThreadCapture(stop_tx))),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                let _ = stop_tx.send(());
                Err(VoiceError::NoDevice("the microphone didn't start".into()))
            }
        }
    }
}

#[cfg(debug_assertions)]
mod fake {
    use std::{
        path::PathBuf,
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        time::{Duration, Instant},
    };

    use super::{Capture, Hub, ThreadCapture};
    use crate::{SAMPLE_RATE, VoiceError, audio::read_wav_16k};

    /// 20 ms.
    const CHUNK: usize = SAMPLE_RATE as usize / 50;
    /// The fake's [`super::Microphone::id`].
    pub(super) const ID: &str = "fake";

    /// [`super::set_fake`]'s files; ahead of the environment.
    pub(super) static FILES: Mutex<Option<Vec<PathBuf>>> = Mutex::new(None);

    pub(super) fn files() -> Option<Vec<PathBuf>> {
        let set = FILES.lock().unwrap_or_else(|e| e.into_inner()).clone();
        set.or_else(|| std::env::var_os("TF_DICTATION_FAKE_MIC").map(|v| std::env::split_paths(&v).collect())).filter(|f: &Vec<PathBuf>| !f.is_empty())
    }

    /// The file the next capture plays: each in turn.
    pub(super) fn next() -> Option<PathBuf> {
        static TURN: AtomicUsize = AtomicUsize::new(0);
        let files = files()?;
        Some(files[TURN.fetch_add(1, Ordering::Relaxed) % files.len()].clone())
    }

    pub(super) fn start(hub: &'static Hub, path: PathBuf) -> Result<Box<dyn Capture>, VoiceError> {
        let audio = read_wav_16k(&path).map_err(|e| VoiceError::NoDevice(format!("fake microphone {}: {e}", path.display())))?;
        log::info!("tf-dictation: fake microphone plays {} ({:.1} s)", path.display(), audio.len() as f32 / SAMPLE_RATE as f32);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        std::thread::Builder::new()
            .name("tf-mic-fake".into())
            .spawn(move || {
                let t0 = Instant::now();
                let silence = [0.0f32; CHUNK];
                for i in 0usize.. {
                    let due = t0 + Duration::from_millis(20 * i as u64);
                    if stop_rx.recv_timeout(due.saturating_duration_since(Instant::now())) != Err(mpsc::RecvTimeoutError::Timeout) {
                        return;
                    }
                    let from = i * CHUNK;
                    let chunk = if from < audio.len() { &audio[from..(from + CHUNK).min(audio.len())] } else { &silence[..] };
                    hub.deliver(SAMPLE_RATE, chunk);
                }
            })
            .map_err(|e| VoiceError::Other(format!("can't start the fake microphone: {e}")))?;
        Ok(Box::new(ThreadCapture(stop_tx)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hub fans one capture out to every consumer, converting to 16 kHz once.
    #[test]
    fn every_consumer_gets_the_same_16k_audio() {
        let hub = Hub::default();
        let (a_tx, a) = mpsc::channel();
        let (b_tx, b) = mpsc::channel();
        hub.lock().subs = vec![(0, a_tx), (1, b_tx)];
        hub.deliver(48_000, &vec![0.25f32; 4_800]);
        let got = |rx: &Receiver<Chunk>| -> usize {
            let mut n = 0;
            while let Ok(Chunk::Audio(c)) = rx.try_recv() {
                n += c.len();
            }
            n
        };
        let (na, nb) = (got(&a), got(&b));
        assert_eq!(na, nb);
        // 100 ms at 48 kHz → ~1600 samples at 16 kHz, less the filter's look-ahead.
        assert!((1_590..=1_600).contains(&na), "{na}");
    }

    #[test]
    fn an_ended_capture_reaches_every_consumer_and_closes() {
        let hub = Hub::default();
        let (a_tx, a) = mpsc::channel();
        hub.lock().subs = vec![(0, a_tx)];
        hub.end(Some(VoiceError::NoDevice("unplugged".into())));
        assert!(matches!(a.try_recv(), Ok(Chunk::Ended(Some(VoiceError::NoDevice(_))))));
        assert!(hub.lock().subs.is_empty());
        // Nothing left to deliver to.
        hub.deliver(16_000, &[0.5; 160]);
        assert!(a.try_recv().is_err());
    }

    /// A lab plays several recordings, one per dictation session: each capture takes the next
    /// file, and the fake is the only microphone listed while it plays.
    #[test]
    fn the_fake_microphone_plays_each_file_in_turn() {
        let (en, de) = (std::path::PathBuf::from("/lab/en.wav"), std::path::PathBuf::from("/lab/de.wav"));
        set_fake(Some(vec![en.clone(), de.clone()]));
        let first = fake::next().unwrap();
        let second = fake::next().unwrap();
        let third = fake::next().unwrap();
        assert_ne!(first, second);
        assert_eq!(first, third);
        assert!([&en, &de].contains(&&first));
        let listed = devices().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].id.as_str(), listed[0].name.as_str(), listed[0].default), (fake::ID, "Fake microphone (en.wav, de.wav)", true));
        set_fake(None);
    }
}
