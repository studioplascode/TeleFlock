#!/usr/bin/env bash
# Reproduce the TeleFlock collab-guest proof end to end in an ISOLATED herdr lab session.
# Never touches the default herdr session or ~/.omp/agent/config.yml.
#
#   .research/poc/run-e2e.sh            # setup + all scenarios
#   .research/poc/run-e2e.sh setup      # lab session, relay, omp host, guest only
#   .research/poc/run-e2e.sh scenarios  # scenarios against an existing setup
#   .research/poc/run-e2e.sh teardown   # stop guest/relay and the lab session
#
# Env: TF_LAB_SESSION (tf-lab-collab), TF_RELAY_PORT (7466), TF_GUEST_PORT (7467),
#      TF_MODEL (openai-codex/gpt-6-luna:low — the `tiny` role on this host).
set -euo pipefail
POC="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$POC/../.." && pwd)"
export TF_LAB_SESSION="${TF_LAB_SESSION:-tf-lab-collab}"
RELAY_PORT="${TF_RELAY_PORT:-7466}"
GUEST_PORT="${TF_GUEST_PORT:-7467}"
MODEL="${TF_MODEL:-openai-codex/gpt-6-luna:low}"
WORK=/tmp/tf-collab-work
RUN=/tmp/tf-collab-run
HL="$POC/hl"
export TF_GUEST="http://127.0.0.1:$GUEST_PORT" TF_AGENT=collabhost

setup() {
	mkdir -p "$WORK" "$RUN"
	printf 'alpha\nbeta\ngamma\n' >"$WORK/notes.txt"
	# 1. lab herdr server (detached; --session is mandatory on every call, see hl)
	if ! "$HL" status server --json 2>/dev/null | grep -q '"running":true'; then
		(cd ~ && setsid -f env -u HERDR_SOCKET_PATH -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
			herdr --session "$TF_LAB_SESSION" server </dev/null >"$RUN/herdr.out" 2>&1)
		sleep 2
	fi
	# 2. relay on loopback
	setsid -f bun "$POC/relay.ts" --port "$RELAY_PORT" </dev/null >"$RUN/relay.out" 2>"$RUN/relay.log"
	sleep 1
	# 3. omp TUI in a lab pane, sharing through the relay via a per-process overlay
	sed "s#ws://127.0.0.1:7466#ws://127.0.0.1:$RELAY_PORT#" "$POC/collab-overlay.yml" >"$RUN/overlay.yml"
	local pane
	pane=$("$HL" workspace create --cwd "$WORK" --label collab --no-focus | bun -e \
		'console.log(JSON.parse(await Bun.stdin.text()).result.root_pane.pane_id)')
	"$HL" agent start collabhost --kind omp --pane "$pane" --timeout 60000 -- \
		--config "$RUN/overlay.yml" --model "$MODEL" >/dev/null
	# 4. discover the room through the local registry (no link ever printed to the pane)
	local id=""
	for _ in $(seq 1 30); do
		id=$(omp collab list --json | bun -e \
			'const h=JSON.parse(await Bun.stdin.text()).hosts.filter(h=>h.cwd===process.argv[1]&&h.relayConnected).at(-1); console.log(h?.instanceId??"")' "$WORK")
		[ -n "$id" ] && break
		sleep 1
	done
	[ -n "$id" ] || { echo "omp host never published to the registry" >&2; exit 1; }
	echo "$id" >"$RUN/instance"
	# 5. PoC guest (WebCrypto) joins as full-control guest
	setsid -f bun "$POC/guest.ts" --instance "$id" --control "$GUEST_PORT" --out "$RUN/frames.jsonl" \
		</dev/null >"$RUN/guest.out" 2>&1
	sleep 2
	curl -sf "$TF_GUEST/state" >/dev/null && echo "guest joined instance $id"
}

scenarios() {
	cd "$REPO"
	local s="bun $POC/scenario.ts"
	$s 01-prompt-text '{"t":"prompt","text":"Think briefly, then reply with exactly: pong"}'
	$s 02-bash-tool '{"t":"prompt","text":"Use the bash tool to run: echo hello-from-collab && uname -s. Then reply done."}'
	$s 03-edit-tool '{"t":"prompt","text":"Edit notes.txt: replace the line beta with BETA-EDITED using your edit tool. Do not read other files. Reply done."}'
	$s 04-todo '{"t":"prompt","text":"Use your todo tool to create a todo list with three items: plan, build, ship. Mark plan as in progress. Then reply ok. Do nothing else."}'
	$s 05-ask-ui-response '{"t":"prompt","text":"Use the ask tool to ask me one question: which color do I prefer, with options red and blue. Then reply with my answer in one word."}' \
		--answer '{"value":"Blue"}' --answer-delay-ms 6000
	$s 06-abort '{"t":"prompt","text":"Write the numbers from 1 to 400 in English words, one per line. No tools."}' --abort-after-ms 1500
	$s 07-task-subagent '{"t":"prompt","text":"Use the task tool to spawn exactly one subagent whose assignment is: reply with the single word ok and do nothing else. Then reply done."}' --timeout 240 --settle 3000
	# keystroke injection: TUI-only command through herdr; the guest observes the state change
	$s 10-injected-switch-thinking --no-send --timeout 12 &
	sleep 1
	"$HL" agent prompt collabhost "/switch :medium" >/dev/null
	sleep 1
	# the autocomplete popup swallows the first Enter for slash commands with args
	"$HL" agent send-keys collabhost enter >/dev/null
	wait
	curl -s "$TF_GUEST/rtt?n=50"
	echo
}

teardown() {
	pkill -f "$POC/guest.ts" || true
	pkill -f "$POC/relay.ts" || true
	env -u HERDR_SOCKET_PATH herdr session stop "$TF_LAB_SESSION" --json || true
	# herdr persists and restores panes (it relaunches omp as `omp --resume=<file>` WITHOUT our
	# --config overlay), so delete the stopped session for a clean replay.
	sleep 1
	env -u HERDR_SOCKET_PATH herdr session delete "$TF_LAB_SESSION" --json || true
}

case "${1:-all}" in
setup) setup ;;
scenarios) scenarios ;;
teardown) teardown ;;
all) setup && scenarios ;;
*) echo "usage: $0 [setup|scenarios|teardown|all]" >&2; exit 2 ;;
esac
