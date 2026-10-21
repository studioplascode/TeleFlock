#!/usr/bin/env bash
# Sets the TeleFlock version everywhere it lives:
#   src-tauri/tauri.conf.json  "version"  (app version: installer/APK names, Android versionName/Code,
#                                          the in-app updater's "current version")
#   Cargo.toml                 [workspace.package] version (every crate, incl. tf-hostd) + Cargo.lock
#   package.json               "version"
#   site/index.html            landing-page footer
# Usage: scripts/set-version.sh X.Y.Z[-pre]     (then commit; release with scripts/release.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

V="${1:-}"
V="${V#v}"
if ! [[ "$V" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: scripts/set-version.sh X.Y.Z[-pre]   (semver; got '${1:-}')" >&2
  exit 2
fi

# The first top-level "version" key of each JSON file (two-space indent), formatting untouched.
for f in src-tauri/tauri.conf.json package.json; do
  sed -E -i "0,/^  \"version\": \"[^\"]*\"/s//  \"version\": \"$V\"/" "$f"
  grep -q "^  \"version\": \"$V\"" "$f" || { echo "$f: no top-level \"version\" updated" >&2; exit 1; }
done

# [workspace.package] is the only line-start `version =` in the root manifest.
sed -E -i "0,/^version = \"[^\"]*\"/s//version = \"$V\"/" Cargo.toml
grep -q "^version = \"$V\"" Cargo.toml || { echo "Cargo.toml: workspace version not updated" >&2; exit 1; }
# Rewrites only the workspace members' entries in Cargo.lock.
cargo update --workspace --offline --quiet 2>/dev/null || cargo update --workspace --quiet

sed -E -i "s/TeleFlock v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)? ·/TeleFlock v$V ·/" site/index.html

echo "version → $V"
git --no-pager diff --stat -- src-tauri/tauri.conf.json package.json Cargo.toml Cargo.lock site/index.html
