//! The recording's video file: QuickTime (`.mov`) with the screencast's JPEGs as Photo-JPEG
//! (`jpeg` sample entry) at a constant 10 fps and the voice as 16 kHz mono 16-bit PCM (`sowt`).
//!
//! Every 100 ms slot is a video sample. A slot whose picture did not change points at the
//! previous frame's bytes (same `co64` chunk offset, its size in `stsz`), so the file holds each
//! JPEG once and still has a constant frame rate: `ffmpeg -ss T -i f -frames:v 1` (how omp's
//! `read` takes a frame) returns the picture visible at T, which variable frame rates (AVI
//! zero-length chunks, Matroska timestamps) get wrong. Every frame is a keyframe, so cuts are
//! frame-exact without re-encoding.
//!
//! Layout: `ftyp`, `mdat` (64-bit size) holding per slot its audio chunk and then the frames it
//! shows first, `moov` (after the data, so the writer needs one pass): `mvhd` (timescale 1000),
//! the video `trak` (timescale 10: one tick per slot) and the audio `trak` (timescale 16000, 1600
//! samples per chunk, one chunk per slot).

use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// One video sample per slot (10 fps).
pub const SLOT_MS: u64 = 100;
/// Voice sample rate.
pub const RATE: u32 = 16_000;
/// Voice samples per ms.
pub const SAMPLES_PER_MS: u64 = RATE as u64 / 1000;
const SLOT_SAMPLES: u64 = SLOT_MS * SAMPLES_PER_MS;
const FTYP_LEN: u64 = 20;
const MDAT_HEADER: u64 = 16;

/// A frame: when it shows (recording time) and where its JPEG is in the source file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame {
    pub t: u64,
    pub offset: u64,
    pub size: u32,
}

/// Where the samples of a 16 kHz mono 16-bit PCM WAV file are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WavData {
    /// File offset of the first sample.
    pub start: u64,
    pub samples: u64,
}

pub struct Input<'a> {
    /// In time order.
    pub frames: &'a [Frame],
    pub width: u16,
    pub height: u16,
    /// The file holding the frames' bytes (`frames.bin`, or `recording.mov` for a render).
    pub source: &'a Path,
    /// The voice and where it starts in recording time, ms.
    pub wav: Option<(&'a Path, u64)>,
    /// Recording time covered, ms.
    pub duration_ms: u64,
    /// Recording-time ranges `[start, end)` left out; may overlap or run past the end.
    pub cuts: &'a [(u64, u64)],
    /// Write every frame, shown or not (the stop: `frames.idx` then points into the video);
    /// otherwise only the frames a slot shows (a render: nothing of a cut range is in the file).
    pub all_frames: bool,
    /// Checked between writes: set, the writer stops with [`io::ErrorKind::Interrupted`].
    pub cancel: &'a AtomicBool,
}

#[derive(Debug)]
pub struct Muxed {
    /// Per input frame, where its JPEG is in the output (`None`: not written).
    pub offsets: Vec<Option<u64>>,
    /// File size.
    pub bytes: u64,
}

/// `[0, duration)` without the cuts: sorted, disjoint, non-empty ranges.
pub fn kept(duration: u64, cuts: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut cuts: Vec<(u64, u64)> = cuts.iter().map(|&(a, b)| (a.min(duration), b.min(duration))).filter(|(a, b)| a < b).collect();
    cuts.sort_unstable();
    let mut out = Vec::new();
    let mut at = 0;
    for (a, b) in cuts {
        if a > at {
            out.push((at, a));
        }
        at = at.max(b);
    }
    if at < duration {
        out.push((at, duration));
    }
    out
}

/// What goes into `mdat`, in order.
enum Op {
    /// The audio chunk of a slot.
    Audio(u64),
    /// A frame's JPEG.
    Frame(usize),
}

/// Writes `out` (through `<out>.part`, synced, then renamed into place).
pub fn write(out: &Path, input: &Input) -> io::Result<Muxed> {
    let part = out.with_extension("mov.part");
    let res = write_part(&part, input).and_then(|m| {
        std::fs::rename(&part, out)?;
        Ok(m)
    });
    if res.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    res
}

fn write_part(part: &Path, input: &Input) -> io::Result<Muxed> {
    let frames = input.frames;
    debug_assert!(frames.windows(2).all(|w| w[0].t <= w[1].t), "frames in time order");
    let ranges = kept(input.duration_ms, input.cuts);
    let total_ms: u64 = ranges.iter().map(|(a, b)| b - a).sum();
    let slots = total_ms.div_ceil(SLOT_MS);
    let audio_samples = total_ms * SAMPLES_PER_MS;
    let wav = match input.wav {
        Some((path, offset_ms)) => {
            let mut f = File::open(path)?;
            let data = wav_data(&mut f)?;
            Some((f, data, offset_ms))
        }
        None => None,
    };
    if slots == 0 || (frames.is_empty() && wav.is_none()) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "nothing to write: no kept time, or neither frames nor voice"));
    }
    if slots > u32::MAX as u64 || audio_samples > u32::MAX as u64 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "recording too long for the video file"));
    }

    // Where each slot is in recording time, and the frame it shows: the latest one at or before
    // that time (before the first frame: the first frame).
    let mut shown = Vec::with_capacity(if frames.is_empty() { 0 } else { slots as usize });
    let mut ops = Vec::with_capacity(slots as usize * 2);
    let (mut range, mut range_out) = (0, 0);
    let (mut next, mut written) = (0, 0);
    for k in 0..slots {
        let u = k * SLOT_MS;
        while u >= range_out + (ranges[range].1 - ranges[range].0) {
            range_out += ranges[range].1 - ranges[range].0;
            range += 1;
        }
        let src = ranges[range].0 + (u - range_out);
        if wav.is_some() {
            ops.push(Op::Audio(k));
        }
        if frames.is_empty() {
            continue;
        }
        while next < frames.len() && frames[next].t <= src {
            next += 1;
        }
        let cur = next.saturating_sub(1);
        if input.all_frames {
            while written <= cur {
                ops.push(Op::Frame(written));
                written += 1;
            }
        } else if written <= cur {
            ops.push(Op::Frame(cur));
            written = cur + 1;
        }
        shown.push(cur);
    }
    if input.all_frames {
        ops.extend((written..frames.len()).map(Op::Frame));
    }

    // Offsets first (the moov needs them, and `mdat` its size up front).
    let chunk_bytes = |k: u64| (audio_samples - k * SLOT_SAMPLES).min(SLOT_SAMPLES) * 2;
    let mut pos = FTYP_LEN + MDAT_HEADER;
    let mut offsets = vec![None; frames.len()];
    let mut chunks = Vec::with_capacity(if wav.is_some() { slots as usize } else { 0 });
    for op in &ops {
        match *op {
            Op::Audio(k) => {
                chunks.push(pos);
                pos += chunk_bytes(k);
            }
            Op::Frame(i) => {
                offsets[i] = Some(pos);
                pos += frames[i].size as u64;
            }
        }
    }
    let mdat_len = pos - FTYP_LEN;

    let mut traks = Vec::new();
    let video_ms = slots * SLOT_MS;
    if !frames.is_empty() {
        let sizes: Vec<u32> = shown.iter().map(|&i| frames[i].size).collect();
        let at: Vec<u64> = shown.iter().map(|&i| offsets[i].expect("a shown frame is written")).collect();
        traks.push(video_trak(traks.len() as u32 + 1, video_ms as u32, slots as u32, input.width, input.height, &sizes, &at));
    }
    if wav.is_some() {
        traks.push(audio_trak(traks.len() as u32 + 1, total_ms as u32, audio_samples as u32, &chunks));
    }
    let movie_ms = if frames.is_empty() { total_ms } else { video_ms.max(total_ms) };
    let moov = moov(movie_ms as u32, &traks);

    let file = crate::util::private_options().write(true).create(true).truncate(true).open(part)?;
    let mut w = BufWriter::with_capacity(1 << 20, file);
    w.write_all(&atom(b"ftyp", &[b"qt  ", &0x200u32.to_be_bytes(), b"qt  "]))?;
    w.write_all(&1u32.to_be_bytes())?;
    w.write_all(b"mdat")?;
    w.write_all(&mdat_len.to_be_bytes())?;
    let mut source = if frames.is_empty() { None } else { Some(File::open(input.source)?) };
    let source_len = match &source {
        Some(f) => f.metadata()?.len(),
        None => 0,
    };
    let mut wav = wav;
    let mut buf = Vec::new();
    for op in &ops {
        if input.cancel.load(Ordering::Relaxed) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        match *op {
            Op::Audio(k) => {
                let (f, data, offset_ms) = wav.as_mut().expect("audio ops only with a voice");
                buf.resize(chunk_bytes(k) as usize, 0);
                fill_audio(f, *data, *offset_ms, &ranges, k * SLOT_SAMPLES, &mut buf)?;
            }
            Op::Frame(i) => {
                let fr = frames[i];
                if fr.offset + fr.size as u64 > source_len {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, format!("frame {i} lies past the end of its source file")));
                }
                let src = source.as_mut().expect("frames have a source");
                src.seek(SeekFrom::Start(fr.offset))?;
                buf.resize(fr.size as usize, 0);
                src.read_exact(&mut buf)?;
            }
        }
        w.write_all(&buf)?;
    }
    w.write_all(&moov)?;
    let file = w.into_inner().map_err(|e| e.into_error())?;
    file.sync_all()?;
    let bytes = file.metadata()?.len();
    debug_assert_eq!(bytes, FTYP_LEN + mdat_len + moov.len() as u64);
    Ok(Muxed { offsets, bytes })
}

/// The voice samples of output samples `[from, from + out.len() / 2)`: the kept ranges' recording
/// time in order, silence where the WAV has nothing (before the voice started, after it ended).
fn fill_audio(wav: &mut File, data: WavData, offset_ms: u64, ranges: &[(u64, u64)], from: u64, out: &mut [u8]) -> io::Result<()> {
    out.fill(0);
    let to = from + out.len() as u64 / 2;
    let mut range_out = 0;
    for &(a, b) in ranges {
        let (lo, hi) = (range_out, range_out + (b - a) * SAMPLES_PER_MS);
        range_out = hi;
        let (s, e) = (lo.max(from), hi.min(to));
        if s >= e {
            continue;
        }
        // Recording-time sample of output sample `s`, then the WAV's.
        let rec = a * SAMPLES_PER_MS + (s - lo);
        let first = rec as i64 - (offset_ms * SAMPLES_PER_MS) as i64;
        let n = (e - s) as i64;
        let (w0, w1) = (first.max(0), (first + n).min(data.samples as i64));
        if w0 < w1 {
            let at = ((s - from) as i64 + (w0 - first)) as usize * 2;
            let len = (w1 - w0) as usize * 2;
            wav.seek(SeekFrom::Start(data.start + w0 as u64 * 2))?;
            wav.read_exact(&mut out[at..at + len])?;
        }
    }
    Ok(())
}

fn invalid_wav(why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("voice.wav: {why}"))
}

/// Finds the samples of a 16 kHz mono 16-bit PCM WAV file. A header whose sizes are not final (a
/// recording that was cut short) is fine: the samples run to the end of the file.
pub fn wav_data(f: &mut File) -> io::Result<WavData> {
    let len = f.metadata()?.len();
    let mut head = [0u8; 12];
    f.seek(SeekFrom::Start(0))?;
    f.read_exact(&mut head).map_err(|_| invalid_wav("no RIFF header"))?;
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return Err(invalid_wav("not a WAV file"));
    }
    let (mut at, mut format) = (12u64, false);
    loop {
        if at + 8 > len {
            return Err(invalid_wav("no data chunk"));
        }
        let mut chunk = [0u8; 8];
        f.seek(SeekFrom::Start(at))?;
        f.read_exact(&mut chunk)?;
        let size = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as u64;
        match &chunk[0..4] {
            b"fmt " => {
                if size < 16 {
                    return Err(invalid_wav("short fmt chunk"));
                }
                let mut fmt = vec![0u8; size.min(40) as usize];
                f.read_exact(&mut fmt)?;
                let u16_at = |i: usize| u16::from_le_bytes([fmt[i], fmt[i + 1]]);
                let mut tag = u16_at(0);
                // WAVE_FORMAT_EXTENSIBLE: the format is the sub-format GUID's first two bytes.
                if tag == 0xFFFE && fmt.len() >= 26 {
                    tag = u16_at(24);
                }
                let rate = u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]);
                if tag != 1 || u16_at(2) != 1 || rate != RATE || u16_at(14) != 16 {
                    return Err(invalid_wav("not 16 kHz mono 16-bit PCM"));
                }
                format = true;
            }
            b"data" => {
                if !format {
                    return Err(invalid_wav("no fmt chunk before the data"));
                }
                let start = at + 8;
                return Ok(WavData { start, samples: (len - start) / 2 });
            }
            _ => {}
        }
        // Chunks are padded to an even size.
        at += 8 + size + (size & 1);
    }
}

/// Makes a WAV header's sizes match the samples in the file (a recording the app could not finish
/// left them behind; the speech engine trusts them) and drops a dangling odd byte. `Ok(None)`: no
/// usable samples.
pub fn repair_wav(path: &Path) -> io::Result<Option<WavData>> {
    let mut f = OpenOptions::new().read(true).write(true).open(path)?;
    let Ok(data) = wav_data(&mut f) else { return Ok(None) };
    let end = data.start + data.samples * 2;
    if f.metadata()?.len() != end {
        f.set_len(end)?;
    }
    let riff = u32::try_from(end - 8).unwrap_or(u32::MAX);
    let size = u32::try_from(data.samples * 2).unwrap_or(u32::MAX);
    for (at, want) in [(4, riff), (data.start - 4, size)] {
        let mut have = [0u8; 4];
        f.seek(SeekFrom::Start(at))?;
        f.read_exact(&mut have)?;
        if u32::from_le_bytes(have) != want {
            f.seek(SeekFrom::Start(at))?;
            f.write_all(&want.to_le_bytes())?;
        }
    }
    f.sync_all()?;
    Ok((data.samples > 0).then_some(data))
}

// ───────────────────────────── atoms ─────────────────────────────

const MATRIX: [u32; 9] = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x4000_0000];

/// Big-endian field writer.
#[derive(Default)]
struct Be(Vec<u8>);

impl Be {
    fn u16(mut self, v: u16) -> Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }
    fn u32(mut self, v: u32) -> Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }
    fn u64(mut self, v: u64) -> Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }
    fn zeros(mut self, n: usize) -> Self {
        self.0.resize(self.0.len() + n, 0);
        self
    }
    fn bytes(mut self, b: &[u8]) -> Self {
        self.0.extend_from_slice(b);
        self
    }
    fn matrix(self) -> Self {
        MATRIX.iter().fold(self, |b, &v| b.u32(v))
    }
    /// A Pascal string (length byte first).
    fn pascal(self, s: &str) -> Self {
        self.bytes(&[s.len() as u8]).bytes(s.as_bytes())
    }
}

fn atom(kind: &[u8; 4], parts: &[&[u8]]) -> Vec<u8> {
    let len = 8 + parts.iter().map(|p| p.len()).sum::<usize>();
    let mut v = Vec::with_capacity(len);
    v.extend_from_slice(&(len as u32).to_be_bytes());
    v.extend_from_slice(kind);
    for p in parts {
        v.extend_from_slice(p);
    }
    v
}

fn full(kind: &[u8; 4], version: u8, flags: u32, parts: &[&[u8]]) -> Vec<u8> {
    let head = ((version as u32) << 24 | flags).to_be_bytes();
    let mut all: Vec<&[u8]> = vec![&head];
    all.extend_from_slice(parts);
    atom(kind, &all)
}

fn tkhd(id: u32, duration: u32, volume: u16, width: u16, height: u16) -> Vec<u8> {
    let b = Be::default().u32(0).u32(0).u32(id).u32(0).u32(duration).zeros(8);
    let b = b.u16(0).u16(0).u16(volume).u16(0).matrix().u32((width as u32) << 16).u32((height as u32) << 16);
    full(b"tkhd", 0, 3, &[&b.0])
}

fn mdhd(timescale: u32, duration: u32) -> Vec<u8> {
    // Language `und` (0x55C4), quality 0.
    full(b"mdhd", 0, 0, &[&Be::default().u32(0).u32(0).u32(timescale).u32(duration).u16(0x55C4).u16(0).0])
}

fn hdlr(subtype: &[u8; 4], name: &str) -> Vec<u8> {
    full(b"hdlr", 0, 0, &[&Be::default().bytes(b"mhlr").bytes(subtype).zeros(12).pascal(name).0])
}

fn dinf() -> Vec<u8> {
    atom(b"dinf", &[&full(b"dref", 0, 0, &[&1u32.to_be_bytes(), &full(b"url ", 0, 1, &[])])])
}

fn stsd(entry: &[u8]) -> Vec<u8> {
    full(b"stsd", 0, 0, &[&1u32.to_be_bytes(), entry])
}

/// One time-to-sample entry: `count` samples of `delta` ticks.
fn stts(count: u32, delta: u32) -> Vec<u8> {
    full(b"stts", 0, 0, &[&Be::default().u32(1).u32(count).u32(delta).0])
}

/// Sample-to-chunk entries `(first chunk, samples per chunk)`, all with sample description 1.
fn stsc(entries: &[(u32, u32)]) -> Vec<u8> {
    let b = entries.iter().fold(Be::default().u32(entries.len() as u32), |b, &(first, n)| b.u32(first).u32(n).u32(1));
    full(b"stsc", 0, 0, &[&b.0])
}

fn co64(offsets: &[u64]) -> Vec<u8> {
    let b = offsets.iter().fold(Be::default().u32(offsets.len() as u32), |b, &o| b.u64(o));
    full(b"co64", 0, 0, &[&b.0])
}

fn video_trak(id: u32, duration_ms: u32, slots: u32, width: u16, height: u16, sizes: &[u32], offsets: &[u64]) -> Vec<u8> {
    const NAME: &str = "Photo - JPEG";
    let entry = Be::default().zeros(6).u16(1).u16(0).u16(0).u32(0).u32(0).u32(512).u16(width).u16(height);
    let entry = entry.u32(0x48_0000).u32(0x48_0000).u32(0).u16(1).pascal(NAME).zeros(31 - NAME.len()).u16(24).u16(0xFFFF);
    let stsz = sizes.iter().fold(Be::default().u32(0).u32(sizes.len() as u32), |b, &z| b.u32(z));
    let stbl = atom(
        b"stbl",
        &[&stsd(&atom(b"jpeg", &[&entry.0])), &stts(slots, 1), &stsc(&[(1, 1)]), &full(b"stsz", 0, 0, &[&stsz.0]), &co64(offsets)],
    );
    let minf = atom(b"minf", &[&full(b"vmhd", 0, 1, &[&[0; 8]]), &dinf(), &stbl]);
    let mdia = atom(b"mdia", &[&mdhd((1000 / SLOT_MS) as u32, slots), &hdlr(b"vide", "TeleFlock video"), &minf]);
    atom(b"trak", &[&tkhd(id, duration_ms, 0, width, height), &mdia])
}

fn audio_trak(id: u32, duration_ms: u32, samples: u32, chunks: &[u64]) -> Vec<u8> {
    let entry = Be::default().zeros(6).u16(1).u16(0).u16(0).u32(0).u16(1).u16(16).u16(0).u16(0).u32(RATE << 16);
    let slot = SLOT_SAMPLES as u32;
    let last = samples - (chunks.len() as u32 - 1) * slot;
    let per_chunk: Vec<(u32, u32)> = match chunks.len() as u32 {
        1 => vec![(1, last)],
        n if last < slot => vec![(1, slot), (n, last)],
        _ => vec![(1, slot)],
    };
    let stbl = atom(
        b"stbl",
        &[
            &stsd(&atom(b"sowt", &[&entry.0])),
            &stts(samples, 1),
            &stsc(&per_chunk),
            &full(b"stsz", 0, 0, &[&Be::default().u32(2).u32(samples).0]),
            &co64(chunks),
        ],
    );
    let minf = atom(b"minf", &[&full(b"smhd", 0, 0, &[&[0; 4]]), &dinf(), &stbl]);
    let mdia = atom(b"mdia", &[&mdhd(RATE, samples), &hdlr(b"soun", "TeleFlock voice"), &minf]);
    atom(b"trak", &[&tkhd(id, duration_ms, 0x100, 0, 0), &mdia])
}

fn moov(duration_ms: u32, traks: &[Vec<u8>]) -> Vec<u8> {
    let mvhd = Be::default().u32(0).u32(0).u32(1000).u32(duration_ms).u32(0x10000).u16(0x100).zeros(10).matrix().zeros(24);
    let mvhd = full(b"mvhd", 0, 0, &[&mvhd.u32(traks.len() as u32 + 1).0]);
    let mut parts: Vec<&[u8]> = vec![&mvhd];
    parts.extend(traks.iter().map(Vec::as_slice));
    atom(b"moov", &parts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Top-level atoms of `data[from..to]`: `(kind, body start, end)`.
    fn atoms(data: &[u8], from: usize, to: usize) -> Vec<([u8; 4], usize, usize)> {
        let mut out = Vec::new();
        let mut at = from;
        while at < to {
            let size = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
            let kind: [u8; 4] = data[at + 4..at + 8].try_into().unwrap();
            let (body, end) = if size == 1 {
                (at + 16, at + u64::from_be_bytes(data[at + 8..at + 16].try_into().unwrap()) as usize)
            } else {
                (at + 8, at + size)
            };
            assert!(end <= to && end > at, "atom {} overruns its parent", String::from_utf8_lossy(&kind));
            out.push((kind, body, end));
            at = end;
        }
        assert_eq!(at, to, "atoms fill their parent exactly");
        out
    }

    /// The body of the atom at `path` (`trak` picks the n-th track via `trak1`, `trak2`).
    fn find<'a>(data: &'a [u8], path: &[&str]) -> &'a [u8] {
        let (mut from, mut to) = (0, data.len());
        for step in path {
            let (name, nth) = match step.strip_prefix("trak") {
                Some(n) if !n.is_empty() => ("trak", n.parse::<usize>().unwrap() - 1),
                _ => (*step, 0),
            };
            let hit = atoms(data, from, to).into_iter().filter(|(k, ..)| k == name.as_bytes()).nth(nth);
            let (_, body, end) = hit.unwrap_or_else(|| panic!("no {step} in {path:?}"));
            (from, to) = (body, end);
        }
        &data[from..to]
    }

    fn be32(b: &[u8], at: usize) -> u32 {
        u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
    }

    fn table32(b: &[u8], skip: usize) -> Vec<u32> {
        let n = be32(b, skip) as usize;
        (0..n).map(|i| be32(b, skip + 4 + 4 * i)).collect()
    }

    /// `co64` entries.
    fn co64_of(stbl_path: &[&str], data: &[u8]) -> Vec<u64> {
        let mut path = stbl_path.to_vec();
        path.push("co64");
        let b = find(data, &path);
        let n = be32(b, 4) as usize;
        (0..n).map(|i| u64::from_be_bytes(b[8 + 8 * i..16 + 8 * i].try_into().unwrap())).collect()
    }

    /// A fake JPEG of `n` bytes (SOI, a fill byte, EOI): only the file layout is checked here.
    fn jpeg(n: usize, fill: u8) -> Vec<u8> {
        let mut v = vec![fill; n];
        v[..2].copy_from_slice(&[0xFF, 0xD8]);
        v[n - 2..].copy_from_slice(&[0xFF, 0xD9]);
        v
    }

    /// A 16 kHz mono WAV whose sample i is `i % 30000`; `final_header: false` leaves the sizes at
    /// zero, as a recording cut short.
    fn wav(path: &Path, samples: u32, final_header: bool) {
        let size = if final_header { samples * 2 } else { 0 };
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(if final_header { 36 + size } else { 0 }).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&RATE.to_le_bytes());
        b.extend_from_slice(&(RATE * 2).to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&size.to_le_bytes());
        for i in 0..samples {
            b.extend_from_slice(&((i % 30000) as i16).to_le_bytes());
        }
        std::fs::write(path, b).unwrap();
    }

    fn sample(i: u64) -> [u8; 2] {
        ((i % 30000) as i16).to_le_bytes()
    }

    struct Fixture {
        dir: tempfile::TempDir,
        jpegs: Vec<Vec<u8>>,
        frames: Vec<Frame>,
    }

    /// `frames.bin` with five frames: t 0, 3000, 6500, 6510 (never on screen: 6550 replaces it
    /// within its slot), 6550.
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let jpegs: Vec<Vec<u8>> = [(100, 1), (150, 2), (200, 3), (120, 4), (90, 5)].iter().map(|&(n, f)| jpeg(n, f)).collect();
        let mut bin = Vec::new();
        let mut frames = Vec::new();
        for (j, t) in jpegs.iter().zip([0, 3000, 6500, 6510, 6550]) {
            frames.push(Frame { t, offset: bin.len() as u64, size: j.len() as u32 });
            bin.extend_from_slice(j);
        }
        std::fs::write(dir.path().join("frames.bin"), bin).unwrap();
        Fixture { dir, jpegs, frames }
    }

    fn mux(fx: &Fixture, out: &str, wav: Option<u64>, duration_ms: u64, cuts: &[(u64, u64)], all_frames: bool) -> (Muxed, Vec<u8>) {
        let cancel = AtomicBool::new(false);
        let wav_path = fx.dir.path().join("voice.wav");
        let out = fx.dir.path().join(out);
        let input = Input {
            frames: &fx.frames,
            width: 64,
            height: 48,
            source: &fx.dir.path().join("frames.bin"),
            wav: wav.map(|o| (wav_path.as_path(), o)),
            duration_ms,
            cuts,
            all_frames,
            cancel: &cancel,
        };
        let m = write(&out, &input).unwrap();
        assert!(!out.with_extension("mov.part").exists());
        (m, std::fs::read(&out).unwrap())
    }

    const V: [&str; 6] = ["moov", "trak1", "mdia", "minf", "stbl", ""];
    const A: [&str; 6] = ["moov", "trak2", "mdia", "minf", "stbl", ""];

    fn stbl<'a>(data: &'a [u8], track: [&str; 6], atom: &'a str) -> &'a [u8] {
        let mut p = track.to_vec();
        p[5] = atom;
        find(data, &p)
    }

    /// The stop's file: atoms nest and size up exactly, every slot points at the JPEG it shows
    /// (unchanged slots at the previous frame's bytes), frames no slot shows are still in the
    /// file, and the voice lands at its offset with silence around it.
    #[test]
    fn layout_offsets_and_voice() {
        let fx = fixture();
        // 8000 ms of voice starting 250 ms in: silence before it and for its last 750 ms.
        wav(&fx.dir.path().join("voice.wav"), 8000 * 16, true);
        let (m, data) = mux(&fx, "recording.mov", Some(250), 9000, &[], true);
        assert_eq!(m.bytes, data.len() as u64);

        let top = atoms(&data, 0, data.len());
        assert_eq!(top.iter().map(|a| &a.0).collect::<Vec<_>>(), [b"ftyp", b"mdat", b"moov"]);
        assert_eq!(&data[8..12], b"qt  ");
        assert_eq!(be32(&data, 20), 1, "64-bit mdat size");
        assert_eq!(be32(find(&data, &["moov", "mvhd"]), 12), 1000, "movie timescale");
        assert_eq!(be32(find(&data, &["moov", "mvhd"]), 16), 9000);

        // Video: 90 slots of 1 tick at 10 per second.
        let mdhd = find(&data, &["moov", "trak1", "mdia", "mdhd"]);
        assert_eq!((be32(mdhd, 12), be32(mdhd, 16)), (10, 90));
        assert_eq!(&find(&data, &["moov", "trak1", "mdia", "hdlr"])[8..12], b"vide");
        assert_eq!(table32(stbl(&data, V, "stts"), 4), [90]);
        assert_eq!(be32(stbl(&data, V, "stts"), 12), 1);
        let jpeg_entry = stbl(&data, V, "stsd");
        assert_eq!(&jpeg_entry[12..16], b"jpeg");
        let stsz = stbl(&data, V, "stsz");
        assert_eq!((be32(stsz, 4), be32(stsz, 8)), (0, 90));
        let sizes: Vec<u32> = (0..90).map(|i| be32(stsz, 12 + 4 * i)).collect();
        let at = co64_of(&V[..5], &data);
        assert_eq!(at.len(), 90);
        let expect = |k: usize| match k {
            0..30 => 0,
            30..65 => 1,
            65 => 2,
            _ => 4,
        };
        for k in 0..90 {
            let j = &fx.jpegs[expect(k)];
            assert_eq!(sizes[k] as usize, j.len(), "slot {k}");
            assert_eq!(&data[at[k] as usize..at[k] as usize + j.len()], &j[..], "slot {k} points at its JPEG");
            assert_eq!(Some(at[k]), m.offsets[expect(k)]);
        }
        assert!(at[1..30].iter().all(|&o| o == at[0]), "unchanged slots reuse the frame's bytes");
        assert_ne!(at[65], at[66]);
        let hidden = m.offsets[3].expect("all frames are written");
        assert_eq!(&data[hidden as usize..hidden as usize + 120], &fx.jpegs[3][..]);

        // Audio: 9000 ms × 16 samples of 2 bytes, one chunk per slot, before the slot's new frame.
        let mdhd = find(&data, &["moov", "trak2", "mdia", "mdhd"]);
        assert_eq!((be32(mdhd, 12), be32(mdhd, 16)), (16000, 144_000));
        assert_eq!(&find(&data, &["moov", "trak2", "mdia", "hdlr"])[8..12], b"soun");
        assert_eq!(&stbl(&data, A, "stsd")[12..16], b"sowt");
        let stsz = stbl(&data, A, "stsz");
        assert_eq!((be32(stsz, 4), be32(stsz, 8)), (2, 144_000));
        let stsc = stbl(&data, A, "stsc");
        assert_eq!((be32(stsc, 4), be32(stsc, 8), be32(stsc, 12)), (1, 1, 1600));
        let chunks = co64_of(&A[..5], &data);
        assert_eq!(chunks.len(), 90);
        assert!(chunks.windows(2).all(|w| w[1] - w[0] >= 3200));
        assert!(chunks[30] < at[30] && at[29] < chunks[30], "slot 30: its audio, then the new frame");
        let pcm = |c: usize| &data[chunks[c] as usize..chunks[c] as usize + 3200];
        assert!(pcm(0).iter().all(|&b| b == 0), "silence before the voice starts");
        // Slot 2 is recording samples 3200..4800; the voice starts at sample 4000.
        assert!(pcm(2)[..1600].iter().all(|&b| b == 0));
        assert_eq!(&pcm(2)[1600..1602], &sample(0));
        assert_eq!(&pcm(2)[3198..3200], &sample(799));
        assert_eq!(&pcm(50)[..2], &sample(50 * 1600 - 4000));
        // The voice ends at recording sample 4000 + 128000: slot 82 holds its last 800 samples.
        assert_eq!(&pcm(82)[1598..1600], &sample(127_999));
        assert!(pcm(82)[1600..].iter().all(|&b| b == 0) && pcm(89).iter().all(|&b| b == 0));
    }

    /// A render with cuts: the kept ranges play back to back (a cut inside a slot splits its
    /// audio), frames only cut ranges show are left out, and a shorter last chunk gets its own
    /// `stsc` entry.
    #[test]
    fn cuts_shift_frames_and_voice() {
        let fx = fixture();
        wav(&fx.dir.path().join("voice.wav"), 9000 * 16, false);
        // Kept: [0, 1050) and [4000, 8530) = 5580 ms → 56 slots, the last one 80 ms.
        let (m, data) = mux(&fx, "cut.mov", Some(0), 9000, &[(1050, 4000), (2000, 3000), (8530, 20_000)], false);
        assert_eq!(be32(find(&data, &["moov", "mvhd"]), 16), 5600, "56 slots of 100 ms");
        assert_eq!(be32(find(&data, &["moov", "trak1", "mdia", "mdhd"]), 16), 56);
        let at = co64_of(&V[..5], &data);
        assert_eq!(at.len(), 56);
        // Slot 10 is recording 1000 (frame 0), slot 11 4050 (frame 1). Recording 6500 is output
        // 3550, inside slot 35 (6450: still frame 1); slot 36 is 6600 (frame 4). Frames 2 and 3
        // only show between slots: not in the file.
        let shows = |k: usize| m.offsets.iter().position(|&o| o == Some(at[k]));
        assert_eq!(shows(10), Some(0));
        assert_eq!(shows(11), Some(1));
        assert_eq!(shows(35), Some(1));
        assert_eq!(shows(36), Some(4));
        assert_eq!((m.offsets[2], m.offsets[3]), (None, None));
        let stsc = stbl(&data, A, "stsc");
        assert_eq!(be32(stsc, 4), 2);
        assert_eq!((be32(stsc, 8), be32(stsc, 12)), (1, 1600));
        assert_eq!((be32(stsc, 20), be32(stsc, 24)), (56, 80 * 16));
        let stsz = stbl(&data, A, "stsz");
        assert_eq!(be32(stsz, 8), 5580 * 16, "audio samples = kept ms × 16");
        assert_eq!(be32(find(&data, &["moov", "trak2", "mdia", "mdhd"]), 16), 5580 * 16);
        let chunks = co64_of(&A[..5], &data);
        // Slot 10: recording 1000–1050 (samples 16000..16800), then 4000–4050 (64000..64800).
        let c = chunks[10] as usize;
        assert_eq!(&data[c..c + 2], &sample(16000));
        assert_eq!(&data[c + 1598..c + 1600], &sample(16799));
        assert_eq!(&data[c + 1600..c + 1602], &sample(64000));
        let last = chunks[55] as usize;
        assert_eq!(&data[last + 2558..last + 2560], &sample(8530 * 16 - 1), "the last chunk's 1280th sample");
        assert_eq!(atoms(&data, 0, data.len()).len(), 3);
    }

    /// The writer reads WAV headers that were never finished, and the repair writes the sizes.
    #[test]
    fn unfinished_wav_headers() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("voice.wav");
        wav(&p, 1000, false);
        let mut f = File::options().append(true).open(&p).unwrap();
        f.write_all(&[7]).unwrap();
        drop(f);
        let d = wav_data(&mut File::open(&p).unwrap()).unwrap();
        assert_eq!((d.start, d.samples), (44, 1000));
        assert_eq!(repair_wav(&p).unwrap(), Some(d));
        let b = std::fs::read(&p).unwrap();
        assert_eq!(b.len(), 44 + 2000);
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 36 + 2000);
        assert_eq!(u32::from_le_bytes(b[40..44].try_into().unwrap()), 2000);
        std::fs::write(&p, b"RIFF\0\0\0\0WAVEfmt ").unwrap();
        assert_eq!(repair_wav(&p).unwrap(), None);
    }

    #[test]
    fn kept_ranges() {
        assert_eq!(kept(1000, &[]), [(0, 1000)]);
        assert_eq!(kept(1000, &[(0, 100), (50, 300), (900, 5000), (400, 400)]), [(300, 900)]);
        assert_eq!(kept(1000, &[(0, 1000)]), []);
        assert_eq!(kept(1000, &[(200, 300), (100, 150)]), [(0, 100), (150, 200), (300, 1000)]);
    }

    fn have(tool: &str) -> bool {
        Command::new(tool).arg("-version").output().is_ok_and(|o| o.status.success())
    }

    /// The first pixel of the frame ffmpeg returns for `-ss t`.
    fn pixel_at(file: &Path, t: f64) -> [u8; 3] {
        let out = Command::new("ffmpeg")
            .args(["-v", "error", "-ss", &t.to_string(), "-i"])
            .arg(file)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .unwrap();
        assert!(out.status.success() && out.stdout.len() >= 3, "ffmpeg -ss {t}: {}", String::from_utf8_lossy(&out.stderr));
        [out.stdout[0], out.stdout[1], out.stdout[2]]
    }

    fn color(p: [u8; 3]) -> &'static str {
        match p {
            [r, g, b] if r > 180 && g < 80 && b < 80 => "red",
            [r, g, b] if g > 180 && r < 80 && b < 80 => "green",
            [r, g, b] if b > 180 && r < 80 && g < 80 => "blue",
            _ => "other",
        }
    }

    /// Real players: ffprobe sees 10 fps MJPEG and 16 kHz mono PCM of the right length, and
    /// `ffmpeg -ss T` (omp's way of taking a frame) returns the picture visible at T, also after
    /// cuts. Skipped without ffmpeg/ffprobe on PATH.
    #[test]
    fn ffmpeg_seeks_to_the_visible_frame() {
        if !have("ffmpeg") || !have("ffprobe") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut bin = Vec::new();
        let mut frames = Vec::new();
        for (c, t) in [("red", 0), ("lime", 3000), ("blue", 6500)] {
            let f = dir.path().join(format!("{c}.jpg"));
            let ok = Command::new("ffmpeg")
                .args(["-v", "error", "-f", "lavfi", "-i", &format!("color=c={c}:s=64x48"), "-frames:v", "1", "-q:v", "2", "-y"])
                .arg(&f)
                .status()
                .unwrap();
            assert!(ok.success());
            let j = std::fs::read(&f).unwrap();
            assert_eq!(&j[..2], &[0xFF, 0xD8]);
            frames.push(Frame { t, offset: bin.len() as u64, size: j.len() as u32 });
            bin.extend_from_slice(&j);
        }
        std::fs::write(dir.path().join("frames.bin"), bin).unwrap();
        wav(&dir.path().join("voice.wav"), 9000 * 16, true);
        let cancel = AtomicBool::new(false);
        let voice = dir.path().join("voice.wav");
        let mov = |name: &str, cuts: &[(u64, u64)]| {
            let out = dir.path().join(name);
            let input = Input {
                frames: &frames,
                width: 64,
                height: 48,
                source: &dir.path().join("frames.bin"),
                wav: Some((voice.as_path(), 0)),
                duration_ms: 9000,
                cuts,
                all_frames: false,
                cancel: &cancel,
            };
            write(&out, &input).unwrap();
            out
        };
        let full = mov("full.mov", &[]);
        let probe = Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "stream=codec_type,codec_name,r_frame_rate,nb_frames,sample_rate,channels:format=duration", "-of", "json"])
            .arg(&full)
            .output()
            .unwrap();
        assert!(probe.status.success(), "{}", String::from_utf8_lossy(&probe.stderr));
        let probe: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
        let streams = probe["streams"].as_array().unwrap();
        let video = streams.iter().find(|s| s["codec_type"] == "video").unwrap();
        assert_eq!((video["codec_name"].as_str(), video["r_frame_rate"].as_str(), video["nb_frames"].as_str()), (Some("mjpeg"), Some("10/1"), Some("90")));
        let audio = streams.iter().find(|s| s["codec_type"] == "audio").unwrap();
        assert_eq!((audio["codec_name"].as_str(), audio["sample_rate"].as_str(), audio["channels"].as_u64()), (Some("pcm_s16le"), Some("16000"), Some(1)));
        let duration: f64 = probe["format"]["duration"].as_str().unwrap().parse().unwrap();
        assert!((duration - 9.0).abs() < 0.01, "{duration}");
        for (t, want) in [(0.0, "red"), (1.0, "red"), (2.95, "green"), (3.05, "green"), (6.0, "green"), (6.45, "blue"), (7.0, "blue"), (8.9, "blue")] {
            assert_eq!(color(pixel_at(&full, t)), want, "-ss {t}");
        }
        // Without 1–4 s: output 1.5 s is recording 4.5 s (green); 3.6 s is 6.6 s (blue).
        let cut = mov("cut.mov", &[(1000, 4000)]);
        for (t, want) in [(0.5, "red"), (1.5, "green"), (3.6, "blue")] {
            assert_eq!(color(pixel_at(&cut, t)), want, "cut -ss {t}");
        }
    }
}
