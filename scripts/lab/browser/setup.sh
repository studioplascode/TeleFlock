#!/usr/bin/env bash
# Browser lab: the TeleFlock Browser end to end, inside scripts/lab/run <lab>: a lab herdr server,
# a mock model provider, the installed omp pinned into the lab (its agents drive the browser with
# omp's own browser tooling), tf-devserver (the app core with its browser manager and DevTools
# proxy) driving the lab's tf-hostd as a local host, and with --ui or --vite the UI against it.
#
# Usage: scripts/lab/browser/setup.sh [--hostd BIN] [--devserver BIN] [--omp BIN] [--chrome PATH] [--ui | --vite] [--fresh] <lab>
#   <lab>            brw-<name> (≤ 18 characters: herdr's socket path must fit sun_path)
#   --hostd BIN      the tf-hostd the devserver deploys (default target/shared/debug/tf-hostd)
#   --devserver BIN  default target/shared/debug/tf-devserver (it embeds the bridge it deploys)
#   --omp BIN        the omp copied into the lab (default ~/.local/bin/omp); the lab's login shells
#                    and herdr panes find it first on PATH, so its agents run exactly this build
#   --chrome PATH    the browser to run (drive.ts sets it with browser.configSet; its screenshots
#                    use it too); without it, drive.ts downloads the pinned Chrome for Testing into
#                    the lab's data dir (browser.installEngine, about 200 MB) unless one is installed
#   --ui             build the UI once (vite build into /tmp/tf-lab-<lab>/ui, about a minute) and
#                    let the devserver serve it: drive.ts screenshots it at 1440×900 into
#                    /tmp/tf-lab-<lab>/shots (a built UI never reloads under the screenshots)
#   --vite           serve the UI from `vite dev` on 127.0.0.1:1472 instead, to work on it (it
#                    reloads whenever a source file changes, so screenshots may catch a reload)
#   --fresh          stop the lab and delete /tmp/tf-lab-<lab> first
#
# Prepares pinned copies of omp, tf-hostd and tf-devserver (a rebuild of the shared target mid-run
# does not swap them), the omp agent dir (models.yml, config.yml: every role on the mock, yolo, no
# wizard), the devserver data dir (hosts.json: one `local` host, id `lab`, on herdr session
# tf-lab-<lab>) and the work folder <lab home>/src/site (a git repo) agents start in. Starts herdr
# (session tf-lab-<lab>, omp integration installed), the mock (127.0.0.1:18783), tf-devserver
# (127.0.0.1:7463; it deploys and attaches tf-hostd with the lab's TF_HOSTD_HOME, relay port 47783;
# the browser's profile is <data>/browser/profile), and with --vite the UI. /tmp/tf-lab-<lab>/lab.env
# has every path.
#
# Prompts (the mock keys on the markers in the newest prompt; see mock.ts):
#   USE-BROWSER <reason>   the bridge's use_user_browser {reason} first
#   BRW-EVAL + code lines  omp's eval tool {language: "js", code} runs the code (omp's `browser`
#                          global); one call per BRW-EVAL block; after USE-BROWSER only when the
#                          user allowed it
# Each turn ends with `BROWSER-LAB done`, quoting every tool result.
# Then: bun scripts/lab/browser/drive.ts <lab> (the scripted checks; --help for its options).
# Logs: /tmp/tf-lab-<lab>/logs (mock.log, devserver.log, …; hostd: teleflock/hostd.log; the
# agents' omp: home/.omp/logs).
# Stop with scripts/lab/stop <lab> [--purge] (drive.ts stops the devserver itself at its end).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
run="$repo/scripts/lab/run"
hostd="$repo/target/shared/debug/tf-hostd"
devserver="$repo/target/shared/debug/tf-devserver"
omp="${HOME:-/root}/.local/bin/omp"
chrome=""
ui=0
vite=0
fresh=0
usage() { sed -n '2,41p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --hostd) hostd="$2"; shift 2 ;;
    --devserver) devserver="$2"; shift 2 ;;
    --omp) omp="$2"; shift 2 ;;
    --chrome) chrome="$2"; shift 2 ;;
    --ui) ui=1; shift ;;
    --vite) vite=1; shift ;;
    --fresh) fresh=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "setup: unknown option $1" >&2; exit 64 ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || { usage >&2; exit 64; }
[ "$ui" = 1 ] && [ "$vite" = 1 ] && { echo "setup: --ui or --vite, not both" >&2; exit 64; }
lab="$1"
[[ "$lab" =~ ^brw-[a-z0-9-]+$ ]] || { echo "setup: lab names start with brw- ([a-z0-9-])" >&2; exit 64; }
[ "${#lab}" -le 18 ] || { echo "setup: lab name $lab is too long for herdr's socket path (18 characters at most)" >&2; exit 64; }
hostd="$(readlink -f "$hostd")"
devserver="$(readlink -f "$devserver")"
omp="$(readlink -f "$omp")"
[ -x "$hostd" ] || { echo "setup: no tf-hostd at $hostd" >&2; exit 66; }
[ -x "$devserver" ] || { echo "setup: no tf-devserver at $devserver" >&2; exit 66; }
[ -x "$omp" ] || { echo "setup: no omp at $omp" >&2; exit 66; }
if [ -n "$chrome" ]; then
  chrome="$(readlink -f "$chrome")"
  [ -x "$chrome" ] || { echo "setup: no browser at $chrome" >&2; exit 66; }
fi

root="/tmp/tf-lab-$lab"
session="tf-lab-$lab"
mock_port=18783
dev_port=7463
vite_port=1472
relay=47783
token="browser-lab-token-0123456789"
if [ "$fresh" = 1 ]; then "$repo/scripts/lab/stop" "$lab" --purge >/dev/null; fi

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$mock_port" "$dev_port" "$relay"; do
  port_busy "$p" && { echo "setup: 127.0.0.1:$p is taken; stop whatever holds it first" >&2; exit 69; }
done
if [ "$vite" = 1 ] && port_busy "$vite_port"; then echo "setup: 127.0.0.1:$vite_port is taken" >&2; exit 69; fi

# Pinned copies. The omp copy comes first on the PATH of the lab's login shells (tf-hostd reads PATH
# from one) and of herdr's panes; scripts/lab/run writes .profile / .bashrc only when they are missing.
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
work="$home/src/site"
mkdir -p "$agent" "$logs" "$data"
cp "$here/models.yml" "$here/config.yml" "$agent/"
printf '{"profiles":[{"id":"lab","name":"Lab","kind":"local","herdrSession":"%s","autoConnect":true,"relayPort":%s}]}\n' "$session" "$relay" >"$data/hosts.json"

if [ ! -d "$work/.git" ]; then
  mkdir -p "$work"
  printf '# Site\n\nThe browser lab agents start here.\n' >"$work/README.md"
  TF_LAB_CWD="$work" "$run" "$lab" -- sh -c 'git init -q -b main && git add -A && git -c user.name=lab -c user.email=lab@example.invalid commit -qm site' >"$logs/repo.log" 2>&1
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

# --ui: the UI as the app ships it, built once from this worktree and served by the devserver itself
# (same origin, so neither /ws nor the browser's DevTools need another allowed origin).
serve=()
if [ "$ui" = 1 ]; then
  echo "setup: building the UI into $root/ui (vite build, about a minute)"
  (cd "$repo" && bunx vite build --outDir "$root/ui" --emptyOutDir) >"$logs/ui-build.log" 2>&1 ||
    { echo "setup: vite build failed (see $logs/ui-build.log)" >&2; exit 1; }
  serve=(--static "$root/ui")
fi
[ "$vite" = 1 ] && serve=(--allow-origin "http://127.0.0.1:$vite_port")
start devserver "$logs/devserver.log" env RUST_LOG="info,tf_client=debug" \
  "$devserver" --bind "127.0.0.1:$dev_port" --data-dir "$data" --hostd-bin "$hostd" --token "$token" ${serve[@]+"${serve[@]}"}
wait_for "tf-devserver (127.0.0.1:$dev_port)" 30 port_busy "$dev_port"

url=""
[ "$ui" = 1 ] && url="http://127.0.0.1:$dev_port/"
if [ "$vite" = 1 ]; then
  TF_LAB_CWD="$repo" start vite "$logs/vite.log" bunx vite --host 127.0.0.1 --port "$vite_port" --strictPort
  wait_for "vite (127.0.0.1:$vite_port)" 60 port_busy "$vite_port"
  url="http://127.0.0.1:$vite_port/?core=ws://127.0.0.1:$dev_port/ws&token=$token"
fi

cat >"$root/lab.env" <<EOF
LAB=$lab
ROOT=$root
HOME_DIR=$home
SESSION=$session
HOSTD=$hostd
HOSTD_HOME=$root/teleflock
OMP=$omp
OMP_AGENT=$agent
WORK=$work
LOGS=$logs
DATA=$data
PROFILE=$data/browser/profile
CHROME=$chrome
ORIGIN=http://127.0.0.1:$dev_port
WS=ws://127.0.0.1:$dev_port/ws?token=$token
DEVSERVER_PID=$(cat "$logs/devserver.pid")
URL=$url
EOF
echo "lab $lab ready ($("$hostd" --version); $("$omp" --version))"
printf '  %-9s %s\n' \
  herdr "pid $(cat "$logs/herdr.pid"), session $session, log $logs/herdr.log" \
  mock "pid $(cat "$logs/mock.pid"), model 127.0.0.1:$mock_port (log $logs/mock.log)" \
  devserver "pid $(cat "$logs/devserver.pid"), 127.0.0.1:$dev_port, data $data, log $logs/devserver.log" \
  hostd "$root/teleflock (hostd.log)" \
  omp "$omp, agent dir $agent (models.yml, config.yml, sessions/)" \
  browser "${chrome:-Chrome for Testing, downloaded by drive.ts into $data/browser/engine}" \
  work "$work"
[ -n "$url" ] && echo "page:  $url"
echo "drive: bun scripts/lab/browser/drive.ts $lab"
echo "stop:  scripts/lab/stop $lab"
