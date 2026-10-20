#!/usr/bin/env bash
# Builds the TeleFlock Windows NSIS installer on Linux (cross-compiled with cargo-xwin):
#   1. frontend (bun run build → dist/)
#   2. tf-hostd for every deploy target (scripts/build-hostd.sh → target/hostd-dist, embedded
#      into the app by tf-client's build.rs)
#   3. the app + NSIS installer (tauri build --runner cargo-xwin --bundles nsis)
# Output: dist-release/TeleFlock_<version>_x64-setup.exe (+ .sha256)
#
# Env: CARGO_TARGET_DIR (default <repo>/target/release-windows), SKIP_HOSTD=1 to reuse an
#      existing target/hostd-dist, SKIP_FRONTEND=1 to reuse dist/.
# Native Windows builds use .github/workflows/windows.yml instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target/release-windows}"
export TF_HOSTD_DIST="${TF_HOSTD_DIST:-$ROOT/target/hostd-dist}"
TRIPLE=x86_64-pc-windows-msvc
OUT="$ROOT/dist-release"

log() { printf '\033[1;35m[build-windows]\033[0m %s\n' "$*"; }

command -v cargo-xwin >/dev/null || { log "cargo install cargo-xwin"; cargo install --locked cargo-xwin; }
command -v makensis >/dev/null || { echo "makensis missing: apt-get install nsis (docs/build.md §3)" >&2; exit 1; }
rustup target list --installed | grep -qx "$TRIPLE" || rustup target add "$TRIPLE"

[ -d node_modules ] || { log "bun install"; bun install --frozen-lockfile; }
if [ "${SKIP_FRONTEND:-0}" != 1 ]; then
  log "frontend"
  bun run build
fi
if [ "${SKIP_HOSTD:-0}" != 1 ]; then
  log "tf-hostd"
  scripts/build-hostd.sh
fi

log "app + NSIS installer ($TRIPLE)"
# The frontend was built above; don't let tauri run beforeBuildCommand again.
bun tauri build --runner cargo-xwin --target "$TRIPLE" --bundles nsis \
  --config '{"build":{"beforeBuildCommand":""}}'

VERSION="$(bun -e 'console.log(require("./src-tauri/tauri.conf.json").version)')"
SETUP="$CARGO_TARGET_DIR/$TRIPLE/release/bundle/nsis/TeleFlock_${VERSION}_x64-setup.exe"
[ -f "$SETUP" ] || { echo "installer not found at $SETUP" >&2; exit 1; }
mkdir -p "$OUT"
cp -f "$SETUP" "$OUT/"
DEST="$OUT/$(basename "$SETUP")"
(cd "$OUT" && sha256sum "$(basename "$DEST")" > "$(basename "$DEST").sha256")
log "→ $DEST ($(stat -c %s "$DEST") bytes)"
command -v file >/dev/null && file "$DEST"
