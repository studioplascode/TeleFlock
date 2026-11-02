//! Models on this device: `<data_dir>/dictation/`.
//! - `models/<id>/<file>`: a model's files, verified by sha256 when downloaded;
//!   `models/<id>/.complete` holds the commit they came from (written after the last check).
//! - `models/<id>/<file>.part`: an interrupted download, resumed with an HTTP range request.
//! - `dictation.json`: the chosen model, language and microphone.

use std::{
    cell::Cell,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    VoiceError,
    catalog::{self, File, Model},
};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// The chosen model; absent = none.
    pub selected: Option<String>,
    /// `auto` or an ISO 639-1 code.
    pub language: String,
    /// The input device to capture from ([`crate::mic::set_device`]); absent = the system default.
    pub microphone: Option<ChosenMic>,
}

/// A microphone the user chose: its id, and its name for when it is not connected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChosenMic {
    pub id: String,
    pub name: String,
}

pub struct Store {
    root: PathBuf,
    /// Serializes `dictation.json` read-modify-write.
    prefs: Mutex<()>,
}

const MARKER: &str = ".complete";

impl Store {
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join("dictation"), prefs: Mutex::new(()) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn model_dir(&self, model: &Model) -> PathBuf {
        self.root.join("models").join(model.id)
    }

    /// Downloaded and verified (as the catalog pins it now).
    pub fn installed(&self, model: &Model) -> bool {
        let dir = self.model_dir(model);
        fs::read_to_string(dir.join(MARKER)).is_ok_and(|c| c.trim() == model.commit)
            && model.files.iter().all(|f| fs::metadata(dir.join(f.name)).is_ok_and(|m| m.len() == f.size))
    }

    /// Bytes on disk of a download in progress or interrupted.
    pub fn partial_bytes(&self, model: &Model) -> u64 {
        let dir = self.model_dir(model);
        model
            .files
            .iter()
            .map(|f| match fs::metadata(dir.join(f.name)) {
                Ok(m) if m.len() == f.size => f.size,
                _ => fs::metadata(part_path(&dir, f)).map(|m| m.len().min(f.size)).unwrap_or(0),
            })
            .sum()
    }

    pub fn prefs(&self) -> Prefs {
        let mut p: Prefs = fs::read(self.root.join("dictation.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if p.language.is_empty() {
            p.language = "auto".into();
        }
        p
    }

    pub fn update_prefs(&self, f: impl FnOnce(&mut Prefs)) -> Result<Prefs, VoiceError> {
        let _guard = self.prefs.lock().unwrap_or_else(|e| e.into_inner());
        let mut p = self.prefs();
        f(&mut p);
        fs::create_dir_all(&self.root).map_err(io_err)?;
        let tmp = self.root.join("dictation.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&p).unwrap_or_default()).map_err(io_err)?;
        fs::rename(&tmp, self.root.join("dictation.json")).map_err(io_err)?;
        Ok(p)
    }

    /// The chosen model if it is installed.
    pub fn selected(&self) -> Option<&'static Model> {
        self.prefs().selected.as_deref().and_then(catalog::find).filter(|m| self.installed(m))
    }

    /// Deletes a model's files (a download in progress must be cancelled first). Unselects it.
    pub fn remove(&self, model: &Model) -> Result<(), VoiceError> {
        match fs::remove_dir_all(self.model_dir(model)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_err(e)),
        }
        self.update_prefs(|p| {
            if p.selected.as_deref() == Some(model.id) {
                p.selected = None;
            }
        })?;
        Ok(())
    }

    /// Removes what no catalog entry owns any more: models dropped from the catalog, files a
    /// model no longer lists, and models pinned to an older commit (they would be downloaded
    /// anew anyway). Run at startup.
    pub fn sweep(&self) {
        let Ok(entries) = fs::read_dir(self.root.join("models")) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(model) = catalog::find(&name) else {
                let _ = fs::remove_dir_all(e.path());
                continue;
            };
            let dir = e.path();
            if fs::read_to_string(dir.join(MARKER)).is_ok_and(|c| c.trim() != model.commit) {
                let _ = fs::remove_dir_all(&dir);
                continue;
            }
            for f in fs::read_dir(&dir).into_iter().flatten().flatten() {
                let n = f.file_name().to_string_lossy().into_owned();
                let owned = n == MARKER || model.files.iter().any(|mf| mf.name == n || format!("{}.part", mf.name) == n);
                if !owned {
                    let _ = fs::remove_file(f.path());
                }
            }
        }
    }

    /// Downloads `model` (resuming what an earlier attempt left), verifying every file's
    /// sha256. `progress(bytes_on_disk)` is called at most every 250 ms. Blocking: run it on a
    /// thread of its own.
    pub fn download(&self, model: &Model, client: &Downloader, cancel: &AtomicBool, progress: &dyn Fn(u64)) -> Result<(), VoiceError> {
        self.download_from(model, &|f| source(model, f), client, cancel, progress)
    }

    fn download_from(&self, model: &Model, url: &dyn Fn(&File) -> String, client: &Downloader, cancel: &AtomicBool, progress: &dyn Fn(u64)) -> Result<(), VoiceError> {
        let dir = self.model_dir(model);
        fs::create_dir_all(&dir).map_err(io_err)?;
        let _ = fs::remove_file(dir.join(MARKER));
        let mut done = 0u64;
        let last = Cell::new(Instant::now());
        for f in model.files {
            let path = dir.join(f.name);
            if fs::metadata(&path).is_ok_and(|m| m.len() == f.size) && sha256_file(&path).is_some_and(|h| h == f.sha256) {
                done += f.size;
                continue;
            }
            let _ = fs::remove_file(&path);
            let part = part_path(&dir, f);
            let base = done;
            let report = |n: u64| {
                if last.get().elapsed() >= PROGRESS_EVERY {
                    last.set(Instant::now());
                    progress(base + n);
                }
            };
            client.fetch(&url(f), &part, &Expect { name: f.name, size: f.size, sha256: f.sha256 }, cancel, &report)?;
            fs::rename(&part, &path).map_err(io_err)?;
            done += f.size;
            progress(done);
            last.set(Instant::now());
        }
        fs::write(dir.join(MARKER), model.commit).map_err(io_err)?;
        Ok(())
    }
}

/// Download progress goes out at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// Where `f` of `model` is downloaded from: Hugging Face, or in debug builds a mirror at
/// `TF_DICTATION_MIRROR` (`<mirror>/<repo>/resolve/<commit>/<file>`, as Hugging Face has it), for
/// labs without the network.
fn source(model: &Model, f: &File) -> String {
    #[cfg(debug_assertions)]
    if let Some(mirror) = std::env::var_os("TF_DICTATION_MIRROR") {
        return format!("{}/{}/resolve/{}/{}", mirror.to_string_lossy().trim_end_matches('/'), model.repo, model.commit, f.name);
    }
    model.url(f)
}

fn part_path(dir: &Path, f: &File) -> PathBuf {
    dir.join(format!("{}.part", f.name))
}

/// What a downloaded file must be.
struct Expect<'a> {
    name: &'a str,
    size: u64,
    sha256: &'a str,
}

fn io_err(e: std::io::Error) -> VoiceError {
    VoiceError::Other(format!("can't write the model files: {e}"))
}

pub fn sha256_file(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(hex(&h.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// HTTP for model downloads: rustls on ring with the Mozilla roots (as the app's updater), on a
/// small runtime of its own so callers can stay synchronous.
pub struct Downloader {
    client: reqwest::Client,
    rt: tokio::runtime::Runtime,
}

impl Downloader {
    pub fn new(user_agent: &str) -> Result<Self, VoiceError> {
        let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| VoiceError::Download(format!("TLS setup failed: {e}")))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let client = reqwest::Client::builder()
            .tls_backend_preconfigured(tls)
            .user_agent(user_agent)
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| VoiceError::Download(format!("HTTP client setup failed: {e}")))?;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| VoiceError::Download(format!("can't start the downloader: {e}")))?;
        Ok(Self { client, rt })
    }

    /// Downloads `url` into `part`, continuing after the bytes it already holds, and checks the
    /// whole file against `f`. A part that fails the check is deleted (the next attempt starts
    /// over).
    fn fetch(&self, url: &str, part: &Path, f: &Expect<'_>, cancel: &AtomicBool, progress: &dyn Fn(u64)) -> Result<(), VoiceError> {
        let mut have = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
        if have > f.size {
            let _ = fs::remove_file(part);
            have = 0;
        }
        // Hash what is already there, then the rest as it arrives.
        let mut hasher = Sha256::new();
        if have > 0 {
            let mut file = fs::File::open(part).map_err(io_err)?;
            let mut buf = vec![0u8; 1 << 20];
            let mut left = have;
            while left > 0 {
                let n = file.read(&mut buf[..(left.min(1 << 20)) as usize]).map_err(io_err)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
                left -= n as u64;
            }
        }
        if have < f.size {
            self.rt.block_on(async {
                let mut req = self.client.get(url);
                if have > 0 {
                    req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
                }
                let mut res = req.send().await.map_err(describe)?;
                let status = res.status();
                if have > 0 && status == reqwest::StatusCode::OK {
                    // The server ignored the range: start over.
                    have = 0;
                    hasher = Sha256::new();
                } else if !status.is_success() {
                    return Err(VoiceError::Download(format!("{} answered {status}", host_of(url))));
                }
                let mut out = fs::OpenOptions::new().create(true).write(true).truncate(have == 0).append(have > 0).open(part).map_err(io_err)?;
                while let Some(chunk) = res.chunk().await.map_err(describe)? {
                    if cancel.load(Ordering::Acquire) {
                        return Err(VoiceError::Cancelled);
                    }
                    have += chunk.len() as u64;
                    if have > f.size {
                        return Err(VoiceError::Download(format!("{} is larger than expected", f.name)));
                    }
                    hasher.update(&chunk);
                    out.write_all(&chunk).map_err(io_err)?;
                    progress(have);
                }
                out.flush().map_err(io_err)?;
                Ok(())
            })?;
        }
        let got = hex(&hasher.finalize());
        if have != f.size || got != f.sha256 {
            let _ = fs::remove_file(part);
            return Err(VoiceError::Download(if have != f.size {
                format!("{} ended early ({have} of {} bytes)", f.name, f.size)
            } else {
                format!("{} doesn't match its checksum", f.name)
            }));
        }
        Ok(())
    }
}

fn host_of(url: &str) -> &str {
    url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url)
}

fn describe(e: reqwest::Error) -> VoiceError {
    VoiceError::Download(if e.is_timeout() {
        "the download stalled".into()
    } else if e.is_connect() {
        "couldn't reach Hugging Face (offline?)".into()
    } else {
        e.without_url().to_string()
    })
}

#[cfg(test)]
mod tests {
    use std::{
        io::{BufRead, BufReader},
        net::TcpListener,
        sync::Arc,
        thread,
    };

    use super::*;
    use crate::catalog::{DeviceClass, Kind};

    fn sha(data: &[u8]) -> String {
        hex(&Sha256::digest(data))
    }

    /// A tiny HTTP/1.1 server for one file that honours `Range: bytes=N-`. `cut`: close the
    /// first response after that many bytes (a dropped connection).
    fn serve(data: Vec<u8>, cut: Option<usize>, ranged: bool) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        thread::spawn(move || {
            let mut first = true;
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { break };
                let mut reader = BufReader::new(s.try_clone().unwrap());
                let mut range = None;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(r) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        range = r.trim().trim_end_matches('-').parse::<usize>().ok();
                        log.lock().unwrap().push(format!("range {}", range.unwrap()));
                    }
                }
                let from = if ranged { range.unwrap_or(0) } else { 0 };
                let body = &data[from..];
                let status = if ranged && range.is_some() { "206 Partial Content" } else { "200 OK" };
                let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let n = if first { cut.unwrap_or(body.len()).min(body.len()) } else { body.len() };
                first = false;
                let _ = s.write_all(&body[..n]);
            }
        });
        (format!("http://{addr}/f"), seen)
    }

    fn test_file(data: &[u8]) -> (String, u64) {
        (sha(data), data.len() as u64)
    }

    fn expect<'a>(t: &'a (String, u64)) -> Expect<'a> {
        Expect { name: "model.bin", size: t.1, sha256: &t.0 }
    }

    #[test]
    fn resumes_an_interrupted_download_and_verifies_it() {
        let data: Vec<u8> = (0..200_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let (url, seen) = serve(data.clone(), Some(50_000), true);
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("model.bin.part");
        let t = test_file(&data);
        let f = expect(&t);
        let dl = Downloader::new("tf-dictation-test").unwrap();
        let never = AtomicBool::new(false);
        // The first connection drops after 50 kB: the attempt fails, the part stays.
        let first = dl.fetch(&url, &part, &f, &never, &|_| {});
        assert!(matches!(first, Err(VoiceError::Download(_))), "{first:?}");
        assert_eq!(fs::metadata(&part).unwrap().len(), 50_000);
        // The next one asks for the rest only.
        let progress = Mutex::new(Vec::new());
        dl.fetch(&url, &part, &f, &never, &|n| progress.lock().unwrap().push(n)).unwrap();
        assert_eq!(fs::read(&part).unwrap(), data);
        assert_eq!(seen.lock().unwrap().as_slice(), ["range 50000"]);
        assert_eq!(*progress.lock().unwrap().last().unwrap(), 200_000);
    }

    #[test]
    fn a_server_ignoring_ranges_starts_over() {
        let data: Vec<u8> = (0..100_000u32).map(|i| (i % 13) as u8).collect();
        let (url, _) = serve(data.clone(), None, false);
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("model.bin.part");
        fs::write(&part, &data[..30_000]).unwrap();
        let dl = Downloader::new("tf-dictation-test").unwrap();
        dl.fetch(&url, &part, &expect(&test_file(&data)), &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(fs::read(&part).unwrap(), data);
    }

    #[test]
    fn a_corrupt_download_is_deleted() {
        let data = vec![1u8; 10_000];
        let (url, _) = serve(data.clone(), None, true);
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("model.bin.part");
        let t = test_file(&data);
        let f = Expect { sha256: "0000000000000000000000000000000000000000000000000000000000000000", ..expect(&t) };
        let err = Downloader::new("t").unwrap().fetch(&url, &part, &f, &AtomicBool::new(false), &|_| {}).unwrap_err();
        assert_eq!(err, VoiceError::Download("model.bin doesn't match its checksum".into()));
        assert!(!part.exists());
    }

    #[test]
    fn cancel_keeps_the_part_for_later() {
        let data = vec![7u8; 300_000];
        let (url, _) = serve(data.clone(), None, true);
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("model.bin.part");
        let cancel = AtomicBool::new(true);
        let err = Downloader::new("t").unwrap().fetch(&url, &part, &expect(&test_file(&data)), &cancel, &|_| {}).unwrap_err();
        assert_eq!(err, VoiceError::Cancelled);
    }

    /// Serves `data` once per connection in `piece`-byte writes `gap` apart (a slow network).
    fn serve_slowly(data: Vec<u8>, piece: usize, gap: Duration) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { break };
                let _ = s.set_nodelay(true);
                let mut reader = BufReader::new(s.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", data.len());
                for c in data.chunks(piece) {
                    if s.write_all(c).and_then(|()| s.flush()).is_err() {
                        break;
                    }
                    thread::sleep(gap);
                }
            }
        });
        format!("http://{addr}/f")
    }

    /// 400 kB of `i % 251`, served slowly.
    static SLOW_FILES: &[File] = &[File { name: "slow.bin", size: 400_000, sha256: "40087af8731f95ca61e74b1175c6ac119cbe2051f13a06188cefcdcc0c1ac087" }];
    static SLOW_MODEL: Model = Model {
        id: "slow-test",
        name: "t",
        summary: "",
        languages: "",
        language_codes: &["en"],
        auto_language: true,
        kind: Kind::NemoTransducer,
        repo: "r",
        commit: "c1",
        files: SLOW_FILES,
        ram_mb: 1,
        speed: 1,
        accuracy: 1,
        notes: "",
        recommended: &[],
    };

    /// Progress goes to the UI as an event each time: a slow download reports at most four times
    /// a second, not once per network chunk.
    #[test]
    fn a_slow_download_reports_its_progress_at_most_four_times_a_second() {
        let data: Vec<u8> = (0..400_000u32).map(|i| (i % 251) as u8).collect();
        assert_eq!(sha(&data), SLOW_FILES[0].sha256);
        let url = serve_slowly(data.clone(), 4_096, Duration::from_millis(10));
        let model = &SLOW_MODEL;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let reports = Mutex::new(Vec::new());
        let t0 = Instant::now();
        store
            .download_from(model, &|_| url.clone(), &Downloader::new("t").unwrap(), &AtomicBool::new(false), &|n| reports.lock().unwrap().push(n))
            .unwrap();
        let took = t0.elapsed();
        let reports = reports.into_inner().unwrap();
        assert!(took >= Duration::from_millis(500), "the download was meant to be slow: {took:?}");
        assert_eq!(reports.last(), Some(&(data.len() as u64)));
        // One per 250 ms at most, and the one when the file is complete.
        assert!(reports.len() as u128 <= took.as_millis() / 250 + 2, "{} reports in {took:?}", reports.len());
        assert!(store.installed(model));
    }

    static TEST_MODEL_FILES: &[File] = &[File { name: "a.onnx", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }];
    static TEST_MODEL: Model = Model {
        id: "parakeet-tdt-0.6b-v3",
        name: "t",
        summary: "",
        languages: "",
        language_codes: &["en"],
        auto_language: true,
        kind: Kind::NemoTransducer,
        repo: "r",
        commit: "c1",
        files: TEST_MODEL_FILES,
        ram_mb: 1,
        speed: 1,
        accuracy: 1,
        notes: "",
        recommended: &[DeviceClass::Desktop],
    };

    #[test]
    fn installed_needs_every_file_and_the_current_commit() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let mdir = store.model_dir(&TEST_MODEL);
        fs::create_dir_all(&mdir).unwrap();
        fs::write(mdir.join("a.onnx"), b"abc").unwrap();
        assert!(!store.installed(&TEST_MODEL));
        fs::write(mdir.join(MARKER), "c0").unwrap();
        assert!(!store.installed(&TEST_MODEL), "an older commit is not this model");
        fs::write(mdir.join(MARKER), "c1").unwrap();
        assert!(store.installed(&TEST_MODEL));
        fs::write(mdir.join("a.onnx"), b"ab").unwrap();
        assert!(!store.installed(&TEST_MODEL), "a truncated file");
    }

    #[test]
    fn removing_the_chosen_model_unselects_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        fs::create_dir_all(store.model_dir(&TEST_MODEL)).unwrap();
        store.update_prefs(|p| p.selected = Some(TEST_MODEL.id.into())).unwrap();
        store.remove(&TEST_MODEL).unwrap();
        assert!(!store.model_dir(&TEST_MODEL).exists());
        assert_eq!(store.prefs(), Prefs { selected: None, language: "auto".into(), microphone: None });
        // Removing what isn't there is fine.
        store.remove(&TEST_MODEL).unwrap();
    }

    #[test]
    fn sweep_drops_unknown_models_stale_commits_and_stray_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let models = store.root().join("models");
        fs::create_dir_all(models.join("retired-model")).unwrap();
        let cur = catalog::find("canary-180m-flash").unwrap();
        let old = catalog::find("whisper-base").unwrap();
        fs::create_dir_all(store.model_dir(cur)).unwrap();
        fs::write(store.model_dir(cur).join(MARKER), cur.commit).unwrap();
        fs::write(store.model_dir(cur).join("tokens.txt.part"), b"x").unwrap();
        fs::write(store.model_dir(cur).join("stray.onnx"), b"x").unwrap();
        fs::create_dir_all(store.model_dir(old)).unwrap();
        fs::write(store.model_dir(old).join(MARKER), "0123").unwrap();
        store.sweep();
        assert!(!models.join("retired-model").exists());
        assert!(!store.model_dir(old).exists());
        assert!(store.model_dir(cur).join("tokens.txt.part").exists());
        assert!(!store.model_dir(cur).join("stray.onnx").exists());
    }
}
