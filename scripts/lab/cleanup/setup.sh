#!/usr/bin/env bash
# Cleanup lab (architecture §3.17 "Background scans", "Incremental scans"): inside scripts/lab/run
# cleanup, a lab herdr server with workspaces in two repositories that have 20 linked worktrees
# between them (`merged-*` branches have a merged pull request, three worktrees carry a
# node_modules-like tree of 300 folders), an omp session file, and a fake gh (./gh) first on the
# lab tf-hostd's PATH. drive.ts then attaches a lab tf-hostd at a fast pace and checks what the
# host does by itself.
#
# Usage: scripts/lab/cleanup/setup.sh [--hostd BIN] [--fresh]
#   --hostd BIN   the tf-hostd to run (default $CARGO_TARGET_DIR/debug/tf-hostd, else target/debug/tf-hostd)
#   --fresh       stop the lab and delete /tmp/tf-lab-cleanup first
# Then: scripts/lab/run cleanup -- env TF_HOSTD_CLEANUP_PACE=30 bun scripts/lab/cleanup/drive.ts
# Stop: scripts/lab/stop cleanup --purge
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
run="$repo/scripts/lab/run"
hostd="${CARGO_TARGET_DIR:-$repo/target}/debug/tf-hostd"
while [ $# -gt 0 ]; do
  case "$1" in
    --hostd) hostd="$2"; shift 2 ;;
    --fresh) fresh=1; shift ;;
    *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64 ;;
  esac
done
hostd="$(readlink -f "$hostd")"
[ -x "$hostd" ] || { echo "setup: no tf-hostd at $hostd" >&2; exit 66; }
lab=cleanup
root="/tmp/tf-lab-$lab"
session="tf-lab-$lab"
[ "$fresh" = 1 ] && "$repo/scripts/lab/stop" "$lab" --purge >/dev/null || true

mkdir -p "$root/home" "$root/bin" "$root/logs"
cp "$here/gh" "$root/bin/gh"
# The daemon reads PATH from the lab's login shell: the fake gh comes first (scripts/lab/run keeps
# these files once they exist).
for rc in .profile .bashrc; do printf 'export PATH="%s/bin:$PATH"\n' "$root" >"$root/home/$rc"; done
"$run" "$lab" -- true
src="$root/home/src"
mkdir -p "$src"

TF_LAB_CWD="$src" "$run" "$lab" -- bash -c '
  set -e
  for r in alpha beta; do
    mkdir -p "$r"
    (cd "$r" && git init -q -b main && printf "node_modules/\n" >.gitignore && echo "# $r" >README.md && git add -A \
      && git -c user.name=lab -c user.email=lab@example.invalid commit -qm init)
    for i in $(seq 0 9); do
      case $i in 0|1|2) b="merged-$r-$i" ;; *) b="plain-$r-$i" ;; esac
      git -C "$r" worktree add -q -b "$b" "$PWD/$r-wt/w$i" main
    done
  done
  for w in alpha-wt/w0 alpha-wt/w5 beta-wt/w7; do
    for d in $(seq 0 299); do
      dir="$w/node_modules/pkg$((d % 30))/lib$d"
      mkdir -p "$dir"
      for f in 0 1 2 3; do head -c $((200 + f)) /dev/zero >"$dir/f$f.js"; done
    done
  done
' >"$root/logs/repos.log" 2>&1

# An omp session that worked elsewhere: the first scan reads it, a quiet one does not.
sessions="$root/omp-agent/sessions/-lab"
mkdir -p "$sessions"
now="$(date -u +%FT%T.000Z)"
printf '{"type":"session","version":3,"id":"labsess","timestamp":"%s","cwd":"%s"}\n' "$now" "$src" >"$sessions/2026-11-20T00-00-00-000Z_labsess.jsonl"
printf '{"type":"message","id":"e1","parentId":null,"timestamp":"%s","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls","cwd":"%s"}}]}}\n' \
  "$now" "$src" >>"$sessions/2026-11-20T00-00-00-000Z_labsess.jsonl"

setsid nohup "$run" "$lab" -- herdr --session "$session" server >"$root/logs/herdr.log" 2>&1 </dev/null &
for _ in $(seq 1 120); do
  "$run" "$lab" -- herdr --session "$session" status server 2>/dev/null | grep -q 'status: running' && break
  sleep 0.25
done
for r in alpha beta; do
  "$run" "$lab" -- herdr --session "$session" workspace create --cwd "$src/$r" --label "$r" --no-focus >/dev/null
done

cat >"$root/lab.env" <<EOF
HOSTD=$hostd
SESSION=$session
RELAY_PORT=47788
HOSTD_HOME=$root/teleflock
LOGS=$root/logs
SRC=$src
SESSION_FILE=$sessions/2026-11-20T00-00-00-000Z_labsess.jsonl
EOF
echo "lab $lab ready: $(ls -d "$src"/*-wt/w* | wc -l) worktrees in $src; herdr session $session; env $root/lab.env"
