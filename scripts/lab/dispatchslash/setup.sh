#!/usr/bin/env bash
# DispatchSlash lab: a Dispatch message that is a slash command (`AgentSpec.command`, hostd 0.9.1)
# against the real stack inside scripts/lab/run dispatchslash: a lab herdr server (session
# tf-lab-dispatchslash, omp integration installed), the installed omp, this tree's bridge as
# TF_HOSTD_HOME/ext/teleflock-bridge.ts, tf-hostd (relay 47877), a git repo with one project skill
# (`.omp/skills/labcheck`), and mock.ts (127.0.0.1:18877), which records every request in
# /tmp/tf-lab-dispatchslash/logs/mock.jsonl.
#
# Usage: scripts/lab/dispatchslash/setup.sh [tf-hostd binary]   (default target/shared/debug/tf-hostd)
# Then:  scripts/lab/run dispatchslash -- bun scripts/lab/dispatchslash/drive.ts
# Stop:  scripts/lab/stop dispatchslash --purge
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
run="$repo/scripts/lab/run"
lab=dispatchslash
root="/tmp/tf-lab-$lab"
session="tf-lab-$lab"
relay=47877
mock_port=18877
hostd="$(readlink -f "${1:-$repo/target/shared/debug/tf-hostd}")"
[ -x "$hostd" ] || { echo "setup: no tf-hostd at $hostd" >&2; exit 66; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$mock_port" "$relay"; do port_busy "$p" && { echo "setup: 127.0.0.1:$p is taken" >&2; exit 69; }; done

"$run" "$lab" -- true
home="$root/teleflock" agent="$root/omp-agent" work="$root/work" logs="$root/logs"
mkdir -p "$home/ext" "$agent/extensions" "$logs" "$work/.omp/skills/labcheck" "$root/home/.omp/agent/extensions"
printf 'collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:%s\n' "$relay" >"$home/omp-overlay.yml"
cp "$repo/host/teleflock-bridge/teleflock-bridge.ts" "$home/ext/teleflock-bridge.ts"
cp "$here/models.yml" "$here/config.yml" "$agent/"
cat >"$work/.omp/skills/labcheck/SKILL.md" <<'SKILL'
---
name: labcheck
description: Lab check skill for the DispatchSlash lab
---
LABCHECK-SKILL-BODY: answer with the word checked, then stop.
SKILL
if [ ! -d "$work/.git" ]; then
  printf '# DispatchSlash lab\n' >"$work/README.md"
  TF_LAB_CWD="$work" "$run" "$lab" -- sh -c 'git init -q -b main && git add -A && git -c user.name=lab -c user.email=lab@example.invalid commit -qm "dispatchslash lab"'
fi

start() { # <name> <log> <command…>
  local name="$1" log="$2"
  shift 2
  setsid nohup "$run" "$lab" -- "$@" >"$log" 2>&1 </dev/null &
  echo $! >"$logs/$name.pid"
}
wait_for() { # <what> <seconds> <test…>
  local what="$1" secs="$2"
  shift 2
  for _ in $(seq 1 $((secs * 4))); do "$@" && return 0; sleep 0.25; done
  echo "setup: $what did not come up within ${secs}s" >&2
  return 1
}
start herdr "$logs/herdr.log" herdr --session "$session" server
herdr_up() { "$run" "$lab" -- herdr --session "$session" status server 2>/dev/null | grep -q 'status: running'; }
wait_for "herdr server ($session)" 30 herdr_up
# herdr installs its omp integration only outside PI_CODING_AGENT_DIR: into the lab home, then copied.
if "$run" "$lab" -- env -u PI_CODING_AGENT_DIR herdr --session "$session" integration install omp >"$logs/herdr-integration.log" 2>&1; then
  cp "$root/home/.omp/agent/extensions/herdr-omp-agent-state.ts" "$agent/extensions/"
else
  echo "setup: herdr integration install omp failed (see $logs/herdr-integration.log)" >&2
fi
touch "$logs/mock.jsonl"
start mock "$logs/mock.out" env "MOCK_LOG=$logs/mock.jsonl" "MOCK_PORT=$mock_port" bun "$here/mock.ts"
wait_for "mock (127.0.0.1:$mock_port)" 20 port_busy "$mock_port"
start hostd "$logs/hostd.stderr" "$hostd" --relay-port "$relay" daemon
wait_for "tf-hostd daemon" 30 test -S "$home/run/hostd.sock"
cat >"$root/lab.env" <<ENV
SESSION=$session
RELAY_PORT=$relay
HOSTD=$hostd
HOSTD_HOME=$home
WORK=$work
LOGS=$logs
MOCK_LOG=$logs/mock.jsonl
ENV
echo "lab $lab ready: $("$hostd" --version); omp $("$run" "$lab" -- omp --version 2>/dev/null | head -1); bridge $(grep -m1 -o 'BRIDGE_VERSION = "[^"]*"' "$home/ext/teleflock-bridge.ts")"
