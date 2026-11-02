#!/usr/bin/env bash
# Agent chat lab: the message board's data (`session.agentChat`, architecture §3.34) for a whole omp
# agent tree against the real stack, inside scripts/lab/run <lab>: a lab herdr server, a mock
# Anthropic Messages provider that plays a tree (Main → Orchestrator → WorkerA, WorkerB) talking
# over omp's IRC, the installed omp pinned into the lab, tf-devserver driving the lab's tf-hostd as a
# local host, and the UI from `vite dev` against that devserver.
#
# Usage: scripts/lab/agentchat/setup.sh [--hostd BIN] [--devserver BIN] [--omp BIN] [--fresh] <lab>
#   <lab>            acb-<name> (≤ 18 characters: herdr's socket path must fit sun_path)
#   --hostd BIN      the tf-hostd the devserver deploys (default target/shared/debug/tf-hostd)
#   --devserver BIN  default target/shared/debug/tf-devserver (it embeds the bridge it deploys:
#                    rebuild it after bridge changes)
#   --omp BIN        the omp copied into the lab (default ~/.local/bin/omp); the lab's login shells
#                    and herdr panes find it first on PATH, so its agents run exactly this build
#   --fresh          stop the lab and delete /tmp/tf-lab-<lab> first
#
# Prepares: the omp agent dir (models.yml, config.yml: every role on the mock, yolo, no wizard, no
# speculative launch or completion probe), the devserver data dir (hosts.json: one `local` host, id
# `lab`, on herdr session tf-lab-<lab>), the work folder <lab home>/src/chat-lab (a git repo with one
# commit) the agents start in, and old-bridge.ts: the bridge of the last release (git HEAD), for the
# driver's older-bridge case.
# Starts: herdr (session tf-lab-<lab>, omp integration installed), the mock (127.0.0.1:18791),
# tf-devserver (127.0.0.1:7471; it deploys and attaches tf-hostd with the lab's TF_HOSTD_HOME, relay
# port 47791), vite (127.0.0.1:1471). Prints the page URL; /tmp/tf-lab-<lab>/lab.env has every path.
#
# Prompts to the main agent (the mock keys on the marker; see mock.ts):
#   ACB-TREE  the scripted tree: spawns, a broadcast, a progress note, a question that wakes a
#             finished worker and omp's wake relay back, an unknown recipient, a send to itself,
#             results; ends with `ACB-LAB tree done`
#   ACB-PING  Main asks the idle Orchestrator, which writes back; ends with `ACB-LAB ping done`
# Scripted run with every check (live, after a tf-hostd restart, an older bridge):
#   bun scripts/lab/agentchat/drive.ts <lab>        (--help for its options)
# Logs: /tmp/tf-lab-<lab>/logs (mock.log, devserver.log, vite.log, …; hostd: teleflock/hostd.log).
# Stop with scripts/lab/stop <lab> [--purge].
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
run="$repo/scripts/lab/run"
hostd="$repo/target/shared/debug/tf-hostd"
devserver="$repo/target/shared/debug/tf-devserver"
omp="${HOME:-/root}/.local/bin/omp"
fresh=0
usage() { sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --hostd) hostd="$2"; shift 2 ;;
    --devserver) devserver="$2"; shift 2 ;;
    --omp) omp="$2"; shift 2 ;;
    --fresh) fresh=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "setup: unknown option $1" >&2; exit 64 ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || { usage >&2; exit 64; }
lab="$1"
[[ "$lab" =~ ^acb-[a-z0-9-]+$ ]] || { echo "setup: lab names start with acb- ([a-z0-9-])" >&2; exit 64; }
[ "${#lab}" -le 18 ] || { echo "setup: lab name $lab is too long for herdr's socket path (18 characters at most)" >&2; exit 64; }
hostd="$(readlink -f "$hostd")"
devserver="$(readlink -f "$devserver")"
omp="$(readlink -f "$omp")"
[ -x "$hostd" ] || { echo "setup: no tf-hostd at $hostd" >&2; exit 66; }
[ -x "$devserver" ] || { echo "setup: no tf-devserver at $devserver" >&2; exit 66; }
[ -x "$omp" ] || { echo "setup: no omp at $omp" >&2; exit 66; }

root="/tmp/tf-lab-$lab"
session="tf-lab-$lab"
mock_port=18791
dev_port=7471
vite_port=1471
relay=47791
token="agentchat-lab-token-0123456789"
if [ "$fresh" = 1 ]; then "$repo/scripts/lab/stop" "$lab" --purge >/dev/null; fi

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$mock_port" "$dev_port" "$vite_port" "$relay"; do
  port_busy "$p" && { echo "setup: 127.0.0.1:$p is taken; stop whatever holds it first" >&2; exit 69; }
done

# Pinned copies: a rebuild of the shared target mid-run must not swap the binaries under the lab.
# The omp copy comes first on the PATH of the lab's login shells (tf-hostd reads PATH from one) and
# of herdr's panes; scripts/lab/run writes .profile / .bashrc only when they are missing.
home="$root/home"
mkdir -p "$root/bin" "$root/pinned" "$home"
pin() { cp "$1" "$2.tmp" && mv "$2.tmp" "$2"; }
pin "$omp" "$root/bin/omp"
pin "$hostd" "$root/pinned/tf-hostd"
pin "$devserver" "$root/pinned/tf-devserver"
omp="$root/bin/omp" hostd="$root/pinned/tf-hostd" devserver="$root/pinned/tf-devserver"
lab_path="$("$run" "$lab" --print-env | sed -n 's/^PATH=//p')"
for rc in .profile .bashrc; do printf 'export PATH="%s:%s"\n' "$root/bin" "$lab_path" >"$home/$rc"; done
git -C "$repo" show HEAD:host/teleflock-bridge/teleflock-bridge.ts >"$root/old-bridge.ts"

"$run" "$lab" -- true # creates the lab's directories
agent="$root/omp-agent"
logs="$root/logs"
data="$root/devserver"
work="$home/src/chat-lab"
mkdir -p "$agent" "$logs" "$data"
cp "$here/models.yml" "$here/config.yml" "$agent/"
printf '{"profiles":[{"id":"lab","name":"Lab","kind":"local","herdrSession":"%s","autoConnect":true,"relayPort":%s}]}\n' "$session" "$relay" >"$data/hosts.json"

if [ ! -d "$work/.git" ]; then
  mkdir -p "$work"
  printf '# Chat lab\n\nThe agent chat lab tree starts here.\n' >"$work/README.md"
  TF_LAB_CWD="$work" "$run" "$lab" -- sh -c 'git init -q -b main && git add -A && git -c user.name=lab -c user.email=lab@example.invalid commit -qm "chat lab"' >"$logs/repo.log" 2>&1
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
# herdr refuses to install its omp integration while PI_CODING_AGENT_DIR points Pi and omp at one
# dir (the lab's): install it into the lab home's ~/.omp/agent, then copy it into the lab's agent dir.
mkdir -p "$home/.omp/agent/extensions" "$agent/extensions"
if "$run" "$lab" -- env -u PI_CODING_AGENT_DIR herdr --session "$session" integration install omp >"$logs/herdr-integration.log" 2>&1; then
  cp "$home/.omp/agent/extensions/herdr-omp-agent-state.ts" "$agent/extensions/"
else
  echo "setup: herdr integration install omp failed (see $logs/herdr-integration.log)" >&2
fi

start mock "$logs/mock.out" env "MOCK_LOG=$logs/mock.log" bun "$here/mock.ts"
wait_for "mock (127.0.0.1:$mock_port)" 20 port_busy "$mock_port"

start devserver "$logs/devserver.log" "$devserver" --bind "127.0.0.1:$dev_port" --data-dir "$data" --hostd-bin "$hostd" \
  --token "$token" --allow-origin "http://127.0.0.1:$vite_port"
wait_for "tf-devserver (127.0.0.1:$dev_port)" 30 port_busy "$dev_port"

TF_LAB_CWD="$repo" start vite "$logs/vite.log" bunx vite --host 127.0.0.1 --port "$vite_port" --strictPort
wait_for "vite (127.0.0.1:$vite_port)" 60 port_busy "$vite_port"

url="http://127.0.0.1:$vite_port/?core=ws://127.0.0.1:$dev_port/ws&token=$token"
cat >"$root/lab.env" <<EOF
LAB=$lab
ROOT=$root
SESSION=$session
HOSTD=$hostd
HOSTD_HOME=$root/teleflock
OMP=$root/bin/omp
OMP_AGENT=$agent
OLD_BRIDGE=$root/old-bridge.ts
WORK=$work
LOGS=$logs
WS=ws://127.0.0.1:$dev_port/ws?token=$token
URL=$url
EOF
echo "lab $lab ready ($("$hostd" --version); $("$root/bin/omp" --version))"
printf '  %-9s %s\n' \
  herdr "pid $(cat "$logs/herdr.pid"), session $session, log $logs/herdr.log" \
  mock "pid $(cat "$logs/mock.pid"), 127.0.0.1:$mock_port, log $logs/mock.log" \
  devserver "pid $(cat "$logs/devserver.pid"), 127.0.0.1:$dev_port, data $data, log $logs/devserver.log" \
  vite "pid $(cat "$logs/vite.pid"), 127.0.0.1:$vite_port, log $logs/vite.log" \
  hostd "$root/teleflock (hostd.log)" \
  omp "$root/bin/omp, agent dir $agent (models.yml, config.yml, sessions/)" \
  work "$work"
echo "page:  $url"
echo "drive: bun scripts/lab/agentchat/drive.ts $lab"
echo "stop:  scripts/lab/stop $lab"
