#!/usr/bin/env bash
# Model access lab setup (architecture §3.22 "Model access"): real omp with the working tree's bridge,
# a lab herdr server, tf-hostd and a mock Anthropic provider (mock.ts) with two signed-in accounts, one
# of which the provider refuses Claude Mythos on. Everything runs inside scripts/lab/run <lab> and in
# one network namespace with nothing but loopback: the accounts' tokens are fake and can reach no one.
#
# Usage: scripts/lab/models/setup.sh [--hostd BIN] [--fresh] <lab> <relay-port> [bridge-file]
#   <lab>          models or models-<name> (herdr session tf-lab-<lab>, lab dir /tmp/tf-lab-<lab>)
#   <relay-port>   loopback port of the lab tf-hostd's collab relay
#   [bridge-file]  deployed as <TF_HOSTD_HOME>/ext/teleflock-bridge.ts (default: the working tree's)
#   --hostd BIN    the tf-hostd to run (default target/ma/debug/tf-hostd)
#   --fresh        stop the lab and delete /tmp/tf-lab-<lab> first
# Writes /tmp/tf-lab-<lab>/lab.env for drive.ts. Stop with scripts/lab/stop <lab> --purge.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
run="$repo/scripts/lab/run"
hostd="$repo/target/ma/debug/tf-hostd"
fresh=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hostd) hostd="$2"; shift 2 ;;
    --fresh) fresh=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "setup: unknown option $1" >&2; exit 64 ;;
    *) break ;;
  esac
done
[ $# -ge 2 ] || { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
lab="$1"
relay="$2"
bridge="${3:-$repo/host/teleflock-bridge/teleflock-bridge.ts}"
[[ "$lab" =~ ^models(-[a-z0-9-]+)?$ ]] || { echo "setup: lab names are models or models-<name>" >&2; exit 64; }
[[ "$relay" =~ ^[0-9]+$ ]] || { echo "setup: bad relay port $relay" >&2; exit 64; }
hostd="$(readlink -f "$hostd")"
bridge="$(readlink -f "$bridge")"
[ -x "$hostd" ] || { echo "setup: no tf-hostd at $hostd" >&2; exit 66; }
[ "$fresh" = 1 ] && "$repo/scripts/lab/stop" "$lab" --purge >/dev/null || true

root="/tmp/tf-lab-$lab"
session="tf-lab-$lab"
mock_port=18791
"$run" "$lab" -- true # creates the lab's directories
home="$root/teleflock"
agent="$root/omp-agent"
work="$root/work"
logs="$root/logs"
mkdir -p "$home/ext" "$agent" "$logs" "$work"
printf 'collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:%s\n  displayName: %s\n' "$relay" "$session" >"$home/omp-overlay.yml"
cp "$bridge" "$home/ext/teleflock-bridge.ts"
cp "$here/models.yml" "$here/config.yml" "$agent/"
printf '# Model access lab repo\n' >"$work/README.md"
TF_LAB_CWD="$work" "$run" "$lab" -- sh -c 'git init -q -b main && git add -A && git -c user.name=lab -c user.email=lab@example.invalid commit -qm "lab repo"'

# The network namespace every lab process runs in: loopback only.
setsid nohup "$run" "$lab" -- unshare -n sleep infinity >/dev/null 2>&1 </dev/null &
echo $! >"$logs/netns.pid"
# Its pid is the `sleep` once unshare made the namespace (setsid, run, env and unshare exec in place).
pid="$(cat "$logs/netns.pid")"
for _ in $(seq 1 100); do [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = sleep ] && [ "$(readlink "/proc/$pid/ns/net")" != "$(readlink /proc/self/ns/net)" ] && break; sleep 0.1; done
[ "$(readlink "/proc/$pid/ns/net")" != "$(readlink /proc/self/ns/net)" ] || { echo "setup: the lab's network namespace did not come up" >&2; exit 1; }
ns="/proc/$pid/ns/net"
nsenter --net="$ns" ip link set lo up
inns() { "$run" "$lab" -- nsenter --net="$ns" "$@"; }

# Two signed-in Anthropic accounts with fake tokens that never expire (no refresh is ever tried).
cat >"$root/credentials.json" <<JSON
{"version":1,"credentials":[
 {"provider":"anthropic","credential":{"type":"oauth","access":"lab-token-no","refresh":"lab-refresh-no","expires":4102444800000,"email":"no-mythos@example.test","accountId":"acct_lab_no","orgId":"org_lab_no"}},
 {"provider":"anthropic","credential":{"type":"oauth","access":"lab-token-yes","refresh":"lab-refresh-yes","expires":4102444800000,"email":"mythos@example.test","accountId":"acct_lab_yes","orgId":"org_lab_yes"}}
]}
JSON
inns omp auth import "$root/credentials.json" >"$logs/auth-import.log" 2>&1 || { echo "setup: omp auth import failed (see $logs/auth-import.log)" >&2; exit 1; }

start() { # <name> <log> <command…>
  local name="$1" log="$2"
  shift 2
  setsid nohup "$run" "$lab" -- nsenter --net="$ns" "$@" >"$log" 2>&1 </dev/null &
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
mkdir -p "$root/home/.omp/agent/extensions" "$agent/extensions"
if inns env -u PI_CODING_AGENT_DIR herdr --session "$session" integration install omp >"$logs/herdr-integration.log" 2>&1; then
  cp "$root/home/.omp/agent/extensions/herdr-omp-agent-state.ts" "$agent/extensions/"
fi
start mock "$logs/mock.out" env "MOCK_LOG=$logs/mock.log" "MOCK_PORT=$mock_port" bun "$here/mock.ts"
wait_for "mock (127.0.0.1:$mock_port)" 20 nsenter --net="$ns" bash -c "exec 3<>/dev/tcp/127.0.0.1/$mock_port"
start hostd "$logs/hostd.stderr" env TF_HOSTD_LOG=info,tf_hostd::model_access=debug,tf_hostd::limit_resume=debug "$hostd" --relay-port "$relay" daemon
wait_for "tf-hostd daemon" 30 test -S "$home/run/hostd.sock"

cat >"$root/lab.env" <<ENV
LAB=$lab
ROOT=$root
SESSION=$session
RELAY_PORT=$relay
HOSTD=$hostd
HOSTD_HOME=$home
OMP_AGENT=$agent
WORK=$work
LOGS=$logs
NETNS=$ns
MOCK_PORT=$mock_port
ENV
echo "lab $lab ready ($("$hostd" --version)); drive: scripts/lab/run $lab -- nsenter --net=$ns bun $here/drive.ts --lab-env $root/lab.env"
