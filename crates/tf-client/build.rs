//! Embeds the tf-hostd binaries found under `$TF_HOSTD_DIST/<triple>/` (default
//! `<workspace>/target/hostd-dist`), zstd-compressed, plus the companion extension
//! `host/teleflock-bridge/teleflock-bridge.ts`. Missing artifacts are not a build error:
//! the generated tables simply lack them and deploy fails at runtime naming what is missing.
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

/// Compresses `src` into `OUT_DIR/<triple>.zst`, reusing a previous result for the same input.
fn compress(out_dir: &Path, triple: &str, raw: &[u8], sha: &str) -> PathBuf {
    let zst = out_dir.join(format!("{triple}.tf-hostd.zst"));
    let stamp = out_dir.join(format!("{triple}.tf-hostd.sha256"));
    if zst.is_file() && std::fs::read_to_string(&stamp).is_ok_and(|s| s == sha) {
        return zst;
    }
    let compressed = zstd::bulk::compress(raw, ZSTD_LEVEL).expect("zstd compress tf-hostd");
    std::fs::write(&zst, compressed).unwrap();
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
    println!("cargo:rerun-if-changed={}", dist.display());

    let mut out = String::new();
    out.push_str("/// tf-hostd binaries embedded at build time (zstd).\n");
    out.push_str("pub static HOSTD_BINS: &[EmbeddedHostd] = &[\n");
    for triple in TRIPLES {
        let exe = if triple.contains("windows") { "tf-hostd.exe" } else { "tf-hostd" };
        let path = dist.join(triple).join(exe);
        println!("cargo:rerun-if-changed={}", path.display());
        if !path.is_file() || (android && triple.contains("windows")) {
            continue;
        }
        let raw = std::fs::read(&path).unwrap();
        let sha = hex(&Sha256::digest(&raw));
        let zst = compress(&out_dir, triple, &raw, &sha);
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
