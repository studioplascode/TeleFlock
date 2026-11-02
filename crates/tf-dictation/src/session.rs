//! Live dictation: microphone → voice activity → one decode per finished utterance, interim
//! decodes while one is spoken.
//!
//! Events of a session, in order: `Listening` once, then `Interim` / `Final` / `Error` as they
//! come, and always `End` last (after `stop`, `cancel`, an error, a minute without speech, or
//! the microphone going away).

use std::{
    path::PathBuf,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

use crate::{
    VoiceError,
    mic::{Chunk, MicStream},
    segment::{Detector, Segmenter, Step},
};

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The microphone is open; speech from now on is heard (the model may still be loading).
    Listening,
    /// What is being said, so far (each replaces the previous one).
    Interim(String),
    /// A finished utterance, in order.
    Final(String),
    Error(VoiceError),
    /// Always last.
    End,
}

#[derive(Debug, Clone)]
pub struct SessionOpts {
    pub data_dir: PathBuf,
    /// The device locale (`de-DE`): the language for a model that needs one when the user's
    /// choice is `auto`.
    pub locale: Option<String>,
}

pub(crate) enum Cmd {
    /// Finish the utterance in progress, then end.
    Stop,
    /// End now, dropping the utterance in progress.
    Cancel,
}

pub struct Session {
    cmd: mpsc::Sender<Cmd>,
    /// The microphone until the session listens (the models load first): a cancel meanwhile
    /// takes it, which closes it at once.
    mic: Arc<Mutex<Option<MicStream>>>,
}

/// Without speech for this long, a session ends by itself (a forgotten open microphone).
const IDLE_END: Duration = Duration::from_secs(60);
/// Interim decodes are skipped when one would likely take longer than this (big models on
/// long utterances): the final text must not wait behind them.
const INTERIM_BUDGET: Duration = Duration::from_millis(350);

impl Session {
    /// Checks the model and opens the microphone, then listens on a thread of its own. Errors
    /// here mean nothing started (no events follow).
    pub fn start(opts: SessionOpts, sink: impl Fn(Event) + Send + 'static) -> Result<Self, VoiceError> {
        #[cfg(not(feature = "engine"))]
        {
            let _ = (opts, sink);
            Err(VoiceError::NoEngine)
        }
        #[cfg(feature = "engine")]
        {
            let (store, model, language) = crate::chosen(&opts.data_dir, None, opts.locale.as_deref())?;
            let mic = Arc::new(Mutex::new(Some(crate::mic::open()?)));
            let (cmd, cmd_rx) = mpsc::channel();
            sink(Event::Listening);
            let held = Arc::clone(&mic);
            std::thread::Builder::new()
                .name("tf-dictation".into())
                .spawn(move || {
                    let listened = load_and_listen(
                        &held,
                        cmd_rx,
                        || crate::engine::Vad::new(&crate::vad_model(&store)?, crate::engine::DICTATION_VAD),
                        || crate::recognizer(&store, model, language),
                        |recognizer, audio| recognizer.decode(audio),
                        &sink,
                    );
                    if let Err(e) = listened {
                        sink(Event::Error(e));
                    }
                    sink(Event::End);
                })
                .map_err(|e| VoiceError::Other(format!("can't start dictation: {e}")))?;
            Ok(Self { cmd, mic })
        }
    }

    /// Stops listening; what is being said still arrives as a final (also when the model is
    /// still loading: everything said meanwhile is decoded then).
    pub fn stop(&self) {
        let _ = self.cmd.send(Cmd::Stop);
    }

    /// Stops listening and drops what is being said. The microphone closes at once, also while
    /// the models load.
    pub fn cancel(&self) {
        let taken = self.mic.lock().unwrap_or_else(|e| e.into_inner()).take();
        drop(taken);
        let _ = self.cmd.send(Cmd::Cancel);
    }
}

/// A session's thread: the detector loads, then the recognizer (seconds for a large model), then
/// [`listen`] takes the microphone. A cancel meanwhile took the microphone already
/// ([`Session::cancel`]): the recognizer is then not loaded, or not used.
#[cfg_attr(not(feature = "engine"), allow(dead_code))]
fn load_and_listen<D: Detector, R>(
    mic: &Mutex<Option<MicStream>>,
    cmd: mpsc::Receiver<Cmd>,
    detector: impl FnOnce() -> Result<D, VoiceError>,
    recognizer: impl FnOnce() -> Result<R, VoiceError>,
    decode: impl Fn(&R, &[f32]) -> String,
    sink: &dyn Fn(Event),
) -> Result<(), VoiceError> {
    let held = || mic.lock().unwrap_or_else(|e| e.into_inner());
    let detector = detector()?;
    if held().is_none() {
        return Ok(());
    }
    let recognizer = recognizer()?;
    let Some(stream) = held().take() else { return Ok(()) };
    listen(stream, cmd, Segmenter::new(detector), &|audio| decode(&recognizer, audio), sink)
}

/// The session loop, independent of the engine (tests drive it with a fake detector and
/// decoder). Returns when the session should end; `End` is the caller's.
pub(crate) fn listen<D: Detector>(
    stream: MicStream,
    cmd: mpsc::Receiver<Cmd>,
    mut seg: Segmenter<D>,
    decode: &dyn Fn(&[f32]) -> String,
    sink: &dyn Fn(Event),
) -> Result<(), VoiceError> {
    let mut last_speech = Instant::now();
    // Decode seconds per audio second, measured (starts optimistic).
    let mut rtf = 0.05f64;
    let decode_timed = |audio: &[f32], rtf: &mut f64| -> String {
        let t0 = Instant::now();
        let text = decode(audio);
        let secs = audio.len() as f64 / f64::from(crate::SAMPLE_RATE);
        if secs > 0.5 {
            *rtf = 0.7 * *rtf + 0.3 * (t0.elapsed().as_secs_f64() / secs);
        }
        text
    };
    let mut ended = None;
    loop {
        match cmd.try_recv() {
            Ok(Cmd::Cancel) => return Ok(()),
            Ok(Cmd::Stop) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        // Everything that arrived meanwhile (a slow decode is caught up in one go).
        let mut audio = Vec::new();
        match stream.recv_timeout(Duration::from_millis(50)) {
            Ok(Chunk::Audio(c)) => audio.extend_from_slice(&c),
            Ok(Chunk::Ended(e)) => {
                ended = Some(e);
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                ended = Some(None);
                break;
            }
        }
        while let Ok(c) = stream.try_recv() {
            match c {
                Chunk::Audio(c) => audio.extend_from_slice(&c),
                Chunk::Ended(e) => {
                    ended = Some(e);
                    break;
                }
            }
        }
        let mut interim = None;
        for step in seg.push(&audio) {
            match step {
                Step::Final(a) => {
                    interim = None;
                    let text = decode_timed(&a, &mut rtf);
                    if !text.is_empty() {
                        sink(Event::Final(text));
                    }
                }
                Step::Interim(a) => interim = Some(a),
            }
        }
        if seg.speaking() {
            last_speech = Instant::now();
        }
        if let Some(a) = interim {
            let expected = Duration::from_secs_f64(rtf * a.len() as f64 / f64::from(crate::SAMPLE_RATE));
            if expected <= INTERIM_BUDGET {
                let text = decode_timed(&a, &mut rtf);
                if !text.is_empty() {
                    sink(Event::Interim(text));
                }
            }
        }
        if ended.is_some() {
            break;
        }
        if last_speech.elapsed() >= IDLE_END {
            log::info!("tf-dictation: no speech for {} s, stopping", IDLE_END.as_secs());
            break;
        }
    }
    // What the microphone delivered since: all of it is still waiting when the user stopped while
    // the model loaded (or a decode ran). Taken, the microphone closes; then it is decoded, the
    // utterance in progress last.
    let mut rest = Vec::new();
    while ended.is_none() {
        match stream.try_recv() {
            Ok(Chunk::Audio(c)) => rest.extend_from_slice(&c),
            Ok(Chunk::Ended(e)) => ended = Some(e),
            Err(_) => break,
        }
    }
    drop(stream);
    let mut steps = seg.push(&rest);
    steps.extend(seg.finish());
    for step in steps {
        if let Step::Final(a) = step {
            let text = decode_timed(&a, &mut rtf);
            if !text.is_empty() {
                sink(Event::Final(text));
            }
        }
    }
    match ended {
        Some(Some(e)) => Err(e),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::segment::tests::{EnergyDetector, silence, tone};

    /// Feeds `audio` through a test microphone, 20 ms chunks at 20× real time (so the loop sees
    /// it arrive as from a device), then `end_mic` or, 100 ms later, `cmd`.
    fn run(audio: Vec<f32>, cmd: Option<Cmd>, end_mic: Option<Option<VoiceError>>) -> (Vec<Event>, Result<(), VoiceError>) {
        let (stream, tx) = MicStream::test();
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let feeder = std::thread::spawn(move || {
            for c in audio.chunks(320) {
                tx.send(Chunk::Audio(c.to_vec().into())).unwrap();
                std::thread::sleep(Duration::from_millis(1));
            }
            if let Some(e) = end_mic {
                tx.send(Chunk::Ended(e)).unwrap();
            }
            tx
        });
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = Arc::clone(&events);
        let handle = std::thread::spawn(move || {
            let decoder = |a: &[f32]| format!("{:.1}s", a.len() as f32 / 16_000.0);
            listen(stream, cmd_rx, Segmenter::new(EnergyDetector::new(8_000)), &decoder, &move |e| sink_events.lock().unwrap().push(e))
        });
        let tx = feeder.join().unwrap();
        if let Some(c) = cmd {
            std::thread::sleep(Duration::from_millis(100));
            let _ = cmd_tx.send(c);
        }
        let r = handle.join().unwrap();
        drop(tx);
        let ev = events.lock().unwrap().clone();
        (ev, r)
    }

    fn finals(ev: &[Event]) -> Vec<String> {
        ev.iter()
            .filter_map(|e| match e {
                Event::Final(t) => Some(t.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn utterances_arrive_in_order_and_stop_finishes_the_last() {
        let mut audio = tone(1.0, 0.5);
        audio.extend(silence(0.6));
        audio.extend(tone(1.5, 0.5));
        // The second utterance is still going when the user stops.
        let (ev, r) = run(audio, Some(Cmd::Stop), None);
        r.unwrap();
        assert_eq!(finals(&ev), ["1.0s", "1.5s"]);
        // Interim text came while speaking, never after the last final.
        assert!(ev.iter().any(|e| matches!(e, Event::Interim(_))));
        assert!(matches!(ev.last(), Some(Event::Final(_))));
    }

    #[test]
    fn cancel_drops_the_utterance_in_progress() {
        let mut audio = tone(1.0, 0.5);
        audio.extend(silence(0.6));
        audio.extend(tone(1.5, 0.5));
        let (ev, r) = run(audio, Some(Cmd::Cancel), None);
        r.unwrap();
        assert_eq!(finals(&ev), ["1.0s"]);
    }

    #[test]
    fn a_lost_microphone_keeps_what_was_said_and_reports_why() {
        let audio = tone(1.2, 0.5);
        let (ev, r) = run(audio, None, Some(Some(VoiceError::NoDevice("unplugged".into()))));
        assert_eq!(r, Err(VoiceError::NoDevice("unplugged".into())));
        assert_eq!(finals(&ev), ["1.2s"]);
    }

    #[test]
    fn the_app_leaving_the_front_ends_quietly() {
        let (ev, r) = run(tone(0.8, 0.5), None, Some(None));
        r.unwrap();
        assert_eq!(finals(&ev), ["0.8s"]);
    }

    /// The user stopped while the model was still loading: the stop is waiting when listening
    /// begins, and so is everything said meanwhile. All of it arrives, as finals.
    #[test]
    fn a_stop_while_the_model_loads_keeps_what_was_said() {
        let (stream, tx) = MicStream::test();
        let mut audio = tone(1.0, 0.5);
        audio.extend(silence(0.6));
        audio.extend(tone(1.5, 0.5));
        for c in audio.chunks(320) {
            tx.send(Chunk::Audio(c.to_vec().into())).unwrap();
        }
        let (cmd_tx, cmd_rx) = mpsc::channel();
        cmd_tx.send(Cmd::Stop).unwrap();
        let events = Mutex::new(Vec::new());
        let decoder = |a: &[f32]| format!("{:.1}s", a.len() as f32 / 16_000.0);
        listen(stream, cmd_rx, Segmenter::new(EnergyDetector::new(8_000)), &decoder, &|e| events.lock().unwrap().push(e)).unwrap();
        let ev = events.into_inner().unwrap();
        assert_eq!(finals(&ev), ["1.0s", "1.5s"]);
        assert!(ev.iter().all(|e| matches!(e, Event::Final(_))), "nothing partial once stopped: {ev:?}");
        drop(tx);
    }

    /// `Session::start`'s thread on the test microphone, the detector's load (`slow_detector`)
    /// or else the recognizer's held up until the test lets go. Cancels once that load began and
    /// checks the microphone closed right then. Whether the recognizer loaded, and the events.
    fn cancel_while_loading(slow_detector: bool) -> (bool, Vec<Event>) {
        let (stream, tx) = MicStream::test();
        let (cmd, cmd_rx) = mpsc::channel();
        let session = Session { cmd, mic: Arc::new(Mutex::new(Some(stream))) };
        let mic = Arc::clone(&session.mic);
        let (began_tx, began) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let recognizer_loaded = Arc::new(AtomicBool::new(false));
        let loaded = Arc::clone(&recognizer_loaded);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = Arc::clone(&events);
        let thread = std::thread::spawn(move || {
            let hold = |now: bool| {
                if now {
                    began_tx.send(()).unwrap();
                    released.recv().unwrap();
                }
            };
            load_and_listen(
                &mic,
                cmd_rx,
                || {
                    hold(slow_detector);
                    Ok(EnergyDetector::new(8_000))
                },
                || {
                    loaded.store(true, Ordering::SeqCst);
                    hold(!slow_detector);
                    Ok(())
                },
                |_: &(), _: &[f32]| String::from("text"),
                &move |e| sink_events.lock().unwrap().push(e),
            )
        });
        began.recv().unwrap();
        tx.send(Chunk::Audio(tone(0.5, 0.5).into())).expect("the microphone is open while the models load");
        session.cancel();
        assert!(tx.send(Chunk::Audio(tone(0.5, 0.5).into())).is_err(), "the cancel closed the microphone at once");
        release.send(()).unwrap();
        thread.join().unwrap().unwrap();
        let ev = events.lock().unwrap().clone();
        (recognizer_loaded.load(Ordering::SeqCst), ev)
    }

    /// A cancel (or the page closing) while the detector loads: the recognizer isn't loaded.
    #[test]
    fn a_cancel_while_the_detector_loads_skips_the_recognizer() {
        let (recognizer_loaded, ev) = cancel_while_loading(true);
        assert!(!recognizer_loaded);
        assert!(ev.is_empty(), "{ev:?}");
    }

    /// A cancel while the recognizer loads (seconds for a large model) closes the microphone
    /// then, not once the load ended.
    #[test]
    fn a_cancel_while_the_recognizer_loads_closes_the_microphone_at_once() {
        let (recognizer_loaded, ev) = cancel_while_loading(false);
        assert!(recognizer_loaded);
        assert!(ev.is_empty(), "{ev:?}");
    }
}
