#!/usr/bin/env bash
# Builds the TeleFlock Linux packages (x86_64):
#   1. frontend (bun run build → dist/)
#   2. tf-hostd for every deploy target (scripts/build-hostd.sh → target/hostd-dist, embedded
#      into the app by tf-client's build.rs)
#   3. the app + .deb + AppImage (tauri build --bundles deb,appimage) inside an Ubuntu 22.04
#      container (packaging/linux/Dockerfile: glibc 2.35 floor, so the packages run on Debian 12+
#      / Ubuntu 22.04+), without the updater key; then each package is signed here for the in-app
#      updater (tf_updater_sign → <package>.sig, minisign, bound to the version)
#   4. the Arch package: packaging/arch/PKGBUILD stamped with this version and the .deb's
#      checksum, built with makepkg in an archlinux:base-devel container, then installed with
#      pacman in a fresh container to prove its dependencies resolve every shared library
# Output: dist-release/TeleFlock_<version>_amd64.{deb,AppImage} (+ .sig, .sha256),
#         dist-release/teleflock-bin-<pkgver>-<pkgrel>-x86_64.pkg.tar.zst (+ .sha256),
#         dist-release/aur/{PKGBUILD,.SRCINFO} (the AUR `teleflock-bin` package for this release)
#
# Needs docker. Env: CARGO_TARGET_DIR (default <repo>/target/release-linux; only ever used by the
#      container: host-built objects would carry the host's newer glibc), SKIP_HOSTD=1 to reuse an
#      existing target/hostd-dist, SKIP_FRONTEND=1 to reuse dist/, SKIP_ARCH=1 to skip step 4,
#      ARCH_IMAGE (default archlinux:base-devel). Updater key: scripts/updater-key.sh.
# CI builds the same .deb + AppImage natively on ubuntu-22.04: .github/workflows/linux.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target/release-linux}"
export TF_HOSTD_DIST="${TF_HOSTD_DIST:-$ROOT/target/hostd-dist}"
OUT="$ROOT/dist-release"
ARCH_IMAGE="${ARCH_IMAGE:-archlinux:base-devel}"

log() { printf '\033[1;35m[build-linux]\033[0m %s\n' "$*"; }
die() { echo "build-linux: $*" >&2; exit 1; }

[ "$(uname -m)" = x86_64 ] || die "x86_64 hosts only (the AppImage tooling and the Arch package are x86_64)"
command -v docker >/dev/null || die "docker is required (packaging/linux/Dockerfile, Arch package)"
# Fail before the long build: without the key the updater .sig files can't be made.
. "$ROOT/scripts/updater-key.sh"
tf_updater_key_check

[ -d node_modules ] || { log "bun install"; bun install --frozen-lockfile; }
if [ "${SKIP_FRONTEND:-0}" != 1 ]; then
  log "frontend"
  bun run build
fi
if [ "${SKIP_HOSTD:-0}" != 1 ]; then
  log "tf-hostd"
  scripts/build-hostd.sh
fi

VERSION="$(bun -e 'console.log(require("./src-tauri/tauri.conf.json").version)')"
BUNDLE="$CARGO_TARGET_DIR/release/bundle"
DEB="TeleFlock_${VERSION}_amd64.deb"
APPIMAGE="TeleFlock_${VERSION}_amd64.AppImage"

RUST_VERSION="$(rustc --version | cut -d' ' -f2)"
BUN_VERSION="$(bun --version)"
BUILDER="teleflock-linux-builder:rust-$RUST_VERSION-bun-$BUN_VERSION"
log "builder image $BUILDER"
docker build -q --build-arg "RUST_VERSION=$RUST_VERSION" --build-arg "BUN_VERSION=$BUN_VERSION" \
  -t "$BUILDER" packaging/linux >/dev/null

log "app + .deb + AppImage (Ubuntu 22.04 container)"
# Stale bundles of other versions would otherwise linger next to the new ones.
rm -rf "$BUNDLE/deb" "$BUNDLE/appimage"
mkdir -p "$CARGO_TARGET_DIR/.tauri-cache" "$HOME/.cargo/registry" "$HOME/.cargo/git"
# Same paths inside as outside (the repo, the target and hostd dirs), the host's cargo download
# cache, and a persistent cache for the AppImage tools tauri downloads. The frontend was built
# above, so beforeBuildCommand is off; the key stays out of the container (signed below).
# NO_STRIP: linuxdeploy's `strip` predates the .relr.dyn sections of current toolchains.
docker run --rm \
  -v "$ROOT:$ROOT" -v "$CARGO_TARGET_DIR:$CARGO_TARGET_DIR" -v "$TF_HOSTD_DIST:$TF_HOSTD_DIST:ro" -w "$ROOT" \
  -v "$HOME/.cargo/registry:/opt/cargo/registry" -v "$HOME/.cargo/git:/opt/cargo/git" \
  -v "$CARGO_TARGET_DIR/.tauri-cache:/root/.cache/tauri" \
  -e CARGO_TARGET_DIR -e TF_HOSTD_DIST -e NO_STRIP=true -e APPIMAGE_EXTRACT_AND_RUN=1 \
  "$BUILDER" bun tauri build --bundles deb,appimage \
  --config '{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}'

# The glibc floor the packages inherit from the build environment.
GLIBC="$(objdump -T "$CARGO_TARGET_DIR/release/teleflock" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -n1)"
log "needs $GLIBC"

mkdir -p "$OUT"
for f in "$BUNDLE/deb/$DEB" "$BUNDLE/appimage/$APPIMAGE"; do
  [ -f "$f" ] || die "package not found at $f"
  name="$(basename "$f")"
  cp -f "$f" "$OUT/"
  tf_updater_sign "$OUT/$name" "$VERSION"
  (cd "$OUT" && sha256sum "$name" > "$name.sha256")
  log "→ $OUT/$name ($(stat -c %s "$OUT/$name") bytes) + .sig + .sha256"
done

[ "${SKIP_ARCH:-0}" = 1 ] && exit 0

# ── Arch package ─────────────────────────────────────────────────────────────────────────────
log "Arch package ($ARCH_IMAGE)"
WORK="$CARGO_TARGET_DIR/arch"
rm -rf "$WORK" && mkdir -p "$WORK/build"
# The PKGBUILD downloads the .deb and LICENSE from the release; makepkg uses local copies of the
# same file names instead, so the stamped PKGBUILD below is exactly what the AUR gets.
cp "$OUT/$DEB" "$WORK/build/$DEB"
cp LICENSE "$WORK/build/LICENSE-$VERSION"
DEB_SHA="$(sha256sum "$OUT/$DEB" | cut -d' ' -f1)"
LICENSE_SHA="$(sha256sum LICENSE | cut -d' ' -f1)"
sed -e "s/^_version=.*/_version=$VERSION/" \
    -e "s/^sha256sums_x86_64=.*/sha256sums_x86_64=('$DEB_SHA'/" \
    -e "s/^ *'SKIP') # LICENSE$/                   '$LICENSE_SHA')/" \
    packaging/arch/PKGBUILD > "$WORK/build/PKGBUILD"
grep -q "$DEB_SHA" "$WORK/build/PKGBUILD" && grep -q "$LICENSE_SHA" "$WORK/build/PKGBUILD" ||
  die "stamping packaging/arch/PKGBUILD failed (checksum lines changed?)"

docker pull -q "$ARCH_IMAGE" >/dev/null
# makepkg refuses to run as root: build as an unprivileged user that owns the build dir.
docker run --rm -v "$WORK/build:/build" "$ARCH_IMAGE" bash -euo pipefail -c '
  useradd -m builder
  chown -R builder /build
  su builder -c "cd /build && makepkg --force --nodeps --noconfirm && makepkg --printsrcinfo > .SRCINFO"
  chown -R '"$(id -u):$(id -g)"' /build
'
PKG="$(cd "$WORK/build" && ls -1 teleflock-bin-*-x86_64.pkg.tar.zst | head -n1)"
[ -n "$PKG" ] || die "makepkg produced no package"

log "verifying $PKG in a fresh container (pacman -U, ldd, namcap)"
docker run --rm -v "$WORK/build:/build:ro" "$ARCH_IMAGE" bash -euo pipefail -c '
  pacman -Syu --noconfirm --needed namcap >/dev/null
  pacman -U --noconfirm "/build/'"$PKG"'" >/dev/null
  missing="$(ldd /usr/bin/teleflock | grep "not found" || true)"
  [ -z "$missing" ] || { echo "unresolved libraries:"; echo "$missing"; exit 1; }
  # The tray loads this one at runtime (dlopen), so ldd cannot see it.
  [ -e /usr/lib/libayatana-appindicator3.so.1 ] || { echo "libayatana-appindicator3.so.1 missing"; exit 1; }
  grep -q "^MimeType=x-scheme-handler/teleflock;" /usr/share/applications/TeleFlock.desktop
  pacman -Qi teleflock-bin | grep -E "^(Version|Depends On|Installed Size)"
  namcap "/build/'"$PKG"'" || true
'

cp -f "$WORK/build/$PKG" "$OUT/"
(cd "$OUT" && sha256sum "$PKG" > "$PKG.sha256")
mkdir -p "$OUT/aur"
cp -f "$WORK/build/PKGBUILD" "$WORK/build/.SRCINFO" "$OUT/aur/"
log "→ $OUT/$PKG ($(stat -c %s "$OUT/$PKG") bytes) + .sha256; AUR files in $OUT/aur/"
rm -rf "$WORK"
