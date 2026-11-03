#!/usr/bin/env bash
# RenameCtx lab: the real stack for "Name it again" (`session.digest` + `ai.complete` task `agentRename`),
# inside scripts/lab/run renamectx: a lab herdr server, a mock OpenAI-compatible provider that RECORDS every
# request body (mock.ts), the installed omp pinned into the lab, and tf-devserver driving the lab's tf-hostd
# as a local host (it deploys the TeleFlock bridge into omp and attaches tf-hostd with the lab's TF_HOSTD_HOME).
#
# Usage: scripts/lab/renamectx/setup.sh [--hostd BIN] [--devserver BIN] [--omp BIN] [--fresh]
#   --hostd BIN      the tf-hostd the devserver deploys (default target/shared/debug/tf-hostd)
#   --devserver BIN  default target/shared/debug/tf-devserver (it embeds the bridge it deploys)
#   --omp BIN        the omp copied into the lab (default ~/.local/bin/omp)
#   --fresh          stop the lab and delete /tmp/tf-lab-renamectx first
#
# Prepares: the omp agent dir (models.yml, config.yml: every role on the mock, yolo, no wizard), the devserver
# data dir (hosts.json: one `local` host, id `lab`, herdr session tf-lab-renamectx, relay port 47741), the work
# folder <lab home>/src/bloomworks (a git repo with one commit).
# Starts: herdr, the mock (127.0.0.1:18741; requests recorded to /tmp/tf-lab-renamectx/logs/requests.jsonl),
# tf-devserver (127.0.0.1:7441, WebSocket at /ws). Writes /tmp/tf-lab-renamectx/lab.env (every path).
# Then: bun scripts/lab/renamectx/drive.ts      (needs the bun import of src/core/ai.ts, see drive.ts)
# Stop with scripts/lab/stop renamectx [--purge] (copy evidence out first; drive.ts does).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
run="$repo/scripts/lab/run"
lab=renamectx
hostd="$repo/target/shared/debug/tf-hostd"
devserver="$repo/target/shared/debug/tf-devserver"
omp="${HOME:-/root}/.local/bin/omp"
fresh=0
usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --hostd) hostd="$2"; shift 2 ;;
    --devserver) devserver="$2"; shift 2 ;;
    --omp) omp="$2"; shift 2 ;;
    --fresh) fresh=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "setup: unknown argument $1" >&2; exit 64 ;;
  esac
done
hostd="$(readlink -f "$hostd")"
devserver="$(readlink -f "$devserver")"
omp="$(readlink -f "$omp")"
[ -x "$hostd" ] || { echo "setup: no tf-hostd at $hostd" >&2; exit 66; }
[ -x "$devserver" ] || { echo "setup: no tf-devserver at $devserver" >&2; exit 66; }
[ -x "$omp" ] || { echo "setup: no omp at $omp" >&2; exit 66; }

root="/tmp/tf-lab-$lab"
session="tf-lab-$lab"
mock_port=18741
dev_port=7441
relay=47741
token="renamectx-lab-token-0123456789"
if [ "$fresh" = 1 ]; then "$repo/scripts/lab/stop" "$lab" --purge >/dev/null; fi

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$mock_port" "$dev_port" "$relay"; do
  port_busy "$p" && { echo "setup: 127.0.0.1:$p is taken; stop whatever holds it first" >&2; exit 69; }
done

# Pinned copies: a rebuild of the shared target mid-run must not swap the binaries under the lab. The omp copy
# comes first on the PATH of the lab's login shells (tf-hostd reads PATH from one) and of herdr's panes.
home="$root/home"
mkdir -p "$root/bin" "$root/pinned" "$home"
pin() { cp "$1" "$2.tmp" && mv "$2.tmp" "$2"; }
pin "$omp" "$root/bin/omp"
pin "$hostd" "$root/pinned/tf-hostd"
pin "$devserver" "$root/pinned/tf-devserver"
omp="$root/bin/omp" hostd="$root/pinned/tf-hostd" devserver="$root/pinned/tf-devserver"
lab_path="$("$run" "$lab" --print-env | sed -n 's/^PATH=//p')"
for rc in .profile .bashrc; do printf 'export PATH="%s:%s"\n' "$root/bin" "$lab_path" >"$home/$rc"; done

"$run" "$lab" -- true # creates the lab's directories
agent="$root/omp-agent"
logs="$root/logs"
data="$root/devserver"
work="$home/src/bloomworks"
mkdir -p "$agent" "$logs" "$data"
cp "$here/models.yml" "$here/config.yml" "$agent/"
printf '{"profiles":[{"id":"lab","name":"Lab","kind":"local","herdrSession":"%s","autoConnect":true,"relayPort":%s}]}\n' "$session" "$relay" >"$data/hosts.json"

if [ ! -d "$work/.git" ]; then
  mkdir -p "$work"
  printf '# Bloomworks\n\nA cozy city-builder.\n' >"$work/README.md"
  TF_LAB_CWD="$work" "$run" "$lab" -- sh -c 'git init -q -b main && git add -A && git -c user.name=lab -c user.email=lab@example.invalid commit -qm "bloomworks"' >"$logs/repo.log" 2>&1
fi

# Long-lived processes, detached from this shell (scripts/lab/run execs, so each pid is the process).
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
# herdr refuses to install its omp integration while PI_CODING_AGENT_DIR points Pi and omp at one dir (the
# lab's): install it into the lab home's ~/.omp/agent, then copy it into the lab's agent dir.
mkdir -p "$home/.omp/agent/extensions" "$agent/extensions"
if "$run" "$lab" -- env -u PI_CODING_AGENT_DIR herdr --session "$session" integration install omp >"$logs/herdr-integration.log" 2>&1; then
  cp "$home/.omp/agent/extensions/herdr-omp-agent-state.ts" "$agent/extensions/"
else
  echo "setup: herdr integration install omp failed (see $logs/herdr-integration.log)" >&2
fi

start mock "$logs/mock.out" env "MOCK_LOG=$logs/mock.log" "MOCK_REC=$logs/requests.jsonl" bun "$here/mock.ts"
wait_for "mock (127.0.0.1:$mock_port)" 20 port_busy "$mock_port"

start devserver "$logs/devserver.log" "$devserver" --bind "127.0.0.1:$dev_port" --data-dir "$data" --hostd-bin "$hostd" --token "$token"
wait_for "tf-devserver (127.0.0.1:$dev_port)" 30 port_busy "$dev_port"

cat >"$root/lab.env" <<EOT
LAB=$lab
ROOT=$root
SESSION=$session
HOSTD=$hostd
HOSTD_HOME=$root/teleflock
OMP=$root/bin/omp
OMP_AGENT=$agent
WORK=$work
LOGS=$logs
REQUESTS=$logs/requests.jsonl
WS=ws://127.0.0.1:$dev_port/ws?token=$token
EOT
echo "lab $lab ready ($("$hostd" --version); $("$root/bin/omp" --version))"
printf '  %-9s %s\n' \
  herdr "pid $(cat "$logs/herdr.pid"), session $session, log $logs/herdr.log" \
  mock "pid $(cat "$logs/mock.pid"), 127.0.0.1:$mock_port, log $logs/mock.log, requests $logs/requests.jsonl" \
  devserver "pid $(cat "$logs/devserver.pid"), 127.0.0.1:$dev_port, data $data, log $logs/devserver.log" \
  hostd "$root/teleflock (hostd.log)" \
  omp "$root/bin/omp, agent dir $agent" \
  work "$work"
echo "drive: bun scripts/lab/renamectx/drive.ts"
echo "stop:  scripts/lab/stop $lab --purge"
