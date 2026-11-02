#!/usr/bin/env bash
# The macOS login item of tf-hostd ("Bring agents back after a reboot"), checked on a real Mac: the
# GitHub macOS runner of .github/workflows/login-items.yml. No real `launchctl` had run against it
# before; this does, and a failed check says which one and why.
#
# The runner is a disposable VM, so the real home (~/.teleflock) is used: it is the one home that
# installs a login item (automations/boot.rs allows no other). The script therefore refuses to run
# anywhere but a GitHub runner, and where ~/.teleflock already has files in it.
#
#   deploy  the built tf-hostd goes to ~/.teleflock/bin/tf-hostd, where the app puts it.
#   seed    ledger.json gets one agent that a reboot ended. A fresh home has no agents and no
#           automations, and then nothing is installed (there is nothing to bring back); this is the
#           entry a real agent leaves behind. herdr is not installed on the runner: nothing is relaunched.
#   (a)     `tf-hostd attach` (what the app runs) starts the daemon and, with no setting touched, the
#           launchd agent appears: its plist in ~/Library/LaunchAgents, `launchctl print gui/<uid>/<label>`
#           loaded, the plist says what automations/launchd.rs promises, host.autoResume says installed.
#   (b)     the daemon is killed by PID (checked) and stays down; `launchctl kickstart -k` brings it back
#           within 60 s. Then the same after `bootout` + `bootstrap`, which is what a login does to a
#           RunAtLoad agent: the closest thing to a reboot a CI job can do.
#   (d)     host.autoResumeSet {bringBack:false} (Settings → Auto-resume) removes the agent and its file.
#   (e)     host.autoResumeSet {bringBack:true} installs it again, and the new agent starts the daemon too.
#   (f)     logs: everything in $LOGIN_ITEMS_LOGS (default $RUNNER_TEMP/login-items-logs), whatever happens.
#
# Not proved: that macOS runs the agent at a real login or reboot (RunAtLoad is exercised through
# bootstrap), that nobody is asked to approve it (System Settings → Login Items), what an older macOS
# does. A GitHub macOS runner is whichever macOS version it is today (sw_vers is in the log).
#
# Usage: scripts/ci/login-items-macos.sh [built tf-hostd]   (default $TF_HOSTD_BIN, else target/release/tf-hostd)
# Env:   LOGIN_ITEMS_LOGS  log folder; LOGIN_ITEMS_WAIT  seconds one wait may take (60);
#        LOGIN_ITEMS_ON_DISPOSABLE_HOST=1  allows it outside a GitHub-hosted runner (it replaces what is
#        under ~/.teleflock, and removes its login item).
# Exit:  0 every check passed, 1 a check failed, 64 refused to run here.

set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WIRE="$HERE/hostd-wire.py"
SRC="${1:-${TF_HOSTD_BIN:-target/release/tf-hostd}}"
LOGS="${LOGIN_ITEMS_LOGS:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/login-items-logs}"
WAIT="${LOGIN_ITEMS_WAIT:-60}"
# Only the default home installs a login item (automations/boot.rs): a TF_HOSTD_HOME in the
# environment would make the daemon and `attach` use another home and install none.
unset TF_HOSTD_HOME
HOME_DIR="$HOME/.teleflock"
BIN="$HOME_DIR/bin/tf-hostd"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
GUI="gui/$(id -u)"
LABEL=""
PLIST=""
HAS_GUI=1 # set from what launchctl says about the GUI domain (describe_machine)

# ── output ──────────────────────────────────────────────────────────────────────────────────────
on_actions() { [ "${GITHUB_ACTIONS:-}" = true ]; }
group() { if on_actions; then echo "::group::$*"; else echo "== $*"; fi; }
endgroup() { if on_actions; then echo "::endgroup::"; fi; return 0; }
# One line that is safe in a workflow command message (the runner unescapes `%`, CR and LF) / property.
oneline() { printf '%s' "$*" | tr '\r\n' '  ' | sed 's/%/%25/g' | cut -c1-600; }
prop() { printf '%s' "$*" | tr -d ':,\r\n' | cut -c1-100; }

RESULTS=() # "pass|text" or "FAIL|text", in the order the checks ran
NFAIL=0
FACTS=()
pass() { RESULTS+=("pass|$1"); printf 'PASS  %s\n' "$1"; }
fail() {
  RESULTS+=("FAIL|$1 — $2")
  NFAIL=$((NFAIL + 1))
  printf 'FAIL  %s — %s\n' "$1" "$2"
  if on_actions; then printf '::error title=login item %s::%s\n' "$(prop "$1")" "$(oneline "$2")"; fi
  if [ -f "$HOME_DIR/hostd.log" ]; then
    echo "--- the end of hostd.log"
    tail -n 15 "$HOME_DIR/hostd.log" | cut -c1-300
    echo "---"
  fi
}
fact() { FACTS+=("$1"); printf 'info  %s\n' "$1"; }
# A file name from a check's name.
slug() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/--*/-/g; s/^-//; s/-$//'; }

# snap NAME command…: the command's output and exit status go to $LOGS/NAME.txt; its head to the log.
snap() {
  local name=$1
  shift
  { printf '$ %s\n' "$*"; "$@" 2>&1; printf '[exit %s]\n' "$?"; } > "$LOGS/$name.txt" 2>&1
  sed -n '1,25p' "$LOGS/$name.txt"
}

# wait_until SECONDS command…: runs the command once a second until it succeeds. WAITED = seconds spent.
WAITED=0
wait_until() {
  local limit=$1 start=$SECONDS
  shift
  while true; do
    if "$@"; then WAITED=$((SECONDS - start)); return 0; fi
    WAITED=$((SECONDS - start))
    if [ "$WAITED" -ge "$limit" ]; then return 1; fi
    sleep 1
  done
}

# with_timeout SECONDS command…: macOS has no timeout(1).
with_timeout() {
  local limit=$1 n=0 pid
  shift
  "$@" &
  pid=$!
  while kill -0 "$pid" 2> /dev/null; do
    if [ "$n" -ge "$limit" ]; then
      kill -TERM "$pid" 2> /dev/null
      sleep 1
      kill -KILL "$pid" 2> /dev/null
      break
    fi
    sleep 1
    n=$((n + 1))
  done
  wait "$pid" 2> /dev/null
}

# fnv1a TEXT: how automations name an item after a home (paths.rs `home_hash`): FNV-1a, 32 bits, over the bytes.
fnv1a() {
  local s=$1 h=2166136261 i c
  local LC_ALL=C
  for ((i = 0; i < ${#s}; i++)); do
    printf -v c '%d' "'${s:i:1}"
    h=$(((h ^ c) * 16777619 & 0xFFFFFFFF))
  done
  printf '%08x' "$h"
}

# ── the daemon ──────────────────────────────────────────────────────────────────────────────────
# The pids of this home's daemons (`<home>/bin/tf-hostd daemon …`). Reads the process table only: it
# never asks (and so never starts) a daemon.
daemon_pids() { ps -axww -o pid= -o command= | awk -v bin="$BIN" '$2 == bin && $3 == "daemon" { print $1 }'; }
daemon_gone() { ! kill -0 "$OLD_PID" 2> /dev/null; }

# call METHOD [PARAMS-JSON]: one request through `tf-hostd attach`; CALL = the reply message. attach
# starts a daemon when none runs, so this is only used where one is expected to.
CALL=""
call() {
  CALL=$(python3 "$WIRE" "$BIN" --timeout 90 call "$@" 2>> "$LOGS/wire.stderr.txt")
  local rc=$?
  printf '%s %s -> %s\n' "$1" "${2:-}" "$CALL" >> "$LOGS/wire-calls.txt"
  return $rc
}
jget() { printf '%s' "$CALL" | python3 "$WIRE" get "$1"; }
# info: the control reply of the running daemon. INFO = the reply, INFO_PID = its pid.
INFO=""
INFO_PID=""
info() {
  INFO=$(python3 "$WIRE" "$BIN" --timeout 90 info 2>> "$LOGS/wire.stderr.txt") || return 1
  printf 'info -> %s\n' "$INFO" >> "$LOGS/wire-calls.txt"
  INFO_PID=$(printf '%s' "$INFO" | python3 "$WIRE" get pid) || return 1
}

# What host.autoResume says about the boot service.
boot_service_installed() { call host.autoResume && [ "$(jget result.bootService.installed)" = true ]; }
boot_service_gone() { call host.autoResume && [ "$(jget result.bootService.installed)" = false ]; }

# ── the login item (launchd) ────────────────────────────────────────────────────────────────────
# The user's GUI domain, where `launchctl bootstrap gui/<uid>` puts the agent when somebody is logged in
# at the screen. Without one (HAS_GUI=0: a session over SSH) tf-hostd falls back to the older
# `launchctl load`, which these helpers then follow, with the commands that go with it.
item_print() { if [ "$HAS_GUI" = 1 ]; then launchctl print "$GUI/$LABEL"; else launchctl list "$LABEL"; fi; }
item_loaded() { item_print > /dev/null 2>&1; }
item_unloaded() { ! item_loaded; }
item_installed() { [ -f "$PLIST" ] && item_loaded; }
item_removed() { [ ! -e "$PLIST" ] && item_unloaded; }
item_kickstart() { if [ "$HAS_GUI" = 1 ]; then launchctl kickstart -k "$GUI/$LABEL" 2>&1; else launchctl start "$LABEL" 2>&1; fi; }
item_bootout() { if [ "$HAS_GUI" = 1 ]; then launchctl bootout "$GUI/$LABEL" 2>&1; else launchctl unload "$PLIST" 2>&1; fi; }
item_bootstrap() { if [ "$HAS_GUI" = 1 ]; then launchctl bootstrap "$GUI" "$PLIST" 2>&1; else launchctl load "$PLIST" 2>&1; fi; }
# What the agent's file says (a plist is XML: plistlib reads it on any OS), one `key=value` per line.
item_plist_facts() {
  python3 - "$PLIST" << 'PY'
import os, plistlib, sys
with open(sys.argv[1], "rb") as f:
    p = plistlib.load(f)
args = p.get("ProgramArguments", [])
env = p.get("EnvironmentVariables", {})
print("label=%s" % p.get("Label"))
print("program=%s" % (os.path.realpath(args[0]) if args else ""))
print("verb=%s" % (args[1] if len(args) > 1 else ""))
print("relayflag=%s" % (args[2] if len(args) > 2 else ""))
print("relayport=%s" % (args[3] if len(args) > 3 else ""))
print("runatload=%s" % p.get("RunAtLoad"))
print("interval=%s" % p.get("StartInterval"))
print("abandon=%s" % p.get("AbandonProcessGroup"))
print("tfhome=%s" % env.get("TF_HOSTD_HOME"))
PY
}

# ── preflight, deploy, seed ─────────────────────────────────────────────────────────────────────
refuse() {
  printf 'login-items-macos: %s\n' "$1" >&2
  exit 64
}

preflight() {
  [ "$(uname -s)" = Darwin ] || refuse "this is for macOS (uname says $(uname -s))."
  if ! on_actions && [ "${LOGIN_ITEMS_ON_DISPOSABLE_HOST:-}" != 1 ]; then
    refuse "it installs and removes a real login item and stops the real tf-hostd of $HOME_DIR: it is meant for the disposable GitHub runner. Set LOGIN_ITEMS_ON_DISPOSABLE_HOST=1 to run it on a machine you can lose that on."
  fi
  if [ "${RUNNER_ENVIRONMENT:-}" = self-hosted ] && [ "${LOGIN_ITEMS_ON_DISPOSABLE_HOST:-}" != 1 ]; then
    refuse "this is a self-hosted runner, somebody's own machine: set LOGIN_ITEMS_ON_DISPOSABLE_HOST=1 if it is one that can lose its login item and its tf-hostd."
  fi
  if [ -n "$(ls -A "$HOME_DIR" 2> /dev/null)" ] && [ "${LOGIN_ITEMS_ON_DISPOSABLE_HOST:-}" != 1 ]; then
    refuse "$HOME_DIR is not empty: this is not a fresh runner, so it is left alone."
  fi
  [ -x "$SRC" ] || refuse "$SRC is not an executable (the built tf-hostd): pass its path."
  command -v python3 > /dev/null || refuse "python3 is missing (scripts/ci/hostd-wire.py needs it)."
  # Nothing is cleaned up after a refusal, so every check that a machine is not the disposable one this
  # needs comes here: this home's login item must not exist before the daemon ever ran.
  launchctl print "$GUI" > /dev/null 2>&1 || HAS_GUI=0
  LABEL="dev.teleflock.hostd.$(fnv1a "$HOME_DIR")"
  PLIST="$LAUNCH_AGENTS/$LABEL.plist"
  item_removed || refuse "the login item $LABEL exists before the daemon ever ran: this is not a fresh runner, so it is left alone."
}

describe_machine() {
  group "the machine"
  {
    echo "--- sw_vers"
    sw_vers
    echo "--- uname -a"
    uname -a
    echo "--- id"
    id
    echo "--- launchctl managername (Aqua: a GUI login session)"
    launchctl managername
    echo "--- launchctl print $GUI (the domain the agent is loaded into)"
    launchctl print "$GUI" | sed -n '1,12p'
    echo "--- launchctl print-disabled $GUI (labels switched off in System Settings → Login Items)"
    launchctl print-disabled "$GUI" | head -n 8
    echo "--- console user"
    stat -f '%Su' /dev/console
    echo "--- binary under test"
    ls -l "$SRC"
    "$SRC" --version
    echo "--- python3"
    python3 --version
    echo "--- HOME=$HOME, home under test $HOME_DIR"
  } > "$LOGS/machine.txt" 2>&1
  cat "$LOGS/machine.txt"
  endgroup
  if [ "$HAS_GUI" != 1 ]; then
    fact "WARNING: launchd has no $GUI domain on this runner (no GUI login session): tf-hostd falls back to the older launchctl load, and the checks follow it with launchctl list / start / load / unload"
    if on_actions; then printf '::warning title=no GUI domain::launchctl cannot see %s, so launchctl bootstrap fails there and tf-hostd falls back to the older launchctl load\n' "$GUI"; fi
  fi
}

deploy_and_seed() {
  group "deploy tf-hostd like the app does, seed the agent ledger"
  mkdir -p "$HOME_DIR/bin" || refuse "cannot create $HOME_DIR/bin"
  chmod 700 "$HOME_DIR"
  install -m 755 "$SRC" "$BIN" || refuse "cannot copy $SRC to $BIN"
  "$BIN" --version
  fact "home $HOME_DIR, so the label should be $LABEL"
  # What a reboot leaves in the ledger: one agent whose omp ended (architecture §3.25, `AgentEnded`).
  (
    umask 077
    printf '{"sessions":{"default":{"ci-login-item":{"record":{"agentId":"ci-login-item","name":"ci-login-item","kind":"omp","title":"Login item check (CI)","ended":{"at":%s,"cause":"reboot","reason":"the host restarted","turn":"idle"}}}}}}\n' "$(($(date +%s) * 1000))" > "$HOME_DIR/ledger.json"
  )
  cat "$HOME_DIR/ledger.json"
  endgroup
}

# ── (a) ─────────────────────────────────────────────────────────────────────────────────────────
check_install() {
  local facts relay got want how
  group "(a) the daemon the app starts installs the login item by default"
  # `attach` is what the app runs: it starts the daemon and answers. No setting is touched.
  if ! call host.autoResume; then
    fail "(a) the daemon starts" "tf-hostd attach did not answer host.autoResume: ${CALL:-nothing} (see wire.stderr.txt, home-hostd.log.txt)"
    endgroup
    return 1
  fi
  fact "host.autoResume right after the start: $(jget result)"
  if ! wait_until "$WAIT" item_installed; then
    snap launchctl-print-missing item_print
    snap launchctl-list-after-start launchctl list
    call host.autoResume
    fail "(a) the login item is installed" "after ${WAIT} s there is no loaded agent $LABEL with a file ($PLIST); $LAUNCH_AGENTS holds: $(find "$LAUNCH_AGENTS" -maxdepth 1 -print 2>&1 | tr '\n' ' '); the daemon says: $(jget result.bootService); see launchctl-print-missing.txt, home-hostd.log.txt"
    endgroup
    return 1
  fi
  how="launchctl print $GUI/$LABEL"
  if [ "$HAS_GUI" != 1 ]; then how="launchctl list $LABEL, there is no GUI domain"; fi
  pass "(a) installed ${WAITED} s after the daemon started: $PLIST is there and the agent is loaded ($how)"
  snap launchctl-print-installed item_print
  cp "$PLIST" "$LOGS/agent.plist.txt"

  if facts=$(item_plist_facts 2>&1); then
    printf '%s\n' "$facts"
    info && relay=$(printf '%s' "$INFO" | python3 "$WIRE" get relayPort)
    want="label=$LABEL program=$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$BIN") verb=ensure relayflag=--relay-port relayport=${relay:-?} runatload=True interval=600 abandon=True tfhome=$HOME_DIR"
    got=$(printf '%s\n' "$facts" | tr '\n' ' ' | sed 's/ $//')
    if [ "$got" = "$want" ]; then
      pass "(a) the plist runs 'tf-hostd ensure' at load and every 600 s, for this home"
    else
      fail "(a) the plist says what automations/launchd.rs promises" "wanted [$want], the file says [$got]"
    fi
  else
    fail "(a) the plist can be read" "$facts"
  fi
  if command -v plutil > /dev/null; then
    if plutil -lint "$PLIST" > "$LOGS/plutil-lint.txt" 2>&1; then pass "(a) plutil -lint accepts the plist"; else fail "(a) plutil -lint accepts the plist" "$(cat "$LOGS/plutil-lint.txt")"; fi
  fi
  # What launchctl itself reads from it (its output format is its own: these only inform).
  local needle
  for needle in "path = $PLIST" "ensure" "run interval = 600 seconds"; do
    if grep -qF -- "$needle" "$LOGS/launchctl-print-installed.txt"; then fact "launchctl print shows: $needle"; else fact "launchctl print does not show: $needle"; fi
  done

  if wait_until "$WAIT" boot_service_installed; then
    local kind avail
    kind=$(jget result.bootService.kind)
    avail=$(jget result.bootService.available)
    if [ "$kind" = '"launchd"' ] && [ "$avail" = true ]; then
      pass "(a) host.autoResume reports the boot service launchd, available and installed (${WAITED} s)"
    else
      fail "(a) host.autoResume reports the login item" "kind $kind, available $avail: $(jget result.bootService)"
    fi
  else
    fail "(a) host.autoResume reports the login item installed" "after ${WAIT} s: $(jget result.bootService)"
  fi
  endgroup
}

# ── (b), (e) the daemon is gone, the item brings it back ────────────────────────────────────────
OLD_PID=""
NEW_PID=""
new_daemon() {
  local p
  p=$(daemon_pids | head -n 1)
  [ -n "$p" ] && [ "$p" != "$OLD_PID" ] && NEW_PID=$p
}

# revive NAME TRIGGER…: kills the daemon by pid, shows it stays down, runs the trigger, and waits for
# a daemon with another pid that answers.
revive() {
  local name=$1 pids cmd out began up
  shift
  pids=$(daemon_pids)
  if [ -z "$pids" ] || [ "$(printf '%s\n' "$pids" | wc -l | tr -d ' ')" != 1 ]; then
    fail "$name" "expected exactly one daemon of $BIN, found: ${pids:-none} ($(ps -axww -o pid= -o command= | awk '/[t]f-hostd/' | tr '\n' ';'))"
    return 1
  fi
  OLD_PID=$pids
  if ! info || [ "$INFO_PID" != "$OLD_PID" ]; then
    fail "$name" "the daemon that answers (pid ${INFO_PID:-none}) is not the process found (pid $OLD_PID)"
    return 1
  fi
  cmd=$(ps -ww -p "$OLD_PID" -o command= 2> /dev/null)
  case "$cmd" in
    "$BIN daemon"*) ;;
    *)
      fail "$name" "pid $OLD_PID is not tf-hostd's daemon: $cmd"
      return 1
      ;;
  esac
  kill -KILL "$OLD_PID"
  if ! wait_until 15 daemon_gone; then
    fail "$name" "pid $OLD_PID did not die after SIGKILL"
    return 1
  fi
  sleep 3
  if [ -n "$(daemon_pids)" ]; then
    fail "$name" "a daemon runs again by itself before the trigger: $(daemon_pids | tr '\n' ' ')"
    return 1
  fi
  pass "$name: daemon pid $OLD_PID killed and verified down (a SIGKILL leaves its socket and lock behind, as a reboot does)"
  out=$("$@")
  printf '%s\n' "$out"
  began=$SECONDS
  if ! wait_until "$WAIT" new_daemon; then
    snap "launchctl-print-$(slug "$name")-no-daemon" item_print
    fail "$name" "no daemon within ${WAIT} s of the trigger (it said: $(oneline "$out")); see launchctl-print-$(slug "$name")-no-daemon.txt, home-hostd.log.txt"
    return 1
  fi
  up=$((SECONDS - began))
  if ! info || [ "$INFO_PID" != "$NEW_PID" ]; then
    fail "$name" "a daemon started (pid $NEW_PID) but a status call was not answered by it (pid ${INFO_PID:-none})"
    return 1
  fi
  fact "$name: new daemon pid $NEW_PID, $(ps -ww -p "$NEW_PID" -o ppid= -o tty= -o command= 2> /dev/null | tr -s ' ')"
  snap "launchctl-print-$(slug "$name")" item_print
  if [ "$up" -le 60 ]; then
    pass "$name: daemon back as pid $NEW_PID ${up} s after the trigger, and it answers a status call"
  else
    fail "$name" "the daemon came back after ${up} s (the limit is 60 s)"
  fi
}

# What a login does to a RunAtLoad agent: launchd loads its file and runs it.
login_trigger() {
  local i out
  item_bootout
  if ! wait_until 20 item_unloaded; then
    echo "the agent is still loaded after bootout"
    return 1
  fi
  [ -f "$PLIST" ] || {
    echo "bootout deleted the file, which only tf-hostd may do"
    return 1
  }
  for i in 1 2 3; do
    if out=$(item_bootstrap); then
      echo "bootstrap ok"
      return 0
    fi
    echo "bootstrap, try $i: $out"
    sleep 2
  done
  return 1
}

check_revive() {
  group "(b) the daemon is gone; the login item brings it back (kickstart)"
  revive "(b) launchctl kickstart" item_kickstart
  endgroup
  group "(b) the same the way a login does it: bootout, then bootstrap (RunAtLoad)"
  revive "(b) bootout and bootstrap (RunAtLoad)" login_trigger
  endgroup
  group "(b) the item runs while the daemon lives (what it does every 10 minutes): nothing changes"
  check_periodic
  endgroup
}

# The StartInterval run of the agent is `ensure` against a daemon that is up: it must start no second one.
check_periodic() {
  local before out after
  before=$(daemon_pids)
  if [ -z "$before" ] || [ "$(printf '%s\n' "$before" | wc -l | tr -d ' ')" != 1 ]; then
    fail "(b) a run of the item while the daemon lives" "expected exactly one daemon, found: ${before:-none}"
    return 1
  fi
  out=$(item_kickstart)
  printf '%s\n' "$out"
  sleep 8
  after=$(daemon_pids)
  if [ "$after" = "$before" ]; then
    pass "(b) a run of the item while the daemon lives (kickstart, as every 10 minutes) starts no second daemon: pid $before stays the only one"
  else
    fail "(b) a run of the item while the daemon lives" "daemon pids were [$before], are [$(printf '%s' "$after" | tr '\n' ' ')]; the item said: $(oneline "$out")"
  fi
}

# ── (d), (e) the setting ────────────────────────────────────────────────────────────────────────
check_off_on() {
  local before
  group "(d) Settings → Auto-resume → Bring agents back after a reboot: off"
  if [ -z "$(daemon_pids)" ]; then
    fact "no daemon runs at this point (a check before failed): one is started, so the setting can be called"
    call host.autoResume
    sleep 3
  fi
  before=$(daemon_pids | head -n 1)
  if ! call host.autoResumeSet '{"bringBack":false}'; then
    fail "(d) the setting can be switched off" "host.autoResumeSet answered: ${CALL:-nothing}"
    endgroup
    return 1
  fi
  if wait_until "$WAIT" item_removed; then
    pass "(d) off: the agent is unloaded (launchctl print fails) and $PLIST is deleted, ${WAITED} s"
  else
    snap launchctl-print-off item_print
    fail "(d) off removes the login item and its file" "after ${WAIT} s: loaded=$(item_loaded && echo yes || echo no), file=$([ -e "$PLIST" ] && echo yes || echo no); see launchctl-print-off.txt, home-hostd.log.txt"
  fi
  if wait_until 30 boot_service_gone; then
    pass "(d) host.autoResume reports it not installed (available: $(jget result.bootService.available))"
  else
    fail "(d) host.autoResume reports it not installed" "$(jget result.bootService)"
  fi
  # The daemon removed the agent that started it. Does launchd take its job's children along?
  sleep 3
  if [ -z "$before" ]; then
    fact "no daemon was running to watch while its login item was switched off"
  elif daemon_pids | grep -qx "$before"; then
    fact "the daemon (pid $before) survived switching its login item off"
  else
    fact "WARNING: the daemon (pid $before) did not survive switching its own login item off"
    if on_actions; then printf '::warning title=the daemon died with its login item::pid %s is gone after bringBack=false\n' "$before"; fi
  fi
  endgroup

  group "(e) on again"
  if ! call host.autoResumeSet '{"bringBack":true}'; then
    fail "(e) the setting can be switched on" "host.autoResumeSet answered: ${CALL:-nothing}"
    endgroup
    return 1
  fi
  if wait_until "$WAIT" item_installed; then
    pass "(e) on: $PLIST is back and loaded, ${WAITED} s"
    snap launchctl-print-reinstalled item_print
  else
    snap launchctl-print-on item_print
    fail "(e) on installs the login item again" "after ${WAIT} s: loaded=$(item_loaded && echo yes || echo no), file=$([ -e "$PLIST" ] && echo yes || echo no); see launchctl-print-on.txt, home-hostd.log.txt"
    endgroup
    return 1
  fi
  if wait_until "$WAIT" boot_service_installed; then
    pass "(e) host.autoResume reports it installed again"
  else
    fail "(e) host.autoResume reports it installed again" "$(jget result.bootService)"
  fi
  endgroup
  group "(e) the reinstalled login item starts the daemon too"
  revive "(e) reinstalled item, launchctl kickstart" item_kickstart
  endgroup
}

# ── (f) leave the runner as it was, keep the logs ───────────────────────────────────────────────
leave_nothing() {
  local p
  if [ -n "$(daemon_pids)" ]; then
    call host.autoResumeSet '{"bringBack":false}' > /dev/null 2>&1
    wait_until 20 item_removed
  fi
  if [ -n "$LABEL" ] && ! item_removed; then
    item_bootout > /dev/null 2>&1
    rm -f "$PLIST"
  fi
  if [ -x "$BIN" ]; then with_timeout 40 "$BIN" stop > "$LOGS/stop.txt" 2>&1; fi
  for p in $(daemon_pids); do
    case "$(ps -ww -p "$p" -o command= 2> /dev/null)" in "$BIN daemon"*) kill -KILL "$p" ;; esac
  done
}

collect_logs() {
  local f
  for f in hostd.log ledger.json autoresume.json state.json tools.json automations.json; do
    if [ -f "$HOME_DIR/$f" ]; then cp "$HOME_DIR/$f" "$LOGS/home-$f.txt"; fi
  done
  ls -laR "$HOME_DIR/bin" "$HOME_DIR/run" "$LAUNCH_AGENTS" > "$LOGS/files.txt" 2>&1
  ps -axww -o pid,ppid,pgid,etime,command | awk 'NR == 1 || /[t]f-hostd/' > "$LOGS/processes.txt" 2>&1
  { launchctl list | grep -i -e teleflock -e '^PID'; launchctl print-disabled "$GUI" | grep -i teleflock; } > "$LOGS/launchctl-list.txt" 2>&1
  # launchd's own account of the agent's runs (what `ensure` printed went nowhere: the plist has no log file).
  with_timeout 120 log show --last 40m --style compact --info --debug --predicate 'eventMessage CONTAINS[c] "teleflock"' > "$LOGS/log-show-teleflock.txt" 2>&1
  with_timeout 120 log show --last 40m --style compact --info --debug --predicate 'subsystem == "com.apple.xpc.launchd" AND eventMessage CONTAINS[c] "dev.teleflock"' > "$LOGS/log-show-launchd.txt" 2>&1
  with_timeout 60 sudo -n sfltool dumpbtm > "$LOGS/background-items-btm.txt" 2>&1
}

summary() {
  local out="$LOGS/summary.md" i cell
  {
    echo "### macOS login item (launchd)"
    echo
    echo "$(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m)), \`$("$SRC" --version 2> /dev/null)\`"
    echo
    echo "| | check |"
    echo "|---|---|"
    for ((i = 0; i < ${#RESULTS[@]}; i++)); do
      # One line, and no pipe: either would end the table cell.
      cell=$(printf '%s' "${RESULTS[$i]#*|}" | tr '\r\n' '  ')
      cell=${cell//|/\\|}
      if [ "${RESULTS[$i]%%|*}" = pass ]; then echo "| pass | $cell |"; else echo "| **FAIL** | $cell |"; fi
    done
    if [ "${#FACTS[@]}" -gt 0 ]; then
      echo
      echo "<details><summary>observations</summary>"
      echo
      for ((i = 0; i < ${#FACTS[@]}; i++)); do echo "- ${FACTS[$i]}"; done
      echo
      echo "</details>"
    fi
  } > "$out"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$out" >> "$GITHUB_STEP_SUMMARY"; fi
}

FINISHED=0
finish() {
  local status=$1 i
  if [ "$FINISHED" = 1 ]; then return 0; fi
  FINISHED=1
  group "(f) leave the runner clean, keep the logs"
  leave_nothing
  collect_logs
  summary
  endgroup
  if [ "$NFAIL" -gt 0 ]; then
    printf '\n%s check(s) failed:\n' "$NFAIL"
    for ((i = 0; i < ${#RESULTS[@]}; i++)); do
      if [ "${RESULTS[$i]%%|*}" = FAIL ]; then printf '  - %s\n' "${RESULTS[$i]#*|}"; fi
    done
    exit 1
  fi
  if [ "$status" != 0 ]; then
    printf '\nthe script stopped with status %s before every check ran\n' "$status"
    exit "$status"
  fi
  printf '\nall %s checks passed\n' "${#RESULTS[@]}"
  exit 0
}

main() {
  preflight
  trap 'finish $?' EXIT
  describe_machine
  deploy_and_seed
  if check_install; then
    check_revive
    check_off_on
  else
    fact "the login item never appeared, so the checks that need it were skipped"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  mkdir -p "$LOGS" || exit 64
  main "$@" 2>&1 | tee -a "$LOGS/run.log"
  exit "${PIPESTATUS[0]}"
fi
