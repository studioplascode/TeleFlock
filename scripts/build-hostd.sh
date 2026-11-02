#!/usr/bin/env bash
# Builds tf-hostd (the herdr-host daemon the app uploads) into
# target/hostd-dist/<triple>/tf-hostd[.exe], each next to tf-hostd[.exe].zst (zstd -19), which
# tf-client's build.rs embeds as is. Default triples, the hosts the app deploys to:
#   x86_64-unknown-linux-musl   static Linux (cargo-zigbuild)
#   aarch64-unknown-linux-musl  static Linux arm64 (cargo-zigbuild)
#   x86_64-pc-windows-msvc      Windows Local mode (cargo-xwin)
# On request also *-linux-gnu and *-apple-darwin (plain cargo; .github/workflows/macos.yml builds
# the macOS ones on a Mac).
#
# The triples of one tool build in one cargo invocation (build scripts and proc-macros compiled
# once, the targets in parallel). The tools run side by side, each in its own build dir because
# cargo locks a build dir for a whole invocation: cargo-zigbuild in $CARGO_TARGET_DIR,
# cargo-xwin in $CARGO_TARGET_DIR-xwin, plain cargo in $CARGO_TARGET_DIR-cargo. Their output
# lines are prefixed with the tool's name.
#
# Usage: scripts/build-hostd.sh [triple ...]      (default: the three above)
# Env:   CARGO_TARGET_DIR  build dir (default: <repo>/target/hostd-build; -xwin / -cargo appended)
#        TF_HOSTD_DIST     output dir (default: <repo>/target/hostd-dist)
#        ZIG_VERSION       zig to install if none on PATH (default 0.15.2)
# Missing tools (zig, cargo-zigbuild, cargo-xwin, rustup targets) are installed on demand. Without
# the zstd CLI no .zst is written and tf-client's build.rs compresses the binaries itself.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${TF_HOSTD_DIST:-$ROOT/target/hostd-dist}"
BUILD_DIR="${CARGO_TARGET_DIR:-$ROOT/target/hostd-build}"
ZIG_VERSION="${ZIG_VERSION:-0.15.2}"
ZIG_SHA256_x86_64_0_15_2="02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239"

TRIPLES=("$@")
[ ${#TRIPLES[@]} -eq 0 ] && TRIPLES=(x86_64-unknown-linux-musl aarch64-unknown-linux-musl x86_64-pc-windows-msvc)

log() { printf '\033[1;35m[build-hostd]\033[0m %s\n' "$*"; }

ensure_target() {
  rustup target list --installed | grep -qx "$1" || { log "rustup target add $1"; rustup target add "$1"; }
}

ensure_zig() {
  command -v zig >/dev/null && return
  local dir="/opt/zig/zig-x86_64-linux-$ZIG_VERSION"
  if [ ! -x "$dir/zig" ]; then
    [ "$(uname -m)" = x86_64 ] || { echo "install zig $ZIG_VERSION for $(uname -m) and put it on PATH" >&2; exit 1; }
    log "installing zig $ZIG_VERSION to /opt/zig"
    local tmp; tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/zig.tar.xz" "https://ziglang.org/download/$ZIG_VERSION/zig-x86_64-linux-$ZIG_VERSION.tar.xz"
    local want_var="ZIG_SHA256_x86_64_${ZIG_VERSION//./_}"
    if [ -n "${!want_var:-}" ]; then
      echo "${!want_var}  $tmp/zig.tar.xz" | sha256sum -c - >/dev/null
    fi
    mkdir -p /opt/zig && tar -xJf "$tmp/zig.tar.xz" -C /opt/zig && rm -rf "$tmp"
  fi
  export PATH="$dir:$PATH"
}

ensure_cargo_tool() { # <binary> <crate>
  command -v "$1" >/dev/null || { log "cargo install $2"; cargo install --locked "$2"; }
}

tool_of() {
  case "$1" in
    *-linux-musl) echo zigbuild ;;
    *-windows-msvc) echo xwin ;;
    *-linux-gnu | *-apple-darwin) echo cargo ;;
    *) echo "unsupported triple: $1" >&2; return 2 ;;
  esac
}

size() { wc -c < "$1" | tr -d ' '; }

# install_one <build dir> <triple>: copies the binary to $DIST/<triple>/ and compresses it.
install_one() {
  local triple="$2" exe=tf-hostd out
  case "$triple" in *-windows-*) exe=tf-hostd.exe ;; esac
  out="$DIST/$triple"
  mkdir -p "$out"
  # tf-client's build.rs watches the dist dir by mtime: only a changed binary is written, so an
  # unchanged one doesn't make the app build again.
  cmp -s "$1/$triple/release/$exe" "$out/$exe" || install -m 0755 "$1/$triple/release/$exe" "$out/$exe"
  if ! command -v zstd >/dev/null; then
    rm -f "$out/$exe.zst"
  elif ! zstd -q -d -c "$out/$exe.zst" 2>/dev/null | cmp -s - "$out/$exe"; then
    zstd -q -19 -f "$out/$exe" -o "$out/$exe.zst"
  fi
  log "→ $out/$exe ($(size "$out/$exe") bytes$(if [ -f "$out/$exe.zst" ]; then echo ", .zst $(size "$out/$exe.zst")"; fi))"
}

# build <tool> <triple…>: one cargo invocation for the triples, then installs each binary.
build() {
  local tool="$1" dir="$BUILD_DIR" t args=()
  shift
  for t in "$@"; do args+=(--target "$t"); done
  case "$tool" in
    zigbuild) CARGO_TARGET_DIR="$dir" cargo zigbuild --release --locked -p tf-hostd "${args[@]}" ;;
    xwin) dir="$BUILD_DIR-xwin"; CARGO_TARGET_DIR="$dir" cargo xwin build --release --locked -p tf-hostd "${args[@]}" ;;
    cargo) dir="$BUILD_DIR-cargo"; CARGO_TARGET_DIR="$dir" cargo build --release --locked -p tf-hostd "${args[@]}" ;;
  esac
  for t in "$@"; do install_one "$dir" "$t"; done
}

prefix() { while IFS= read -r line; do printf '[%s] %s\n' "$1" "$line"; done; }

cd "$ROOT"
# Tools and rustup targets first, one at a time: the builds below run side by side.
TOOLS=()
for t in "${TRIPLES[@]}"; do
  tool="$(tool_of "$t")" || exit 2
  case "$tool" in
    zigbuild) ensure_zig; ensure_cargo_tool cargo-zigbuild cargo-zigbuild ;;
    xwin) ensure_cargo_tool cargo-xwin cargo-xwin ;;
  esac
  ensure_target "$t"
  case " ${TOOLS[*]:-} " in *" $tool "*) ;; *) TOOLS+=("$tool") ;; esac
done

PIDS=()
for tool in "${TOOLS[@]}"; do
  group=()
  for t in "${TRIPLES[@]}"; do
    if [ "$(tool_of "$t")" = "$tool" ]; then group+=("$t"); fi
  done
  log "$tool: ${group[*]}"
  build "$tool" "${group[@]}" 2>&1 | prefix "$tool" &
  PIDS+=($!)
done
FAILED=""
for i in "${!TOOLS[@]}"; do
  wait "${PIDS[$i]}" || FAILED="$FAILED ${TOOLS[$i]}"
done
[ -z "$FAILED" ] || { echo "build-hostd: failed:$FAILED" >&2; exit 1; }

# Sanity: the Linux builds must be static (they run on any distro the user's host has).
for t in "${TRIPLES[@]}"; do
  case "$t" in *-linux-musl)
    if command -v file >/dev/null; then
      file "$DIST/$t/tf-hostd" | grep -q "statically linked\|static-pie linked" \
        || { echo "$DIST/$t/tf-hostd is not statically linked" >&2; file "$DIST/$t/tf-hostd" >&2; exit 1; }
    fi
  esac
done
log "done: $DIST"
