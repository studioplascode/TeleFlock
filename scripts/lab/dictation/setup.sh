#!/usr/bin/env bash
# Dictation lab: on-device dictation end to end, inside scripts/lab/run <lab>: a lab herdr server, the
# Rambler lab's mock model provider (scripts/lab/rambler: lab-tiny / lab-smol / lab-big behind omp's tiny /
# smol / default roles), tf-devserver built with `--features voice` (the app core with tf-dictation)
# listening to a fake microphone, the lab's tf-hostd as a local host, optionally a local Hugging Face
# mirror for model downloads (mirror.ts) and the UI.
#
# Usage: scripts/lab/dictation/setup.sh [options] <lab>
#   <lab>            dict[a-z0-9-]* (≤ 18 characters: herdr's socket path must fit sun_path)
#   --mic FILES      the 16 kHz WAV files the fake microphone plays, one per capture in turn, joined
#                    with `:`, each with its transcript next to it (<name>.txt) for drive.ts
#                    (default target/shared-voice/samples/dictation/session-{en,de}.wav)
#   --models DIR     sherpa-onnx release directories named after their Hugging Face repositories
#                    (sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/, …): --install copies from them and
#                    the mirror serves them, so Settings → Dictation downloads from 127.0.0.1
#                    (TF_DICTATION_MIRROR). Without it models come from Hugging Face.
#   --install IDS    install these models (comma-separated catalog ids) before the devserver starts,
#                    with `cargo run -p tf-dictation --example install`; the last one is chosen
#                    (default canary-180m-flash,parakeet-tdt-0.6b-v3; `none`: none)
#   --hostd BIN      the tf-hostd the devserver deploys (default target/shared/debug/tf-hostd)
#   --devserver BIN  a tf-devserver built with --features voice (default target/shared/debug/tf-devserver)
#   --rate MB/S      the mirror's speed (default 25), slow enough to watch a download's progress
#   --ui             build the UI once from this worktree (vite build into <root>/ui, about a minute)
#                    and serve it from the devserver: http://127.0.0.1:7469/
#   --vite           the UI from `vite dev` on 127.0.0.1:1469 instead; its hot reloads (any edit
#                    under src/) reload the page, which ends a dictation session
#   --fresh          stop the lab and delete /tmp/tf-lab-<lab> first
#
# Starts herdr (session tf-lab-<lab>), the mock (127.0.0.1:18789), with --models the mirror
# (127.0.0.1:18790), tf-devserver (127.0.0.1:7469, data <root>/devserver: hosts.json with one `local`
# host `lab` on relay port 47789; TF_DICTATION_FAKE_MIC) and the UI. Agents start in the work folder
# <lab home>/src/notes (a git repo). /tmp/tf-lab-<lab>/lab.env has every path.
#
# Then: bun scripts/lab/dictation/drive.ts <lab> (the scripted checks over the devserver's /ws).
# Logs: /tmp/tf-lab-<lab>/logs (devserver.log with tf_dictation at debug, mirror.log, mock.log, …).
# Stop with scripts/lab/stop <lab> [--purge].
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
run="$repo/scripts/lab/run"
rambler="$repo/scripts/lab/rambler"
hostd="$repo/target/shared/debug/tf-hostd"
devserver="$repo/target/shared/debug/tf-devserver"
samples="$repo/target/shared-voice/samples/dictation"
mic="$samples/session-en.wav:$samples/session-de.wav"
models=""
install="canary-180m-flash,parakeet-tdt-0.6b-v3"
rate=25
ui=0
vite=0
fresh=0
usage() { sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --mic) mic="$2"; shift 2 ;;
    --models) models="$2"; shift 2 ;;
    --install) install="$2"; shift 2 ;;
    --hostd) hostd="$2"; shift 2 ;;
    --devserver) devserver="$2"; shift 2 ;;
    --rate) rate="$2"; shift 2 ;;
    --ui) ui=1; shift ;;
    --vite) vite=1; shift ;;
    --fresh) fresh=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "setup: unknown option $1" >&2; exit 64 ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || { usage >&2; exit 64; }
lab="$1"
[[ "$lab" =~ ^dict[a-z0-9-]*$ ]] || { echo "setup: lab names start with dict ([a-z0-9-])" >&2; exit 64; }
[ "${#lab}" -le 18 ] || { echo "setup: lab name $lab is too long for herdr's socket path (18 characters at most)" >&2; exit 64; }
[ "$ui" = 1 ] && [ "$vite" = 1 ] && { echo "setup: --ui or --vite, not both" >&2; exit 64; }
hostd="$(readlink -f "$hostd")"
devserver="$(readlink -f "$devserver")"
[ -x "$hostd" ] || { echo "setup: no tf-hostd at $hostd" >&2; exit 66; }
[ -x "$devserver" ] || { echo "setup: no tf-devserver at $devserver" >&2; exit 66; }
# Only debug builds with tf-dictation play a fake microphone (and log this line when they do).
grep -aq 'fake microphone plays' "$devserver" || { echo "setup: $devserver has no fake microphone: build it with cargo build -p tf-devserver --features voice (debug)" >&2; exit 66; }
IFS=: read -r -a mic_files <<<"$mic"
for f in "${mic_files[@]}"; do [ -f "$f" ] || { echo "setup: no microphone sample $f (--mic)" >&2; exit 66; }; done
if [ -n "$models" ]; then
  models="$(readlink -f "$models")"
  [ -d "$models" ] || { echo "setup: no model directory $models" >&2; exit 66; }
fi

root="/tmp/tf-lab-$lab"
session="tf-lab-$lab"
mock_port=18789
mirror_port=18790
dev_port=7469
vite_port=1469
relay=47789
token="dictation-lab-token-0123456789"
if [ "$fresh" = 1 ]; then "$repo/scripts/lab/stop" "$lab" --purge >/dev/null; fi

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$mock_port" "$dev_port" "$relay"; do
  port_busy "$p" && { echo "setup: 127.0.0.1:$p is taken; stop whatever holds it first" >&2; exit 69; }
done
if [ -n "$models" ] && port_busy "$mirror_port"; then echo "setup: 127.0.0.1:$mirror_port is taken" >&2; exit 69; fi
if [ "$vite" = 1 ] && port_busy "$vite_port"; then echo "setup: 127.0.0.1:$vite_port is taken" >&2; exit 69; fi

"$run" "$lab" -- true # creates the lab's directories
home="$root/home"
agent="$root/omp-agent"
logs="$root/logs"
data="$root/devserver"
work="$home/src/notes"
mkdir -p "$agent" "$logs" "$data"
cp "$rambler/config.yml" "$agent/"
sed "s#127.0.0.1:18781#127.0.0.1:$mock_port#" "$rambler/models.yml" >"$agent/models.yml"
printf '{"profiles":[{"id":"lab","name":"Lab","kind":"local","herdrSession":"%s","autoConnect":true,"relayPort":%s}]}\n' "$session" "$relay" >"$data/hosts.json"

if [ ! -d "$work/.git" ]; then
  mkdir -p "$work"
  printf '# Notes\n\nThe dictation lab agents start here.\n' >"$work/README.md"
  TF_LAB_CWD="$work" "$run" "$lab" -- sh -c 'git init -q -b main && git add -A && git -c user.name=lab -c user.email=lab@example.invalid commit -qm notes' >"$logs/repo.log" 2>&1
fi

# Models as Settings → Dictation leaves them (every file checked against the catalog's sha256).
if [ "$install" != none ]; then
  from=()
  [ -n "$models" ] && from=(--from "$models")
  IFS=, read -r -a ids <<<"$install"
  for id in "${ids[@]}"; do
    (cd "$repo" && CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$repo/target/shared}" CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-0}" \
      cargo run -q -p tf-dictation --example install -- --data-dir "$data" --model "$id" ${from[@]+"${from[@]}"})
  done
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

start mock "$logs/mock.out" env "MOCK_PORT=$mock_port" "MOCK_LOG=$logs/mock.log" bun "$rambler/mock.ts"
wait_for "mock (127.0.0.1:$mock_port)" 20 port_busy "$mock_port"

mirror=""
if [ -n "$models" ]; then
  start mirror "$logs/mirror.out" env "MIRROR_RATE=$rate" "MIRROR_LOG=$logs/mirror.log" bun "$here/mirror.ts" "$models" "$mirror_port"
  wait_for "mirror (127.0.0.1:$mirror_port)" 20 port_busy "$mirror_port"
  mirror="http://127.0.0.1:$mirror_port"
fi

# --ui: the UI as the app ships it, built once from this worktree and served by the devserver itself
# (same origin, no allowed origin needed, no hot reloads ending a session).
serve=()
if [ "$ui" = 1 ]; then
  echo "setup: building the UI into $root/ui (vite build, about a minute)"
  (cd "$repo" && bunx vite build --outDir "$root/ui" --emptyOutDir) >"$logs/ui-build.log" 2>&1 ||
    { echo "setup: vite build failed (see $logs/ui-build.log)" >&2; exit 1; }
  serve=(--static "$root/ui")
fi
[ "$vite" = 1 ] && serve=(--allow-origin "http://127.0.0.1:$vite_port")
dev_env=(RUST_LOG="info,tf_client=debug,tf_dictation=debug" "TF_DICTATION_FAKE_MIC=$mic")
[ -n "$mirror" ] && dev_env+=("TF_DICTATION_MIRROR=$mirror")
start devserver "$logs/devserver.log" env "${dev_env[@]}" \
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
OMP_AGENT=$agent
WORK=$work
LOGS=$logs
DATA=$data
MODELS=$models
MIC=$mic
MIRROR=$mirror
ORIGIN=http://127.0.0.1:$dev_port
WS=ws://127.0.0.1:$dev_port/ws?token=$token
DEVSERVER_PID=$(cat "$logs/devserver.pid")
URL=$url
EOF
mirror_info="none: downloads come from Hugging Face"
[ -n "$mirror" ] && mirror_info="$mirror at $rate MB/s from $models (log $logs/mirror.log)"
echo "lab $lab ready ($("$hostd" --version))"
printf '  %-10s %s\n' \
  herdr "pid $(cat "$logs/herdr.pid"), session $session, log $logs/herdr.log" \
  mock "pid $(cat "$logs/mock.pid"), models 127.0.0.1:$mock_port (log $logs/mock.log)" \
  mirror "$mirror_info" \
  devserver "pid $(cat "$logs/devserver.pid"), 127.0.0.1:$dev_port, data $data, log $logs/devserver.log" \
  microphone "$mic" \
  models "$(ls "$data/dictation/models" 2>/dev/null | tr '\n' ' ')" \
  hostd "$root/teleflock (hostd.log)" \
  omp "$agent (models.yml, config.yml, sessions/)" \
  work "$work"
[ -n "$url" ] && echo "page:  $url"
echo "drive: bun scripts/lab/dictation/drive.ts $lab"
echo "stop:  scripts/lab/stop $lab"
