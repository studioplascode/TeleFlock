//! Utterance segmentation for live dictation: a voice activity detector cuts the microphone
//! stream into utterances (a final decode each) and, while one is being spoken, asks for
//! interim decodes of what was said so far.

use std::collections::VecDeque;

use crate::SAMPLE_RATE;

/// A voice activity detector over 16 kHz mono audio.
pub trait Detector: Send {
    fn accept(&mut self, samples: &[f32]);
    /// Speech is going on (including the pause that may still end the utterance).
    fn speaking(&self) -> bool;
    /// The next finished utterance: its first sample's index (from the first sample accepted)
    /// and its samples.
    fn pop(&mut self) -> Option<(u64, Vec<f32>)>;
    /// End of input: speech in progress becomes an utterance.
    fn flush(&mut self);
}

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// What has been said of the utterance in progress (decode it and show it as interim text).
    Interim(Vec<f32>),
    /// A finished utterance, in order.
    Final(Vec<f32>),
}

/// Audio between interim decodes of an utterance in progress.
pub const INTERIM_EVERY: u64 = SAMPLE_RATE as u64 / 2;
/// The detector reports speech once it has lasted a little (min speech duration plus a window):
/// interim audio starts this much before that moment.
const LEAD: u64 = SAMPLE_RATE as u64 / 2;
/// Most audio kept for interim decodes (the detector splits longer utterances).
const MAX_INTERIM: u64 = 30 * SAMPLE_RATE as u64;
/// The detector steps through audio this much at a time (Silero's window at 16 kHz, 32 ms),
/// so speech is placed to the window where it was said even in audio that piled up.
pub(crate) const WINDOW: usize = 512;

pub struct Segmenter<D> {
    det: D,
    /// Recent audio, from absolute sample `hist_start`.
    hist: VecDeque<f32>,
    hist_start: u64,
    total: u64,
    /// Start of the utterance in progress (estimate), once the detector heard speech.
    speech_from: Option<u64>,
    /// `total` when the last interim was handed out.
    interim_at: u64,
}

impl<D: Detector> Segmenter<D> {
    pub fn new(det: D) -> Self {
        Self { det, hist: VecDeque::new(), hist_start: 0, total: 0, speech_from: None, interim_at: 0 }
    }

    /// Feeds audio; returns finished utterances in order, then at most one interim request.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Step> {
        let mut steps = Vec::new();
        // A window at a time: in audio that piled up (a model loading, a decode running) an
        // utterance's interim audio still starts where it was said, not at the end of the pile.
        for w in samples.chunks(WINDOW) {
            self.det.accept(w);
            self.hist.extend(w);
            self.total += w.len() as u64;
            steps.extend(self.finals());
            if !self.det.speaking() {
                self.speech_from = None;
            } else if self.speech_from.is_none() {
                // Just heard: the first interim comes once there is more to show.
                self.interim_at = self.total;
                self.speech_from = Some(self.total.saturating_sub(LEAD).max(self.hist_start));
            }
        }
        if let Some(from) = self.speech_from
            && self.total - self.interim_at.max(from) >= INTERIM_EVERY
        {
            self.interim_at = self.total;
            let from = from.max(self.total.saturating_sub(MAX_INTERIM)).max(self.hist_start);
            steps.push(Step::Interim(self.hist.range((from - self.hist_start) as usize..).copied().collect()));
        }
        self.trim();
        steps
    }

    /// End of input: the utterance in progress, if any, as final.
    pub fn finish(&mut self) -> Vec<Step> {
        self.det.flush();
        let steps = self.finals();
        self.speech_from = None;
        steps
    }

    /// Whether an utterance is in progress.
    pub fn speaking(&self) -> bool {
        self.det.speaking()
    }

    fn finals(&mut self) -> Vec<Step> {
        let mut steps = Vec::new();
        while let Some((_, seg)) = self.det.pop() {
            if seg.is_empty() {
                continue;
            }
            steps.push(Step::Final(seg));
            // The next utterance starts after this one.
            self.speech_from = None;
            self.interim_at = self.total;
        }
        steps
    }

    /// Keeps what an interim decode may still need: the utterance in progress, else a lead-in.
    fn trim(&mut self) {
        let keep_from = match self.speech_from {
            Some(from) => from.max(self.total.saturating_sub(MAX_INTERIM)),
            None => self.total.saturating_sub(LEAD),
        };
        if keep_from > self.hist_start {
            let n = ((keep_from - self.hist_start) as usize).min(self.hist.len());
            self.hist.drain(..n);
            self.hist_start += n as u64;
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Speech = samples above 0.1 in magnitude; an utterance ends after `silence` quiet samples.
    pub struct EnergyDetector {
        silence: u64,
        pos: u64,
        cur: Option<(u64, Vec<f32>, u64)>,
        done: VecDeque<(u64, Vec<f32>)>,
    }

    impl EnergyDetector {
        pub fn new(silence: u64) -> Self {
            Self { silence, pos: 0, cur: None, done: VecDeque::new() }
        }
    }

    impl Detector for EnergyDetector {
        fn accept(&mut self, samples: &[f32]) {
            for &s in samples {
                let loud = s.abs() > 0.1;
                match &mut self.cur {
                    Some((_, buf, quiet)) => {
                        buf.push(s);
                        *quiet = if loud { 0 } else { *quiet + 1 };
                        if *quiet >= self.silence {
                            let (start, mut buf, quiet) = self.cur.take().unwrap();
                            buf.truncate(buf.len() - quiet as usize);
                            self.done.push_back((start, buf));
                        }
                    }
                    None if loud => self.cur = Some((self.pos, vec![s], 0)),
                    None => {}
                }
                self.pos += 1;
            }
        }
        fn speaking(&self) -> bool {
            self.cur.is_some()
        }
        fn pop(&mut self) -> Option<(u64, Vec<f32>)> {
            self.done.pop_front()
        }
        fn flush(&mut self) {
            if let Some((start, mut buf, quiet)) = self.cur.take() {
                buf.truncate(buf.len() - quiet as usize);
                self.done.push_back((start, buf));
            }
        }
    }

    /// `secs` of speech-like signal at amplitude `level`.
    pub fn tone(secs: f32, level: f32) -> Vec<f32> {
        (0..(secs * SAMPLE_RATE as f32) as usize).map(|i| if i % 2 == 0 { level } else { -level }).collect()
    }

    pub fn silence(secs: f32) -> Vec<f32> {
        vec![0.0; (secs * SAMPLE_RATE as f32) as usize]
    }

    fn feed(seg: &mut Segmenter<EnergyDetector>, audio: &[f32]) -> Vec<Step> {
        // 20 ms chunks, as the microphone delivers them.
        audio.chunks(320).flat_map(|c| seg.push(c)).collect()
    }

    fn summary(steps: &[Step]) -> Vec<String> {
        steps
            .iter()
            .map(|s| match s {
                Step::Interim(a) => format!("interim {:.1}", a.len() as f32 / SAMPLE_RATE as f32),
                Step::Final(a) => format!("final {:.1}", a.len() as f32 / SAMPLE_RATE as f32),
            })
            .collect()
    }

    #[test]
    fn utterances_come_out_in_order_after_their_pause() {
        let mut seg = Segmenter::new(EnergyDetector::new(8_000));
        let mut audio = silence(0.3);
        audio.extend(tone(1.0, 0.5));
        audio.extend(silence(0.6));
        audio.extend(tone(2.0, 0.5));
        audio.extend(silence(0.6));
        let steps = feed(&mut seg, &audio);
        let finals: Vec<_> = summary(&steps).into_iter().filter(|s| s.starts_with("final")).collect();
        assert_eq!(finals, ["final 1.0", "final 2.0"]);
        assert!(!seg.speaking());
        assert!(seg.finish().is_empty());
    }

    #[test]
    fn interim_audio_grows_with_the_utterance_and_starts_before_detection() {
        let mut seg = Segmenter::new(EnergyDetector::new(8_000));
        let mut audio = silence(1.0);
        audio.extend(tone(2.0, 0.5));
        let steps = feed(&mut seg, &audio);
        let interims: Vec<usize> = steps
            .iter()
            .filter_map(|s| match s {
                Step::Interim(a) => Some(a.len()),
                Step::Final(_) => None,
            })
            .collect();
        // Every half second of speech, each covering everything since just before it began.
        assert_eq!(interims.len(), 3, "{interims:?}");
        assert!(interims.windows(2).all(|w| w[1] > w[0]));
        let last = *interims.last().unwrap() as u64;
        assert!(last >= 2 * SAMPLE_RATE as u64 - 320 && last <= 2 * SAMPLE_RATE as u64 + LEAD, "{last}");
    }

    #[test]
    fn stopping_mid_utterance_finishes_it() {
        let mut seg = Segmenter::new(EnergyDetector::new(8_000));
        let steps = feed(&mut seg, &tone(1.5, 0.5));
        assert!(steps.iter().all(|s| matches!(s, Step::Interim(_))));
        assert_eq!(summary(&seg.finish()), ["final 1.5"]);
        assert!(seg.finish().is_empty());
    }

    #[test]
    fn silence_alone_asks_for_nothing_and_keeps_little() {
        let mut seg = Segmenter::new(EnergyDetector::new(8_000));
        assert!(feed(&mut seg, &silence(30.0)).is_empty());
        assert!(seg.hist.len() as u64 <= LEAD + 320);
    }

    #[test]
    fn interims_restart_with_each_utterance() {
        let mut seg = Segmenter::new(EnergyDetector::new(8_000));
        let mut audio = tone(1.2, 0.5);
        audio.extend(silence(0.6));
        audio.extend(tone(0.8, 0.5));
        let steps = feed(&mut seg, &audio);
        let after_final: Vec<_> = steps.iter().skip_while(|s| matches!(s, Step::Interim(_))).skip(1).collect();
        // The second utterance's interim covers it alone, not the first one's audio.
        let Some(Step::Interim(a)) = after_final.first() else { panic!("{:?}", summary(&steps)) };
        assert!((a.len() as u64) < SAMPLE_RATE as u64 + LEAD, "{}", a.len());
    }

    #[test]
    fn speech_in_audio_that_piled_up_is_shown_from_where_it_began() {
        // A session's first audio arrives at once: what was said while the model loaded.
        let mut seg = Segmenter::new(EnergyDetector::new(8_000));
        let mut audio = silence(1.0);
        audio.extend(tone(1.0, 0.5));
        let steps = seg.push(&audio);
        // Right away, an interim of everything said so far, from just before it began.
        let Some(Step::Interim(a)) = steps.last() else { panic!("{:?}", summary(&steps)) };
        assert!(a.len() as u64 >= SAMPLE_RATE as u64 && a.len() as u64 <= SAMPLE_RATE as u64 + LEAD, "{}", a.len());
    }
}
