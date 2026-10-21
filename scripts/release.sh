#!/usr/bin/env bash
# Publishes TeleFlock v<version> (version = src-tauri/tauri.conf.json; set it with
# scripts/set-version.sh, commit and push first) as a GitHub release the in-app updater picks up:
#   1. builds the signed Windows installer (+ updater .sig), the signed universal APK and the
#      Linux .deb + AppImage (+ updater .sig) + Arch package (frontend and tf-hostd once, shared),
#      or reuses dist-release/ with --skip-* (only packages this script built from HEAD)
#   2. verifies every package: checksums, updater signatures against tauri.conf.json's key and
#      this version, the APK's signing certificate
#   3. writes dist-release/latest.json (Tauri static update manifest: Windows, AppImage, .deb)
#   4. gh release create v<version> with every package, its .sig / .sha256, and latest.json
# The v<version> tag starts .github/workflows/macos.yml, which builds the macOS .dmg on a GitHub
# runner and adds it (+ .sha256) to this release. macOS installs only ever download it by hand:
# it is not signed for the updater and not in latest.json (docs/build.md §13).
#
# Usage: scripts/release.sh [--skip-build | --skip-windows | --skip-android | --skip-linux]
#                           [--notes-file FILE] [--prerelease] [--draft] [--dry-run]
#   --skip-build     reuse every package already in dist-release/ (no build at all)
#   --skip-windows   reuse the Windows installer + .sig in dist-release/
#   --skip-android   reuse the APK in dist-release/
#   --skip-linux     reuse the .deb, AppImage (+ .sig) and Arch package in dist-release/
#   --notes-file F   release notes (markdown); default: GitHub's generated notes
#   --prerelease     publish as a pre-release (the updater still offers it); default: normal release
#   --draft          create a draft (the updater ignores drafts until published)
#   --dry-run        build + verify + write latest.json, print the gh command instead of running it
# Reused packages must carry a dist-release/.built-<platform> stamp with the current HEAD, written
# when this script built them from a clean tree (a dry run only warns about a mismatch).
# Env: everything scripts/build-{windows,android,linux}.sh read (signing keys: docs/build.md §6.2
#      and §11.1). SKIP_FRONTEND / SKIP_HOSTD / SKIP_ARCH from the caller are ignored.
set -euo pipefail
# A stale export must never make a release reuse an old frontend / tf-hostd or drop a package.
unset SKIP_FRONTEND SKIP_HOSTD SKIP_ARCH

# Must match REPO in src-tauri/src/update/release.rs (where installed apps look for updates).
REPO=studioplascode/TeleFlock
# SHA-256 of the APK signing certificate (/root/.teleflock-keys/teleflock-release.jks, §6.2).
# Android refuses updates signed by another key, so a wrong one must never be published.
APK_CERT_SHA256=0cf2f823fd49cb12bbcccd2341b31fd508ac1722ec6531ad9808f690d4097fd9

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/dist-release"
log() { printf '\033[1;35m[release]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[release]\033[0m %s\n' "$*" >&2; }
die() { echo "release: $*" >&2; exit 1; }

BUILD_WINDOWS=1 BUILD_ANDROID=1 BUILD_LINUX=1 NOTES_FILE="" PRERELEASE=0 DRAFT=0 DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) BUILD_WINDOWS=0 BUILD_ANDROID=0 BUILD_LINUX=0 ;;
    --skip-windows) BUILD_WINDOWS=0 ;;
    --skip-android) BUILD_ANDROID=0 ;;
    --skip-linux) BUILD_LINUX=0 ;;
    --notes-file) NOTES_FILE="${2:?--notes-file needs a path}"; shift ;;
    --prerelease) PRERELEASE=1 ;;
    --draft) DRAFT=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) sed -n '2,28p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

VERSION="$(bun -e 'console.log(require("./src-tauri/tauri.conf.json").version)')"
TAG="v$VERSION"
EXE="TeleFlock_${VERSION}_x64-setup.exe"
APK="TeleFlock_${VERSION}_universal.apk"
DEB="TeleFlock_${VERSION}_amd64.deb"
APPIMAGE="TeleFlock_${VERSION}_amd64.AppImage"
# Arch pkgver has no '-' (packaging/arch/PKGBUILD: pkgver=${_version//-/}).
ARCHPKG="teleflock-bin-${VERSION//-/}-1-x86_64.pkg.tar.zst"
[ -z "$NOTES_FILE" ] || [ -f "$NOTES_FILE" ] || die "notes file $NOTES_FILE not found"

# ── preflight ────────────────────────────────────────────────────────────────────────────────
[ "$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n1)" = "$VERSION" ] ||
  die "Cargo.toml and tauri.conf.json disagree on the version: run scripts/set-version.sh $VERSION"
[ "$(bun -e 'console.log(require("./package.json").version)')" = "$VERSION" ] ||
  die "package.json and tauri.conf.json disagree on the version: run scripts/set-version.sh $VERSION"
HEAD_SHA="$(git rev-parse HEAD)"
# What the packages are built from: HEAD, or HEAD plus local changes (never publishable).
CLEAN=0
[ -z "$(git status --porcelain)" ] && CLEAN=1
SOURCE="$HEAD_SHA"
[ "$CLEAN" = 1 ] || SOURCE="$HEAD_SHA-dirty"
# The commit an existing tag on origin points at (annotated tags peeled), or nothing.
remote_tag_commit() {
  git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}" |
    awk '{ c[$2] = $1 } END { t = "refs/tags/'"$TAG"'"; if (t "^{}" in c) print c[t "^{}"]; else if (t in c) print c[t] }'
}
if [ "$DRY_RUN" = 0 ]; then
  command -v gh >/dev/null || die "gh (GitHub CLI) is required"
  gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    die "release $TAG already exists on $REPO (bump with scripts/set-version.sh)"
  fi
  [ "$CLEAN" = 1 ] || die "uncommitted or untracked changes (git status): commit the release state first"
  git fetch --quiet origin
  [ -n "$(git branch -r --contains "$HEAD_SHA")" ] || die "HEAD $HEAD_SHA is not pushed to origin"
  TAG_COMMIT="$(remote_tag_commit)"
  [ -z "$TAG_COMMIT" ] || [ "$TAG_COMMIT" = "$HEAD_SHA" ] ||
    die "tag $TAG on origin points at $TAG_COMMIT, not HEAD $HEAD_SHA"
fi

# ── build ────────────────────────────────────────────────────────────────────────────────────
# .built-<platform>: the source the packages in dist-release/ were built from by this script.
stamp() { mkdir -p "$OUT" && echo "$SOURCE" > "$OUT/.built-$1"; }
if [ "$BUILD_WINDOWS" = 1 ] || [ "$BUILD_ANDROID" = 1 ] || [ "$BUILD_LINUX" = 1 ]; then
  log "frontend"; bun run build
  log "tf-hostd"; scripts/build-hostd.sh
  if [ "$BUILD_WINDOWS" = 1 ]; then SKIP_FRONTEND=1 SKIP_HOSTD=1 scripts/build-windows.sh; stamp windows; fi
  if [ "$BUILD_ANDROID" = 1 ]; then SKIP_FRONTEND=1 SKIP_HOSTD=1 scripts/build-android.sh; stamp android; fi
  if [ "$BUILD_LINUX" = 1 ]; then SKIP_FRONTEND=1 SKIP_HOSTD=1 scripts/build-linux.sh; stamp linux; fi
fi
for platform in windows android linux; do
  built="$(cat "$OUT/.built-$platform" 2>/dev/null || echo "(no stamp)")"
  if [ "$built" != "$HEAD_SHA" ]; then
    msg="dist-release/ $platform packages were built from $built, not a clean HEAD $HEAD_SHA (rebuild without --skip-$platform)"
    if [ "$DRY_RUN" = 1 ]; then warn "$msg"; else die "$msg"; fi
  fi
done

# ── verify ───────────────────────────────────────────────────────────────────────────────────
SIGNED=("$EXE" "$DEB" "$APPIMAGE")
SUMMED=("$EXE" "$APK" "$DEB" "$APPIMAGE" "$ARCHPKG")
ASSETS=()
for f in "${SUMMED[@]}"; do ASSETS+=("$OUT/$f" "$OUT/$f.sha256"); done
for f in "${SIGNED[@]}"; do ASSETS+=("$OUT/$f.sig"); done
for f in "${ASSETS[@]}"; do [ -s "$f" ] || die "missing $f (build it or drop --skip-*)"; done
(cd "$OUT" && sha256sum --quiet -c "${SUMMED[@]/%/.sha256}") || die "checksum mismatch in $OUT"
# Each .sig must verify against its package with the key installed apps trust, bound to $VERSION
# (plugins.updater.requireSignedVersion), or installed apps reject the update.
SIGNED_PATHS=()
for f in "${SIGNED[@]}"; do SIGNED_PATHS+=("$OUT/$f"); done
bun scripts/verify-updater-sig.ts "$VERSION" "${SIGNED_PATHS[@]}" || die "updater signature check failed"
# The APK must be signed with the release key installed apps were signed with.
[ -f /root/.teleflock-android-env ] && . /root/.teleflock-android-env
: "${ANDROID_HOME:?ANDROID_HOME not set (docs/build.md §4): needed for apksigner}"
APKSIGNER="$ANDROID_HOME/build-tools/$(ls -1 "$ANDROID_HOME/build-tools" | sort -V | tail -n1)/apksigner"
CERTS="$("$APKSIGNER" verify --print-certs "$OUT/$APK")" || die "apksigner rejects $APK"
[ "$(grep -c 'certificate SHA-256 digest' <<<"$CERTS")" = 1 ] &&
  grep -q "certificate SHA-256 digest: $APK_CERT_SHA256\$" <<<"$CERTS" ||
  die "$APK is not signed (only) by the release certificate $APK_CERT_SHA256: $(grep 'SHA-256' <<<"$CERTS")"
log "verified: checksums, updater signatures (key + version $VERSION), APK certificate"

# ── latest.json (read by tauri-plugin-updater on Windows and Linux) ────────────────────────────
NOTES="TeleFlock $TAG"
[ -z "$NOTES_FILE" ] || NOTES="$(cat "$NOTES_FILE")"
NOTES="$NOTES" VERSION="$VERSION" OUT="$OUT" DOWNLOAD="https://github.com/$REPO/releases/download/$TAG" \
  PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" EXE="$EXE" DEB="$DEB" APPIMAGE="$APPIMAGE" \
  bun -e '
    const fs = require("fs");
    const e = process.env;
    // The plugin looks up "<os>-<arch>-<installer>" first, then "<os>-<arch>".
    const entry = (name) => ({
      signature: fs.readFileSync(`${e.OUT}/${name}.sig`, "utf8").trim(),
      url: `${e.DOWNLOAD}/${name}`,
    });
    const manifest = {
      version: e.VERSION,
      notes: e.NOTES,
      pub_date: e.PUB_DATE,
      platforms: {
        "windows-x86_64": entry(e.EXE),
        "linux-x86_64-appimage": entry(e.APPIMAGE),
        "linux-x86_64-deb": entry(e.DEB),
      },
    };
    fs.writeFileSync(process.argv[1], JSON.stringify(manifest, null, 2) + "\n");
  ' "$OUT/latest.json"
log "latest.json → $OUT/latest.json"

# ── publish ──────────────────────────────────────────────────────────────────────────────────
CMD=(gh release create "$TAG" --repo "$REPO" --title "TeleFlock $TAG")
if [ "$DRY_RUN" = 0 ]; then
  # Reuse the pushed tag (checked above to point at HEAD), else tag the (pushed) HEAD.
  if [ -n "$TAG_COMMIT" ]; then CMD+=(--verify-tag); else CMD+=(--target "$HEAD_SHA"); fi
fi
if [ -n "$NOTES_FILE" ]; then CMD+=(--notes-file "$NOTES_FILE"); else CMD+=(--generate-notes); fi
[ "$PRERELEASE" = 1 ] && CMD+=(--prerelease)
[ "$DRAFT" = 1 ] && CMD+=(--draft)
CMD+=("${ASSETS[@]}" "$OUT/latest.json")

if [ "$DRY_RUN" = 1 ]; then
  log "dry run; would run:"
  printf '  %q' "${CMD[@]}"
  echo
  exit 0
fi
log "publishing $TAG on $REPO"
"${CMD[@]}"
log "done: https://github.com/$REPO/releases/tag/$TAG"
log "macOS: the $TAG tag started .github/workflows/macos.yml; it adds the .dmg to this release when green"
log "  (gh run list --repo $REPO --workflow macos.yml --limit 1)"
