//! Embeds the tf-hostd binaries found under `$TF_HOSTD_DIST/<triple>/` (default
//! `<workspace>/target/hostd-dist`) and the companion extension
//! `host/teleflock-bridge/teleflock-bridge.ts`. Missing artifacts are not a build error:
//! the generated tables simply lack them and deploy fails at runtime naming what is missing.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

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

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.parent().and_then(Path::parent).expect("workspace root").to_path_buf();
    println!("cargo:rerun-if-env-changed=TF_HOSTD_DIST");
    let dist = std::env::var_os("TF_HOSTD_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("target").join("hostd-dist"));
    println!("cargo:rerun-if-changed={}", dist.display());

    let mut out = String::new();
    out.push_str("/// `(target triple, tf-hostd binary)` pairs embedded at build time.\n");
    out.push_str("pub static HOSTD_BINS: &[(&str, &[u8])] = &[\n");
    for triple in TRIPLES {
        let exe = if triple.contains("windows") { "tf-hostd.exe" } else { "tf-hostd" };
        let path = dist.join(triple).join(exe);
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_file() {
            writeln!(out, "    ({triple:?}, include_bytes!({:?})),", path.display().to_string()).unwrap();
        }
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

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    std::fs::write(out_dir.join("embedded.rs"), out).unwrap();
}
