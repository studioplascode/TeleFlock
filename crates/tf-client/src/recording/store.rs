//! A recording's folder, `<data_dir>/recordings/<id>/`, and every folder and file in it are this
//! user's only (0700 and 0600 on Unix: [`private_dir`], [`private_options`], [`write_file`]):
//!
//! * `meta.json`: [`Meta`], replaced atomically.
//! * While recording: `frames.bin` (the JPEGs, appended) and `frames.idx` ([`Record`]s, 24 bytes
//!   each); `events.jsonl` (the UI's events, a line each); `shots/<name>`; `voice.wav`
//!   (tf-dictation writes it, its header refreshed about every second).
//! * From the stop: `recording.mov`, and `frames.idx` points into it (`frames.bin` is gone: the
//!   frames are stored once). The switch writes `frames.idx.new`, removes `frames.bin`, then
//!   renames the index: while `frames.bin` exists the index points into it.
//! * `bundle/<render>/`: what one `recording.render` wrote, until `recording.release` (its upload
//!   ended) or the next start of the app.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use tf_proto::{ApiError, Millis, RecordingAppendParams, RecordingInfo, RecordingState, is_windows_device_name};

use crate::util::{invalid, private_dir, private_options};

pub const META: &str = "meta.json";
pub const FRAMES_BIN: &str = "frames.bin";
pub const FRAMES_IDX: &str = "frames.idx";
pub const FRAMES_IDX_NEW: &str = "frames.idx.new";
pub const EVENTS: &str = "events.jsonl";
pub const SHOTS: &str = "shots";
pub const VOICE: &str = "voice.wav";
pub const VIDEO: &str = "recording.mov";
pub const BUNDLE: &str = "bundle";
/// Longest shot and bundle file name.
pub const NAME_MAX: usize = 80;
/// Longest title (characters).
pub const TITLE_MAX: usize = 200;
const RECORD_LEN: usize = 24;

/// What recordings may take.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Per recording (its folder).
    pub max_bytes: u64,
    /// Per recording, recording time.
    pub max_ms: u64,
    /// All recordings.
    pub budget: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_bytes: 1 << 30, max_ms: 60 * 60 * 1000, budget: 2 << 30 }
    }
}

/// A limit an append reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    Duration,
    Bytes,
    Budget,
}

impl Stop {
    /// What the UI shows when it stops the recording.
    pub fn sentence(self, limits: &Limits) -> String {
        match self {
            Stop::Duration => format!("This recording reached {} minutes", limits.max_ms / 60_000),
            Stop::Bytes => format!("This recording reached {}", gb(limits.max_bytes)),
            Stop::Budget => format!("Recordings reached {}; delete some in Recordings", gb(limits.budget)),
        }
    }
}

/// `2.1 GB` (GiB, one decimal, `2 GB` when whole).
pub fn gb(bytes: u64) -> String {
    let s = format!("{:.1}", bytes as f64 / (1u64 << 30) as f64);
    format!("{} GB", s.strip_suffix(".0").unwrap_or(&s))
}

/// `n` of `[a-z0-9]`, at random.
fn random_chars(n: usize) -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    (0..n).map(|_| CHARS[rand::random_range(0..CHARS.len())] as char).collect()
}

pub fn new_id() -> String {
    format!("rec_{}", random_chars(10))
}

/// `rec_` + 10 `[a-z0-9]`: also what keeps an id inside the recordings folder.
pub fn valid_id(id: &str) -> bool {
    id.strip_prefix("rec_").is_some_and(|r| r.len() == 10 && r.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
}

/// A render's folder name in `bundle/`.
pub fn new_render() -> String {
    random_chars(8)
}

/// 8 `[a-z0-9]`: also what keeps a render's folder inside `bundle/`.
pub fn valid_render(render: &str) -> bool {
    render.len() == 8 && render.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// Checks a shot's file name: `[A-Za-z0-9._-]`, at most [`NAME_MAX`], not starting with `.`,
/// without `..`, ending in `.jpg`, `.jpeg` or `.png`, not a Windows device name. `Ok(true)`: a PNG.
pub fn shot_name(name: &str) -> Result<bool, ApiError> {
    let lower = name.to_ascii_lowercase();
    let png = lower.ends_with(".png");
    let ok = name.len() <= NAME_MAX
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        && !name.starts_with('.')
        && !name.contains("..")
        && !is_windows_device_name(name)
        && (png || lower.ends_with(".jpg") || lower.ends_with(".jpeg"));
    if !ok {
        return Err(invalid(format!("shots: \"{name}\" is not a shot name (letters, digits, . _ - only, up to {NAME_MAX}, ending in .jpg, .jpeg or .png)")));
    }
    Ok(png)
}

/// A bundle file's name as written: characters other than `[A-Za-z0-9._-]` become `_`, as do
/// `..` and a leading `.`; a Windows device name gets a leading `_`; at most [`NAME_MAX`].
/// `recording.mov` is the cut video's.
pub fn bundle_name(name: &str) -> Result<String, ApiError> {
    let mut s: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect();
    while s.contains("..") {
        s = s.replace("..", "_");
    }
    if s.starts_with('.') {
        s.replace_range(..1, "_");
    }
    if is_windows_device_name(&s) {
        s.insert(0, '_');
    }
    s.truncate(NAME_MAX);
    if s.is_empty() {
        return Err(invalid("files: a file needs a name"));
    }
    if s.eq_ignore_ascii_case(VIDEO) {
        return Err(invalid(format!("files: {VIDEO} is the video's name")));
    }
    Ok(s)
}

/// The path (in the recording's folder) of a file `recording.read` reads: `recording.mov`,
/// `voice.wav`, `shots/<shot name>`, `bundle/<render>/<bundle name>`.
pub fn readable(file: &str) -> Option<PathBuf> {
    if file == VIDEO || file == VOICE {
        return Some(PathBuf::from(file));
    }
    let (dir, name) = file.split_once('/')?;
    match dir {
        SHOTS => shot_name(name).is_ok().then(|| Path::new(SHOTS).join(name)),
        BUNDLE => {
            let (render, name) = name.split_once('/')?;
            let ok = valid_render(render) && (name == VIDEO || bundle_name(name).is_ok_and(|n| n == name));
            ok.then(|| Path::new(BUNDLE).join(render).join(name))
        }
        _ => None,
    }
}

// ───────────────────────────── meta.json ─────────────────────────────

/// `meta.json`: what Rust owns of [`RecordingInfo`] (`bytes` is measured, not trusted), the UI's
/// `doc`, and the pause bookkeeping.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    #[serde(flatten)]
    pub info: RecordingInfo,
    /// When the current pause began. Also written at shutdown: when recording stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_at: Option<Millis>,
    /// Time spent paused before `paused_at`, ms.
    #[serde(default)]
    pub paused_ms: u64,
    /// Transcriptions of the voice that started and never ended: the app quit or crashed in them
    /// (out of memory, say). Back to 0 when one ends.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub transcribe_runs: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl Meta {
    /// Recording time: live while recording or paused, then the stored one.
    pub fn duration(&self, now: Millis) -> u64 {
        match self.info.state {
            RecordingState::Recording | RecordingState::Paused => {
                let end = self.paused_at.unwrap_or(now);
                ((end - self.info.created_at).max(0) as u64).saturating_sub(self.paused_ms)
            }
            _ => self.info.duration_ms,
        }
    }

    /// The microphone's first sample came at epoch ms `at` (0: none yet): the voice's offset in
    /// recording time, unless known. Asked at every append, before every pause and resume, and at
    /// the stop, so only pauses before `at` have been counted (no samples are written while
    /// paused). Whether the offset was set now.
    pub fn voice_started(&mut self, at: u64) -> bool {
        if at == 0 || self.info.voice.offset_ms.is_some() {
            return false;
        }
        let since = (at as Millis - self.info.created_at).max(0) as u64;
        self.info.voice.offset_ms = Some(since.saturating_sub(self.paused_ms));
        true
    }
}

pub fn read_meta(dir: &Path) -> io::Result<Meta> {
    serde_json::from_slice(&fs::read(dir.join(META))?).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Bytes of every file under `dir`.
pub fn folder_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => folder_size(&e.path()),
            Ok(_) => e.metadata().map_or(0, |m| m.len()),
            Err(_) => 0,
        })
        .sum()
}

// ───────────────────────────── frames.idx ─────────────────────────────

/// One `frames.idx` record (24 bytes, little-endian): `t` u64 ms, `offset` u64, `size` u32,
/// `width` u16, `height` u16.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Record {
    pub t: u64,
    pub offset: u64,
    pub size: u32,
    pub width: u16,
    pub height: u16,
}

impl Record {
    pub fn to_bytes(self) -> [u8; RECORD_LEN] {
        let mut b = [0u8; RECORD_LEN];
        b[0..8].copy_from_slice(&self.t.to_le_bytes());
        b[8..16].copy_from_slice(&self.offset.to_le_bytes());
        b[16..20].copy_from_slice(&self.size.to_le_bytes());
        b[20..22].copy_from_slice(&self.width.to_le_bytes());
        b[22..24].copy_from_slice(&self.height.to_le_bytes());
        b
    }

    pub fn from_bytes(b: &[u8]) -> Record {
        Record {
            t: u64::from_le_bytes(b[0..8].try_into().unwrap()),
            offset: u64::from_le_bytes(b[8..16].try_into().unwrap()),
            size: u32::from_le_bytes(b[16..20].try_into().unwrap()),
            width: u16::from_le_bytes(b[20..22].try_into().unwrap()),
            height: u16::from_le_bytes(b[22..24].try_into().unwrap()),
        }
    }
}

/// The complete records of an index (a record cut short by a crash is not one). No file: none.
pub fn read_index(path: &Path) -> io::Result<Vec<Record>> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    Ok(bytes.chunks_exact(RECORD_LEN).map(Record::from_bytes).collect())
}

/// Record `index`, if the index has it.
pub fn read_record(path: &Path, index: u32) -> io::Result<Option<Record>> {
    let mut f = File::open(path)?;
    let at = index as u64 * RECORD_LEN as u64;
    if at + RECORD_LEN as u64 > f.metadata()?.len() {
        return Ok(None);
    }
    let mut b = [0u8; RECORD_LEN];
    f.seek(SeekFrom::Start(at))?;
    f.read_exact(&mut b)?;
    Ok(Some(Record::from_bytes(&b)))
}

/// Writes an index and syncs it.
pub fn write_index(path: &Path, records: &[Record]) -> io::Result<()> {
    let mut bytes = Vec::with_capacity(records.len() * RECORD_LEN);
    for r in records {
        bytes.extend_from_slice(&r.to_bytes());
    }
    let mut f = private_options().write(true).create(true).truncate(true).open(path)?;
    f.write_all(&bytes)?;
    f.sync_all()
}

/// Reads `len` bytes at `offset` of `path`.
pub fn read_at(path: &Path, offset: u64, len: usize) -> io::Result<Vec<u8>> {
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

/// Writes `bytes` to `path` through `.<name>.tmp` beside it (a half-written file never has the
/// name), readable by this user only, also over a temp file a crash left.
pub fn write_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    let _ = fs::remove_file(&tmp);
    private_options().write(true).create_new(true).open(&tmp)?.write_all(bytes)?;
    fs::rename(&tmp, path)
}

// ───────────────────────────── appending ─────────────────────────────

struct NewFrame {
    t: u64,
    width: u16,
    height: u16,
    jpeg: Vec<u8>,
}

/// A decoded, checked `recording.append`.
pub struct Batch {
    frames: Vec<NewFrame>,
    /// `events.jsonl` lines.
    events: Vec<u8>,
    event_count: u32,
    shots: Vec<(String, Vec<u8>)>,
}

const JPEG_MAGIC: &[u8] = &[0xFF, 0xD8];
const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

impl Batch {
    /// Decodes and checks everything that does not depend on the recording (its frame size is
    /// [`Writer::append`]'s).
    pub fn decode(p: RecordingAppendParams) -> Result<Batch, ApiError> {
        let mut frames = Vec::with_capacity(p.frames.len());
        for (i, f) in p.frames.into_iter().enumerate() {
            let jpeg = B64.decode(f.data.as_bytes()).map_err(|_| invalid(format!("frames[{i}]: data is not base64")))?;
            if !jpeg.starts_with(JPEG_MAGIC) || jpeg.len() > u32::MAX as usize {
                return Err(invalid(format!("frames[{i}]: data is not a JPEG")));
            }
            let (Ok(width), Ok(height)) = (u16::try_from(f.width), u16::try_from(f.height)) else {
                return Err(invalid(format!("frames[{i}]: {}×{} is too large", f.width, f.height)));
            };
            if width == 0 || height == 0 {
                return Err(invalid(format!("frames[{i}]: the size is {width}×{height}")));
            }
            frames.push(NewFrame { t: f.t, width, height, jpeg });
        }
        let mut events = Vec::new();
        for e in &p.events {
            serde_json::to_writer(&mut events, e).map_err(|e| invalid(format!("events: {e}")))?;
            events.push(b'\n');
        }
        let mut shots = Vec::with_capacity(p.shots.len());
        for s in p.shots {
            let png = shot_name(&s.name)?;
            let data = B64.decode(s.data.as_bytes()).map_err(|_| invalid(format!("shots: \"{}\" is not base64", s.name)))?;
            if !data.starts_with(if png { PNG_MAGIC } else { JPEG_MAGIC }) {
                return Err(invalid(format!("shots: \"{}\" is not a {}", s.name, if png { "PNG" } else { "JPEG" })));
            }
            shots.push((s.name, data));
        }
        Ok(Batch { frames, events, event_count: p.events.len() as u32, shots })
    }
}

/// What an append added.
#[derive(Debug, Default)]
pub struct Appended {
    pub frames: u32,
    pub events: u32,
    /// New shot names (a name again replaces its shot).
    pub shots: u32,
    /// The frames' size (set by the first frame).
    pub size: Option<(u16, u16)>,
    /// The folder now, `voice.wav` included.
    pub bytes: u64,
    pub stop: Option<Stop>,
}

/// The files of the recording being recorded.
pub struct Writer {
    dir: PathBuf,
    bin: File,
    idx: File,
    events: File,
    bin_len: u64,
    /// Time of the last frame.
    pub last_t: Option<u64>,
    size: Option<(u16, u16)>,
    /// What the appends wrote (`frames.bin`, `frames.idx`, `events.jsonl`, `shots/`).
    bytes: u64,
    /// The recording stopped: no more appends.
    pub closed: bool,
}

fn append_file(path: &Path) -> io::Result<File> {
    private_options().create(true).append(true).open(path)
}

/// The byte limit a recording's folder of `mine` bytes reached, `others` being every other
/// recording's.
fn byte_limit(mine: u64, others: u64, limits: &Limits) -> Option<Stop> {
    if mine >= limits.max_bytes {
        Some(Stop::Bytes)
    } else if others + mine >= limits.budget {
        Some(Stop::Budget)
    } else {
        None
    }
}

impl Writer {
    /// Opens the files of a new recording's folder.
    pub fn create(dir: &Path) -> io::Result<Writer> {
        let w = Writer {
            dir: dir.to_path_buf(),
            bin: append_file(&dir.join(FRAMES_BIN))?,
            idx: append_file(&dir.join(FRAMES_IDX))?,
            events: append_file(&dir.join(EVENTS))?,
            bin_len: 0,
            last_t: None,
            size: None,
            bytes: 0,
            closed: false,
        };
        Ok(w)
    }

    /// The rest of the folder: the voice (it grows without appends) and `meta.json`.
    fn rest(&self) -> u64 {
        let size_of = |name: &str| fs::metadata(self.dir.join(name)).map_or(0, |m| m.len());
        size_of(VOICE) + size_of(META)
    }

    /// The byte limit the recording reached now, if any: its own, or the budget of all recordings
    /// (`others`: the bytes of every other recording).
    pub fn reached(&self, others: u64, limits: &Limits) -> Option<Stop> {
        byte_limit(self.bytes + self.rest(), others, limits)
    }

    /// Writes a batch unless a limit is reached already (then nothing). `others`: the bytes of
    /// every other recording. A batch may run past the byte limits by its own size; frames at or
    /// past the time limit are dropped.
    pub fn append(&mut self, b: Batch, others: u64, limits: &Limits) -> Result<Appended, ApiError> {
        let io = |e: io::Error| ApiError::new("io_error", format!("recording: {e}"));
        let size = self.size.or(b.frames.first().map(|f| (f.width, f.height)));
        if let (Some((w, h)), Some(bad)) = (size, b.frames.iter().find(|f| (f.width, f.height) != size.unwrap())) {
            return Err(invalid(format!("frames: every frame must be {w}×{h} like the first, not {}×{}", bad.width, bad.height)));
        }
        let rest = self.rest();
        let full = |mine: u64| byte_limit(mine, others, limits);
        let mut out = Appended { size: self.size, ..Appended::default() };
        if let Some(stop) = full(self.bytes + rest) {
            out.bytes = self.bytes + rest;
            out.stop = Some(stop);
            return Ok(out);
        }
        for f in b.frames {
            let t = self.last_t.map_or(f.t, |last| f.t.max(last));
            if t >= limits.max_ms {
                out.stop = Some(Stop::Duration);
                break;
            }
            let rec = Record { t, offset: self.bin_len, size: f.jpeg.len() as u32, width: f.width, height: f.height };
            self.bin.write_all(&f.jpeg).map_err(io)?;
            self.idx.write_all(&rec.to_bytes()).map_err(io)?;
            self.bin_len += f.jpeg.len() as u64;
            self.bytes += f.jpeg.len() as u64 + RECORD_LEN as u64;
            self.last_t = Some(t);
            self.size = Some((f.width, f.height));
            out.frames += 1;
        }
        if !b.events.is_empty() {
            self.events.write_all(&b.events).map_err(io)?;
            self.bytes += b.events.len() as u64;
            out.events = b.event_count;
        }
        if !b.shots.is_empty() {
            let dir = self.dir.join(SHOTS);
            private_dir(&dir).map_err(io)?;
            for (name, data) in b.shots {
                let path = dir.join(&name);
                let old = fs::metadata(&path).ok().map(|m| m.len());
                write_file(&path, &data).map_err(io)?;
                self.bytes = (self.bytes + data.len() as u64).saturating_sub(old.unwrap_or(0));
                out.shots += old.is_none() as u32;
            }
        }
        out.size = self.size;
        out.bytes = self.bytes + rest;
        out.stop = out.stop.or(full(out.bytes));
        Ok(out)
    }
}

// ───────────────────────────── recovery ─────────────────────────────

/// What a recording the app could not stop left behind, made consistent.
#[derive(Debug, Default, PartialEq)]
pub struct Recovered {
    pub frames: u32,
    pub last_t: Option<u64>,
    pub size: Option<(u16, u16)>,
    pub events: u32,
    pub shots: u32,
    /// Voice samples (`voice.wav`, its header repaired).
    pub voice_samples: Option<u64>,
    /// Last write to the recording's files.
    pub last_write: Option<Millis>,
}

/// Makes the files of a recording the app quit (or crashed) while recording consistent: the
/// index keeps the records whose frames are complete, `events.jsonl` loses a line cut short,
/// half-written shots go, the voice's header gets its sizes.
pub fn recover_files(dir: &Path) -> io::Result<Recovered> {
    let mut out = Recovered::default();
    let mut last_write = None;
    let mut touched = |p: &Path| {
        let t = fs::metadata(p).and_then(|m| m.modified()).ok();
        if let Some(ms) = t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as Millis) {
            last_write = Some(last_write.map_or(ms, |l: Millis| l.max(ms)));
        }
    };
    let (bin, idx) = (dir.join(FRAMES_BIN), dir.join(FRAMES_IDX));
    touched(&bin);
    touched(&idx);
    if let Ok(meta) = fs::metadata(&bin) {
        let records = read_index(&idx)?;
        let valid = records.iter().take_while(|r| r.offset + r.size as u64 <= meta.len()).count();
        if valid * RECORD_LEN != fs::metadata(&idx).map_or(0, |m| m.len() as usize) {
            OpenOptions::new().write(true).open(&idx)?.set_len((valid * RECORD_LEN) as u64)?;
        }
        out.frames = valid as u32;
        out.last_t = records[..valid].last().map(|r| r.t);
        out.size = records.first().filter(|_| valid > 0).map(|r| (r.width, r.height));
    }
    let events = dir.join(EVENTS);
    touched(&events);
    if let Ok(mut f) = OpenOptions::new().read(true).write(true).open(&events) {
        let (mut lines, mut end, mut at) = (0u32, 0u64, 0u64);
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            for (i, &c) in buf[..n].iter().enumerate() {
                if c == b'\n' {
                    lines += 1;
                    end = at + i as u64 + 1;
                }
            }
            at += n as u64;
        }
        if end != at {
            f.set_len(end)?;
        }
        out.events = lines;
    }
    if let Ok(entries) = fs::read_dir(dir.join(SHOTS)) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if shot_name(&name).is_ok() {
                out.shots += 1;
            } else {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    let voice = dir.join(VOICE);
    touched(&voice);
    if voice.exists() {
        out.voice_samples = Some(super::mov::repair_wav(&voice)?.map_or(0, |d| d.samples));
    }
    let _ = fs::remove_file(dir.join(VIDEO).with_extension("mov.part"));
    out.last_write = last_write;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_names() {
        let id = new_id();
        assert!(valid_id(&id), "{id}");
        assert_ne!(new_id(), id);
        for bad in ["rec_", "rec_ABCDEFGHIJ", "rec_abc/../xyz", "rec_abcdefghijk", "x_abcdefghij", "rec_abcdefgh.."] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert_eq!(shot_name("shot-1.png").unwrap(), true);
        assert_eq!(shot_name("A_b.JPEG").unwrap(), false);
        for bad in ["../x.png", "a/b.png", "a\\b.png", ".x.png", "a..b.png", "x.gif", "x", "", "con.png", "é.png", &format!("{}.png", "x".repeat(77))] {
            let e = shot_name(bad).unwrap_err();
            assert_eq!(e.code, "invalid_params", "{bad}");
        }
        assert_eq!(bundle_name("timeline.md").unwrap(), "timeline.md");
        assert_eq!(bundle_name("../time line?.md").unwrap(), "__time_line_.md");
        assert_eq!(bundle_name(".hidden").unwrap(), "_hidden");
        assert_eq!(bundle_name("nul.txt").unwrap(), "_nul.txt");
        assert_eq!(bundle_name(&"x".repeat(100)).unwrap().len(), NAME_MAX);
        assert_eq!(bundle_name("").unwrap_err().code, "invalid_params");
        assert_eq!(bundle_name("Recording.MOV").unwrap_err().code, "invalid_params");
    }

    /// `recording.read` reaches the video, the voice, shots and the files of a render's folder,
    /// nothing else.
    #[test]
    fn read_allow_list() {
        let render = new_render();
        assert!(valid_render(&render), "{render}");
        for ok in ["recording.mov", "voice.wav", "shots/a.png", "bundle/abcd1234/timeline.md", "bundle/0a1b2c3d/recording.mov"] {
            assert_eq!(readable(ok).as_deref(), Some(Path::new(ok)), "{ok}");
        }
        for bad in [
            "meta.json",
            "frames.bin",
            "frames.idx",
            "events.jsonl",
            "shots/../meta.json",
            "bundle/../meta.json",
            "bundle/timeline.md",
            "bundle/abcd1234/../meta.json",
            "bundle/abcd1234/a b.md",
            "bundle/abcd1234/",
            "bundle/abcd1234/sub/x.md",
            "bundle/ABCD1234/timeline.md",
            "bundle/abc/timeline.md",
            "shots/x.txt",
            "/etc/passwd",
            "bundle/",
            "other/x.png",
            "shots/a/b.png",
        ] {
            assert_eq!(readable(bad), None, "{bad}");
        }
    }

    #[test]
    fn sizes_and_sentences() {
        assert_eq!(gb(2 << 30), "2 GB");
        assert_eq!(gb((21 << 30) / 10), "2.1 GB");
        let l = Limits::default();
        assert_eq!(Stop::Duration.sentence(&l), "This recording reached 60 minutes");
        assert_eq!(Stop::Bytes.sentence(&l), "This recording reached 1 GB");
        assert_eq!(Stop::Budget.sentence(&l), "Recordings reached 2 GB; delete some in Recordings");
    }

    fn jpeg(n: usize) -> String {
        let mut v = vec![0u8; n];
        v[..2].copy_from_slice(JPEG_MAGIC);
        B64.encode(v)
    }

    fn batch(frames: &[(u64, usize, u32)], events: usize, shots: &[(&str, &[u8])]) -> Result<Batch, ApiError> {
        Batch::decode(RecordingAppendParams {
            id: String::new(),
            frames: frames.iter().map(|&(t, n, w)| tf_proto::RecordingFrame { t, data: jpeg(n), width: w, height: 10 }).collect(),
            events: (0..events).map(|i| serde_json::json!({ "t": i, "kind": "note", "text": "a\nb" })).collect(),
            shots: shots.iter().map(|(n, d)| tf_proto::RecordingShot { name: n.to_string(), data: B64.encode(d) }).collect(),
        })
    }

    /// Appends land in the files as the contract lays them out; older times count as the last
    /// frame's; the first frame fixes the size; nothing invalid is written.
    #[test]
    fn appends_and_checks() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Writer::create(dir.path()).unwrap();
        let l = Limits::default();
        let out = w.append(batch(&[(100, 50, 20), (90, 60, 20)], 2, &[("a.png", PNG_MAGIC)]).unwrap(), 0, &l).unwrap();
        assert_eq!((out.frames, out.events, out.shots, out.size, out.stop), (2, 2, 1, Some((20, 10)), None));
        let idx = read_index(&dir.path().join(FRAMES_IDX)).unwrap();
        assert_eq!(idx, [Record { t: 100, offset: 0, size: 50, width: 20, height: 10 }, Record { t: 100, offset: 50, size: 60, width: 20, height: 10 }]);
        assert_eq!(fs::metadata(dir.path().join(FRAMES_BIN)).unwrap().len(), 110);
        let events = fs::read_to_string(dir.path().join(EVENTS)).unwrap();
        assert_eq!(events.lines().count(), 2, "one line per event, newlines escaped");
        assert_eq!(out.bytes, folder_size(dir.path()));
        let again = w.append(batch(&[], 0, &[("a.png", PNG_MAGIC)]).unwrap(), 0, &l).unwrap();
        assert_eq!(again.shots, 0, "the same name replaces the shot");
        let e = w.append(batch(&[(200, 50, 30)], 1, &[]).unwrap(), 0, &l).unwrap_err();
        assert!(e.code == "invalid_params" && e.message.contains("20×10"), "{e:?}");
        assert_eq!(read_index(&dir.path().join(FRAMES_IDX)).unwrap().len(), 2, "nothing of a refused append is written");
        assert_eq!(fs::read_to_string(dir.path().join(EVENTS)).unwrap(), events);
        for bad in [
            Batch::decode(RecordingAppendParams { id: String::new(), frames: vec![tf_proto::RecordingFrame { t: 0, data: B64.encode([1, 2, 3]), width: 1, height: 1 }], events: vec![], shots: vec![] }),
            Batch::decode(RecordingAppendParams { id: String::new(), frames: vec![tf_proto::RecordingFrame { t: 0, data: "%%".into(), width: 1, height: 1 }], events: vec![], shots: vec![] }),
            batch(&[(0, 10, 70_000)], 0, &[]),
            batch(&[(0, 10, 0)], 0, &[]),
            batch(&[], 0, &[("x.png", JPEG_MAGIC)]),
            batch(&[], 0, &[("../x.png", PNG_MAGIC)]),
        ] {
            assert_eq!(bad.err().unwrap().code, "invalid_params");
        }
    }

    /// Past a limit an append writes nothing and says which; frames at the time limit are dropped.
    #[test]
    fn caps() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Writer::create(dir.path()).unwrap();
        let l = Limits { max_bytes: 1000, max_ms: 5000, budget: 1500 };
        let out = w.append(batch(&[(0, 400, 10), (4999, 100, 10), (5000, 100, 10)], 0, &[]).unwrap(), 0, &l).unwrap();
        assert_eq!((out.frames, out.stop), (2, Some(Stop::Duration)));
        let out = w.append(batch(&[(4999, 600, 10)], 0, &[]).unwrap(), 0, &l).unwrap();
        assert_eq!((out.frames, out.stop), (1, Some(Stop::Bytes)), "a batch may run past the limit by itself");
        let out = w.append(batch(&[(4999, 10, 10)], 0, &[]).unwrap(), 0, &l).unwrap();
        assert_eq!((out.frames, out.stop), (0, Some(Stop::Bytes)));
        let dir = tempfile::tempdir().unwrap();
        let mut w = Writer::create(dir.path()).unwrap();
        let out = w.append(batch(&[(0, 100, 10)], 0, &[]).unwrap(), 1400, &l).unwrap();
        assert_eq!((out.frames, out.stop), (1, Some(Stop::Budget)));
        let out = w.append(batch(&[(0, 100, 10)], 0, &[]).unwrap(), 1400, &l).unwrap();
        assert_eq!((out.frames, out.stop), (0, Some(Stop::Budget)));
    }

    /// A crash mid-write: the record without its whole frame, the event line cut short and a
    /// half-written shot go; the voice header gets its sizes.
    #[test]
    fn recovery_of_files() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let mut w = Writer::create(d).unwrap();
        w.append(batch(&[(0, 100, 20), (500, 100, 20)], 3, &[("s.jpg", JPEG_MAGIC)]).unwrap(), 0, &Limits::default()).unwrap();
        drop(w);
        let mut idx = OpenOptions::new().append(true).open(d.join(FRAMES_IDX)).unwrap();
        idx.write_all(&Record { t: 900, offset: 200, size: 100, width: 20, height: 10 }.to_bytes()).unwrap();
        idx.write_all(&[1, 2, 3]).unwrap();
        OpenOptions::new().append(true).open(d.join(FRAMES_BIN)).unwrap().write_all(&[0xFF, 0xD8, 0]).unwrap();
        OpenOptions::new().append(true).open(d.join(EVENTS)).unwrap().write_all(b"{\"t\":7,\"ki").unwrap();
        fs::write(d.join(SHOTS).join(".t.png.tmp"), b"x").unwrap();
        let mut wav = b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data\0\0\0\0".to_vec();
        wav.extend_from_slice(&[0; 3200]);
        fs::write(d.join(VOICE), &wav).unwrap();
        fs::write(d.join("recording.mov.part"), b"x").unwrap();
        let r = recover_files(d).unwrap();
        assert_eq!((r.frames, r.last_t, r.size, r.events, r.shots, r.voice_samples), (2, Some(500), Some((20, 10)), 3, 1, Some(1600)));
        assert!(r.last_write.is_some());
        assert_eq!(fs::metadata(d.join(FRAMES_IDX)).unwrap().len(), 48);
        assert!(fs::read(d.join(EVENTS)).unwrap().ends_with(b"}\n"));
        assert!(!d.join(SHOTS).join(".t.png.tmp").exists() && !d.join("recording.mov.part").exists());
        assert_eq!(u32::from_le_bytes(fs::read(d.join(VOICE)).unwrap()[40..44].try_into().unwrap()), 3200);
    }
}
