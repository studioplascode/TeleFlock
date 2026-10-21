# TeleFlock bridge protocol (v1)

The wire between **tf-hostd** (`crates/tf-hostd/src/bridge.rs`) and the omp companion extension
**teleflock-bridge** (`host/teleflock-bridge/teleflock-bridge.ts`). Architecture: §4.

## Transport

| Platform | Endpoint | Notes |
|---|---|---|
| Linux / macOS / WSL | `<home>/run/bridge.sock` | Unix socket, mode `0600`, dir `0700`. hostd replaces a stale file on start. |
| Windows | `\\.\pipe\teleflock-bridge-<USERNAME>` | For a home other than `%USERPROFILE%\.teleflock`: `…-<USERNAME>-<fnv1a32(home) as 8 hex>`. Remote clients rejected. Every pipe instance carries a protected DACL granting `GENERIC_ALL` to the current user's SID and SYSTEM only. |

The extension resolves `<home>` in this order:
1. `TF_BRIDGE_SOCK`, which overrides the whole endpoint verbatim.
2. Its own location, when deployed as `<home>/ext/teleflock-bridge.ts`. omp inherits the herdr pane's env, which usually lacks `TF_HOSTD_HOME`, so this is what makes app-deployed lab and real homes work.
3. `TF_HOSTD_HOME`.
4. `~/.teleflock`.

- hostd is the **server**; every omp process running the extension is a **client** (one connection per process).
- Framing: **JSON lines**: one UTF-8 JSON object per `\n`-terminated line. Lines over 64 MiB close the connection.
- Every frame has a string `t` (frame type). Unknown `t` values and unknown fields are ignored by both sides.
- All keys are camelCase. Enum values are camelCase strings (`planPaused`, `xhigh`, `inPlace`).

### Authentication (`bridge.secret`)

On Windows another local user can create the pipe name before hostd does (the extension cannot check who owns a pipe), so every connection starts with hostd proving it knows a per-start secret. The handshake runs on every platform.

- At every start, before it listens, hostd writes 32 random bytes as **64 lowercase hex characters** (no newline) to `<home>/run/bridge.secret`. The file is replaced atomically (tmp file + rename) and is readable by the current user only: mode `0600` inside the `0700` run dir on unix, a protected DACL (current user + SYSTEM) on Windows.
- The extension reads the secret from `<home>/run/bridge.secret`, using the same `<home>` resolution as the endpoint. With a unix `TF_BRIDGE_SOCK`, it reads `bridge.secret` next to that socket instead. It reads the file fresh on every connection attempt, because hostd rotates it on restart.
- hostd's **first frame** on every connection is [`auth`](#auth). The extension sends nothing, not even `hello`, until it has verified that frame. It hex-decodes both values and compares them with `crypto.timingSafeEqual`.
- On a missing or unreadable file, a malformed or mismatched secret, a first frame that is not `auth`, more than 4 KiB before `auth`, or no `auth` within 5 s, the extension closes the connection, logs to the omp debug log, and retries on the normal 5 s schedule.
- The Rust clients of the **hostd** pipe (`tf-hostd attach`/`stop`) don't need the secret. After connecting, they check that the pipe's server process (`GetNamedPipeServerProcessId` → process token `TokenUser`) runs as the current user's SID. If it doesn't, they refuse with an error.

### Connection lifecycle (extension)
1. On `session_start` the extension starts a 1 s managed ticker (`ctx.setInterval`).
2. If not connected, it connects when the endpoint exists. After any failure or close it retries **every 5 s**.
3. On connect it waits for hostd's `auth` frame and verifies it (see [Authentication](#authentication-bridgesecret)). Only then does it send `hello` (`reason: "connect"`).
4. Each tick (and right after every request and relevant omp event) it compares the live state with the last one it sent and pushes `state` / `queue_update` deltas.
5. When the omp session changes inside the same process (`/new`, `/resume`, `/fork`, `branch`), it sends a fresh `hello` with `reason: "switch"` and `previousSessionId`.
6. On `session_shutdown` it sends `bye` and closes.

Only the **main** agent session is bridged. Subagent bindings (`ctx.agent.kind === "sub"`) stay silent.

The TUI shows exactly one thing: a dim `⇄ teleflock` status-line notice while connected.

## Frames: extension → hostd

### `hello`
```json
{"t":"hello","v":1,"reason":"connect","previousSessionId":null,
 "pid":254512,"sessionId":"01a15b7f-298b-7641-aa67-c71874a55647",
 "sessionFile":"/root/.omp/agent/sessions/-tmp-w/2026-…_01a15b7f-….jsonl","cwd":"/tmp/w",
 "ompVersion":"18.12.3","bridgeVersion":"1.0.0","tui":true,
 "state":{ …CtlState… }}
```
- `reason`: `connect` (new connection) or `switch` (same connection, new omp session).
- `tui`: omp runs the interactive TUI (`ctx.mode === "tui"`). Ops marked **TUI** below need it.
- hostd keys sessions by `sessionId`. The latest `hello` wins if two connections claim the same id.

### `event`
```json
{"t":"event","event":"<name>","sessionId":"…","data":{…}}
```
hostd attributes events to the connection's current session (from its last `hello`).

| `event` | `data` | When |
|---|---|---|
| `state` | `CtlState` | Any field changed: model, thinking, fast, mode, goal, title, idle, context, leaf, queue, plan review, attached. Covers architecture §4's `model` / `thinking` change events. Checked once per second and after events. |
| `queue_update` | `{steering:string[], followUp:string[]}` | The TUI queue chip changed. |
| `plan_review_requested` | `PlanReviewInfo` | omp opened its interactive plan review. |
| `plan_review_resolved` | `{reviewId, choice: string\|null, by:"local"\|"extension"}` | The review closed. `choice` is `null` when it was dismissed or cancelled. |
| `btw_delta` | `{btwId, text, done, error?}` | Side-question stream. While `done:false`, `text` is a **delta**. The single `done:true` frame carries the **full final reply** in `text`, or `error`. |

### `res`
```json
{"t":"res","id":7,"ok":true,"result":{…}}
{"t":"res","id":7,"ok":false,"error":{"code":"busy","message":"handoff needs the agent to be idle"}}
```

### `bye`
`{"t":"bye","sessionId":"…"}`: sent on `session_shutdown`, just before closing.

## Frames: hostd → extension

### `auth`
`{"t":"auth","v":1,"secret":"<64 lowercase hex>"}`: always the first frame on a connection, sent before the extension says anything. The extension must verify `secret` against `<home>/run/bridge.secret` before it serves any request or sends `hello`. It does not check `v`.

### `welcome`
`{"t":"welcome","v":1,"hostd":"0.1.0"}`: sent after every `hello`. It is informational; the extension ignores it.

### `req`
```json
{"t":"req","id":7,"op":"setModel","params":{"model":"anthropic/claude-haiku-5-5","thinking":"low"}}
```
`id` is a positive integer, unique per hostd. Every `req` gets exactly one `res`, unless the connection drops first. `null` param values count as absent.

## Shared shapes

```ts
type CtlState = {
  model?: {provider: string; id: string; label?: string};
  thinking?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"|"auto";
  fast: boolean;                         // any service tier is priority/ultrafast
  mode: "normal"|"plan"|"planPaused";    // from the branch's last plan mode_change entry
  goal?: {objective: string; status: string; tokensUsed?: number; budget?: number}; // active/paused/budget-limited only
  title?: string;
  idle: boolean;
  context?: {tokens: number; window: number; pct: number};
  leafId?: string;
  queue: {steering: string[]; followUp: string[]};
  planReview?: PlanReviewInfo;           // open review, if any
  attached: boolean;                     // command context captured (see "TUI mechanics")
};
type PlanReviewInfo = {
  reviewId: string; title: string|null; planPath: string|null; content: string;
  choices: {id: "execute"|"compact"|"keep"|"refine"|"save"; label: string; disabled: boolean}[];
  tiers: {role: string; provider: string; model: string; thinkingLevel: string|null}[];
};
type TreeInfo = {                        // = tf_proto::TreeInfo
  nodes: {id: string; parentId: string|null; kind: "user"|"assistant"|"summary"|"compaction"|"other";
          label: string; at: number; onPath: boolean; children: number}[];
  leafId: string|null;
};
```

`getTree` includes only conversational entries: user and assistant messages, branch summaries, compactions and custom messages. Housekeeping entries (model, thinking, title and mode changes, custom state) are folded into their nearest conversational ancestor, so `parentId`, `children` and `leafId` refer to visible nodes only. `label` is the first text block, whitespace-collapsed and cut to 120 characters (`[tool calls]` / `[image]` when there is no text).

## Ops

**TUI** marks ops that need `tui: true`; otherwise they fail with `unsupported`. The hostd timeout is what `BridgeHandle` waits before returning `Timeout`.

| op | params | result | Mechanism | TUI | hostd timeout |
|---|---|---|---|---|---|
| `ping` | – | `{pong: ms}` | – | | 10 s |
| `getState` | – | `CtlState` | read | | 10 s |
| `setModel` | `model` (`provider/id`, bare id or `@role`), `thinking?` | `CtlState` | `ctx.models.resolve` + `pi.setModel` (+ `pi.setThinkingLevel`) | | 10 s |
| `setThinking` | `level` | `CtlState` | `pi.setThinkingLevel` (omp clamps per model) | | 10 s |
| `setFast` | `on` | `CtlState` | `/fast on\|off`. Without the TUI: `pi.setServiceTier(family, "priority"\|undefined)`. Fails `unsupported` if the tier doesn't stick. | | 30 s |
| `setPlan` | `on` | `CtlState` | Walks `/plan` (off → on → paused → off) until the mode matches | ✓ | 30 s |
| `goal` | `op`: `set\|pause\|resume\|drop\|budget`, `objective?`, `budget?` | `{}` | `/goal set <objective>` (then `/goal budget N`), `/goal pause\|resume\|drop`, `/goal budget <N\|off>` | ✓ | 30 s |
| `compact` | `instructions?` | `{}` | `ctx.compact`. Fails `nothing_to_compact` when omp writes no compaction entry. | | 600 s |
| `rename` | `title` | `{title}` | `pi.setSessionName` | | 10 s |
| `followUp` | `text` | `{steering, followUp}` | TUI: `/queue <text>` (visible "After yield" chip, restored on Esc; starts at once when idle). Otherwise `sendUserMessage(deliverAs: followUp)`. | | 30 s |
| `navigateTree` | `entryId`, `summarize?` (false) | `{leafId}` | `cmdCtx.navigateTree` | ✓ | 30 s (600 s with summarize) |
| `branch` | `entryId` (a user message; it and everything after are dropped) | `{sessionId, sessionFile}` | `cmdCtx.branch`, then `hello{reason:"switch"}` | ✓ | 30 s |
| `fork` | `entryId?`, `placement`: `inPlace\|pane` | `{sessionId, sessionFile}` | Optional `navigateTree(entryId)`, then `/fork` or `/fork pane`. Needs the agent idle. | ✓ | 30 s |
| `newSession` | – | `{sessionId, sessionFile}` | `cmdCtx.newSession` | ✓ | 30 s |
| `resolvePlanReview` | `reviewId`, `choice`, `feedback?` (required for `refine`), `role?` (approvals only; a `tiers[].role`) | `{}` | `ctx.resolvePlanReview` | | 10 s |
| `btw` | `question` | `{btwId}` immediately; the answer arrives as `btw_delta` events | `ctx.runEphemeralTurn` (not saved to the session; can run while streaming) | | 10 s |
| `btwCancel` | `btwId` | `{}` | aborts the side turn (its final `btw_delta` carries `error`) | | 10 s |
| `export` | `path?` (default `<artifacts dir>/teleflock-export-<sessionId>-<ms>.html`; no whitespace) | `{path}` | `/export <path>`, then waits up to 15 s for the file | ✓ | 30 s |
| `handoff` | `focus?` | `{settled}` | `/handoff [focus]`. Needs the agent idle. | ✓ | 600 s |
| `slash` | `command` (single line, starts with `/`) | `{settled}` | Any slash command through the composer | ✓ | 30 s |
| `abort` | – | `{}` | `ctx.abort()` | | 10 s |
| `getTree` | – | `TreeInfo` | `sessionManager.getEntries()` | | 10 s |
| `getQueue` | – | `{steering, followUp}` | TUI queue chip contents (empty without the TUI) | | 10 s |

`{settled:false}` means that after 15 s the command was still waiting on a TUI dialog (for example "Exit plan mode?"). The operator must answer it in the terminal.

## Errors

| `code` | Meaning | `ApiError` (hostd) |
|---|---|---|
| `invalid_params` | missing or ill-typed param, unknown level, choice or placement | `invalid_params` |
| `not_found` | unknown model, entry id, plan review, or btw id | `not_found` |
| `unsupported` | not in the TUI, no ephemeral turns, fast tier unavailable, plan mode refused | `unsupported` |
| `busy` | needs idle, or plan mode is waiting for a terminal confirmation | `busy` (retryable) |
| `auth_required` | model has no credentials | `auth_required` |
| `nothing_to_compact` | the session is too small or already compacted | `omp_error` (message kept) |
| `cancelled` | an extension hook cancelled the navigation, branch or new session | `omp_error` |
| `not_ready` | request arrived before `session_start` | `not_connected` (retryable) |
| `unknown_op` | older extension | `unsupported` + update hint |
| `omp_error` | anything omp threw | `omp_error` |

hostd-side failures: `NotConnected` → `not_connected` (retryable, hint: start via TeleFlock or install the extension). `Timeout` → `timeout` (retryable). `Disconnected` → `not_connected` (retryable). An undecodable result → `omp_error`.

## TUI mechanics (why some ops need the TUI)

- **Composer submit.** TUI-only commands (`/plan`, `/goal`, `/fork`, `/handoff`, `/export`, `/fast`, `/queue`, `slash`) run through the main composer's own Enter handler (`editor.onSubmit(text)`), exactly as if the operator typed them. No herdr keystroke injection is involved.
  - The operator's draft is protected: pasted images are held back from the submission and the draft text is restored if a command cleared it.
  - Submitted commands appear in the composer's ↑ history.
- **Finding the composer.** The extension reaches the TUI once by opening and immediately closing an empty `ctx.ui.custom()` component, restoring keyboard focus to whatever had it, and then locates the composer in the component tree.
- **Command context.** `navigateTree`, `branch` and `newSession` need an `ExtensionCommandContext`. The extension captures it once by submitting its own hidden command `/teleflock-attach` through the composer. After that, `state.attached` is `true` for the life of the process.
- **Focused subagent.** If the operator has focused a subagent in the TUI, composer submissions go to that subagent (omp behaviour).

## Safety rules (extension)

- It never throws into omp. Socket callbacks, the ticker, promise chains and every event handler are wrapped in try/catch. Timers use `ctx.setInterval`, which omp clears on shutdown.
- It answers bad frames with nothing (or a `res` error) and never closes the TUI.
  - Lab-verified: garbage JSON, non-object frames, unknown ops, bad params, a 2 MB junk line, abrupt disconnects mid-request and mid-btw. omp kept the same pid throughout.
- Logs go to omp's debug log only (`pi.logger.debug`); nothing is printed into the TUI.
