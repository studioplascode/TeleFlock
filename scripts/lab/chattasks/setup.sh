#!/usr/bin/env bash
# ChatTasks lab: the real stack for chat tasks (agents with no repository or folder), inside
# scripts/lab/run <lab>: a lab herdr server, a mock model provider, and tf-devserver driving the
# lab's tf-hostd as a local host and serving a built UI (no dev server: other work in the tree
# cannot reload the page under a check).
#
# Usage: scripts/lab/chattasks/setup.sh [--hostd BIN] [--devserver BIN] [--ui DIR] [--fresh] <lab>
#   <lab>          chat-<name> (≤ 18 characters: herdr's socket path must fit sun_path)
#   --hostd BIN    the tf-hostd the devserver deploys (default target/shared/debug/tf-hostd)
#   --devserver BIN  default target/shared/debug/tf-devserver
#   --ui DIR       a built UI (`bunx vite build --outDir DIR`); without it, setup builds the UI
#                  into /tmp/tf-lab-<lab>/ui (vite build, about a minute)
#   --fresh        stop the lab and delete /tmp/tf-lab-<lab> first
#
# Prepares: the omp agent dir (models.yml, config.yml: every role on the mock, yolo, no wizard),
# the devserver data dir (hosts.json: one `local` host on herdr session tf-lab-<lab>, relay 47771).
# Starts: herdr (session tf-lab-<lab>, omp integration installed), the mock (mock.ts,
# 127.0.0.1:18771), tf-devserver (127.0.0.1:7451, serving the UI; it deploys and attaches tf-hostd
# with the lab's TF_HOSTD_HOME). Prints the page URL.
# Logs: /tmp/tf-lab-<lab>/logs. Stop with scripts/lab/stop <lab> [--purge].
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
run="$repo/scripts/lab/run"
hostd="$repo/target/shared/debug/tf-hostd"
devserver="$repo/target/shared/debug/tf-devserver"
ui=""
fresh=0
usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --hostd) hostd="$2"; shift 2 ;;
    --devserver) devserver="$2"; shift 2 ;;
    --ui) ui="$2"; shift 2 ;;
    --fresh) fresh=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "setup: unknown option $1" >&2; exit 64 ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || { usage >&2; exit 64; }
lab="$1"
[[ "$lab" =~ ^chat-[a-z0-9-]+$ ]] || { echo "setup: lab names start with chat- ([a-z0-9-])" >&2; exit 64; }
[ "${#lab}" -le 18 ] || { echo "setup: lab name $lab is too long for herdr's socket path (18 characters at most)" >&2; exit 64; }
hostd="$(readlink -f "$hostd")"
devserver="$(readlink -f "$devserver")"
[ -x "$hostd" ] || { echo "setup: no tf-hostd at $hostd" >&2; exit 66; }
[ -x "$devserver" ] || { echo "setup: no tf-devserver at $devserver" >&2; exit 66; }
if [ -n "$ui" ]; then
  ui="$(readlink -f "$ui")"
  [ -f "$ui/index.html" ] || { echo "setup: no built UI in $ui (bunx vite build --outDir $ui)" >&2; exit 66; }
fi

root="/tmp/tf-lab-$lab"
session="tf-lab-$lab"
mock_port=18771
dev_port=7451
relay=47771
token="chattasks-lab-token-0123456789"
if [ "$fresh" = 1 ]; then "$repo/scripts/lab/stop" "$lab" --purge >/dev/null; fi

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$mock_port" "$dev_port" "$relay"; do
  port_busy "$p" && { echo "setup: 127.0.0.1:$p is taken; stop whatever holds it first" >&2; exit 69; }
done

"$run" "$lab" -- true # creates the lab's directories
agent="$root/omp-agent"
logs="$root/logs"
data="$root/devserver"
mkdir -p "$agent" "$logs" "$data"
cp "$here/models.yml" "$here/config.yml" "$agent/"
printf '{"profiles":[{"id":"lab","name":"Lab","kind":"local","herdrSession":"%s","autoConnect":true,"relayPort":%s}]}\n' "$session" "$relay" >"$data/hosts.json"

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
# herdr refuses to install its omp integration while PI_CODING_AGENT_DIR points Pi and omp at one
# dir (the lab's): install it into the lab home's ~/.omp/agent, then copy it into the lab's agent dir.
home="$root/home"
mkdir -p "$home/.omp/agent/extensions" "$agent/extensions"
if "$run" "$lab" -- env -u PI_CODING_AGENT_DIR herdr --session "$session" integration install omp >"$logs/herdr-integration.log" 2>&1; then
  cp "$home/.omp/agent/extensions/herdr-omp-agent-state.ts" "$agent/extensions/"
else
  echo "setup: herdr integration install omp failed (see $logs/herdr-integration.log)" >&2
fi

start mock "$logs/mock.out" env "MOCK_LOG=$logs/mock.log" bun "$here/mock.ts"
wait_for "mock (127.0.0.1:$mock_port)" 20 port_busy "$mock_port"

if [ -z "$ui" ]; then
  ui="$root/ui"
  echo "setup: building the UI into $ui (vite build, about a minute)"
  (cd "$repo" && bunx vite build --outDir "$ui" --emptyOutDir) >"$logs/ui-build.log" 2>&1 ||
    { echo "setup: vite build failed (see $logs/ui-build.log)" >&2; exit 1; }
fi

start devserver "$logs/devserver.log" "$devserver" --bind "127.0.0.1:$dev_port" --data-dir "$data" --hostd-bin "$hostd" \
  --static "$ui" --token "$token"
wait_for "tf-devserver (127.0.0.1:$dev_port)" 30 port_busy "$dev_port"

url="http://127.0.0.1:$dev_port/?token=$token"
cat >"$root/lab.env" <<EOF
LAB=$lab
ROOT=$root
SESSION=$session
HOSTD=$hostd
HOSTD_HOME=$root/teleflock
OMP_AGENT=$agent
LOGS=$logs
URL=$url
EOF
echo "lab $lab ready ($("$hostd" --version))"
printf '  %-9s %s\n' \
  herdr "pid $(cat "$logs/herdr.pid"), session $session, log $logs/herdr.log" \
  mock "pid $(cat "$logs/mock.pid"), 127.0.0.1:$mock_port, log $logs/mock.log" \
  devserver "pid $(cat "$logs/devserver.pid"), 127.0.0.1:$dev_port, UI $ui, data $data, log $logs/devserver.log" \
  hostd "$root/teleflock (hostd.log; chats/ once a chat starts)" \
  omp "$agent (models.yml, config.yml, sessions/)"
echo "page:  $url"
echo "stop:  scripts/lab/stop $lab"
