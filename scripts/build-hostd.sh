#!/usr/bin/env bash
# Builds tf-hostd (the herdr-host daemon the app uploads) for every host it can deploy to:
#   x86_64-unknown-linux-musl   static Linux (cargo-zigbuild)
#   aarch64-unknown-linux-musl  static Linux arm64 (cargo-zigbuild)
#   x86_64-pc-windows-msvc      Windows Local mode (cargo-xwin)
# into target/hostd-dist/<triple>/tf-hostd[.exe], where tf-client's build.rs embeds them.
#
# Usage: scripts/build-hostd.sh [triple ...]      (default: all three)
# Env:   CARGO_TARGET_DIR  build dir (default: <repo>/target/hostd-build)
#        TF_HOSTD_DIST     output dir (default: <repo>/target/hostd-dist)
#        ZIG_VERSION       zig to install if none on PATH (default 0.15.2)
# Missing tools (zig, cargo-zigbuild, cargo-xwin, rustup targets) are installed on demand.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${TF_HOSTD_DIST:-$ROOT/target/hostd-dist}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target/hostd-build}"
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

build_one() {
  local triple="$1" exe="tf-hostd" out
  case "$triple" in
    *-linux-musl)
      ensure_zig; ensure_cargo_tool cargo-zigbuild cargo-zigbuild; ensure_target "$triple"
      log "$triple (cargo zigbuild)"
      cargo zigbuild --release -p tf-hostd --target "$triple"
      ;;
    *-windows-msvc)
      ensure_cargo_tool cargo-xwin cargo-xwin; ensure_target "$triple"
      exe="tf-hostd.exe"
      log "$triple (cargo xwin)"
      cargo xwin build --release -p tf-hostd --target "$triple"
      ;;
    *-linux-gnu)
      ensure_target "$triple"
      log "$triple (cargo)"
      cargo build --release -p tf-hostd --target "$triple"
      ;;
    *) echo "unsupported triple: $triple" >&2; exit 2 ;;
  esac
  out="$DIST/$triple"
  mkdir -p "$out"
  install -m 0755 "$CARGO_TARGET_DIR/$triple/release/$exe" "$out/$exe"
  log "→ $out/$exe ($(stat -c %s "$out/$exe") bytes)"
}

cd "$ROOT"
for t in "${TRIPLES[@]}"; do build_one "$t"; done

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
