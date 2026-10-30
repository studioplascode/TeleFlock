# teleflock-bridge

The omp companion extension that gives TeleFlock a structured control plane over a live, interactive omp TUI session and, since 2.0.0, its data plane: a live feed of the session in omp's collab frame shapes, prompts with images, the session's dialogs answerable from TeleFlock, and subagent control (architecture §4). The wire protocol is in [`docs/bridge-protocol.md`](../../docs/bridge-protocol.md); the hostd side is in `crates/tf-hostd/src/bridge.rs`.

## Loading

```sh
omp -e /path/to/teleflock-bridge.ts            # per process (TeleFlock's launch recipe)
cp teleflock-bridge.ts ~/.omp/agent/extensions/ # global install (needs the user's consent)
```

- **Socket.** The extension connects to `<home>/run/bridge.sock` (Windows: `\\.\pipe\teleflock-bridge-<USERNAME>[-<hash>]`). It resolves `<home>` from `TF_BRIDGE_SOCK` (which overrides the whole endpoint), then from its own location when deployed as `<home>/ext/teleflock-bridge.ts`, then `TF_HOSTD_HOME`, then `~/.teleflock`.
- **Retry.** It retries every 5 s while hostd is absent.
- **One per process** (1.4.0). A process that loads several copies (the global install plus TeleFlock's `-e` copy, maybe of different versions) elects one through a `globalThis[Symbol.for("teleflock.bridge")]` slot: the highest version, else the first claimant, connects; the others stay silent, and a newer copy loading later takes over. Older copies (< 1.4.0) don't know the slot; hostd routes to the newest bridge of a pid. See the protocol doc's "One bridge per omp process".
- **TUI footprint.** Its only output is a dim `⇄ teleflock` status notice while connected.
- **Scope.** Only the main session is bridged. A copy loaded in a subagent session never connects; it relays that session's task bus (its subagents' progress and lifecycle) to the owner copy (2.0.0).

## What it does

| Area | Details |
|---|---|
| **Events → hostd** | `hello` (with `caps` since 2.0.0; sent again on session switch), `state` (model, thinking, fast, plan mode, goal, title, idle, context, leaf, queue, plan review), `queue_update`, `plan_review_requested`, `plan_review_resolved`, `btw_delta` |
| **Model and modes** | `setModel`, `setThinking`, `setFast`, `setPlan`, `goal` |
| **Session ops** | `compact`, `rename`, `followUp`, `navigateTree`, `branch`, `fork`, `newSession`, `handoff`, `export` |
| **Interaction** | `resolvePlanReview`, `btw` (omp's own `/btw`: in the TUI and its BTW history; `btwId` follows up), `btwCancel`, `getBtwHistory`, `slash`, `dequeue`, `abort` |
| **Reads** | `getTree`, `getQueue`, `getCommands`, `getState`, `ping` |
| **Data plane (2.0.0)** | `liveSubscribe` / `liveUnsubscribe`: a `resync` snapshot, then `live` frames shaped like omp's collab host→guest frames (agent events from omp's own AgentSession, `state`, task-bus `bus` frames at every depth, `agents` roster with session files, dialogs), with source throttles, coalescing under backpressure and one `resync` on overflow. `prompt` (images, delivery), `uiResponse` (the session's ask / approval / select / editor / confirm / input dialogs race the TUI against hostd, first answer wins), `agentCmd` (chat / kill / revive a subagent) |
| **Model roles (2.1.0, `caps.roleModels`)** | `getRoleModels` (the session's own roles and fallback chains apart from the host's), `setRoleModels` (the session's complete maps as omp runtime overrides of `modelRoles` / `retry.fallbackChains`, after reloading the agent's `--config` overlay hostd rewrote; a changed `default` switches the session's model, session only). Needs omp's live `Settings` and the two setting handles (literal subpath imports, checked against the root `Settings` export) |
| **Background jobs (2.1.0, `caps.jobs`)** | `jobs` (the session's and its subagents' background bash / eval / subagent-task jobs, oldest running first; inspected ones with output tail, pids, exit code, folder, artifact, omp's widget), `jobCancel` (through the owner's session `cancelAsyncJob`), and a `jobs` event (counts, omp's async wait, the freshest live widget's glance) on the 1 s tick when it changed. omp's AgentSession job API, else the public `ctx.getAsyncJobSnapshot()`. Tests: `jobs.test.ts` |
| **Context breakdown (2.1.0, `caps.context`)** | `context`: what fills the context window. omp's own `/context` data (`session/context-view` `buildSessionContextView` on the main AgentSession, the overview's `allocateUsage` / `overviewLabel`), loaded on the first request; on an omp without it an estimate per part (the session's tokenizer) splitting omp's reported usage; without the AgentSession the totals. Image count and whether omp can drop them. Tests: `context.test.ts` |

TUI-only commands run through the composer's own submit handler, so no herdr keystroke injection is needed and the operator's draft is preserved. Tree, branch and new-session control use a command context, which the extension captures once per process through its hidden `/teleflock-control` command (older copies register `/teleflock-attach` and keep the context to themselves); every 1.4.0+ copy stores the context in the shared slot. See the protocol doc's "TUI mechanics" section.

**Schema dump mode** (1.2.0). With `TF_OMP_SCHEMA_OUT=<file>` set, the extension skips all of the above: it writes omp's settings schema (`config/all-settings` → `orderedSettings()` definitions) to `<file>` and exits. tf-hostd uses it for `omp.settings` (protocol doc "Schema dump").

**Settings-write mode** (1.3.0). With `TF_OMP_SETTINGS_IN=<in>` and `TF_OMP_SETTINGS_OUT=<out>` set, the extension likewise skips all of the above: it reads the changes from the owner-only `<in>` (deleting it at once), applies them through omp's Settings API exactly like `omp config set|reset`, writes the per-key results to `<out>` and exits. tf-hostd uses it for credential writes, so secrets never appear in a command line (protocol doc "Settings write").

## Safety

The extension must never take omp down:
- Every socket callback, timer, promise chain and event handler is wrapped in try/catch.
- The ticker is `ctx.setInterval`, so omp clears it on shutdown.
- Malformed frames are ignored, bad requests get a `res` error, and oversized input (over 64 MiB) drops the connection, which then reconnects.

## Verifying

- **Tests:** `bun test host/teleflock-bridge` — the ordered writer (coalescing under backpressure, overflow → one resync, seq), throttles, the dialog race and ask flow, the wrappers on omp's UI context, and the whole extension against a fake hostd socket with a fake omp (resync contents, dialogs end to end, nested relay, `prompt`, `agentCmd`, session switch).
- **Type-check** against omp's shipped `.d.ts`: map `@oh-my-pi/pi-coding-agent` (and `/*`) to the package's `dist/types` with `strict` and `noUnusedLocals` on.
- **Fake hostd** (`probe.ts`): `bun host/teleflock-bridge/probe.ts <dir> --out frames.jsonl --subscribe` listens on `<dir>/bridge.sock` with a fresh `<dir>/bridge.secret`, authenticates like hostd, prints one line per frame and appends every frame to `frames.jsonl`. stdin takes `<op> {json params}` requests, `answer <label>` (uiResponse to the oldest pending dialog; `answer` alone cancels), `pause` / `resume` (stop reading the socket) and raw frames.
- **Lab recipe** (real omp, nothing of the user's touched):
  1. An isolated agent dir: `PI_CODING_AGENT_DIR=/tmp/<lab>/agent` (run omp once to create it; a model call needs a credential in its `agent.db`; copy one without its refresh token so the lab can never rotate the account's tokens). omp still writes its log to `~/.omp/logs/omp.<date>.<pid>.log`; delete yours afterwards.
  2. Start the probe, then `TF_BRIDGE_SOCK=/tmp/<lab>/run/bridge.sock omp --model openai-codex/gpt-6-luna --thinking low -e host/teleflock-bridge/teleflock-bridge.ts` in a terminal (add `--approval-mode always-ask` to see approvals; `TF_BRIDGE_LIVE_LIMITS=0,4096` plus the probe's `pause` forces backpressure and an overflow).
  3. Drive it from the probe: `prompt {"text":"…"}`, `answer Blue`, `agentCmd {"cmd":"chat","agentId":"…","text":"…"}`, `slash {"command":"/new"}`.
- **Through hostd:** `tf_hostd::bridge::BridgeHandle::bind(BridgeEndpoint::Unix("/tmp/tf-lab-bridge-home/run/bridge.sock"))` with a herdr session `tf-lab-bridge` (`TF_HOSTD_HOME=/tmp/tf-lab-bridge-home`) running `agent start … -- --model openai-codex/gpt-6-luna --thinking low -e host/teleflock-bridge/teleflock-bridge.ts`.
