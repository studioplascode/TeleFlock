#!/usr/bin/env bash
# Publishes TeleFlock v<version> (version = src-tauri/tauri.conf.json; set it with
# scripts/set-version.sh, commit and push first) as a GitHub release the in-app updater picks up:
#   1. builds the signed Windows installer (+ updater .sig), the signed arm64 APK and the Linux
#      .deb + AppImage (+ updater .sig) + Arch package in two stages: the frontend and tf-hostd
#      (shared by all three), then the three platforms. The steps of a stage run side by side;
#      their output lines are prefixed with the step ([windows] …) and each step's full output is
#      kept in dist-release/logs/<step>.log. Platforms whose packages can be reused (below) are
#      not built.
#   2. verifies every package: checksums, updater signatures against tauri.conf.json's key and
#      this version, the APK's signing certificate and that arm64-v8a is its only ABI
#   3. writes dist-release/latest.json (Tauri static update manifest: Windows, AppImage, .deb)
#   4. gh release create v<version> with every package, its .sig / .sha256, and latest.json
# and prints the wall-clock time of every step when it exits.
# The v<version> tag starts .github/workflows/macos.yml, which builds the macOS .dmg on a GitHub
# runner and adds it (+ .sha256) to this release. macOS installs only ever download it by hand:
# it is not signed for the updater and not in latest.json (docs/build.md §13).
#
# Every platform build writes dist-release/.built-<platform>: "<commit>[-dirty] <version>" (what
# its packages were built from), then the sha256 of each of the platform's files there. They are
# reused (not rebuilt, and publishable) only if that commit was clean, the version is this one,
# the tree is clean, the files still have those checksums, and no file the platform is built
# from changed between that commit and HEAD (platforms_of below: documentation changes none, a
# Linux-only file only Linux, every other file all three). A platform's stamp is removed when its
# build starts (build-<platform>.sh does that too, also when run by hand) and written after the
# build succeeded, unless HEAD moved or a clean tree got changes while the builds ran. To rebuild
# one platform, delete its stamp.
#
# Usage: scripts/release.sh [--rebuild] [--skip-build | --skip-windows | --skip-android | --skip-linux]
#                           [--notes-file FILE] [--prerelease] [--draft] [--dry-run]
#   --rebuild        build every platform, also those whose packages could be reused
#   --skip-build     build nothing: use the packages in dist-release/
#   --skip-windows   don't build the Windows installer + .sig: use dist-release/'s
#   --skip-android   don't build the APK: use dist-release/'s
#   --skip-linux     don't build the .deb, AppImage (+ .sig) and Arch package: use dist-release/'s
#   --notes-file F   release notes (markdown); default: GitHub's generated notes
#   --prerelease     publish as a pre-release (the updater still offers it); default: normal release
#   --draft          create a draft (the updater ignores drafts until published)
#   --dry-run        build + verify + write latest.json, print the gh command instead of running it;
#                    packages that can't be published (not reusable as above) are only warned about
# Env: everything scripts/build-{hostd,windows,android,linux}.sh read (signing keys:
#      docs/build.md §6.2 and §11.1). SKIP_FRONTEND / SKIP_HOSTD / SKIP_ARCH from the caller are
#      ignored.
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
LOGS="$OUT/logs"
PLATFORMS=(windows android linux)
log() { printf '\033[1;35m[release]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[release]\033[0m %s\n' "$*" >&2; }
die() { echo "release: $*" >&2; exit 1; }

declare -A SKIP=([windows]=0 [android]=0 [linux]=0)
REBUILD=0 NOTES_FILE="" PRERELEASE=0 DRAFT=0 DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rebuild) REBUILD=1 ;;
    --skip-build) SKIP=([windows]=1 [android]=1 [linux]=1) ;;
    --skip-windows) SKIP[windows]=1 ;;
    --skip-android) SKIP[android]=1 ;;
    --skip-linux) SKIP[linux]=1 ;;
    --notes-file) NOTES_FILE="${2:?--notes-file needs a path}"; shift ;;
    --prerelease) PRERELEASE=1 ;;
    --draft) DRAFT=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) sed -n '2,/^set -euo pipefail/{/^set -euo pipefail/!p}' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

VERSION="$(bun -e 'console.log(require("./src-tauri/tauri.conf.json").version)')"
TAG="v$VERSION"
EXE="TeleFlock_${VERSION}_x64-setup.exe"
# arm64-v8a only (since 0.9.0); "universal" is the name installed apps look for
# (src-tauri/src/update/release.rs), so it stays.
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
# What the packages are built from: HEAD, or HEAD plus local changes (never publishable).
tree_source() {
  local head
  head="$(git rev-parse HEAD)"
  if [ -z "$(git status --porcelain)" ]; then echo "$head"; else echo "$head-dirty"; fi
}
SOURCE="$(tree_source)"
HEAD_SHA="${SOURCE%-dirty}"
CLEAN=0
[ "$SOURCE" = "$HEAD_SHA" ] && CLEAN=1
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

# ── timing ───────────────────────────────────────────────────────────────────────────────────
# Wall-clock seconds and outcome per step, printed when the script exits (also after a failure).
# With set -e off there, the summary can't stop half-way or replace the script's exit status.
declare -A TOOK=() NOTE=()
mmss() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }
summary() {
  local rc=$? s
  set +e
  if [ ${#NOTE[@]} -gt 0 ]; then
    log "time per step (wall clock; the steps of a stage run side by side):"
    for s in frontend tf-hostd "${PLATFORMS[@]}" verify; do
      [ -n "${NOTE[$s]+set}" ] || continue
      printf '  %-9s %7s  %s\n' "$s" "$(if [ -n "${TOOK[$s]:-}" ]; then mmss "${TOOK[$s]}"; fi)" "${NOTE[$s]}"
    done
    printf '  %-9s %7s\n' total "$(mmss "$SECONDS")"
  fi
  exit "$rc"
}
trap summary EXIT

# ── jobs ─────────────────────────────────────────────────────────────────────────────────────
# start_job <step> <command…> runs the command in the background, its output prefixed with
# [step] and kept in $LOGS/<step>.log. wait_jobs <step…> waits for all of them, records their
# time and outcome, and lists the failed ones in FAILED.
declare -A PID=()
start_job() {
  local step="$1"; shift
  mkdir -p "$LOGS"
  (
    started=$SECONDS rc=0
    "$@" 2>&1 | tee "$LOGS/$step.log" | sed -u "s/^/[$step] /" || rc=$?
    echo $((SECONDS - started)) > "$LOGS/$step.took"
    exit "$rc"
  ) &
  PID[$step]=$!
}
FAILED=()
wait_jobs() {
  local step
  FAILED=()
  for step in "$@"; do
    wait "${PID[$step]}" || { NOTE[$step]="FAILED, see $LOGS/$step.log"; FAILED+=("$step"); }
    TOOK[$step]="$(cat "$LOGS/$step.took" 2>/dev/null || echo 0)"
  done
}

# ── what each platform is built from ─────────────────────────────────────────────────────────
# platforms_of <path>: the platforms whose packages a change to <path> can affect. Documentation
# and files no package build reads affect none, files only one platform's build reads only that
# platform, every other path all three.
platforms_of() {
  case "$1" in
    docs/* | *.md | .github/* | .research/* | drafts/* | site/* | scripts/lab/* | scripts/ci/* | \
      scripts/lab-remote-auth.sh | scripts/build-site.sh | scripts/set-version.sh | \
      scripts/verify-updater-sig.ts | src-tauri/tauri.macos.conf.json) ;;
    src-tauri/windows/* | scripts/build-windows.sh) echo windows ;;
    src-tauri/gen/android/* | src-tauri/plugins/teleflock-android/* | scripts/build-android.sh) echo android ;;
    src-tauri/tauri.linux.conf.json | src-tauri/linux/* | packaging/* | scripts/build-linux.sh | LICENSE) echo linux ;;
    scripts/updater-key.sh) echo windows linux ;;
    *) echo "${PLATFORMS[@]}" ;;
  esac
}
# The files each platform's build writes to dist-release/; checksums <platform> prints their
# sha256sum lines (and fails if one is missing).
declare -A OUTPUTS=(
  [windows]="$EXE $EXE.sig $EXE.sha256"
  [android]="$APK $APK.sha256"
  [linux]="$DEB $DEB.sig $DEB.sha256 $APPIMAGE $APPIMAGE.sig $APPIMAGE.sha256 $ARCHPKG $ARCHPKG.sha256 aur/PKGBUILD aur/.SRCINFO"
)
checksums() {
  local files
  read -ra files <<<"${OUTPUTS[$1]}"
  (cd "$OUT" && sha256sum -- "${files[@]}")
}
# reusable <platform>: whether dist-release/ holds this platform's packages for this release
# (see the header); WHY says why (not).
reusable() {
  local p="$1" src="" ver="" changed f hits=()
  [ -f "$OUT/.built-$p" ] && read -r src ver < "$OUT/.built-$p"
  if [ -z "$src" ]; then WHY="not stamped by this script (dist-release/.built-$p)"; return 1; fi
  if [[ ! "$src" =~ ^[0-9a-f]{40}$ ]]; then WHY="built from uncommitted changes ($src)"; return 1; fi
  if [ "$ver" != "$VERSION" ]; then WHY="built for version ${ver:-unknown}"; return 1; fi
  if [ "$(checksums "$p" 2>/dev/null)" != "$(tail -n +2 "$OUT/.built-$p")" ]; then
    WHY="its files in dist-release/ are not the ones stamped (replaced or removed since)"
    return 1
  fi
  if [ "$CLEAN" != 1 ]; then WHY="uncommitted or untracked changes (git status)"; return 1; fi
  changed="$(git diff --no-renames --name-only "$src" HEAD 2>/dev/null)" ||
    { WHY="built from ${src:0:12}, which this repo doesn't have"; return 1; }
  while IFS= read -r f; do
    [ -n "$f" ] && [[ " $(platforms_of "$f") " == *" $p "* ]] && hits+=("$f")
  done <<<"$changed"
  if [ ${#hits[@]} -gt 0 ]; then
    WHY="${#hits[@]} of its inputs changed since ${src:0:12} (${hits[*]:0:3}$([ ${#hits[@]} -le 3 ] || echo ' …'))"
    return 1
  fi
  WHY="built from ${src:0:12}"
  [ "$src" = "$HEAD_SHA" ] || WHY="$WHY, none of its inputs changed since"
}

# ── build ────────────────────────────────────────────────────────────────────────────────────
# .built-<platform>: "<source> <version>", what this script built the platform's packages from,
# then the checksums of its files.
stamp() {
  local sums
  sums="$(checksums "$1")" || die "$1 was built, but dist-release/ lacks some of its files"
  printf '%s %s\n%s\n' "$SOURCE" "$VERSION" "$sums" > "$OUT/.built-$1"
}
BUILD=()
for p in "${PLATFORMS[@]}"; do
  if [ "${SKIP[$p]}" = 1 ]; then
    NOTE[$p]="not built (--skip-$p)"
  elif [ "$REBUILD" = 0 ] && reusable "$p"; then
    NOTE[$p]="reused: $WHY"
    log "$p: reusing dist-release/ ($WHY)"
  else
    [ "$REBUILD" = 0 ] || WHY="--rebuild"
    NOTE[$p]="built: $WHY"
    BUILD+=("$p")
  fi
done
if [ ${#BUILD[@]} -gt 0 ]; then
  [ -d node_modules ] || { log "bun install"; bun install --frozen-lockfile; }
  # The Linux container shares the cargo registry, not cargo's lock on it: every crate is
  # downloaded and unpacked before builds run side by side.
  cargo fetch --locked --quiet
  log "frontend + tf-hostd"
  NOTE[frontend]=built NOTE[tf-hostd]=built
  start_job frontend bun run build
  start_job tf-hostd scripts/build-hostd.sh
  wait_jobs frontend tf-hostd
  [ ${#FAILED[@]} -eq 0 ] || die "${FAILED[*]} failed (logs in $LOGS/)"
  log "platforms: ${BUILD[*]}"
  for p in "${BUILD[@]}"; do
    rm -f "$OUT/.built-$p" # its packages are about to be replaced
    start_job "$p" env SKIP_FRONTEND=1 SKIP_HOSTD=1 "scripts/build-$p.sh"
  done
  wait_jobs "${BUILD[@]}"
  # The stamps say what the packages were built from: not if HEAD moved, or a clean tree got
  # changes, while the builds read it.
  now="$(tree_source)"
  if [ "$now" = "$SOURCE" ]; then
    for p in "${BUILD[@]}"; do [[ " ${FAILED[*]} " == *" $p "* ]] || stamp "$p"; done
  else
    what="git status changed"
    [ "${now%-dirty}" = "$HEAD_SHA" ] || what="HEAD moved to ${now:0:12}"
    msg="the tree changed while the platforms were built ($what): none is stamped, so they can't be published"
    if [ "$DRY_RUN" = 1 ]; then warn "$msg"; else die "$msg"; fi
  fi
  [ ${#FAILED[@]} -eq 0 ] || die "${FAILED[*]} failed (logs in $LOGS/)"
fi
for p in "${PLATFORMS[@]}"; do
  reusable "$p" && continue
  msg="dist-release/ $p packages can't be published for $HEAD_SHA: $WHY"
  if [ "$DRY_RUN" = 1 ]; then warn "$msg"; else die "$msg"; fi
done

# ── verify ───────────────────────────────────────────────────────────────────────────────────
VERIFY_STARTED=$SECONDS
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
# arm64 phones only: the app's library for arm64-v8a, nothing for another ABI.
APK_LIBS="$(unzip -Z1 "$OUT/$APK" | grep '^lib/' || true)"
grep -qx 'lib/arm64-v8a/libteleflock_lib.so' <<<"$APK_LIBS" && ! grep -qv '^lib/arm64-v8a/' <<<"$APK_LIBS" ||
  die "$APK must hold lib/arm64-v8a/libteleflock_lib.so and no other ABI, it has: $(echo $APK_LIBS)"
TOOK[verify]=$((SECONDS - VERIFY_STARTED)) NOTE[verify]="checksums, updater signatures, APK certificate + ABI"
log "verified: checksums, updater signatures (key + version $VERSION), APK certificate, APK ABI arm64-v8a"

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
