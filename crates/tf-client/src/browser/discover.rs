//! The browsers this device can run (`BrowserConfig::engines`), in the order the app prefers them:
//! Google Chrome, Chromium, Microsoft Edge, Brave, then the Chrome for Testing the app downloaded
//! (`super::install`). A path the user configured (`BrowserConfig::engine_path`) wins over all of
//! them. Snap packages are left out: their confinement keeps them out of hidden directories such
//! as the app's data dir, where the profile lives.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tf_proto::BrowserEngine;

pub(super) const CHROME: &str = "Google Chrome";
pub(super) const CHROMIUM: &str = "Chromium";
pub(super) const EDGE: &str = "Microsoft Edge";
pub(super) const BRAVE: &str = "Brave";
pub(super) const CFT: &str = "Chrome for Testing";

/// A version probe (`<browser> --version`) that takes longer is given up.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Where each engine may be installed on `os` (`linux`, `macos`, `windows`), in the order the
/// engines are preferred, each engine's places in the order they are tried. `env` reads the
/// environment (`PATH`, `HOME`, `ProgramFiles`, `ProgramFiles(x86)`, `LOCALAPPDATA`).
pub(super) fn candidates(os: &str, env: &dyn Fn(&str) -> Option<OsString>) -> Vec<(&'static str, PathBuf)> {
    let mut out = Vec::new();
    match os {
        "windows" => {
            let roots: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"].into_iter().filter_map(env).map(PathBuf::from).collect();
            for (name, rel) in [
                (CHROME, &["Google", "Chrome", "Application", "chrome.exe"][..]),
                (CHROMIUM, &["Chromium", "Application", "chrome.exe"]),
                (EDGE, &["Microsoft", "Edge", "Application", "msedge.exe"]),
                (BRAVE, &["BraveSoftware", "Brave-Browser", "Application", "brave.exe"]),
            ] {
                for root in &roots {
                    out.push((name, rel.iter().fold(root.clone(), |p, c| p.join(c))));
                }
            }
        }
        "macos" => {
            let mut roots = vec![PathBuf::from("/Applications")];
            roots.extend(env("HOME").map(|h| PathBuf::from(h).join("Applications")));
            for (name, app, exe) in [
                (CHROME, "Google Chrome.app", "Google Chrome"),
                (CHROMIUM, "Chromium.app", "Chromium"),
                (EDGE, "Microsoft Edge.app", "Microsoft Edge"),
                (BRAVE, "Brave Browser.app", "Brave Browser"),
            ] {
                for root in &roots {
                    out.push((name, root.join(app).join("Contents").join("MacOS").join(exe)));
                }
            }
        }
        _ => {
            let path: Vec<PathBuf> = env("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
            for (name, commands, fixed) in [
                (CHROME, &["google-chrome-stable", "google-chrome"][..], &["/opt/google/chrome/chrome"][..]),
                (CHROMIUM, &["chromium", "chromium-browser"], &["/usr/lib/chromium/chromium", "/usr/lib/chromium-browser/chromium-browser"]),
                (EDGE, &["microsoft-edge-stable", "microsoft-edge"], &["/opt/microsoft/msedge/msedge"]),
                (BRAVE, &["brave-browser-stable", "brave-browser", "brave"], &["/opt/brave.com/brave/brave"]),
            ] {
                for c in commands {
                    out.extend(path.iter().map(|dir| (name, dir.join(c))));
                }
                out.extend(fixed.iter().map(|f| (name, PathBuf::from(f))));
            }
        }
    }
    out
}

/// The engines installed here, one per name in [`candidates`] order, then Chrome for Testing
/// (`cft`, when downloaded): `(name, path)`.
pub(super) fn found(os: &str, env: &dyn Fn(&str) -> Option<OsString>, cft: Option<PathBuf>) -> Vec<(&'static str, PathBuf)> {
    let mut out: Vec<(&'static str, PathBuf)> = Vec::new();
    for (name, path) in candidates(os, env) {
        if out.iter().any(|(n, _)| *n == name) || !runnable(&path) || is_snap(&path) {
            continue;
        }
        out.push((name, path));
    }
    out.extend(cft.filter(|p| runnable(p)).map(|p| (CFT, p)));
    out
}

/// An executable file (Windows: any file).
pub(super) fn runnable(path: &Path) -> bool {
    let Ok(m) = std::fs::metadata(path) else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        m.is_file() && m.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    m.is_file()
}

/// A snap package, or Ubuntu's script that runs one (`/usr/bin/chromium-browser`).
fn is_snap(path: &Path) -> bool {
    if std::fs::canonicalize(path).is_ok_and(|p| p.starts_with("/snap")) {
        return true;
    }
    std::fs::metadata(path).is_ok_and(|m| m.len() < 16 * 1024)
        && std::fs::read(path).is_ok_and(|b| b.starts_with(b"#!") && b.windows(6).any(|w| w == b"/snap/"))
}

/// The engine name of `path` when it is a discovered one.
pub(super) fn name_of(path: &Path, found: &[(&'static str, PathBuf)]) -> Option<String> {
    found.iter().find(|(_, p)| p == path).map(|(n, _)| n.to_string())
}

/// An engine as the wire shows it; the one named [`CFT`] (the download, as [`found`] names it) is
/// TeleFlock's own browser.
pub(super) fn engine(name: &str, path: &Path, version: Option<String>) -> BrowserEngine {
    BrowserEngine { name: name.to_string(), path: path.to_string_lossy().into_owned(), version, builtin: name == CFT, blocked: false }
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

/// What a browser's `--version` says (`Google Chrome 120.0.6099.109`, `Chromium 119.0.6045.159
/// built on Debian 12.4`, `Brave Browser 120.1.61.109`): the product (the words before the
/// version) and the first `x.y.z[.w]`.
pub(super) fn parse_version(out: &str) -> (Option<String>, Option<String>) {
    let words: Vec<&str> = out.split_whitespace().collect();
    match words.iter().position(|t| is_version(t)) {
        Some(i) => ((i > 0).then(|| words[..i].join(" ")), Some(words[i].to_string())),
        None => (None, None),
    }
}

fn is_version(t: &str) -> bool {
    let parts: Vec<&str> = t.split('.').collect();
    parts.len() >= 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
}

fn version_key(v: &str) -> Vec<u64> {
    v.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

/// The newest `x.y.z.w` directory next to `exe` (how Chrome, Edge and Brave install on Windows:
/// `Application\chrome.exe` beside `Application\120.0.6099.109\`).
pub(super) fn version_dir(exe: &Path) -> Option<String> {
    let dir = exe.parent()?;
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().to_str().map(String::from))
        .filter(|n| is_version(n))
        .max_by_key(|n| version_key(n))
}

/// What probing found, by path, with the file's modification time then.
#[derive(Default)]
pub(super) struct Versions(HashMap<PathBuf, (Option<SystemTime>, Probed)>);

/// A browser's product name and version.
type Probed = (Option<String>, Option<String>);

impl Versions {
    fn cached(&self, path: &Path) -> Option<Probed> {
        let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        self.0.get(path).filter(|(t, _)| *t == mtime).map(|(_, v)| v.clone())
    }
}

/// `path`'s product and version: Windows reads the version from the install's version
/// directory, other systems ask the browser (`--version`).
async fn probe(os: &str, path: &Path) -> Probed {
    if os == "windows" {
        return (None, version_dir(path));
    }
    let mut cmd = tokio::process::Command::new(path);
    cmd.arg("--version").stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    match tokio::time::timeout(PROBE_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => parse_version(&String::from_utf8_lossy(&out.stdout)),
        _ => (None, None),
    }
}

/// Engines with versions (cached, else probed and remembered in `versions`); an engine without
/// a name (a configured path) is named by the product it reports, else by its file.
pub(super) async fn with_versions(os: &str, engines: Vec<(Option<String>, PathBuf)>, versions: &std::sync::Mutex<Versions>) -> Vec<BrowserEngine> {
    let mut out = Vec::with_capacity(engines.len());
    for (name, path) in engines {
        let cached = versions.lock().unwrap().cached(&path);
        let (product, version) = match cached {
            Some(v) => v,
            None => {
                let v = probe(os, &path).await;
                let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
                versions.lock().unwrap().0.insert(path.clone(), (mtime, v.clone()));
                v
            }
        };
        match name {
            Some(n) => out.push(engine(&n, &path, version)),
            // Not one of the discovered engines, so never TeleFlock's own.
            None => out.push(BrowserEngine { name: product.unwrap_or_else(|| file_name(&path)), path: path.to_string_lossy().into_owned(), version, builtin: false, blocked: false }),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exe(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\necho 'Chromium 1.2.3.4'\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn env_of(vars: Vec<(&'static str, OsString)>) -> impl Fn(&str) -> Option<OsString> {
        move |k| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone())
    }

    /// Chrome, Chromium, Edge, Brave in that order whatever order PATH lists them in, one entry
    /// per engine (the first place it is found), Chrome for Testing last, snap packages and
    /// files that are not programs skipped.
    #[test]
    fn linux_preference_order() {
        let td = tempfile::tempdir().unwrap();
        let (a, b) = (td.path().join("a"), td.path().join("b"));
        exe(&a.join("brave-browser"));
        exe(&a.join("chromium"));
        exe(&b.join("microsoft-edge"));
        exe(&b.join("google-chrome"));
        exe(&a.join("google-chrome-stable"));
        std::fs::write(b.join("chromium-browser"), "#!/bin/sh\nexec /snap/bin/chromium \"$@\"\n").unwrap();
        std::fs::write(b.join("brave"), "not a program").unwrap();
        let cft = td.path().join("engine/156.0.8078.80/chrome-linux64/chrome");
        exe(&cft);
        let path = std::env::join_paths([&a, &b]).unwrap();
        let env = env_of(vec![("PATH", path)]);
        let got = found("linux", &env, Some(cft.clone()));
        assert_eq!(
            got,
            vec![
                (CHROME, a.join("google-chrome-stable")),
                (CHROMIUM, a.join("chromium")),
                (EDGE, b.join("microsoft-edge")),
                (BRAVE, a.join("brave-browser")),
                (CFT, cft.clone()),
            ]
        );
        assert_eq!(name_of(&a.join("chromium"), &got).as_deref(), Some(CHROMIUM));
        assert_eq!(name_of(Path::new("/opt/custom/thorium-browser"), &got), None, "a configured path that is not one of them");
        // Ubuntu's chromium-browser script runs the snap: never picked.
        assert!(is_snap(&b.join("chromium-browser")));
        let only_snap = env_of(vec![("PATH", std::env::join_paths([&b]).unwrap())]);
        assert!(found("linux", &only_snap, None).iter().all(|(n, _)| *n != CHROMIUM));
    }

    #[test]
    fn windows_and_macos_places() {
        let env = env_of(vec![
            ("ProgramFiles", r"C:\Program Files".into()),
            ("ProgramFiles(x86)", r"C:\Program Files (x86)".into()),
            ("LOCALAPPDATA", r"C:\Users\ada\AppData\Local".into()),
            ("HOME", "/Users/ada".into()),
        ]);
        let win: Vec<(&str, String)> = candidates("windows", &env).into_iter().map(|(n, p)| (n, p.to_string_lossy().replace('/', "\\"))).collect();
        assert_eq!(win[0], (CHROME, r"C:\Program Files\Google\Chrome\Application\chrome.exe".to_string()));
        assert_eq!(win[2], (CHROME, r"C:\Users\ada\AppData\Local\Google\Chrome\Application\chrome.exe".to_string()));
        assert_eq!(win[3], (CHROMIUM, r"C:\Program Files\Chromium\Application\chrome.exe".to_string()));
        assert_eq!(win[7], (EDGE, r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe".to_string()));
        assert_eq!(win[11], (BRAVE, r"C:\Users\ada\AppData\Local\BraveSoftware\Brave-Browser\Application\brave.exe".to_string()));
        let mac = candidates("macos", &env);
        assert_eq!(mac[0], (CHROME, PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")));
        assert_eq!(mac[1], (CHROME, PathBuf::from("/Users/ada/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")));
        assert_eq!(mac[6], (BRAVE, PathBuf::from("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")));
    }

    #[tokio::test]
    async fn versions() {
        let v = |s: &str| parse_version(s);
        let some = |p: &str, n: &str| (Some(p.to_string()), Some(n.to_string()));
        assert_eq!(v("Google Chrome 120.0.6099.109 \n"), some("Google Chrome", "120.0.6099.109"));
        assert_eq!(v("Chromium 119.0.6045.159 built on Debian 12.4, running on Debian 12.4\n"), some("Chromium", "119.0.6045.159"));
        assert_eq!(v("Microsoft Edge 120.0.2210.61 unknown\n"), some("Microsoft Edge", "120.0.2210.61"));
        assert_eq!(v("Brave Browser 120.1.61.109\n"), some("Brave Browser", "120.1.61.109"));
        assert_eq!(v("Google Chrome for Testing 156.0.8078.80 \n"), some("Google Chrome for Testing", "156.0.8078.80"));
        assert_eq!(v("156.0.8078.80\n"), (None, Some("156.0.8078.80".into())));
        assert_eq!(v("no version here"), (None, None));
        let td = tempfile::tempdir().unwrap();
        let app = td.path().join("Application");
        for d in ["119.0.6045.199", "120.0.6099.109", "SetupMetrics", "9.0.1.1"] {
            std::fs::create_dir_all(app.join(d)).unwrap();
        }
        assert_eq!(version_dir(&app.join("chrome.exe")).as_deref(), Some("120.0.6099.109"));
        // A configured path is named by what it reports; a discovered one keeps its name.
        let custom = td.path().join("bin/thorium");
        exe(&custom);
        let versions = std::sync::Mutex::default();
        let got = with_versions("linux", vec![(None, custom.clone()), (Some(CHROME.into()), custom.clone())], &versions).await;
        assert_eq!((got[0].name.as_str(), got[0].version.as_deref()), ("Chromium", Some("1.2.3.4")));
        assert_eq!((got[1].name.as_str(), got[1].version.as_deref()), (CHROME, Some("1.2.3.4")));
    }
}
