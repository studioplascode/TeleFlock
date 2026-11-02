//! Embeds the tf-hostd binaries found under `$TF_HOSTD_DIST/<triple>/` (default
//! `<workspace>/target/hostd-dist`), zstd-compressed, plus the companion extension
//! `host/teleflock-bridge/teleflock-bridge.ts`. Missing artifacts are not a build error:
//! the generated tables simply lack them and deploy fails at runtime naming what is missing.
//!
//! `scripts/build-hostd.sh` stores each binary compressed next to it (`tf-hostd[.exe].zst`,
//! zstd -19), which is embedded when it decompresses to exactly that binary; otherwise
//! (binaries put there by hand) this script compresses the binary itself. Either way what is
//! embedded is this script's copy in `OUT_DIR`, never the dist file: rustc reads `include_bytes!`
//! after this script has checked the bytes, and another build-hostd.sh run may rewrite the shared
//! dist dir in between.
//!
//! Android builds only embed Linux/macOS hosts (phones reach hosts over Tailscale SSH;
//! Windows hosts are local/WSL-only).

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const TRIPLES: &[&str] = &[
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
];

const ZSTD_LEVEL: i32 = 19;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `<binary>.zst` written by scripts/build-hostd.sh, if it decompresses to exactly `raw`.
fn precompressed(path: &Path, raw: &[u8]) -> Option<Vec<u8>> {
    let mut zst = path.as_os_str().to_owned();
    zst.push(".zst");
    let compressed = std::fs::read(PathBuf::from(zst)).ok()?;
    (zstd::bulk::decompress(&compressed, raw.len()).ok()? == raw).then_some(compressed)
}

/// Writes `raw` compressed to `OUT_DIR/<triple>.tf-hostd.zst` (the precompressed copy next to
/// `path` if it matches, else compressed here) and returns that file, which is kept for the next
/// run while `raw` is the same.
fn compressed(out_dir: &Path, path: &Path, triple: &str, raw: &[u8], sha: &str) -> PathBuf {
    let zst = out_dir.join(format!("{triple}.tf-hostd.zst"));
    let stamp = out_dir.join(format!("{triple}.tf-hostd.sha256"));
    if zst.is_file() && std::fs::read_to_string(&stamp).is_ok_and(|s| s == sha) {
        return zst;
    }
    let bytes = precompressed(path, raw)
        .unwrap_or_else(|| zstd::bulk::compress(raw, ZSTD_LEVEL).expect("zstd compress tf-hostd"));
    // The stamp goes first, so an interrupted write never leaves a stamped partial file.
    let _ = std::fs::remove_file(&stamp);
    std::fs::write(&zst, bytes).unwrap();
    std::fs::write(&stamp, sha).unwrap();
    zst
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.parent().and_then(Path::parent).expect("workspace root").to_path_buf();
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let android = std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "android");
    println!("cargo:rerun-if-env-changed=TF_HOSTD_DIST");
    let dist = std::env::var_os("TF_HOSTD_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("target").join("hostd-dist"));
    // A rerun-if-changed path that does not exist makes cargo rerun this script, and so rebuild
    // this crate and the app, on every build. So only the dist dir is watched (a binary added,
    // replaced or removed below it changes the newest mtime cargo compares), not each triple's
    // file; without the dir, the script reruns until there is one.
    println!("cargo:rerun-if-changed={}", dist.display());

    let mut out = String::new();
    out.push_str("/// tf-hostd binaries embedded at build time (zstd).\n");
    out.push_str("pub static HOSTD_BINS: &[EmbeddedHostd] = &[\n");
    for triple in TRIPLES {
        let exe = if triple.contains("windows") { "tf-hostd.exe" } else { "tf-hostd" };
        let path = dist.join(triple).join(exe);
        if !path.is_file() || (android && triple.contains("windows")) {
            continue;
        }
        let raw = std::fs::read(&path).unwrap();
        let sha = hex(&Sha256::digest(&raw));
        let zst = compressed(&out_dir, &path, triple, &raw, &sha);
        writeln!(
            out,
            "    EmbeddedHostd {{ triple: {triple:?}, sha256: {sha:?}, len: {}, zstd: include_bytes!({:?}) }},",
            raw.len(),
            zst.display().to_string()
        )
        .unwrap();
    }
    out.push_str("];\n");

    let bridge = root.join("host").join("teleflock-bridge").join("teleflock-bridge.ts");
    println!("cargo:rerun-if-changed={}", bridge.display());
    if bridge.is_file() {
        writeln!(
            out,
            "/// Companion extension source.\npub static BRIDGE_EXT: Option<&str> = Some(include_str!({:?}));",
            bridge.display().to_string()
        )
        .unwrap();
    } else {
        out.push_str("/// Companion extension source (absent at build time).\npub static BRIDGE_EXT: Option<&str> = None;\n");
    }
    writeln!(out, "/// Where the build looked for hostd binaries.\npub static HOSTD_DIST_DIR: &str = {:?};", dist.display().to_string()).unwrap();

    std::fs::write(out_dir.join("embedded.rs"), out).unwrap();
}
