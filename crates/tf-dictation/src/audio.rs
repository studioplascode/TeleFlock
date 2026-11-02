//! Sample-rate conversion to the 16 kHz the models and the VAD take, and WAV files.

use std::path::{Path, PathBuf};

use crate::{SAMPLE_RATE, VoiceError};

/// Streaming band-limited resampler (windowed sinc, as Kaldi's `LinearResample`, which
/// sherpa-onnx uses itself): low-pass at 99 % of the lower Nyquist frequency, 6 zero crossings,
/// Hann window. Input arrives in chunks of any size; output follows as soon as the filter
/// window is covered, so the delay is under a millisecond.
pub struct Resampler {
    in_rate: f64,
    out_rate: f64,
    cutoff: f64,
    /// Half the filter's width in seconds.
    half: f64,
    /// Input samples from absolute index `start`.
    buf: Vec<f32>,
    start: u64,
    /// Absolute index of the next output sample.
    next: u64,
    passthrough: bool,
}

const ZEROS: f64 = 6.0;

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let cutoff = 0.99 * 0.5 * f64::from(in_rate.min(out_rate));
        Self {
            in_rate: f64::from(in_rate),
            out_rate: f64::from(out_rate),
            cutoff,
            half: ZEROS / (2.0 * cutoff),
            buf: Vec::new(),
            start: 0,
            next: 0,
            passthrough: in_rate == out_rate,
        }
    }

    pub fn to_16k(in_rate: u32) -> Self {
        Self::new(in_rate, SAMPLE_RATE)
    }

    fn weight(&self, dt: f64) -> f64 {
        if dt.abs() >= self.half {
            return 0.0;
        }
        let window = 0.5 * (1.0 + (std::f64::consts::TAU * self.cutoff / ZEROS * dt).cos());
        let filter = if dt == 0.0 { 2.0 * self.cutoff } else { (std::f64::consts::TAU * self.cutoff * dt).sin() / (std::f64::consts::PI * dt) };
        filter * window / self.in_rate
    }

    /// Appends the output for `input` to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.passthrough {
            out.extend_from_slice(input);
            return;
        }
        self.buf.extend_from_slice(input);
        self.drain(out, false);
    }

    /// Emits what the buffered input still owes (its last samples, as if silence followed).
    pub fn flush(&mut self, out: &mut Vec<f32>) {
        if self.passthrough {
            return;
        }
        self.drain(out, true);
        self.buf.clear();
    }

    fn drain(&mut self, out: &mut Vec<f32>, flush: bool) {
        let end = self.start + self.buf.len() as u64;
        loop {
            let t = self.next as f64 / self.out_rate;
            if flush && t * self.in_rate >= end as f64 {
                break;
            }
            let last = ((t + self.half) * self.in_rate).floor() as i64;
            if !flush && last >= end as i64 {
                break;
            }
            let first = (((t - self.half) * self.in_rate).ceil() as i64).max(self.start as i64);
            let last = last.min(end as i64 - 1);
            let mut acc = 0.0f64;
            for j in first..=last {
                let x = self.buf[(j as u64 - self.start) as usize];
                acc += f64::from(x) * self.weight(t - j as f64 / self.in_rate);
            }
            out.push(acc as f32);
            self.next += 1;
        }
        // Keep only what the next output's window still reaches.
        let t = self.next as f64 / self.out_rate;
        let keep_from = (((t - self.half) * self.in_rate).ceil() as i64).max(self.start as i64) as u64;
        let drop = (keep_from - self.start).min(self.buf.len() as u64) as usize;
        self.buf.drain(..drop);
        self.start += drop as u64;
    }
}

/// Averages interleaved channels into one.
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    let scale = 1.0 / channels as f32;
    out.extend(interleaved.chunks_exact(channels).map(|f| f.iter().sum::<f32>() * scale));
}

/// Root mean square of a chunk (0 – 1 for full-scale audio).
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// A WAV file (PCM 8–32 bit or float, any rate and channel count) read as 16 kHz mono, a piece
/// at a time: a transcription never holds a whole recording (an hour at 16 kHz is 230 MB as
/// floats, three times that while it is converted).
pub struct Wav16k {
    reader: hound::WavReader<std::io::BufReader<std::fs::File>>,
    path: PathBuf,
    resampler: Resampler,
    /// The resampler's last samples went out: the file is through.
    flushed: bool,
    interleaved: Vec<f32>,
    mono: Vec<f32>,
}

impl Wav16k {
    pub fn open(path: &Path) -> Result<Self, VoiceError> {
        let reader = hound::WavReader::open(path).map_err(|e| VoiceError::Other(format!("can't read {}: {e}", path.display())))?;
        let resampler = Resampler::to_16k(reader.spec().sample_rate);
        Ok(Self { reader, path: path.to_path_buf(), resampler, flushed: false, interleaved: Vec::new(), mono: Vec::new() })
    }

    /// The file's own rate.
    pub fn rate(&self) -> u32 {
        self.reader.spec().sample_rate
    }

    /// Its length at 16 kHz, as its header says.
    pub fn len_16k(&self) -> u64 {
        u64::from(self.reader.duration()) * u64::from(SAMPLE_RATE) / u64::from(self.rate().max(1))
    }

    /// Appends the next `frames` of the file (fewer at its end) to `out` as 16 kHz mono; the end
    /// brings the resampler's last samples along. `false` once the file is through.
    pub fn read(&mut self, frames: usize, out: &mut Vec<f32>) -> Result<bool, VoiceError> {
        if self.flushed {
            return Ok(false);
        }
        let spec = self.reader.spec();
        let channels = usize::from(spec.channels.max(1));
        let want = frames.max(1) * channels;
        let path = &self.path;
        let bad = |e: hound::Error| VoiceError::Other(format!("can't read {}: {e}", path.display()));
        self.interleaved.clear();
        match spec.sample_format {
            hound::SampleFormat::Float => {
                for s in self.reader.samples::<f32>().take(want) {
                    self.interleaved.push(s.map_err(bad)?);
                }
            }
            hound::SampleFormat::Int => {
                let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
                for s in self.reader.samples::<i32>().take(want) {
                    self.interleaved.push(s.map_err(bad)? as f32 * scale);
                }
            }
        }
        self.mono.clear();
        downmix(&self.interleaved, channels, &mut self.mono);
        self.resampler.process(&self.mono, out);
        if self.interleaved.len() < want {
            self.resampler.flush(out);
            self.flushed = true;
        }
        Ok(true)
    }
}

/// Reads a WAV file (PCM 8–32 bit or float, any rate and channel count) as 16 kHz mono, whole.
pub fn read_wav_16k(path: &Path) -> Result<Vec<f32>, VoiceError> {
    let mut wav = Wav16k::open(path)?;
    let mut out = Vec::with_capacity(wav.len_16k() as usize + 16);
    while wav.read(SAMPLE_RATE as usize, &mut out)? {}
    Ok(out)
}

/// 16 kHz mono 16-bit PCM WAV writer.
pub fn wav_spec_16k() -> hound::WavSpec {
    hound::WavSpec { channels: 1, sample_rate: SAMPLE_RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int }
}

pub fn to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, rate: u32, secs: f64) -> Vec<f32> {
        let n = (f64::from(rate) * secs) as usize;
        (0..n).map(|i| (std::f64::consts::TAU * freq * i as f64 / f64::from(rate)).sin() as f32 * 0.5).collect()
    }

    /// Amplitude of `freq` in `x` (single-bin DFT), sampled at `rate`.
    fn amplitude(x: &[f32], freq: f64, rate: u32) -> f64 {
        let (mut re, mut im) = (0.0, 0.0);
        for (i, s) in x.iter().enumerate() {
            let ph = std::f64::consts::TAU * freq * i as f64 / f64::from(rate);
            re += f64::from(*s) * ph.cos();
            im -= f64::from(*s) * ph.sin();
        }
        2.0 * (re * re + im * im).sqrt() / x.len() as f64
    }

    fn resample_chunked(x: &[f32], from: u32, chunk: usize) -> Vec<f32> {
        let mut rs = Resampler::new(from, 16_000);
        let mut out = Vec::new();
        for c in x.chunks(chunk) {
            rs.process(c, &mut out);
        }
        rs.flush(&mut out);
        out
    }

    #[test]
    fn keeps_speech_band_tones_and_length() {
        for from in [48_000, 44_100, 22_050, 8_000] {
            let x = sine(440.0, from, 1.0);
            let y = resample_chunked(&x, from, 441);
            assert!((y.len() as i64 - 16_000).abs() <= 2, "{from}: {} samples", y.len());
            // Skip the edges (the filter's ramp).
            let a = amplitude(&y[400..15_600], 440.0, 16_000);
            assert!((a - 0.5).abs() < 0.01, "{from}: amplitude {a}");
        }
    }

    #[test]
    fn removes_what_16k_cannot_hold() {
        // 12 kHz at 48 kHz would alias to 4 kHz after plain decimation.
        let x = sine(12_000.0, 48_000, 1.0);
        let y = resample_chunked(&x, 48_000, 480);
        assert!(amplitude(&y[400..15_600], 4_000.0, 16_000) < 0.005);
        assert!(rms(&y[400..15_600]) < 0.005);
    }

    #[test]
    fn chunk_boundaries_do_not_matter() {
        let x = sine(1000.0, 44_100, 0.5);
        let a = resample_chunked(&x, 44_100, 7);
        let b = resample_chunked(&x, 44_100, 4096);
        assert_eq!(a.len(), b.len());
        assert!(a.iter().zip(&b).all(|(p, q)| (p - q).abs() < 1e-6));
    }

    #[test]
    fn same_rate_passes_through() {
        let x = sine(300.0, 16_000, 0.1);
        assert_eq!(resample_chunked(&x, 16_000, 100), x);
    }

    #[test]
    fn downmix_averages_channels() {
        let mut out = Vec::new();
        downmix(&[1.0, 0.0, 0.5, 0.5, -1.0, 1.0], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.5, 0.0]);
    }

    /// Whole, or a piece at a time as a transcription reads it: the same samples.
    #[test]
    fn reads_any_wav_as_16k_mono() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.wav");
        let spec = hound::WavSpec { channels: 2, sample_rate: 48_000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for s in sine(440.0, 48_000, 0.5) {
            w.write_sample(to_i16(s)).unwrap();
            w.write_sample(to_i16(s)).unwrap();
        }
        w.finalize().unwrap();
        let y = read_wav_16k(&path).unwrap();
        assert!((y.len() as i64 - 8_000).abs() <= 2);
        assert!((amplitude(&y[400..7_600], 440.0, 16_000) - 0.5).abs() < 0.01);

        let mut wav = Wav16k::open(&path).unwrap();
        assert_eq!((wav.rate(), wav.len_16k()), (48_000, 8_000));
        let (mut pieces, mut piece) = (Vec::new(), Vec::new());
        while wav.read(333, &mut piece).unwrap() {
            assert!(piece.len() < 200, "{} samples at once", piece.len());
            pieces.append(&mut piece);
        }
        assert_eq!(pieces, y);
    }
}
