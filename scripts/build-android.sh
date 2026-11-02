#!/usr/bin/env bash
# Builds the signed TeleFlock Android APK for arm64 phones (arm64-v8a only):
#   1. frontend (bun run build → dist/)
#   2. tf-hostd for every deploy target (scripts/build-hostd.sh → embedded by tf-client)
#   3. tauri android build --apk --target aarch64 (Rust + Gradle, incl. the Kotlin plugin)
#   4. verify the signature, the 16 KB alignment and that arm64-v8a is the APK's only ABI, copy
#      to dist-release/
# Output: dist-release/TeleFlock_<version>_universal.apk (+ .sha256). The APK held four ABIs up
# to 0.8.1; the name stays because installed apps look for exactly it (src-tauri/src/update).
#
# Extra args are passed to `tauri android build`.
# Env: TELEFLOCK_KEYSTORE_PROPERTIES (default /root/.teleflock-keys/keystore.properties; see
#      docs/build.md §6.2), CARGO_TARGET_DIR (default <repo>/target/release-android),
#      SKIP_HOSTD=1, SKIP_FRONTEND=1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f /root/.teleflock-android-env ] && . /root/.teleflock-android-env
: "${ANDROID_HOME:?ANDROID_HOME not set (docs/build.md §4)}"
: "${NDK_HOME:?NDK_HOME not set (docs/build.md §4)}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target/release-android}"
export TF_HOSTD_DIST="${TF_HOSTD_DIST:-$ROOT/target/hostd-dist}"
DEFAULT_PROPS=/root/.teleflock-keys/keystore.properties
if [ -z "${TELEFLOCK_KEYSTORE_PROPERTIES:-}" ] && [ -f "$DEFAULT_PROPS" ]; then
  export TELEFLOCK_KEYSTORE_PROPERTIES="$DEFAULT_PROPS"
fi
OUT="$ROOT/dist-release"
BT="$ANDROID_HOME/build-tools/$(ls -1 "$ANDROID_HOME/build-tools" | sort -V | tail -n1)"

log() { printf '\033[1;35m[build-android]\033[0m %s\n' "$*"; }

rustup target list --installed | grep -qx aarch64-linux-android || rustup target add aarch64-linux-android
# From here on dist-release/'s APK is being replaced: scripts/release.sh's stamp of what it was
# built from no longer holds (docs/build.md §11.2).
rm -f "$OUT/.built-android"
[ -d node_modules ] || { log "bun install"; bun install --frozen-lockfile; }
[ -d src-tauri/gen/android ] || { log "tauri android init"; bun tauri android init --ci; }

if [ "${SKIP_FRONTEND:-0}" != 1 ]; then
  log "frontend"
  bun run build
fi
if [ "${SKIP_HOSTD:-0}" != 1 ]; then
  log "tf-hostd"
  scripts/build-hostd.sh
fi

log "app (Rust for aarch64 + Gradle)"
# Links 4-ABI builds (up to 0.8.1) left for the other ABIs: their libraries may be gone.
rm -rf src-tauri/gen/android/app/src/main/jniLibs/{armeabi-v7a,x86,x86_64}
bun tauri android build --apk --target aarch64 --config '{"build":{"beforeBuildCommand":""}}' "$@"

APK_DIR=src-tauri/gen/android/app/build/outputs/apk/universal/release
APK="$APK_DIR/app-universal-release.apk"
if [ ! -f "$APK" ]; then
  if [ -f "$APK_DIR/app-universal-release-unsigned.apk" ]; then
    echo "built only an UNSIGNED apk: set TELEFLOCK_KEYSTORE_PROPERTIES (docs/build.md §6.2)" >&2
  fi
  echo "apk not found at $APK" >&2
  exit 1
fi
log "verifying signature, alignment, ABI"
"$BT/apksigner" verify --print-certs "$APK" | grep -E "Signer.*certificate (DN|SHA-256)"
"$BT/zipalign" -c -P 16 4 "$APK"
LIBS="$(unzip -Z1 "$APK" | grep '^lib/' || true)"
grep -qx 'lib/arm64-v8a/libteleflock_lib.so' <<<"$LIBS" && ! grep -qv '^lib/arm64-v8a/' <<<"$LIBS" ||
  { echo "the APK must hold lib/arm64-v8a/libteleflock_lib.so and no other ABI, it has: $(echo $LIBS)" >&2; exit 1; }

VERSION="$(bun -e 'console.log(require("./src-tauri/tauri.conf.json").version)')"
mkdir -p "$OUT"
DEST="$OUT/TeleFlock_${VERSION}_universal.apk"
cp -f "$APK" "$DEST"
(cd "$OUT" && sha256sum "$(basename "$DEST")" > "$(basename "$DEST").sha256")
log "→ $DEST ($(stat -c %s "$DEST") bytes)"
