//! Links the speech engine (feature `engine`): the sherpa-onnx C API with onnxruntime, as the
//! prebuilt libraries sherpa-onnx publishes for its v2.0.1 release, pinned by sha256. Desktop
//! targets link them statically into the app. Android links the shared libraries, which an APK
//! would have to carry next to the app's own library (`DEP_TF_DICTATION_ENGINE_LIB_DIR` names
//! their directory); the Android app doesn't build this crate (it keeps the system speech
//! recognizer). Also fetches the Silero voice activity model (630 KB, MIT), which the crate
//! embeds (`OUT_DIR/silero_vad.onnx`).
//!
//! Downloads (`curl`) go to a cache keyed by sha256, `$TF_NATIVE_CACHE` (default
//! `<repo>/target/native-cache`), so every build dir (target/shared, target/release-*, the Linux
//! build container, which mounts the repo at the same path) reuses them. The script reruns when
//! the cache's files it used are gone (the extracted archive's `.complete`, the VAD model), so a
//! deleted cache is fetched again rather than leaving the link without its libraries.
//! `TF_DICTATION_LIB_DIR` points at already extracted libraries instead (offline builds; the VAD
//! model still needs the cache or the network).
//!
//! A build interrupted while downloading or extracting leaves its temporary file or directory
//! (up to 1 GB) in the cache, which nothing else would finish. Every build holds `<cache>/.lock`
//! shared while it works there, and one that finds no other holding it removes them first.

use std::{
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::Command,
};

use sha2::{Digest, Sha256};

const RELEASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1";

const VAD_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
const VAD_SHA256: &str = "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6";

struct Prebuilt {
    file: &'static str,
    sha256: &'static str,
    /// Shared libraries (Android); static archives elsewhere.
    shared: bool,
}

fn prebuilt(os: &str, arch: &str) -> Option<Prebuilt> {
    let (file, sha256, shared) = match (os, arch) {
        ("linux", "x86_64") => (
            "sherpa-onnx-v2.0.1-linux-x64-static-lib.tar.bz2",
            "55cfadf65ba50d0afc1a802b7a337942819e51c94a5b5a384def1978f7c70871",
            false,
        ),
        ("linux", "aarch64") => (
            "sherpa-onnx-v2.0.1-linux-aarch64-static-lib.tar.bz2",
            "b6c6090e40fd18d6812f04fe21260602cd1223d7b5e83ad39dab87ad7c1c031d",
            false,
        ),
        ("macos", "x86_64") => (
            "sherpa-onnx-v2.0.1-osx-x64-static-lib.tar.bz2",
            "6a3cb3c14104d3a02e7b2a6cd5621f590b14892cce7d0bc0935f7655ef518938",
            false,
        ),
        ("macos", "aarch64") => (
            "sherpa-onnx-v2.0.1-osx-arm64-static-lib.tar.bz2",
            "d7a9b14f337958e7373c8c650f046df33d210bbaff2f33cb8322dda663ee5e1c",
            false,
        ),
        // `MT`: built against the static CRT, which tauri-build links on Windows (libcmt +
        // libvcruntime, dynamic UCRT).
        ("windows", "x86_64") => (
            "sherpa-onnx-v2.0.1-win-x64-static-MT-Release-lib.tar.bz2",
            "23e7b986b197eda0bbc47ff3d7d5c87afd6ef2b9077214ba26b0f1ec52ef0e66",
            false,
        ),
        // One archive for every ABI (jniLibs/<abi>/); APKs ship arm64-v8a only.
        ("android", "aarch64") => (
            "sherpa-onnx-v2.0.1-android.tar.bz2",
            "39003753ec293425ed56723ea9b972b98841a490af3311670c3060548d654330",
            true,
        ),
        _ => return None,
    };
    Some(Prebuilt { file, sha256, shared })
}

/// Static archives in link order (each only refers to the ones after it).
const STATIC_LIBS: &[&str] = &[
    "sherpa-onnx-c-api",
    "sherpa-onnx-core",
    "kaldi-decoder-core",
    "sherpa-onnx-kaldifst-core",
    "sherpa-onnx-fstfar",
    "sherpa-onnx-fst",
    "kaldi-native-fbank-core",
    "kissfft-float",
    "onnxruntime",
    "ssentencepiece_core",
    "utf8proc",
];

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=TF_DICTATION_LIB_DIR");
    println!("cargo:rerun-if-env-changed=TF_NATIVE_CACHE");
    if env::var_os("CARGO_FEATURE_ENGINE").is_none() {
        return;
    }
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();
    let Some(pre) = prebuilt(&os, &arch) else {
        panic!("tf-dictation: no prebuilt speech engine for {os}/{arch}; build without the `engine` feature");
    };
    let cache = cache_root();
    // Held until the script ends: no other build sweeps the cache while this one works in it.
    let _cache_lock = lock_cache(&cache);

    let vad = cache.join(format!("{}-silero_vad.onnx", &VAD_SHA256[..16]));
    download(VAD_URL, VAD_SHA256, &vad);
    watch(&vad);
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::copy(&vad, out.join("silero_vad.onnx")).expect("copy silero_vad.onnx into OUT_DIR");

    let lib_dir = match env::var_os("TF_DICTATION_LIB_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => {
            let root = fetch_archive(&cache, &pre);
            // The libraries stay in the cache (`static:-bundle`): the final link needs them there.
            watch(&root.join(".complete"));
            if pre.shared { root.join("jniLibs").join(android_abi(&arch)) } else { find_lib_dir(&root) }
        }
    };
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    // For dependents' build scripts (`DEP_TF_DICTATION_ENGINE_LIB_DIR`: the shared libraries an
    // Android APK would carry).
    println!("cargo:lib_dir={}", lib_dir.display());
    if pre.shared {
        println!("cargo:rustc-link-lib=dylib=sherpa-onnx-c-api");
        return;
    }
    // Not bundled into the rlib (onnxruntime alone is > 100 MB): the final link finds them on the
    // search path above.
    for lib in STATIC_LIBS {
        println!("cargo:rustc-link-lib=static:-bundle={lib}");
    }
    match os.as_str() {
        "linux" => {
            for lib in ["stdc++", "m", "pthread", "dl"] {
                println!("cargo:rustc-link-lib=dylib={lib}");
            }
        }
        "macos" => {
            // onnxruntime calls CoreFoundation (CFString, CFTimeZone) and NSLog.
            println!("cargo:rustc-link-lib=dylib=c++");
            println!("cargo:rustc-link-lib=framework=CoreFoundation");
            println!("cargo:rustc-link-lib=framework=Foundation");
        }
        "windows" if !cfg!(windows) => windows_case_fixups(&out),
        _ => {}
    }
}

/// Cross builds from Linux (cargo-xwin) link against a copy of the Windows SDK on a
/// case-sensitive file system, where onnxruntime's `/DEFAULTLIB:PathCch.lib` matches no file
/// (the SDK has `pathcch.lib` and `PATHCCH.lib`). A copy under the requested name, on the link
/// search path, fixes the link; native Windows builds never get here.
fn windows_case_fixups(out: &Path) {
    const REQUESTED: &[&str] = &["PathCch.lib"];
    let flags = env::var("CARGO_ENCODED_RUSTFLAGS").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut parts = flags.split('\x1f').peekable();
    while let Some(p) = parts.next() {
        let value = match p {
            "-L" => parts.next().unwrap_or(""),
            _ => p.strip_prefix("-L").unwrap_or(""),
        };
        if !value.is_empty() {
            dirs.push(PathBuf::from(value.split_once('=').map_or(value, |(_, d)| d)));
        }
    }
    dirs.extend(env::var("LIB").unwrap_or_default().split(';').filter(|d| !d.is_empty()).map(PathBuf::from));
    let fix = out.join("winlibs");
    fs::create_dir_all(&fix).unwrap();
    for name in REQUESTED {
        if dirs.iter().any(|d| d.join(name).is_file()) {
            continue;
        }
        let found = dirs.iter().find_map(|d| {
            fs::read_dir(d).ok()?.flatten().map(|e| e.path()).find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(name)))
        });
        match found {
            Some(src) => {
                fs::copy(&src, fix.join(name)).unwrap_or_else(|e| panic!("tf-dictation: copy {}: {e}", src.display()));
            }
            None => println!("cargo:warning=tf-dictation: no {name} in the Windows SDK search path; the link may fail"),
        }
    }
    println!("cargo:rustc-link-search=native={}", fix.display());
}

fn android_abi(arch: &str) -> &'static str {
    match arch {
        "aarch64" => "arm64-v8a",
        "arm" => "armeabi-v7a",
        "x86" => "x86",
        _ => "x86_64",
    }
}

/// The directory holding the static archives inside an extracted archive (`<stem>/lib`).
fn find_lib_dir(root: &Path) -> PathBuf {
    let direct = root.join("lib");
    if direct.is_dir() {
        return direct;
    }
    fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path().join("lib"))
        .find(|p| p.is_dir())
        .unwrap_or_else(|| panic!("tf-dictation: no lib/ directory in {}", root.display()))
}

fn cache_root() -> PathBuf {
    let root = match env::var_os("TF_NATIVE_CACHE") {
        Some(dir) => PathBuf::from(dir),
        None => {
            let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
            manifest.parent().and_then(Path::parent).expect("repo root").join("target").join("native-cache")
        }
    };
    fs::create_dir_all(&root).unwrap_or_else(|e| panic!("tf-dictation: create {}: {e}", root.display()));
    root
}

/// Locks the cache shared and returns the lock; first, if no other build holds it, removes what
/// interrupted builds left there (`sweep`). A lock rather than process ids: the Linux build
/// container shares the cache from a pid namespace of its own. A cache that can't be locked is
/// used without (and not swept).
fn lock_cache(cache: &Path) -> Option<fs::File> {
    let lock = fs::File::options().write(true).create(true).truncate(false).open(cache.join(".lock")).ok()?;
    if lock.try_lock().is_ok() {
        sweep(cache);
        lock.unlock().ok()?;
    }
    lock.lock_shared().ok()?;
    Some(lock)
}

/// Removes the temporary files and directories of `download` and `fetch_archive` from the cache.
/// Only while no other build works there: only the build that made one would ever finish it.
fn sweep(cache: &Path) {
    for entry in fs::read_dir(cache).into_iter().flatten().flatten() {
        if !entry.file_name().to_str().is_some_and(is_temp_name) {
            continue;
        }
        let path = entry.path();
        let removed = match entry.file_type() {
            Ok(t) if t.is_dir() => fs::remove_dir_all(&path),
            _ => fs::remove_file(&path),
        };
        if removed.is_ok() {
            println!("cargo:warning=tf-dictation: removed {}, left by an interrupted build", path.display());
        }
    }
}

/// Whether `name` is one of the temporary names `download` (`<file>.part-<suffix>`) and
/// `fetch_archive` (`sherpa-onnx-<sha>.tmp-<suffix>`) give, `<suffix>` as `temp_suffix` makes it.
fn is_temp_name(name: &str) -> bool {
    let Some((stem, suffix)) = name.rsplit_once(".part-").or_else(|| name.rsplit_once(".tmp-")) else {
        return false;
    };
    let Some((pid, random)) = suffix.split_once('-') else {
        return false;
    };
    (stem.starts_with("sherpa-onnx-") || stem.ends_with("silero_vad.onnx"))
        && !pid.is_empty()
        && pid.bytes().all(|b| b.is_ascii_digit())
        && random.len() == 16
        && random.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Reruns this script once `path` is gone. Its time is set back to the epoch first: cargo reruns a
/// script whose watched files are newer than its last run, and this run may just have written it.
fn watch(path: &Path) {
    if let Ok(f) = fs::File::options().write(true).open(path) {
        let _ = f.set_modified(std::time::UNIX_EPOCH);
    }
    println!("cargo:rerun-if-changed={}", path.display());
}

/// A temporary name's suffix: the process id and 64 random bits (the process id alone is not
/// unique: the Linux build container shares the cache from a pid namespace of its own).
fn temp_suffix() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    format!("{}-{:016x}", std::process::id(), h.finish())
}

/// Downloads `url` to `dest` unless `dest` already holds `sha256`. Concurrent builds (other
/// target dirs, the build container) may fetch the same file: each writes its own temporary name
/// and renames it. A download that stalls (under 1 KB/s for a minute) is retried like a failed one.
fn download(url: &str, sha256: &str, dest: &Path) {
    if sha256_file(dest).as_deref() == Some(sha256) {
        return;
    }
    let mut part = dest.as_os_str().to_owned();
    part.push(format!(".part-{}", temp_suffix()));
    let part = PathBuf::from(part);
    println!("cargo:warning=tf-dictation: downloading {url}");
    let status = Command::new("curl")
        .args(["-fsSL", "--retry", "3", "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "60", "-o"])
        .arg(&part)
        .arg(url)
        .status()
        .unwrap_or_else(|e| panic!("tf-dictation: running curl to fetch {url}: {e}"));
    if !status.success() {
        let _ = fs::remove_file(&part);
        panic!("tf-dictation: downloading {url} failed ({status})");
    }
    let got = sha256_file(&part).unwrap_or_default();
    if got != sha256 {
        let _ = fs::remove_file(&part);
        panic!("tf-dictation: {url} has sha256 {got}, expected {sha256}");
    }
    if fs::rename(&part, dest).is_err() {
        let _ = fs::remove_file(&part);
    }
}

/// Downloads and extracts `pre` unless the cache has it; returns the extracted dir.
fn fetch_archive(cache: &Path, pre: &Prebuilt) -> PathBuf {
    let dir = cache.join(format!("sherpa-onnx-{}", &pre.sha256[..16]));
    if dir.join(".complete").is_file() {
        return dir;
    }
    let archive = cache.join(pre.file);
    download(&format!("{RELEASE}/{}", pre.file), pre.sha256, &archive);
    let tmp = cache.join(format!("sherpa-onnx-{}.tmp-{}", &pre.sha256[..16], temp_suffix()));
    let _ = fs::remove_dir_all(&tmp);
    let file = fs::File::open(&archive).unwrap_or_else(|e| panic!("tf-dictation: open {}: {e}", archive.display()));
    tar::Archive::new(bzip2::read::BzDecoder::new(io::BufReader::new(file)))
        .unpack(&tmp)
        .unwrap_or_else(|e| panic!("tf-dictation: unpacking {}: {e}", archive.display()));
    fs::write(tmp.join(".complete"), pre.sha256).unwrap();
    if fs::rename(&tmp, &dir).is_err() {
        // Another build finished first (or a stale incomplete dir is in the way).
        if dir.join(".complete").is_file() {
            let _ = fs::remove_dir_all(&tmp);
        } else {
            let _ = fs::remove_dir_all(&dir);
            fs::rename(&tmp, &dir).unwrap_or_else(|e| panic!("tf-dictation: rename into {}: {e}", dir.display()));
        }
    }
    dir
}

fn sha256_file(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}
