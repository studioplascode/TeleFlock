#!/usr/bin/env bash
# ChatStall lab setup: everything the freeze reproduction needs, inside scripts/lab/run <lab>.
#
# Usage: scripts/lab/chatstall/setup.sh [--hostd BIN] [--hostd-env K=V]… [--fresh] <lab> <relay-port> [bridge-file]
#   <lab>          chatstall-<name>; the herdr session is tf-lab-<lab>, the lab lives in /tmp/tf-lab-<lab>
#   <relay-port>   loopback port of the lab tf-hostd's collab relay
#   [bridge-file]  deployed as <TF_HOSTD_HOME>/ext/teleflock-bridge.ts (default: the working tree's
#                  host/teleflock-bridge/teleflock-bridge.ts)
#   --hostd BIN    the tf-hostd to run (default target/ChatStall/debug/tf-hostd), so a HEAD build
#                  ('before') and the working tree ('after') can be compared
#   --hostd-env K=V  extra environment for the daemon (e.g. TF_HOSTD_LAB_FREEZE=toolcall_delta,
#                  TF_HOSTD_LOG=debug); repeatable
#   --fresh        stop the lab and delete /tmp/tf-lab-<lab> first
#
# Prepares: TF_HOSTD_HOME (omp-overlay.yml: collab autoStart control on ws://127.0.0.1:<relay-port>;
# ext/teleflock-bridge.ts), the omp agent dir (models.yml, config.yml: every role on the mock, yolo,
# no wizard or update checks), a work dir with a small git repo the scripted grep/read calls hit.
# Starts: the lab's herdr server (session tf-lab-<lab>), the mock provider (mock.ts, 127.0.0.1:18761)
# and `tf-hostd daemon`. Writes /tmp/tf-lab-<lab>/lab.env for observe.ts. Logs: /tmp/tf-lab-<lab>/logs.
# Stop with scripts/lab/stop <lab> (keeps the logs; --purge deletes them).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
run="$repo/scripts/lab/run"
hostd="$repo/target/ChatStall/debug/tf-hostd"
hostd_env=()
fresh=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hostd) hostd="$2"; shift 2 ;;
    --hostd-env) hostd_env+=("$2"); shift 2 ;;
    --fresh) fresh=1; shift ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "setup: unknown option $1" >&2; exit 64 ;;
    *) break ;;
  esac
done
[ $# -ge 2 ] || { sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
lab="$1"
relay="$2"
bridge="${3:-$repo/host/teleflock-bridge/teleflock-bridge.ts}"
[[ "$lab" =~ ^chatstall-[a-z0-9-]+$ ]] || { echo "setup: lab names start with chatstall- ([a-z0-9-])" >&2; exit 64; }
# herdr's socket, /tmp/tf-lab-<lab>/xdg/config/herdr/sessions/tf-lab-<lab>/…, must fit sun_path.
[ "${#lab}" -le 18 ] || { echo "setup: lab name $lab is too long for herdr's socket path (18 characters at most)" >&2; exit 64; }
[[ "$relay" =~ ^[0-9]+$ ]] || { echo "setup: bad relay port $relay" >&2; exit 64; }
hostd="$(readlink -f "$hostd")"
bridge="$(readlink -f "$bridge")"
[ -x "$hostd" ] || { echo "setup: no tf-hostd at $hostd" >&2; exit 66; }
[ -f "$bridge" ] || { echo "setup: no bridge at $bridge" >&2; exit 66; }
for kv in "${hostd_env[@]}"; do [[ "$kv" =~ ^[A-Z_][A-Z0-9_]*= ]] || { echo "setup: bad --hostd-env $kv" >&2; exit 64; }; done

root="/tmp/tf-lab-$lab"
session="tf-lab-$lab"
mock_port=18761
if [ "$fresh" = 1 ]; then "$repo/scripts/lab/stop" "$lab" --purge >/dev/null; fi

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
port_busy "$mock_port" && { echo "setup: 127.0.0.1:$mock_port is taken (another lab's mock?); stop that lab first" >&2; exit 69; }
port_busy "$relay" && { echo "setup: relay port $relay is taken" >&2; exit 69; }
[ -e "$root/teleflock/run/hostd.sock" ] && "$run" "$lab" -- "$hostd" --relay-port "$relay" stop >/dev/null 2>&1 || true

"$run" "$lab" -- true # creates the lab's directories
home="$root/teleflock"
agent="$root/omp-agent"
work="$root/work"
logs="$root/logs"
mkdir -p "$home/ext" "$agent" "$logs"

# TF_HOSTD_HOME: the collab overlay and the bridge every agent.start loads (`--config … -e …`).
printf 'collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:%s\n  displayName: %s\n' "$relay" "$session" >"$home/omp-overlay.yml"
cp "$bridge" "$home/ext/teleflock-bridge.ts"

# omp agent dir.
cp "$here/models.yml" "$here/config.yml" "$agent/"

# Work dir: the files the scripted grep (pattern of the screenshot) and read calls hit.
rm -rf "$work"
mkdir -p "$work/src" "$work/app"
cat >"$work/src/transport.ts" <<'EOF'
// Which way a request to DATEV takes.
export type Transport = "connector" | "direct";

export function kind(settings: { transport?: string }): Transport {
	return settings.transport === "connector" ? "connector" : "direct";
}

export function transport(settings: { transport?: string }): Transport {
	return kind(settings);
}
EOF
cat >"$work/src/platform.ts" <<'EOF'
export function isDesktop(): boolean {
	return typeof window !== "undefined" && "__TAURI__" in window;
}

export async function online(statusUrl: string): Promise<boolean> {
	try {
		const res = await fetch(statusUrl, { signal: AbortSignal.timeout(1500) });
		return res.ok;
	} catch {
		return false;
	}
}
EOF
cat >"$work/src/DatevRouter.ts" <<'EOF'
import { isDesktop, online } from "./platform";
import { transport } from "./transport";

/** Decides whether a request goes through the local connector or straight to DATEV. */
export class DatevRouter {
	constructor(
		private readonly settings: { transport?: string },
		private readonly connectorUrl = "http://127.0.0.1:58454",
		private readonly datevUrl = "https://api.datev.de",
	) {}

	async route(path: string): Promise<string> {
		if (!isDesktop()) return `${this.datevUrl}${path}`;
		if (await online(`${this.connectorUrl}/status`)) return `${this.connectorUrl}${path}`;
		return transport(this.settings) === "connector" ? `${this.connectorUrl}${path}` : `${this.datevUrl}${path}`;
	}
}
EOF
cat >"$work/app/Kind.swift" <<'EOF'
enum TransportKind: String {
    case connector = "connector"
    case direct = "direct"
}
EOF
cat >"$work/app/connector.js" <<'EOF'
// Builds the request the desktop shell sends through the connector.
function viaConnector(path, body) {
	return { url: `http://127.0.0.1:58454${path}`, method: "POST", body: JSON.stringify(body) };
}

function desktop() {
	return typeof window !== "undefined";
}

module.exports = { viaConnector, desktop };
EOF
printf '# ChatStall lab repo\n\nA tiny project for the scripted grep/read turn.\n' >"$work/README.md"
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
"$run" "$lab" -- herdr --session "$session" integration install omp >"$logs/herdr-integration.log" 2>&1 || echo "setup: herdr integration install omp failed (see $logs/herdr-integration.log)" >&2

start mock "$logs/mock.out" env "MOCK_LOG=$logs/mock.log" bun "$here/mock.ts"
wait_for "mock (127.0.0.1:$mock_port)" 20 port_busy "$mock_port"

start hostd "$logs/hostd.stderr" env "${hostd_env[@]}" "$hostd" --relay-port "$relay" daemon
wait_for "tf-hostd daemon" 30 test -S "$home/run/hostd.sock"

cat >"$root/lab.env" <<EOF
LAB=$lab
ROOT=$root
SESSION=$session
RELAY_PORT=$relay
HOSTD=$hostd
HOSTD_ENV="${hostd_env[*]}"
HOSTD_HOME=$home
OMP_AGENT=$agent
WORK=$work
LOGS=$logs
BRIDGE=$bridge
MOCK_PORT=$mock_port
HERDR_PID=$(cat "$logs/herdr.pid")
MOCK_PID=$(cat "$logs/mock.pid")
HOSTD_PID=$(cat "$logs/hostd.pid")
EOF

echo "lab $lab ready ($("$hostd" --version), bridge $(grep -m1 -o 'BRIDGE_VERSION = "[^"]*"' "$home/ext/teleflock-bridge.ts" || echo '?'))"
printf '  %-8s %s\n' \
  herdr "pid $(cat "$logs/herdr.pid"), session $session, log $logs/herdr.log" \
  mock "pid $(cat "$logs/mock.pid"), 127.0.0.1:$mock_port, log $logs/mock.log" \
  hostd "pid $(cat "$logs/hostd.pid"), $hostd --relay-port $relay daemon${hostd_env:+ (env: ${hostd_env[*]})}" \
  home "$home (hostd.log, omp-overlay.yml, ext/teleflock-bridge.ts ← $bridge)" \
  omp "$agent (models.yml, config.yml, sessions/)" \
  work "$work" \
  env "$root/lab.env"
echo "observe: scripts/lab/run $lab -- bun $here/observe.ts --lab-env $root/lab.env"
echo "stop:    scripts/lab/stop $lab"
