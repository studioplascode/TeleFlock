#!/usr/bin/env bash
# IdleShells lab: the real stack for idle shells, inside scripts/lab/run <lab>: a lab herdr server
# with a scenario of shells, tf-devserver driving the lab's tf-hostd as a local host, and the UI
# served by that devserver.
#
# Usage: scripts/lab/idleshells/setup.sh [--hostd BIN] [--devserver BIN] [--static DIR] [--minutes N] [--fresh] <lab>
#   <lab>            idle-<name> (≤ 18 characters: herdr's socket path must fit sun_path)
#   --hostd BIN      the tf-hostd the devserver deploys (default target/IdleShells/debug/tf-hostd)
#   --devserver BIN  default target/IdleShells/debug/tf-devserver
#   --static DIR     the built UI the devserver serves (default target/IdleShells/dist)
#   --minutes N      idle threshold written to the lab's idle-shells.json, auto off (default 2)
#   --fresh          stop the lab and delete /tmp/tf-lab-<lab> first
#
# Scenario (herdr session tf-lab-<lab>; folders under the lab's HOME/src):
#   agent     omp running (no model is ever called), plus a plain shell beside it
#   busy      `sleep 1000` in front of the shell
#   jobs      `sleep 1000 &` behind the shell
#   viewed    a plain shell: open it in the app's terminal to keep it attached
#   notes     a plain shell that ran `sleep 3` (its last command)
#   home      a plain shell in the lab's HOME
#   shop      a repository's primary checkout (a plain shell) with the linked worktree shop-fix
#             (a plain shell) grouped under it
# Only notes, home, shop-fix (and viewed, unless it is open in a terminal) may be offered or closed.
# Logs: /tmp/tf-lab-<lab>/logs. Stop with scripts/lab/stop <lab> [--purge].
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
run="$repo/scripts/lab/run"
hostd="$repo/target/IdleShells/debug/tf-hostd"
devserver="$repo/target/IdleShells/debug/tf-devserver"
static="$repo/target/IdleShells/dist"
minutes=2
fresh=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hostd) hostd="$2"; shift 2 ;;
    --devserver) devserver="$2"; shift 2 ;;
    --static) static="$2"; shift 2 ;;
    --minutes) minutes="$2"; shift 2 ;;
    --fresh) fresh=1; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "setup: unknown option $1" >&2; exit 64 ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
lab="$1"
[[ "$lab" =~ ^idle-[a-z0-9-]+$ ]] || { echo "setup: lab names start with idle- ([a-z0-9-])" >&2; exit 64; }
[ "${#lab}" -le 18 ] || { echo "setup: lab name $lab is too long for herdr's socket path (18 characters at most)" >&2; exit 64; }
hostd="$(readlink -f "$hostd")"
devserver="$(readlink -f "$devserver")"
static="$(readlink -f "$static")"
[ -x "$hostd" ] || { echo "setup: no tf-hostd at $hostd" >&2; exit 66; }
[ -x "$devserver" ] || { echo "setup: no tf-devserver at $devserver" >&2; exit 66; }
[ -f "$static/index.html" ] || { echo "setup: no built UI at $static (bunx vite build --outDir $static)" >&2; exit 66; }

root="/tmp/tf-lab-$lab"
session="tf-lab-$lab"
dev_port=7446
relay=47746
token="idleshells-lab-token-0123456789"
if [ "$fresh" = 1 ]; then "$repo/scripts/lab/stop" "$lab" --purge >/dev/null; fi

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$dev_port" "$relay"; do
  port_busy "$p" && { echo "setup: 127.0.0.1:$p is taken; stop whatever holds it first" >&2; exit 69; }
done

"$run" "$lab" -- true # creates the lab's directories
home="$root/home"
agent="$root/omp-agent"
logs="$root/logs"
data="$root/devserver"
mkdir -p "$agent" "$logs" "$data" "$home/src"
cp "$here/config.yml" "$agent/"
printf '{"auto": false, "minutes": %s}\n' "$minutes" >"$root/teleflock/idle-shells.json"
printf '{"profiles":[{"id":"lab","name":"Lab","kind":"local","herdrSession":"%s","autoConnect":true,"relayPort":%s}]}\n' "$session" "$relay" >"$data/hosts.json"

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
h() { "$run" "$lab" -- herdr --session "$session" "$@"; }

start herdr "$logs/herdr.log" herdr --session "$session" server
herdr_up() { h status server 2>/dev/null | grep -q 'status: running'; }
wait_for "herdr server ($session)" 30 herdr_up
h integration install omp >"$logs/herdr-integration.log" 2>&1 || echo "setup: herdr integration install omp failed (see $logs/herdr-integration.log)" >&2

# The repository and its linked worktree.
TF_LAB_CWD="$home/src" "$run" "$lab" -- bash -c '
  set -e
  mkdir -p shop && cd shop && git init -q -b main && git -c user.name=lab -c user.email=lab@example.com commit -q --allow-empty -m init
  git worktree add -q -b fix ../shop-fix
' >"$logs/repo.log" 2>&1
mkdir -p "$home/src/agent" "$home/src/busy" "$home/src/jobs" "$home/src/viewed" "$home/src/notes"

# `workspace create` answers JSON with the new workspace's root pane.
root_pane() { sed -n 's/.*"root_pane":{[^}]*"pane_id":"\([^"]*\)".*/\1/p; s/.*"pane_id":"\([^"]*\)".*/\1/p' | head -1; }
ws() { # <label> <cwd>: prints the root pane
  h workspace create --cwd "$2" --label "$1" --no-focus | root_pane
}
p_agent="$(ws agent "$home/src/agent")"
p_busy="$(ws busy "$home/src/busy")"
p_jobs="$(ws jobs "$home/src/jobs")"
p_viewed="$(ws viewed "$home/src/viewed")"
p_notes="$(ws notes "$home/src/notes")"
p_home="$(ws home "$home")"
p_shop="$(ws shop "$home/src/shop")"
p_fix="$(ws shop-fix "$home/src/shop-fix")"
for v in p_agent p_busy p_jobs p_viewed p_notes p_home p_shop p_fix; do
  [ -n "${!v}" ] || { echo "setup: no pane for $v" >&2; exit 70; }
done
sleep 1
h pane run "$p_agent" omp >/dev/null
h pane split "$p_agent" --direction right --cwd "$home/src/agent" >/dev/null
h pane run "$p_busy" "sleep 1000" >/dev/null
h pane run "$p_jobs" "sleep 1000 &" >/dev/null
h pane run "$p_notes" "sleep 3" >/dev/null

start devserver "$logs/devserver.log" "$devserver" --bind "127.0.0.1:$dev_port" --data-dir "$data" --hostd-bin "$hostd" \
  --token "$token" --static "$static"
wait_for "tf-devserver (127.0.0.1:$dev_port)" 30 port_busy "$dev_port"

url="http://127.0.0.1:$dev_port/?token=$token"
cat >"$root/lab.env" <<EOF
LAB=$lab
ROOT=$root
SESSION=$session
HOSTD=$hostd
HOSTD_HOME=$root/teleflock
LOGS=$logs
URL=$url
PANES="agent=$p_agent busy=$p_busy jobs=$p_jobs viewed=$p_viewed notes=$p_notes home=$p_home shop=$p_shop shop-fix=$p_fix"
EOF
echo "lab $lab ready ($("$hostd" --version)); idle after $minutes min, auto off ($root/teleflock/idle-shells.json)"
printf '  %-9s %s\n' \
  herdr "pid $(cat "$logs/herdr.pid"), session $session, log $logs/herdr.log" \
  devserver "pid $(cat "$logs/devserver.pid"), 127.0.0.1:$dev_port, data $data, log $logs/devserver.log" \
  hostd "$root/teleflock (hostd.log)" \
  panes "agent=$p_agent busy=$p_busy jobs=$p_jobs viewed=$p_viewed notes=$p_notes home=$p_home shop=$p_shop shop-fix=$p_fix"
echo "page:  $url"
echo "stop:  scripts/lab/stop $lab"
