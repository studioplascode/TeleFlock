//! Agent-presented documents (the bridge's `present` artifacts) for the webview.
//!
//! An HTML artifact cannot run in an `srcdoc` frame of the app's page: that frame inherits the
//! app's CSP, which blocks inline scripts. The page stages the document here instead
//! (`doc_stage`) and frames the URL it gets back; the `tfdoc` protocol answers that URL with the
//! document under a policy of its own (the artifact policy plus `sandbox allow-scripts`: an
//! opaque origin, nothing over the network). `doc_release` drops a document the page no longer
//! shows. `doc_open` (desktop) writes a document to a private temporary file and opens it with
//! the OS default app.

use std::collections::VecDeque;
use std::hash::{BuildHasher, RandomState};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::http::{Method, Request, Response, StatusCode, header};
use tauri::{Manager, Runtime, State, UriSchemeContext, UriSchemeResponder};

/// URI scheme of staged documents.
pub const SCHEME: &str = "tfdoc";

/// A staged document's URL is this plus its token. Tauri 2 serves a custom scheme as
/// `<scheme>://localhost/` on macOS and Linux and as `http://<scheme>.localhost/` on Windows and
/// Android (`https://` only with `useHttpsScheme`, which tauri.conf.json leaves off).
#[cfg(any(windows, target_os = "android"))]
const BASE: &str = "http://tfdoc.localhost/";
#[cfg(not(any(windows, target_os = "android")))]
const BASE: &str = "tfdoc://localhost/";

/// The artifact wrapper's policy, verbatim, plus `sandbox allow-scripts`.
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; \
    style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; \
    media-src data: blob:; worker-src data: blob:; frame-src 'none'; child-src 'none'; \
    connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; \
    manifest-src 'none'; sandbox allow-scripts";

/// Documents staged at most; one more evicts the oldest.
const MAX_DOCS: usize = 12;
/// Bytes staged at most, all documents together; staging past it evicts the oldest.
const MAX_BYTES: usize = 96 << 20;

/// Staged documents (Tauri state), served by [`serve`].
pub struct Docs(Mutex<Store>);

impl Default for Docs {
    fn default() -> Self {
        Self(Mutex::new(Store::new(MAX_DOCS, MAX_BYTES)))
    }
}

impl Docs {
    fn store(&self) -> MutexGuard<'_, Store> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Stages `doc` under a new token; answers its URL.
    fn stage(&self, doc: Vec<u8>) -> Result<String, String> {
        let token = token();
        self.store().stage(token.clone(), doc)?;
        Ok(format!("{BASE}{token}"))
    }

    /// The document a protocol request for `path` (`/<token>`) names.
    fn find(&self, path: &str) -> Option<Arc<Vec<u8>>> {
        let token = path.strip_prefix('/').filter(|t| is_token(t))?;
        self.store().get(token)
    }

    /// Drops the document [`Docs::stage`] answered `url` for, if it is still there.
    fn release(&self, url: &str) {
        if let Some(token) = url.strip_prefix(BASE).filter(|t| is_token(t)) {
            self.store().release(token);
        }
    }
}

/// The staged documents, oldest first, within a count and a byte limit.
struct Store {
    docs: VecDeque<(String, Arc<Vec<u8>>)>,
    bytes: usize,
    max_docs: usize,
    max_bytes: usize,
}

impl Store {
    fn new(max_docs: usize, max_bytes: usize) -> Self {
        Self { docs: VecDeque::new(), bytes: 0, max_docs, max_bytes }
    }

    /// Keeps `doc` under `token`, then evicts the oldest documents until both limits hold again
    /// (never `doc`). A document over the byte limit on its own is refused.
    fn stage(&mut self, token: String, doc: Vec<u8>) -> Result<(), String> {
        if doc.len() > self.max_bytes {
            return Err(format!(
                "this document is too large to show ({:.1} MiB, at most {} MiB)",
                doc.len() as f64 / f64::from(1 << 20),
                self.max_bytes >> 20
            ));
        }
        self.bytes += doc.len();
        self.docs.push_back((token, Arc::new(doc)));
        while self.docs.len() > self.max_docs || self.bytes > self.max_bytes {
            let Some((_, old)) = self.docs.pop_front() else { break };
            self.bytes -= old.len();
        }
        Ok(())
    }

    fn get(&self, token: &str) -> Option<Arc<Vec<u8>>> {
        self.docs.iter().find(|(t, _)| t == token).map(|(_, doc)| Arc::clone(doc))
    }

    fn release(&mut self, token: &str) {
        if let Some(i) = self.docs.iter().position(|(t, _)| t == token)
            && let Some((_, doc)) = self.docs.remove(i)
        {
            self.bytes -= doc.len();
        }
    }
}

/// A new token: 128 bits as 32 lowercase hex digits, two SipHash values of a serial number, the
/// time and the pid under this process's hash keys (`RandomState`, seeded by the OS): unique in
/// practice and not predictable without the keys.
fn token() -> String {
    static KEYS: LazyLock<RandomState> = LazyLock::new(RandomState::new);
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let pid = std::process::id();
    let [high, low] = [0u8, 1].map(|half| KEYS.hash_one((half, serial, nanos, pid)));
    format!("{high:016x}{low:016x}")
}

fn is_token(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The protocol's answer to a `method` request whose path names `doc` (`None`: no staged
/// document): the document for `GET`, else 404 or 405 as text. Every answer carries the policy.
fn response(method: &Method, doc: Option<&[u8]>) -> Response<Vec<u8>> {
    let text = |status, message: &str| (status, "text/plain; charset=utf-8", message.as_bytes().to_vec());
    let (status, content_type, body) = match doc {
        _ if method != Method::GET => text(StatusCode::METHOD_NOT_ALLOWED, "only GET"),
        None => text(StatusCode::NOT_FOUND, "no such document"),
        Some(doc) => (StatusCode::OK, "text/html; charset=utf-8", doc.to_vec()),
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, CSP)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer");
    if status == StatusCode::METHOD_NOT_ALLOWED {
        builder = builder.header(header::ALLOW, "GET");
    }
    builder.body(body).expect("static status and headers")
}

/// The `tfdoc` protocol (every webview): `GET /<token>` answers the document staged under that
/// token. The lookup is a clone of an `Arc`; the copy into the response is made on the blocking
/// pool, off the webview thread that calls this.
pub fn serve<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let doc = ctx.app_handle().try_state::<Docs>().and_then(|docs| docs.find(request.uri().path()));
    let method = request.method().clone();
    tauri::async_runtime::spawn_blocking(move || responder.respond(response(&method, doc.as_deref().map(Vec::as_slice))));
}

/// Stages `html` and answers the URL an `<iframe src>` in the main webview shows it from
/// (`tfdoc://localhost/<token>`, Windows and Android `http://tfdoc.localhost/<token>`). The 12
/// most recent documents stay, 96 MiB together; a document over 96 MiB is refused. Async: a
/// large document's argument is taken on the async runtime, not on the main thread.
#[tauri::command]
pub async fn doc_stage(docs: State<'_, Docs>, html: String) -> Result<String, String> {
    docs.stage(html.into_bytes())
}

/// Drops the document staged under `url`; nothing when there is none.
#[tauri::command]
pub fn doc_release(docs: State<'_, Docs>, url: String) {
    docs.release(&url);
}

/// Writes `base64` (a document's bytes, at most 64 MiB) to a private temporary file named after
/// `name` and opens it with the OS default app. Desktop only.
#[tauri::command]
pub async fn doc_open(name: String, base64: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        tauri::async_runtime::spawn_blocking(move || file::open(&name, &base64)).await.map_err(|e| e.to_string())?
    }
    #[cfg(mobile)]
    {
        let _ = (name, base64);
        Err("unsupported".to_owned())
    }
}

/// `doc_open`'s files: `<temp>/teleflock-docs-<uid>/<random>/<name>` (Windows: `teleflock-docs`).
#[cfg(desktop)]
mod file {
    use std::fs;
    use std::io::Write as _;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime};

    /// Largest document written.
    const MAX_BYTES: usize = 64 << 20;
    /// Earlier documents' folders are deleted once they are this old.
    const KEEP: Duration = Duration::from_secs(24 * 60 * 60);
    /// Longest file name, extension included.
    const MAX_NAME: usize = 100;
    /// Extensions a file keeps: what the app's Open in browser writes (an HTML page with the
    /// artifact policy first, Markdown, images, JSON, text) and source files whose default app shows
    /// them rather than runs them. Any other extension, or none, gets `.txt` appended, so a
    /// presented `.bat`, `.js` (Windows Script Host), `.py`, `.command` (macOS) or `.desktop` opens
    /// as text instead of running, and so do `.svg` and `.xml` (a browser runs their scripts outside
    /// the sandbox) and `.csv`/`.tsv` (a spreadsheet app evaluates their formulas).
    const OPENABLE: &[&str] = &[
        "html", "htm", "md", "markdown", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "json", "txt",
        "log", "rs", "go", "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "java", "kt", "swift", "zig", "ts", "tsx", "mts",
        "cts", "css", "scss", "less", "sql", "yaml", "yml", "toml", "ini", "diff", "patch", "proto", "graphql",
    ];

    pub fn open(name: &str, base64: &str) -> Result<(), String> {
        let bytes = decode(base64, MAX_BYTES)?;
        #[cfg(unix)]
        // SAFETY: getuid has no preconditions and always succeeds.
        let root = root_in(&std::env::temp_dir(), Some(unsafe { libc::getuid() }));
        #[cfg(not(unix))]
        let root = root_in(&std::env::temp_dir(), None);
        let path = write(&root, &file_name(name), &bytes, SystemTime::now())?;
        crate::platform::open_default(path.as_os_str())
    }

    /// This user's folder for `doc_open`'s files in `temp`: `teleflock-docs-<uid>` on Unix, where the
    /// temporary folder is shared (`/tmp`: another account's folder of one shared name would be
    /// refused, see [`write`], until they deleted it); `teleflock-docs` on Windows, whose `%TEMP%` is
    /// the user's own.
    fn root_in(temp: &Path, uid: Option<u32>) -> PathBuf {
        temp.join(uid.map_or_else(|| "teleflock-docs".to_owned(), |uid| format!("teleflock-docs-{uid}")))
    }

    /// The bytes of `data` (standard base64); more than `max` is refused, longer input undecoded.
    fn decode(data: &str, max: usize) -> Result<Vec<u8>, String> {
        use base64::Engine as _;
        let too_large = || format!("the document is too large to open (at most {} MiB)", max >> 20);
        if data.len() > max.div_ceil(3) * 4 {
            return Err(too_large());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| format!("the document is not base64: {e}"))?;
        if bytes.len() > max {
            return Err(too_large());
        }
        Ok(bytes)
    }

    /// A safe file name for `name` (a file name or path): its last segment with every run of
    /// characters outside `[A-Za-z0-9._ -]` turned into one `_`, the extension kept when it is
    /// [`OPENABLE`] (else `.txt` appended), at most [`MAX_NAME`] characters, never empty, never
    /// starting with a dot and never a Windows device name (`CON`, `NUL`, `COM1`, …).
    fn file_name(name: &str) -> String {
        let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
        let mut clean = String::with_capacity(last.len());
        let mut in_run = false;
        for c in last.chars() {
            let keep = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ' ' | '-');
            if keep {
                clean.push(c);
            } else if !in_run {
                clean.push('_');
            }
            in_run = !keep;
        }
        let (stem, ext) = match clean.rsplit_once('.') {
            Some((stem, ext)) if OPENABLE.iter().any(|o| o.eq_ignore_ascii_case(ext)) => (stem, ext),
            _ => (clean.as_str(), "txt"),
        };
        let stem = stem.trim_matches(['.', ' ']);
        let mut stem =
            if stem.chars().all(|c| c == '_' || c == '.' || c == ' ') { "document".to_owned() } else { stem.to_owned() };
        if is_device_name(&stem) {
            stem.insert(0, '_');
        }
        // ASCII only from here: byte lengths are character counts.
        stem.truncate(MAX_NAME - 1 - ext.len());
        format!("{}.{ext}", stem.trim_end_matches(['.', ' ']))
    }

    /// Windows reserves these names whatever the extension (`con.html` is the console).
    fn is_device_name(stem: &str) -> bool {
        let head = stem.split('.').next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
        matches!(head.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (head.len() == 4 && (head.starts_with("COM") || head.starts_with("LPT")) && head.as_bytes()[3].is_ascii_digit())
    }

    /// A folder only this user can enter (0700 on Unix); fails when it exists.
    fn private_dir(path: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(path)
        }
        #[cfg(not(unix))]
        fs::create_dir(path)
    }

    /// Writes `bytes` to `<root>/<random>/<name>` (folders 0700, file 0600 on Unix), first deleting
    /// the other folders under `root` older than [`KEEP`] at `now`. `root` must be this user's own
    /// folder: a symlink there, or another user's folder (`/tmp` is shared), is refused and never
    /// pruned.
    fn write(root: &Path, name: &str, bytes: &[u8], now: SystemTime) -> Result<PathBuf, String> {
        let failed = |what: &str, path: &Path, e: std::io::Error| format!("{what} {}: {e}", path.display());
        match private_dir(root) {
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(failed("creating", root, e)),
            _ => {}
        }
        let meta = fs::symlink_metadata(root).map_err(|e| failed("reading", root, e))?;
        if !meta.is_dir() {
            return Err(format!("{} is not a folder", root.display()));
        }
        let dir = root.join(super::token());
        private_dir(&dir).map_err(|e| failed("creating", &dir, e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            // The new folder's owner is this user.
            if fs::metadata(&dir).map_err(|e| failed("reading", &dir, e))?.uid() != meta.uid() {
                let _ = fs::remove_dir(&dir);
                return Err(format!("{} belongs to another user", root.display()));
            }
            fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|e| failed("securing", root, e))?;
        }
        prune(root, &dir, now);
        let path = dir.join(name);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&path).map_err(|e| failed("creating", &path, e))?;
        file.write_all(bytes).map_err(|e| failed("writing", &path, e))?;
        Ok(path)
    }

    /// Deletes the folders under `root` but `keep` last changed more than [`KEEP`] before `now`;
    /// files and symlinks stay.
    fn prune(root: &Path, keep: &Path, now: SystemTime) {
        let Ok(entries) = fs::read_dir(root) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let stale = entry.file_type().is_ok_and(|t| t.is_dir())
                && entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| now.duration_since(t).is_ok_and(|age| age > KEEP));
            if stale && path != keep {
                let _ = fs::remove_dir_all(&path);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn decodes_base64_within_the_limit() {
            assert_eq!(decode("PHA+aGk8L3A+", 64).unwrap(), b"<p>hi</p>");
            assert!(decode("not base64!", 64).unwrap_err().contains("not base64"));
            // 13 bytes are 20 characters: 14 are refused once decoded, 24 characters undecoded.
            assert_eq!(decode("AAAAAAAAAAAAAAAAAA==", 13).unwrap(), [0; 13]);
            assert!(decode("AAAAAAAAAAAAAAAAAAA=", 13).unwrap_err().contains("too large"));
            assert!(decode(&"!".repeat(24), 13).unwrap_err().contains("too large"));
        }

        #[test]
        fn file_names_are_reduced_and_never_runnable() {
            let cases = [
                ("presented/report-v2.html", "report-v2.html"),
                ("C:\\Users\\me\\Notes.MD", "Notes.MD"),
                ("Q3: sales (draft).csv", "Q3_ sales _draft_.csv.txt"),
                ("report-v2.tsv", "report-v2.tsv.txt"),
                ("logo-v1.svg", "logo-v1.svg.txt"),
                ("feed.XML", "feed.XML.txt"),
                ("logo-v1.html", "logo-v1.html"),
                ("日本語.md", "document.md"),
                ("", "document.txt"),
                (".html", "document.html"),
                ("....", "document.txt"),
                (".bashrc", "bashrc.txt"),
                ("../../etc/passwd", "passwd.txt"),
                ("report. ", "report.txt"),
                ("run.bat", "run.bat.txt"),
                ("tool.JS", "tool.JS.txt"),
                ("setup.exe", "setup.exe.txt"),
                ("launch.desktop", "launch.desktop.txt"),
                ("con.html", "_con.html"),
                ("LPT1 .txt", "_LPT1.txt"),
                ("nul.tar.gz", "_nul.tar.gz.txt"),
                ("a?:*b.md", "a_b.md"),
                ("a_?b.md", "a__b.md"),
                ("com10.txt", "com10.txt"),
                ("console.html", "console.html"),
            ];
            for (name, expected) in cases {
                assert_eq!(file_name(name), expected, "{name:?}");
            }
            let long = file_name(&format!("{}.markdown", "a".repeat(300)));
            assert_eq!(long.len(), MAX_NAME);
            assert!(long.ends_with("a.markdown"));
            let long = file_name(&"b".repeat(300));
            assert_eq!((long.len(), &long[95..]), (MAX_NAME, "b.txt"));
        }

        #[test]
        fn writes_private_files_and_prunes_old_folders() {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path().join("teleflock-docs");
            let now = SystemTime::now();
            let first = write(&root, "a.html", b"<p>a</p>", now).unwrap();
            assert_eq!(fs::read(&first).unwrap(), b"<p>a</p>");
            let first_dir = first.parent().unwrap().to_owned();
            assert_eq!(first_dir.parent().unwrap(), root);
            assert!(super::super::is_token(first_dir.file_name().unwrap().to_str().unwrap()));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
                assert_eq!((mode(&root), mode(&first_dir), mode(&first)), (0o700, 0o700, 0o600));
            }
            // A day later the first folder goes; a file there stays.
            fs::write(root.join("note"), b"x").unwrap();
            let second = write(&root, "a.html", b"<p>b</p>", now + KEEP + Duration::from_secs(60)).unwrap();
            assert!(!first_dir.exists());
            assert!(second.exists() && root.join("note").exists());
            // Not yet a day: both stay.
            let third = write(&root, "a.html", b"<p>c</p>", now).unwrap();
            assert!(second.exists() && third.exists());
        }

        #[cfg(unix)]
        #[test]
        fn a_symlinked_root_is_refused_and_not_pruned() {
            let tmp = tempfile::tempdir().unwrap();
            let elsewhere = tmp.path().join("home");
            fs::create_dir_all(elsewhere.join("old")).unwrap();
            let root = tmp.path().join("teleflock-docs");
            std::os::unix::fs::symlink(&elsewhere, &root).unwrap();
            let later = SystemTime::now() + KEEP * 2;
            assert!(write(&root, "a.html", b"x", later).unwrap_err().contains("not a folder"));
            assert!(elsewhere.join("old").exists());
            assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 1);
        }

        #[cfg(unix)]
        #[test]
        fn another_accounts_folder_is_not_in_the_way() {
            let tmp = tempfile::tempdir().unwrap();
            // SAFETY: getuid has no preconditions and always succeeds.
            let me = unsafe { libc::getuid() };
            let other = me + 1;
            assert_eq!(root_in(tmp.path(), Some(me)), tmp.path().join(format!("teleflock-docs-{me}")));
            assert_eq!(root_in(tmp.path(), None), tmp.path().join("teleflock-docs"));
            // Another account made its folder first (owned by it when the test can chown, as root).
            let theirs = root_in(tmp.path(), Some(other));
            fs::create_dir(&theirs).unwrap();
            if std::os::unix::fs::chown(&theirs, Some(other), None).is_ok() {
                assert!(write(&theirs, "a.html", b"x", SystemTime::now()).unwrap_err().contains("belongs to another user"));
            }
            assert!(write(&root_in(tmp.path(), Some(me)), "a.html", b"x", SystemTime::now()).is_ok());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_follow_tauris_custom_scheme_convention() {
        #[cfg(any(windows, target_os = "android"))]
        let base = "http://tfdoc.localhost/";
        #[cfg(not(any(windows, target_os = "android")))]
        let base = "tfdoc://localhost/";
        let docs = Docs::default();
        let url = docs.stage(b"<p>hi</p>".to_vec()).unwrap();
        let token = url.strip_prefix(base).expect("this platform's URL form");
        assert!(is_token(token), "{token}");
        // What the protocol handler sees for it (Windows and Android map the http form back).
        let path = url.parse::<tauri::http::Uri>().unwrap().path().to_owned();
        assert_eq!(path, format!("/{token}"));
        assert_eq!(docs.find(&path).as_deref().map(Vec::as_slice), Some(&b"<p>hi</p>"[..]));
        docs.release(&url);
        assert!(docs.find(&path).is_none());
    }

    #[test]
    fn tokens_are_fresh_lowercase_hex() {
        let tokens: std::collections::HashSet<String> = (0..1000).map(|_| token()).collect();
        assert_eq!(tokens.len(), 1000);
        assert!(tokens.iter().all(|t| is_token(t)));
    }

    #[test]
    fn request_paths_name_only_well_formed_tokens() {
        assert!(is_token("0123456789abcdef0123456789abcdef"));
        for bad in [
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "0123456789abcdef0123456789abcdeg",
            "",
        ] {
            assert!(!is_token(bad), "{bad:?}");
        }
        let docs = Docs::default();
        let url = docs.stage(b"x".to_vec()).unwrap();
        let token = &url[url.len() - 32..];
        assert!(docs.find(&format!("/{token}")).is_some());
        for path in [
            token.to_owned(),
            format!("/{token}/"),
            format!("/{token}/style.css"),
            format!("//{token}"),
            "/".to_owned(),
            String::new(),
        ] {
            assert!(docs.find(&path).is_none(), "{path:?}");
        }
        // Releasing what is not a staged URL changes nothing.
        docs.release(&format!("https://example.com/{token}"));
        docs.release(token);
        assert!(docs.find(&format!("/{token}")).is_some());
    }

    #[test]
    fn staging_evicts_the_oldest_past_either_limit() {
        // Count: the first of four is gone.
        let mut store = Store::new(3, 100);
        for t in ["t0", "t1", "t2", "t3"] {
            store.stage(t.into(), vec![b'x'; 2]).unwrap();
        }
        assert!(store.get("t0").is_none());
        assert!(["t1", "t2", "t3"].iter().all(|t| store.get(t).is_some()));
        assert_eq!(store.bytes, 6);

        // Bytes: 4 + 4 + 4 is over 10, so the oldest goes; a 10-byte document leaves only itself.
        let mut store = Store::new(10, 10);
        for t in ["a", "b", "c"] {
            store.stage(t.into(), vec![b'x'; 4]).unwrap();
        }
        assert!(store.get("a").is_none() && store.get("b").is_some() && store.get("c").is_some());
        assert_eq!(store.bytes, 8);
        store.stage("full".into(), vec![b'y'; 10]).unwrap();
        assert_eq!((store.docs.len(), store.bytes), (1, 10));
        assert!(store.get("full").is_some());
        // Over the limit on its own: refused, nothing evicted.
        assert!(store.stage("huge".into(), vec![b'z'; 11]).unwrap_err().contains("too large"));
        assert_eq!((store.docs.len(), store.bytes), (1, 10));
        store.release("unknown");
        assert_eq!(store.bytes, 10);
        store.release("full");
        assert_eq!((store.docs.len(), store.bytes), (0, 0));

        // The app's store keeps the 12 most recent.
        let docs = Docs::default();
        let urls: Vec<String> = (0..13).map(|_| docs.stage(b"<p>".to_vec()).unwrap()).collect();
        let path = |url: &str| format!("/{}", &url[url.len() - 32..]);
        assert!(docs.find(&path(&urls[0])).is_none());
        assert!(urls[1..].iter().all(|url| docs.find(&path(url)).is_some()));
    }

    #[test]
    fn responses_carry_the_document_under_the_policy() {
        let ok = response(&Method::GET, Some(b"<p>hi</p>"));
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.body(), b"<p>hi</p>");
        let headers = ok.headers();
        let get = |name: header::HeaderName| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
        assert_eq!(get(header::CONTENT_TYPE), "text/html; charset=utf-8");
        assert_eq!(
            get(header::CONTENT_SECURITY_POLICY),
            "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; \
             img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src data: blob:; frame-src 'none'; \
             child-src 'none'; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; \
             manifest-src 'none'; sandbox allow-scripts"
        );
        assert_eq!(get(header::CACHE_CONTROL), "no-store");
        assert_eq!(get(header::X_CONTENT_TYPE_OPTIONS), "nosniff");
        assert_eq!(get(header::REFERRER_POLICY), "no-referrer");

        let missing = response(&Method::GET, None);
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(missing.headers()[header::CONTENT_TYPE], "text/plain; charset=utf-8");

        for method in [Method::POST, Method::HEAD, Method::PUT] {
            let refused = response(&method, Some(b"<p>hi</p>"));
            assert_eq!(refused.status(), StatusCode::METHOD_NOT_ALLOWED, "{method}");
            assert_eq!(refused.headers()[header::ALLOW], "GET");
            assert!(!refused.body().starts_with(b"<p>"));
        }
    }
}
