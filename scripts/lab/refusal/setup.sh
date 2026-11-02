#!/usr/bin/env bash
# Refusal fallback lab setup: the real stack for refusal fallback, inside scripts/lab/run <lab>: a lab
# herdr server, real omp with the working tree's TeleFlock bridge, tf-hostd, and a mock Anthropic
# provider whose Opus refuses a turn for `cyber` while its Sonnet answers (mock.ts).
#
# Usage: scripts/lab/refusal/setup.sh [--hostd BIN] [--hostd-env K=V]… [--ui DIR [--devserver BIN]] [--fresh] <lab> <relay-port> [bridge-file]
#   <lab>          refusal-<name> (≤ 18 characters: herdr's socket path must fit sun_path); the herdr
#                  session is tf-lab-<lab>, the lab lives in /tmp/tf-lab-<lab>
#   <relay-port>   loopback port of the lab tf-hostd's collab relay
#   [bridge-file]  deployed as <TF_HOSTD_HOME>/ext/teleflock-bridge.ts (default: the working tree's
#                  host/teleflock-bridge/teleflock-bridge.ts)
#   --hostd BIN    the tf-hostd to run (default target/shared/debug/tf-hostd)
#   --hostd-env K=V  extra environment for the daemon (e.g. TF_HOSTD_LOG=info,tf_hostd::refusal=debug); repeatable
#   --ui DIR       a built UI (`bunx vite build --outDir DIR`): tf-devserver (127.0.0.1:7481) serves it and
#                  runs the daemon instead of setup: it deploys pinned copies of --hostd and of the bridge it
#                  embeds ([bridge-file] does not apply: rebuild the devserver after bridge changes) and
#                  attaches them as the `local` host `lab` on the lab's herdr session and relay port.
#                  The page is URL in lab.env; drive.ts works the same.
#   --devserver BIN  the tf-devserver for --ui (default target/shared/debug/tf-devserver)
#   --fresh        stop the lab and delete /tmp/tf-lab-<lab> first
#
# Prepares: TF_HOSTD_HOME (omp-overlay.yml: collab autoStart control on ws://127.0.0.1:<relay-port>;
# ext/teleflock-bridge.ts), the omp agent dir (models.yml, config.yml), a work dir.
# Starts: the lab's herdr server, the mock provider (127.0.0.1:18781) and `tf-hostd daemon` (with
# --ui: tf-devserver, which starts it). Writes /tmp/tf-lab-<lab>/lab.env for drive.ts.
# Logs: /tmp/tf-lab-<lab>/logs. Stop with scripts/lab/stop <lab> [--purge].
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
run="$repo/scripts/lab/run"
hostd="$repo/target/shared/debug/tf-hostd"
hostd_env=()
ui=""
devserver="$repo/target/shared/debug/tf-devserver"
fresh=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hostd) hostd="$2"; shift 2 ;;
    --hostd-env) hostd_env+=("$2"); shift 2 ;;
    --ui) ui="$2"; shift 2 ;;
    --devserver) devserver="$2"; shift 2 ;;
    --fresh) fresh=1; shift ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "setup: unknown option $1" >&2; exit 64 ;;
    *) break ;;
  esac
done
[ $# -ge 2 ] || { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
lab="$1"
relay="$2"
bridge="${3:-$repo/host/teleflock-bridge/teleflock-bridge.ts}"
[[ "$lab" =~ ^refusal-[a-z0-9-]+$ ]] || { echo "setup: lab names start with refusal- ([a-z0-9-])" >&2; exit 64; }
[ "${#lab}" -le 18 ] || { echo "setup: lab name $lab is too long for herdr's socket path (18 characters at most)" >&2; exit 64; }
[[ "$relay" =~ ^[0-9]+$ ]] || { echo "setup: bad relay port $relay" >&2; exit 64; }
hostd="$(readlink -f "$hostd")"
bridge="$(readlink -f "$bridge")"
[ -x "$hostd" ] || { echo "setup: no tf-hostd at $hostd" >&2; exit 66; }
for kv in "${hostd_env[@]}"; do [[ "$kv" =~ ^[A-Z_][A-Z0-9_]*= ]] || { echo "setup: bad --hostd-env $kv" >&2; exit 64; }; done
[ -f "$bridge" ] || { echo "setup: no bridge at $bridge" >&2; exit 66; }
if [ -n "$ui" ]; then
  ui="$(readlink -f "$ui")"
  devserver="$(readlink -f "$devserver")"
  [ -f "$ui/index.html" ] || { echo "setup: no built UI in $ui (bunx vite build --outDir $ui)" >&2; exit 66; }
  [ -x "$devserver" ] || { echo "setup: no tf-devserver at $devserver" >&2; exit 66; }
fi

root="/tmp/tf-lab-$lab"
session="tf-lab-$lab"
mock_port=18781
dev_port=7481
token="refusal-lab-token-0123456789"
if [ "$fresh" = 1 ]; then "$repo/scripts/lab/stop" "$lab" --purge >/dev/null; fi

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
port_busy "$mock_port" && { echo "setup: 127.0.0.1:$mock_port is taken (another lab's mock?); stop that lab first" >&2; exit 69; }
port_busy "$relay" && { echo "setup: relay port $relay is taken" >&2; exit 69; }
[ -n "$ui" ] && port_busy "$dev_port" && { echo "setup: 127.0.0.1:$dev_port (tf-devserver) is taken" >&2; exit 69; }
[ -e "$root/teleflock/run/hostd.sock" ] && "$run" "$lab" -- "$hostd" --relay-port "$relay" stop >/dev/null 2>&1 || true

"$run" "$lab" -- true # creates the lab's directories
home="$root/teleflock"
agent="$root/omp-agent"
work="$root/work"
logs="$root/logs"
mkdir -p "$home/ext" "$agent" "$logs" "$work"

# TF_HOSTD_HOME: the collab overlay and the bridge every agent.start loads (`--config … -e …`).
printf 'collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:%s\n  displayName: %s\n' "$relay" "$session" >"$home/omp-overlay.yml"
cp "$bridge" "$home/ext/teleflock-bridge.ts"

# omp agent dir.
cp "$here/models.yml" "$here/config.yml" "$agent/"

if [ -n "$ui" ]; then
  # Pinned copies: the devserver deploys tf-hostd again on a reconnect, and a rebuild of the shared
  # target mid-run must not swap it. Its data dir has the one `local` host on the lab's herdr session.
  mkdir -p "$root/pinned" "$root/devserver"
  for b in "$hostd" "$devserver"; do cp "$b" "$root/pinned/${b##*/}.tmp" && mv "$root/pinned/${b##*/}.tmp" "$root/pinned/${b##*/}"; done
  hostd="$root/pinned/tf-hostd" devserver="$root/pinned/tf-devserver"
  data="$root/devserver"
  printf '{"profiles":[{"id":"lab","name":"Lab","kind":"local","herdrSession":"%s","autoConnect":true,"relayPort":%s}]}\n' "$session" "$relay" >"$data/hosts.json"
fi

printf '# Refusal lab repo\n\nA folder for the agents under test.\n' >"$work/README.md"
TF_LAB_CWD="$work" "$run" "$lab" -- sh -c 'git init -q -b main && git add -A && git -c user.name=lab -c user.email=lab@example.invalid commit -qm "lab repo"'

# Long-lived processes, detached from this shell; each one's pid is the process itself
# (scripts/lab/run execs).
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
mkdir -p "$root/home/.omp/agent/extensions" "$agent/extensions"
if "$run" "$lab" -- env -u PI_CODING_AGENT_DIR herdr --session "$session" integration install omp >"$logs/herdr-integration.log" 2>&1; then
  cp "$root/home/.omp/agent/extensions/herdr-omp-agent-state.ts" "$agent/extensions/"
else
  echo "setup: herdr integration install omp failed (see $logs/herdr-integration.log)" >&2
fi

start mock "$logs/mock.out" env "MOCK_LOG=$logs/mock.log" bun "$here/mock.ts"
wait_for "mock (127.0.0.1:$mock_port)" 20 port_busy "$mock_port"

if [ -n "$ui" ]; then
  start devserver "$logs/devserver.log" env "${hostd_env[@]}" "$devserver" --bind "127.0.0.1:$dev_port" --data-dir "$data" \
    --hostd-bin "$hostd" --static "$ui" --token "$token"
  wait_for "tf-devserver (127.0.0.1:$dev_port)" 30 port_busy "$dev_port"
  wait_for "tf-hostd daemon (the devserver deploys and starts it)" 90 test -S "$home/run/hostd.sock"
  url="http://127.0.0.1:$dev_port/?token=$token"
  started="DEVSERVER_PID=$(cat "$logs/devserver.pid")
URL=$url"
else
  start hostd "$logs/hostd.stderr" env "${hostd_env[@]}" "$hostd" --relay-port "$relay" daemon
  wait_for "tf-hostd daemon" 30 test -S "$home/run/hostd.sock"
  started="HOSTD_PID=$(cat "$logs/hostd.pid")"
fi

cat >"$root/lab.env" <<EOF
LAB=$lab
ROOT=$root
SESSION=$session
RELAY_PORT=$relay
HOSTD=$hostd
HOSTD_HOME=$home
OMP_AGENT=$agent
WORK=$work
LOGS=$logs
BRIDGE=$bridge
MOCK_PORT=$mock_port
HERDR_PID=$(cat "$logs/herdr.pid")
MOCK_PID=$(cat "$logs/mock.pid")
$started
EOF

echo "lab $lab ready ($("$hostd" --version), bridge $(grep -m1 -o 'BRIDGE_VERSION = "[^"]*"' "$home/ext/teleflock-bridge.ts" || echo '?'))"
if [ -n "$ui" ]; then
  printf '  %-9s %s\n' \
    herdr "pid $(cat "$logs/herdr.pid"), session $session, log $logs/herdr.log" \
    mock "pid $(cat "$logs/mock.pid"), 127.0.0.1:$mock_port, log $logs/mock.log" \
    devserver "pid $(cat "$logs/devserver.pid"), 127.0.0.1:$dev_port, UI $ui, data $data, log $logs/devserver.log" \
    hostd "$hostd, deployed into $home/bin and attached by the devserver (relay $relay)" \
    home "$home (hostd.log, refusalfallback.json, omp-overlay.yml, ext/teleflock-bridge.ts ← the devserver's)" \
    omp "$agent (models.yml, config.yml, sessions/)" \
    work "$work" \
    env "$root/lab.env"
  echo "page:    $url"
else
  printf '  %-8s %s\n' \
    herdr "pid $(cat "$logs/herdr.pid"), session $session, log $logs/herdr.log" \
    mock "pid $(cat "$logs/mock.pid"), 127.0.0.1:$mock_port, log $logs/mock.log" \
    hostd "pid $(cat "$logs/hostd.pid"), $hostd --relay-port $relay daemon" \
    home "$home (hostd.log, refusalfallback.json, omp-overlay.yml, ext/teleflock-bridge.ts ← $bridge)" \
    omp "$agent (models.yml, config.yml, sessions/)" \
    work "$work" \
    env "$root/lab.env"
fi
echo "drive:   scripts/lab/run $lab -- bun $here/drive.ts --lab-env $root/lab.env"
echo "stop:    scripts/lab/stop $lab --purge"
