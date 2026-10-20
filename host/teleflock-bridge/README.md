# teleflock-bridge

The omp companion extension that gives TeleFlock a structured control plane over a live, interactive omp TUI session (architecture §4). The wire protocol is in [`docs/bridge-protocol.md`](../../docs/bridge-protocol.md); the hostd side is in `crates/tf-hostd/src/bridge.rs`.

## Loading

```sh
omp -e /path/to/teleflock-bridge.ts            # per process (TeleFlock's launch recipe)
cp teleflock-bridge.ts ~/.omp/agent/extensions/ # global install (needs the user's consent)
```

- **Socket.** The extension connects to `<home>/run/bridge.sock` (Windows: `\\.\pipe\teleflock-bridge-<USERNAME>[-<hash>]`). It resolves `<home>` from `TF_BRIDGE_SOCK` (which overrides the whole endpoint), then from its own location when deployed as `<home>/ext/teleflock-bridge.ts`, then `TF_HOSTD_HOME`, then `~/.teleflock`.
- **Retry.** It retries every 5 s while hostd is absent.
- **TUI footprint.** Its only output is a dim `⇄ teleflock` status notice while connected.
- **Scope.** Only the main session is bridged; subagents are ignored.

## What it does

| Area | Details |
|---|---|
| **Events → hostd** | `hello` (sent again on session switch), `state` (model, thinking, fast, plan mode, goal, title, idle, context, leaf, queue, plan review), `queue_update`, `plan_review_requested`, `plan_review_resolved`, `btw_delta` |
| **Model and modes** | `setModel`, `setThinking`, `setFast`, `setPlan`, `goal` |
| **Session ops** | `compact`, `rename`, `followUp`, `navigateTree`, `branch`, `fork`, `newSession`, `handoff`, `export` |
| **Interaction** | `resolvePlanReview`, `btw` (streamed `ctx.runEphemeralTurn`), `btwCancel`, `slash`, `abort` |
| **Reads** | `getTree`, `getQueue`, `getState`, `ping` |

TUI-only commands run through the composer's own submit handler, so no herdr keystroke injection is needed and the operator's draft is preserved. Tree, branch and new-session control use a command context, which the extension captures once through its hidden `/teleflock-attach` command. See the protocol doc's "TUI mechanics" section.

## Safety

The extension must never take omp down:
- Every socket callback, timer, promise chain and event handler is wrapped in try/catch.
- The ticker is `ctx.setInterval`, so omp clears it on shutdown.
- Malformed frames are ignored, bad requests get a `res` error, and oversized input (over 64 MiB) drops the connection, which then reconnects.

## Verifying

- **Type-check** against omp's shipped `.d.ts`: map `@oh-my-pi/pi-coding-agent` to `.research/omp-src/package/dist/types/index.d.ts` with `strict` and `noUnusedLocals` on.
- **Lab recipe:**
  1. Start a herdr session `tf-lab-bridge` with `TF_HOSTD_HOME=/tmp/tf-lab-bridge-home` in its environment.
  2. In it, run `agent start … -- --model openai-codex/gpt-6-luna --thinking low -e host/teleflock-bridge/teleflock-bridge.ts`.
  3. Drive it through `tf_hostd::bridge::BridgeHandle::bind(BridgeEndpoint::Unix("/tmp/tf-lab-bridge-home/run/bridge.sock"))`.
