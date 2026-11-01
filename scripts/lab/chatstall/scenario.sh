#!/usr/bin/env bash
# One ChatStall lab scenario end to end: bridge copy, setup.sh --fresh, observe.ts, scripts/lab/stop.
#
# Usage: scripts/lab/chatstall/scenario.sh <scenario> <tag> --hostd BIN [--timeout S] [--keep]
#   baseline       no fault; the working tree's bridge
#   bridge-all     fault 4a:  bridge-side stuck writer, no frame at all after the first live toolcall update
#   bridge-live    fault 4b2: bridge-side, no live frame after it (control state and resyncs still flow)
#   collab-freeze  fault 4b:  bridge 1.4.0 (git v0.5.3, collab plane) + TF_HOSTD_LAB_FREEZE=toolcall_delta
#                  (needs a tf-hostd built with --features lab-faults)
#   bridge-freeze  the working tree's bridge + TF_HOSTD_LAB_FREEZE=toolcall_delta (hostd-side, bridge plane)
#   <tag>          b (before: HEAD build) | a (after: working tree) | any 1-3 of [a-z0-9]
#   --keep         leave the lab running (stop it later with scripts/lab/stop <lab>)
# The lab is chatstall-<code>-<tag> (code: base, all, live, col, hfz), short because herdr's socket
# path (/tmp/tf-lab-<lab>/xdg/config/herdr/sessions/tf-lab-<lab>/…) must fit sun_path.
# Logs stay in /tmp/tf-lab-<lab>/logs (observe-*.log/json, herdr/mock/hostd output) and
# /tmp/tf-lab-<lab>/teleflock/hostd.log.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
[ $# -ge 2 ] || { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
scenario="$1"
tag="$2"
shift 2
hostd=""
timeout=180
keep=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hostd) hostd="$2"; shift 2 ;;
    --timeout) timeout="$2"; shift 2 ;;
    --keep) keep=1; shift ;;
    *) echo "scenario: unknown option $1" >&2; exit 64 ;;
  esac
done
[ -n "$hostd" ] || { echo "scenario: --hostd BIN is required" >&2; exit 64; }
[[ "$tag" =~ ^[a-z0-9]{1,3}$ ]] || { echo "scenario: bad tag $tag (1-3 of [a-z0-9])" >&2; exit 64; }

bridges=/tmp/tf-lab-chatstall-bridges
mkdir -p "$bridges"
env_args=()
case "$scenario" in
  baseline) code=base; relay=47760; bridge="$repo/host/teleflock-bridge/teleflock-bridge.ts" ;;
  bridge-all)
    code=all; relay=47761; bridge="$bridges/stall-all.ts"
    bun "$here/patch-bridge-stall.ts" --mode all "$bridge" ;;
  bridge-live)
    code=live; relay=47762; bridge="$bridges/stall-live.ts"
    bun "$here/patch-bridge-stall.ts" --mode live "$bridge" ;;
  collab-freeze)
    code=col; relay=47763; bridge="$bridges/v0.5.3.ts"
    git -C "$repo" show v0.5.3:host/teleflock-bridge/teleflock-bridge.ts >"$bridge"
    env_args=(--hostd-env TF_HOSTD_LAB_FREEZE=toolcall_delta) ;;
  bridge-freeze)
    code=hfz; relay=47764; bridge="$repo/host/teleflock-bridge/teleflock-bridge.ts"
    env_args=(--hostd-env TF_HOSTD_LAB_FREEZE=toolcall_delta) ;;
  *) echo "scenario: unknown scenario $scenario" >&2; exit 64 ;;
esac

lab="chatstall-$code-$tag"
"$here/setup.sh" --fresh --hostd "$hostd" "${env_args[@]}" "$lab" "$relay" "$bridge"
rc=0
"$repo/scripts/lab/run" "$lab" -- bun "$here/observe.ts" --lab-env "/tmp/tf-lab-$lab/lab.env" --label "$scenario-$tag" --timeout "$timeout" || rc=$?
if [ "$keep" = 0 ]; then "$repo/scripts/lab/stop" "$lab" | tail -2; fi
exit "$rc"
