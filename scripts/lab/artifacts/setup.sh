#!/usr/bin/env bash
# Artifacts lab: the real stack for documents an agent presents (the bridge's `present` tool,
# bridge 2.3.0), inside scripts/lab/run <lab>: a lab herdr server, a mock model provider with a
# sink, tf-devserver driving the lab's tf-hostd as a local host, and the UI from `vite dev` against
# that devserver.
#
# Usage: scripts/lab/artifacts/setup.sh [--hostd BIN] [--devserver BIN] [--fresh] <lab>
#   <lab>            art-<name> (≤ 18 characters: herdr's socket path must fit sun_path)
#   --hostd BIN      the tf-hostd the devserver deploys (default target/shared/debug/tf-hostd)
#   --devserver BIN  default target/shared/debug/tf-devserver (it embeds the bridge it deploys)
#   --fresh          stop the lab and delete /tmp/tf-lab-<lab> first
#
# Prepares: the omp agent dir (models.yml, config.yml: every role on the mock, yolo, no wizard),
# the devserver data dir (hosts.json: one `local` host, id `lab`, on herdr session tf-lab-<lab>),
# the work folder <lab home>/src/weekly-report (a git repo with one commit) the agent starts in.
# Starts: herdr (session tf-lab-<lab>; its omp integration is tried, and refused while pi and omp
# share the lab's agent dir, which this lab does without), the mock (mock.ts: the model on
# 127.0.0.1:18773, the sink on 127.0.0.1:18774, raw TCP 18775 and UDP 18776), tf-devserver
# (127.0.0.1:7453; it deploys and attaches tf-hostd with the lab's TF_HOSTD_HOME, relay port 47773),
# vite (127.0.0.1:1453).
# Prints the page URL; /tmp/tf-lab-<lab>/lab.env has every path.
#
# Agent: start it in the work folder with model mock/lab-1, from the UI (New agent: folder
# <lab home>/src/weekly-report) or scripted (`agent.start` over the devserver's /ws, as drive.ts
# does). Prompts, sent in this order (the mock keys on the marker in the newest prompt):
#   PRESENT-HTML        writes report/logo.svg and report/index.html, presents "Lab report" (v1)
#   PRESENT-HTML again  rewrites the page (new headline), presents "Lab report" again (v2)
#   PRESENT-MD          presents inline Markdown (table, mermaid block) as "Lab notes" (v1)
#   PRESENT-EVIL        writes evil/index.html, presents it as "Evil page" (v1): the page tries every
#                       way out of the viewer's sandbox toward the sink (WebRTC from the page, an empty
#                       frame and a frame it makes, resource hints in its markup and added at runtime
#                       included) and lists what happened
# Each turn ends with an answer whose last line is `PRESENT-LAB <html|again|md|evil> done`.
# Scripted run of all four plus the checks (snapshots on disk, typed `present` rows from
# session.open/session.history, a base64 session.artifact read, an empty sink log):
#   bun scripts/lab/artifacts/drive.ts <lab>        (--help for its options)
# Sandbox check: open "Evil page" in the app; every line logs/sink.log gets is something that got
# out of the sandbox (the agent run alone never touches the sink). Expected in a browser (this lab's
# vite page): a TLS ClientHello for html-string.localhost (a hint parsed from an HTML string) and
# UDP/TCP from "a frame the page made" (WebRTC there); see docs/architecture.md §3.32.
#
# Run, from the repo root (the devserver embeds the bridge it deploys: rebuild it after bridge
# changes):
#   CARGO_TARGET_DIR=target/shared CARGO_PROFILE_DEV_DEBUG=0 cargo build -p tf-hostd -p tf-devserver
#   scripts/lab/artifacts/setup.sh --fresh art-lab
#   bun scripts/lab/artifacts/drive.ts art-lab      # agent.start, the four prompts, the checks
#   then open the printed page (the agent `presenter` is on the board, its session live)
# Logs: /tmp/tf-lab-<lab>/logs (mock.log, sink.log, devserver.log, …; hostd: teleflock/hostd.log).
# Stop with scripts/lab/stop <lab> [--purge].
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
run="$repo/scripts/lab/run"
hostd="$repo/target/shared/debug/tf-hostd"
devserver="$repo/target/shared/debug/tf-devserver"
fresh=0
usage() { sed -n '2,49p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --hostd) hostd="$2"; shift 2 ;;
    --devserver) devserver="$2"; shift 2 ;;
    --fresh) fresh=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "setup: unknown option $1" >&2; exit 64 ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || { usage >&2; exit 64; }
lab="$1"
[[ "$lab" =~ ^art-[a-z0-9-]+$ ]] || { echo "setup: lab names start with art- ([a-z0-9-])" >&2; exit 64; }
[ "${#lab}" -le 18 ] || { echo "setup: lab name $lab is too long for herdr's socket path (18 characters at most)" >&2; exit 64; }
hostd="$(readlink -f "$hostd")"
devserver="$(readlink -f "$devserver")"
[ -x "$hostd" ] || { echo "setup: no tf-hostd at $hostd" >&2; exit 66; }
[ -x "$devserver" ] || { echo "setup: no tf-devserver at $devserver" >&2; exit 66; }

root="/tmp/tf-lab-$lab"
session="tf-lab-$lab"
mock_port=18773
sink_port=18774
sink_tcp_port=18775
dev_port=7453
vite_port=1453
relay=47773
token="artifacts-lab-token-0123456789"
if [ "$fresh" = 1 ]; then "$repo/scripts/lab/stop" "$lab" --purge >/dev/null; fi

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$mock_port" "$sink_port" "$sink_tcp_port" "$dev_port" "$vite_port" "$relay"; do
  port_busy "$p" && { echo "setup: 127.0.0.1:$p is taken; stop whatever holds it first" >&2; exit 69; }
done

"$run" "$lab" -- true # creates the lab's directories
home="$root/home"
agent="$root/omp-agent"
logs="$root/logs"
data="$root/devserver"
work="$home/src/weekly-report"
mkdir -p "$agent" "$logs" "$data"
cp "$here/models.yml" "$here/config.yml" "$agent/"
printf '{"profiles":[{"id":"lab","name":"Lab","kind":"local","herdrSession":"%s","autoConnect":true,"relayPort":%s}]}\n' "$session" "$relay" >"$data/hosts.json"
: >"$logs/sink.log"

# The work folder: a small repository the agent writes its report into.
if [ ! -d "$work/.git" ]; then
  mkdir -p "$work"
  printf '# Weekly report\n\nThe artifacts lab agent builds its reports here (report/, evil/).\n' >"$work/README.md"
  TF_LAB_CWD="$work" "$run" "$lab" -- sh -c 'git init -q -b main && git add -A && git -c user.name=lab -c user.email=lab@example.invalid commit -qm "weekly report"' >"$logs/repo.log" 2>&1
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
"$run" "$lab" -- herdr --session "$session" integration install omp >"$logs/herdr-integration.log" 2>&1 || echo "setup: herdr's omp integration not installed (see $logs/herdr-integration.log); the lab runs without it" >&2

start mock "$logs/mock.out" env "MOCK_LOG=$logs/mock.log" "SINK_LOG=$logs/sink.log" bun "$here/mock.ts"
wait_for "mock (127.0.0.1:$mock_port)" 20 port_busy "$mock_port"
wait_for "sink (127.0.0.1:$sink_port)" 10 port_busy "$sink_port"

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
OMP_AGENT=$agent
WORK=$work
LOGS=$logs
SINK_LOG=$logs/sink.log
WS=ws://127.0.0.1:$dev_port/ws?token=$token
URL=$url
EOF
echo "lab $lab ready ($("$hostd" --version))"
printf '  %-9s %s\n' \
  herdr "pid $(cat "$logs/herdr.pid"), session $session, log $logs/herdr.log" \
  mock "pid $(cat "$logs/mock.pid"), model 127.0.0.1:$mock_port (log $logs/mock.log), sink 127.0.0.1:$sink_port (log $logs/sink.log)" \
  devserver "pid $(cat "$logs/devserver.pid"), 127.0.0.1:$dev_port, data $data, log $logs/devserver.log" \
  vite "pid $(cat "$logs/vite.pid"), 127.0.0.1:$vite_port, log $logs/vite.log" \
  hostd "$root/teleflock (hostd.log)" \
  omp "$agent (models.yml, config.yml, sessions/)" \
  work "$work"
echo "page:  $url"
echo "drive: bun scripts/lab/artifacts/drive.ts $lab"
echo "stop:  scripts/lab/stop $lab"
