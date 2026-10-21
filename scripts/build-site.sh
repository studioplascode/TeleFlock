#!/usr/bin/env bash
# Assembles .site/ for serving over the tailnet:
#   /              landing page (site/index.html)
#   /app/          the web build of the UI (use ?demo for the built-in demo host)
#   /downloads/    release artifacts from dist-release/ + manifest.json
#   /drafts/       the visual drafts
# Serve with: python3 -m http.server 8080 --bind <tailnet-ip> --directory .site
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
site="$root/.site"
rm -rf "$site"
mkdir -p "$site/downloads"
cp "$root/site/index.html" "$site/index.html"
(cd "$root" && bunx vite build --base /app/ --outDir "$site/app" --emptyOutDir --logLevel warn)
ln -s ../drafts "$site/drafts"

manifest="$site/downloads/manifest.json"
printf '{"files":[' >"$manifest"
sep=""
shopt -s nullglob
for f in "$root"/dist-release/*.exe "$root"/dist-release/*.apk; do
  name="$(basename "$f")"
  case "$name" in *.exe) kind=exe ;; *.apk) kind=apk ;; esac
  cp "$f" "$site/downloads/$name"
  size="$(stat -c %s "$f")"
  sha="$(sha256sum "$f" | cut -d' ' -f1)"
  built="$(date -u -d "@$(stat -c %Y "$f")" '+%Y-%m-%d %H:%M UTC')"
  printf '%s{"kind":"%s","name":"%s","size":%s,"sha256":"%s","built":"%s"}' "$sep" "$kind" "$name" "$size" "$sha" "$built" >>"$manifest"
  sep=","
done
printf ']}\n' >>"$manifest"
echo "site ready: $site ($(ls "$site/downloads" | wc -l) download files)"
