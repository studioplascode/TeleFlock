# TeleFlock bridge protocol

The wire between **tf-hostd** (`crates/tf-hostd/src/bridge.rs`) and the omp companion extension
**teleflock-bridge** (`host/teleflock-bridge/teleflock-bridge.ts`). Architecture: §4.

The control plane (ops on the live TUI session, `state` events) is protocol `v: 1` from bridge 1.0.
Bridge **2.0.0** adds the **data plane** without changing `v`: a live feed of the session in omp's
collab frame shapes, prompts with images, the session's dialogs and subagent control. A bridge
announces it in [`hello.caps`](#hello); see [Data plane](#data-plane-bridge--200).

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

- hostd is the **server**; every omp process running the extension is a **client**: one connection per process (per hostd endpoint), even when the process loads several copies of the extension (see [One bridge per omp process](#one-bridge-per-omp-process-bridge--140)).
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
1. On `session_start` the copy claims the process slot (see below). Only the owner starts a 1 s managed ticker (`ctx.setInterval`) and connects; the other copies stay silent.
2. If not connected, it connects when the endpoint exists. After any failure or close it retries **every 5 s**.
3. On connect it waits for hostd's `auth` frame and verifies it (see [Authentication](#authentication-bridgesecret)). Only then does it send `hello` (`reason: "connect"`), once its probe of the omp internals behind `caps` finished (a few module imports, normally done long before).
4. Each tick (and right after every request and relevant omp event) it compares the live state with the last one it sent and pushes `state` / `queue_update` deltas.
5. When the omp session changes inside the same process (`/new`, `/resume`, `/fork`, `branch`), it sends a fresh `hello` with `reason: "switch"` and `previousSessionId`. A live feed ends there (2.0.0).
6. On `session_shutdown` it sends `bye` and closes.

Only the **main** agent session is bridged. A subagent's binding of the extension (`ctx.agent.kind === "sub"`) never connects; from 2.0.0 it hands its session's task bus to the owner copy (see [Subagents](#subagents)).

The TUI shows exactly one thing: a dim `⇄ teleflock` status-line notice while the owning copy is connected (copies share the status key; a copy only ever clears the notice it set).

### One bridge per omp process (bridge ≥ 1.4.0)

An omp process can load the extension more than once: the global install in `~/.omp/agent/extensions/` (the "TeleFlock bridge for every session" setup fix) is ambient and loads first, TeleFlock's launch recipe adds `-e <home>/ext/teleflock-bridge.ts`, and the two can be different versions. Before 1.4.0 each copy connected on its own, so hostd saw two connections per pid, routed requests to whichever said `hello` last, and `navigateTree` / `branch` / `newSession` failed with "could not capture the session command context" whenever that was not the copy omp runs `/teleflock-attach` in (omp's `getCommand` returns the **last** loaded extension's command).

1.4.0 copies coordinate through a process-wide slot, `globalThis[Symbol.for("teleflock.bridge")]`:

```ts
interface BridgeSlot {
  owners: Record<string, {version: string; stop(): void;  // active copy per hostd endpoint (socket path / pipe name)
                          relay?(frame: {channel: string; data: unknown; from?: string}): void}>; // 2.0.0
  cmdCtx?: ExtensionCommandContext;                        // stored by whichever copy's /teleflock-control ran
  attachWaiters: Array<() => void>;                        // called and removed by that handler
  uiReqSeq?: number;                                       // 2.0.0: last dialog reqId handed out in the process
}
```

- **Election.** On every main-session `session_start` / switch a copy claims `owners[endpoint]`: it becomes the owner when the slot is empty or the owner's `version` is lower (numeric `x.y.z` comparison). The highest version wins; on equal versions the first claimant (the global install) stays. A copy that takes over calls the previous owner's `stop()`, which closes its socket, stops its ticker and clears its status notice; the new owner then connects and says `hello`. Copies that do not own the slot never connect, tick or touch the status line. The owner releases the slot on `session_shutdown`.
- **Endpoints.** Copies resolve their endpoint independently (a global copy cannot use its location, see the resolution order above). They only end up with different endpoints when `TF_HOSTD_HOME` / `TF_BRIDGE_SOCK` disagree with the deployed copy's home; each of those hostds then still gets exactly one connection.
- **Command context.** 1.4.0+ copies capture it through their own hidden command `/teleflock-control`; older copies keep registering `/teleflock-attach` and keep the context to themselves. omp dispatches a command name to just one of its registrants, and in the lab (omp 18.13.1) that was the legacy global copy, not the `-e` copy, in the first omp started after the extension file changed, so a shared name could never be relied on. Every 1.4.0+ copy's handler stores the context in `cmdCtx` and resolves `attachWaiters`, so the owner finds it whichever 1.4.0+ copy omp ran the command in. `state.attached` reads the slot.
- **Compatibility contract.** The slot is shared across versions: later versions keep these fields and their meaning and only add optional ones. Copies older than 1.4.0 do not know the slot; hostd arbitrates them (see `hello`).
- **2.0.0 additions.** An owner's `relay` takes the task-bus frames that copies loaded in subagent sessions see (see [Subagents](#subagents)); an owner without it (1.4.x) simply gets none. `uiReqSeq` keeps dialog request ids unique for the process lifetime, also across a takeover, so a late `uiResponse` can never answer an unrelated dialog.

## Frames: extension → hostd

### `hello`
```json
{"t":"hello","v":1,"reason":"connect","previousSessionId":null,
 "pid":254512,"sessionId":"01a15b7f-298b-7641-aa67-c71874a55647",
 "sessionFile":"/root/.omp/agent/sessions/-tmp-w/2026-…_01a15b7f-….jsonl","cwd":"/tmp/w",
 "ompVersion":"18.13.2","bridgeVersion":"2.0.0","tui":true,
 "caps":{"live":1,"dialogs":true,"subagentCtl":true,"prompt":true},
 "state":{ …CtlState… }}
```
- `reason`: `connect` (new connection) or `switch` (same connection, new omp session).
- `tui`: omp runs the interactive TUI (`ctx.mode === "tui"`). Ops marked **TUI** below need it.
- `bridgeVersion`: omp loads the extension once per process, so a session keeps the bridge it started with. 1.1.0 runs `btw` through omp's own `/btw` (follow-ups, `getBtwHistory`); hostd refuses a `btwId` follow-up to an older bridge with `unsupported` and the hint to restart the agent. 1.2.0 adds the schema-dump mode (see "Schema dump"); 1.3.0 the settings-write mode (see "Settings write"); 1.4.0 the process slot ([One bridge per omp process](#one-bridge-per-omp-process-bridge--140)); 2.0.0 the [data plane](#data-plane-bridge--200).
- `caps` (2.0.0; absent before): `live` is the live-feed version (1); `prompt` that the `prompt` op exists; `dialogs` that the dialog wrappers sit on omp's UI context (false without a UI, e.g. print mode); `subagentCtl` that omp's `AgentLifecycleManager` (the instance omp runs) was found, so `agentCmd` works. hostd serves a session from the bridge, without collab, when `caps.live ≥ 1`.
- hostd keys sessions by `sessionId`. When two connections claim the same id, the latest `hello` wins, with one exception for two connections of the **same pid** (several copies in one process, at least one older than 1.4.0): only the copy with the highest `bridgeVersion` (semver) is routed. An older copy's `hello` is answered with `welcome` but registers nothing (it drops a session it was still routed for), its events are ignored and no request reaches it. Equal versions fall back to "latest `hello` wins". A different pid always takes the session over (a new process resumed it).

### `event`
```json
{"t":"event","event":"<name>","sessionId":"…","data":{…}}
```
hostd attributes events to the connection's current session (from its last `hello`).

| `event` | `data` | When |
|---|---|---|
| `state` | `CtlState` | Any field changed: model, thinking, fast, mode, goal, title, idle, context, leaf, queue, plan review, attached. Covers architecture §4's `model` / `thinking` change events. Checked once per second and after events. |
| `queue_update` | `{steering:string[], followUp:string[]}` | The TUI queue chip changed. omp redraws that band before it queues a collab-guest prompt, so steers TeleFlock sends through collab are missing from it until something else redraws it; hostd merges its own list of prompts it queued (kept until their user row lands) into `meta.queue` / `omp.queue`. |
| `plan_review_requested` | `PlanReviewInfo` | omp opened its interactive plan review. |
| `plan_review_resolved` | `{reviewId, choice: string\|null, by:"local"\|"extension"}` | The review closed. `choice` is `null` when it was dismissed or cancelled. |
| `btw_delta` | `{btwId, turn, question?, text, done, error?}` | Side-question stream, per turn of a `/btw` conversation (`turn` 0 is the question, then one per follow-up; older bridges omit it). `question` comes with the turn's first frame. While `done:false`, `text` is a **delta**. The single `done:true` frame carries the **full final reply** in `text`, or `error` (`cancelled`, `interrupted`, or the failure). Sent for side questions asked through TeleFlock **and** for `/btw` typed in omp's TUI. |

### `res`
```json
{"t":"res","id":7,"ok":true,"result":{…}}
{"t":"res","id":7,"ok":false,"error":{"code":"busy","message":"handoff needs the agent to be idle"}}
```

### `bye`
`{"t":"bye","sessionId":"…"}`: sent on `session_shutdown`, just before closing.

### `live` (2.0.0)
`{"t":"live","seq":17,"f":<frame>}`: one frame of the [live feed](#live-feed). `f` is shaped exactly like an omp collab host→guest frame (`event`, `state`, `bus`, `agents`, `ui-request`, `ui-request-end`).

### `resync` (2.0.0)
`{"t":"resync","seq":1,"sessionId","sessionFile","leafId","lastEntryId","live":{"streaming":bool,"frames":[<frame>…]}}`: the snapshot that starts a live feed and replaces one that overflowed. See [Live feed](#live-feed).

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
| `btw` | `question`, `btwId?` (follow up on that conversation) | `{btwId, turn}` once omp started the turn; the answer arrives as `btw_delta` events | omp's own `/btw` (see "Side questions") | | 30 s |
| `btwCancel` | `btwId` | `{}` once omp marked the turn cancelled (its final `btw_delta` carries `error: "cancelled"`) | omp's Esc on the `/btw` panel | | 10 s |
| `getBtwHistory` | – | `{threads:[{btwId, at, turns:[{question, answer, status, error?, at}]}]}`, oldest first; `status` `running\|complete\|cancelled\|error\|interrupted` | the session's BTW history files, overlaid with live turns | | 10 s |
| `export` | `path?` (default `<artifacts dir>/teleflock-export-<sessionId>-<ms>.html`; no whitespace) | `{path}` | `/export <path>`, then waits up to 15 s for the file | ✓ | 30 s |
| `handoff` | `focus?` | `{settled}` | `/handoff [focus]`. Needs the agent idle. | ✓ | 600 s |
| `slash` | `command` (single line, starts with `/`) | `{settled}` | Any slash command through the composer. omp runs builtins (e.g. hostd's `/collab ws://127.0.0.1:<port>` for `agent.connect`) at once even while the agent streams. | ✓ | 30 s |
| `abort` | – | `{}` | `ctx.abort()` | | 10 s |
| `getTree` | – | `TreeInfo` | `sessionManager.getEntries()` | | 10 s |
| `getQueue` | – | `{steering, followUp}` | TUI queue chip contents (empty without the TUI) | | 10 s |
| `getCommands` | – | `{commands:[{name, description?, source}]}` | `pi.getCommands()`: extension, prompt-template and skill commands (`source` `extension`/`prompt`/`skill`; builtins excluded; the bridge's own `teleflock-control` and older copies' `teleflock-attach` filtered out) | | 10 s |
| `dequeue` | – | `{text?}` | TUI `editor.onDequeue()` (Alt+Up) pops the last queued message (steer first, then follow-up); the popped text is returned and the operator's draft and images are restored. Tried when the band lists something or `ctx.hasPendingMessages()` (the band can lag guest steers); `{}` when nothing was popped. Popped images are dropped | ✓ | 10 s |

`{settled:false}` means that after 15 s the command was still waiting on a TUI dialog (for example "Exit plan mode?"). The operator must answer it in the terminal.

Data-plane ops (`liveSubscribe`, `liveUnsubscribe`, `prompt`, `uiResponse`, `agentCmd`; bridge ≥ 2.0.0): see [Data plane](#data-plane-bridge--200).

## Errors

| `code` | Meaning | `ApiError` (hostd) |
|---|---|---|
| `invalid_params` | missing or ill-typed param, unknown level, choice or placement | `invalid_params` |
| `not_found` | unknown model, entry id, plan review, btw conversation, or no running btw | `not_found` |
| `unsupported` | not in the TUI, no ephemeral turns, fast tier unavailable, plan mode refused, a btw that only omp's TUI can cancel, `agentCmd` without omp's agent lifecycle manager | `unsupported` |
| `busy` | needs idle, plan mode is waiting for a terminal confirmation, another `/btw` is still answering (omp runs one at a time), or omp is compacting while the command context is still to be captured | `busy` (retryable) |
| `auth_required` | model has no credentials | `auth_required` |
| `nothing_to_compact` | the session is too small or already compacted | `omp_error` (message kept) |
| `cancelled` | an extension hook cancelled the navigation, branch or new session | `omp_error` |
| `not_ready` | request arrived before `session_start` | `not_connected` (retryable) |
| `unknown_op` | older extension | `unsupported` + update hint |
| `omp_error` | anything omp threw | `omp_error` |

hostd-side failures: `NotConnected` → `not_connected` (retryable, hint: start via TeleFlock or install the extension). `Timeout` → `timeout` (retryable). `Disconnected` → `not_connected` (retryable). An undecodable result → `omp_error`.

## Data plane (bridge ≥ 2.0.0)

Everything here is announced by [`hello.caps`](#hello); a bridge without `caps` has none of it, and hostd keeps using collab for its session.

### Ops

| op | params | result | Mechanism | hostd timeout |
|---|---|---|---|---|
| `liveSubscribe` | – | `{}` | Starts (or restarts) the [live feed](#live-feed) on this connection: anything still queued for an earlier feed is dropped, a `resync` goes out first, **before** this request's `res`, then `live` frames. | 10 s |
| `liveUnsubscribe` | – | `{}` | Ends the feed; queued live frames are dropped. | 10 s |
| `prompt` | `text`, `images?: [{data: base64, mimeType: "image/…", type?: "image"}]`, `delivery?: "auto"\|"steer"\|"followUp"` (default `auto`) | `{queued}` | `pi.sendUserMessage(text \| [{type:"text",text}, …images])`. Idle: starts a turn whatever `delivery` says (`queued: false`). Streaming: `auto` / `steer` steer the running turn, `followUp` waits for its end (`queued: true`). Never slash-dispatched. `text` may be empty when images are given. | 10 s |
| `uiResponse` | `reqId`, `value: string\|null` (`null` or absent = cancel) | `{}` | Answers the pending dialog `reqId` with collab's `ui-response` value semantics (see [Dialogs](#dialogs)). An unknown or already settled `reqId` is no error: the `res` is ok and a `ui-request-end` for it follows on the live feed, as omp's collab host does. | 10 s |
| `agentCmd` | `cmd: "chat"\|"kill"\|"revive"`, `agentId`, `text?` (chat) | `{}` | omp's collab host `#handleAgentCmd`. `chat`: `AgentLifecycleManager.global().ensureLive(agentId)` (revives a parked subagent), then `session.prompt(text, {streamingBehavior: "steer"})`; returns once the prompt is dispatched (a failure within 1.5 s is reported, later ones are logged). `kill`: aborts a running subagent (`USER_INTERRUPT_LABEL`), then `release(agentId, ref, {tombstone: true})`. `revive`: `ensureLive`. Advisors are refused (`invalid_params`). Without `caps.subagentCtl`: `unsupported`. | 30 s |

### Live feed

- Frames: `{"t":"live","seq":N,"f":<frame>}` and `{"t":"resync","seq":N,…}`. `seq` starts at 1 on each connection and grows by one per live / resync frame. It is assigned when the frame is written, so it is contiguous on the wire; a gap is a bug (re-subscribe).
- `f` is an omp collab host→guest frame (`crates/tf-collab/src/frame.rs` `HostFrame`), so hostd feeds it to its `Replica` unchanged:
  - `{"t":"event","event":{…}}`: the session's agent events, the set and shape omp's collab host mirrors (`agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `notice`, `auto_compaction_start` / `_end`, `auto_retry_start` / `_end`, `thinking_level_changed`). `message_update` carries the cumulative `message`. Payloads that repeat other frames are left out: `assistantMessageEvent.partial` / `.message` (= `message`), `agent_end.messages`, `turn_end.message` / `.toolResults` (= the turn's `message_end` frames).
  - `{"t":"state","state":{isStreaming, isAborting, queuedMessageCount, sessionName?, cwd, model, thinkingLevel, contextUsage: {tokens, contextWindow, percent}, participants: []}}`: collab's `#buildState`, debounced 100 ms and sent only when it changed (checked after state-changing events, after every request and every second). `model` holds `id, name, api, provider, baseUrl, reasoning, input, contextWindow, maxTokens` (no provider headers).
  - `{"t":"bus","channel":"task:subagent:progress"|"task:subagent:lifecycle","data":…}`: the task bus at every depth (see [Subagents](#subagents)).
  - `{"t":"agents","agents":[AgentSnapshot…]}`: collab's roster plus `sessionFile` (absolute path, or `null`) on every agent, main included. Debounced 100 ms after an agent-registry change, sent only when it changed.
  - `{"t":"ui-request","request":…}` / `{"t":"ui-request-end","reqId":N}`: see [Dialogs](#dialogs).
- Source: the extension finds omp's own `AgentSession` of the main session (`pi.pi.AgentRegistry.global().get(ctx.agent.id).session`) and subscribes to it as omp's collab host does, so it sees every event synchronously and in order, `notice` and `thinking_level_changed` included. Until it is found, extension events stand in (without those two; `message_update` / `tool_execution_update` only on an omp without the registry, since any handler for them makes omp build an extension context per streamed token).
- Ordering quirk (omp's, the same in collab): the ask tool's `ui-request` can come before its `tool_execution_start`. The assistant `message_end` before it already carries the tool call.

#### `resync`

```json
{"t":"resync","seq":1,"sessionId":"…","sessionFile":"/…/….jsonl","leafId":"…","lastEntryId":"…",
 "live":{"streaming":true,"frames":[{"t":"state",…},{"t":"agents",…},{"t":"event","event":{"type":"message_update",…}},…]}}
```

Taken synchronously when it is written (between two omp events). hostd applies the session file through `lastEntryId`, then `live.frames` in order, then the `live` frames with a higher `seq`.
- `lastEntryId`: the newest entry already in the session file (`getEntries()` order; `title_change` entries are skipped, omp writes those asynchronously). `null` while omp has not written the file yet (it materializes a fresh session with its first assistant message); `frames` then starts with that session's entries as collab `entry` frames (`message`, `custom_message`, `compaction`, `branch_summary`, `model_change`, `thinking_level_change`).
- An entry can still be on its way to the file when a resync is taken (omp queues message persistence after `message_end`), while its event is already behind the resync's seq: hostd gets it from its file tail.
- `frames` order: [`entry`…] → `state` → `agents` → in-flight `event`s (`auto_compaction_start` / `auto_retry_start` while running; the streaming assistant message as one `message_update` with omp's live `streamMessage`, which can be ahead of the last update sent; per running tool its `tool_execution_start`, then its latest `tool_execution_update`) → per subagent (least recently active first) its latest lifecycle, then its latest progress `bus` frame → one `ui-request` per pending dialog, oldest first.
- `streaming`: the AgentSession's `isStreaming`.

#### Flow control

The extension never blocks omp and never fails because hostd is slow.
- **Source throttles.** `message_update` at most once per 50 ms per message, `tool_execution_update` once per 100 ms per tool call, the newest kept as the trailing call. No update follows its message's / tool call's end frame (a held one is dropped at the end).
- **One ordered writer per connection.** Every frame, control frames (`res`, `event`, `hello`, `bye`) included, goes through it, so nothing overtakes anything. While the socket holds more than **1 MiB** unsent (`writableLength`), frames wait in the writer's queue, where a queued `message_update` (per message), `tool_execution_update` (per tool call), subagent progress (per subagent), `state` or `agents` frame is **replaced** by its newest version: the stale one is dropped and the new one appended, so what arrives is always a subsequence of what omp produced. Starts, ends, lifecycle and dialog frames are never dropped. The queue drains on the socket's `drain` event (and every tick).
- **Overflow.** When the queued non-replaceable live frames pass **16 MiB**, every queued live frame is dropped and one `resync` takes their place, built when it is written; live frames produced while it waits are covered by it and skipped. Control frames stay.
- **Stall.** Queued control frames past 64 MiB mean hostd stopped reading: the extension drops the connection and reconnects on the 5 s schedule.
- **Frame size.** A live frame over 8 MiB of JSON is clipped (long strings and arrays cut with a marker, like omp's collab shrink), else replaced by a collab-style `notice` naming what was omitted; a `resync` is bounded at 48 MiB. hostd's line limit is 64 MiB.
- **Lab knob.** `TF_BRIDGE_LIVE_LIMITS=<highWater>,<overflow>` (bytes) in omp's environment lowers the two limits, so a paused fake hostd (`probe.ts` `pause`) shows backpressure and an overflow with an ordinary turn.

#### Session switch

A `hello{reason:"switch"}` ends the feed: queued live frames are dropped and no live frame follows the hello until hostd sends `liveSubscribe` again (whose resync describes the new session). A dropped connection ends the feed too. Pending dialogs survive both and come back in the next resync.

### Dialogs

The extension wraps the dialog members of omp's **shared** extension UI context: `askDialog`, `approve`, `select`, `editor`, `confirm`, `input`. It reaches that object through the handler context's prototype (`Object.getPrototypeOf(ctx).ui`, omp's `trackUserWaits` proxy) and defines each wrapper on the proxy's target, so everything that reads the member on each call (the ask tool and approvals through their own proxies over the same object, extensions, commands) calls the wrapper. A mode re-init that hands out a new UI object is wrapped again on the next tick; another bridge copy's wrapper stays underneath and passes straight through once that copy stopped bridging.

Each call races omp's own dialog against hostd, exactly as omp races its collab guests (`modes/controllers/extension-ui-controller.ts` `#raceCollabDialog`, `showAskDialog`): the request is offered at once (a `ui-request` live frame, or in the next `resync` while hostd is not subscribed or not connected), the **first answer wins**, and the loser is cancelled through its abort signal (the TUI dialog closes, hostd gets `ui-request-end`). A request that can no longer be answered remotely (the caller's signal aborted, the bridge stood down or shut down) leaves the decision to the TUI. At most 64 requests are pending; beyond that dialogs stay local.

What hostd sees (collab's `ui-request` kinds) and how its `value` maps back:

| member | `ui-request` | `value` → result |
|---|---|---|
| `select` | `{kind:"select", title, options, initialIndex?, selectionMarker?, checkedIndices?, markableCount?, helpText?}` (omp's own mirroring) | the label; cancel → `undefined` |
| `editor` | `{kind:"editor", title, prefill?}` | the text; cancel → `undefined` |
| `approve` | `{kind:"select", title: prompt.full, options: approvalChoiceLabels(prompt)}`: title `Allow tool: <tool>\n<details>`, options grant labels, `Approve` (or `Approve Once` beside grants), the session label, `Deny` | omp's `approvalAnswerForChoice`: once / session / grant; anything else or a cancel denies |
| `askDialog` | one select per question, in order: radio `[…options, "Other (type your own)", "Chat about this"]` with `initialIndex` = `recommended`, or (multi) a checkbox loop that toggles one label per round and offers `"Next →"` once something is checked; `"Other"` is followed by `{kind:"editor", title:"Custom answer: <question>"}` (cancelling that reopens the question) | omp's ask result `{kind:"submit", results:[{id, question, options, multi, selectedOptions, customInput?}]}`; `"Chat about this"` → `{kind:"chat"}`; a cancel → `undefined`. Labels that collide with the sentinels get a ` (2)` suffix and map back. |
| `confirm` | `{kind:"select", title:"<title>\n<message>", options:["Yes","No"]}` (omp keeps it local for collab) | `"Yes"` → true, else false |
| `input` | `{kind:"editor", title}` (omp keeps it local for collab) | the text; cancel → `undefined` |

`reqId`s are positive integers, unique for the omp process's lifetime (never reused, also across a bridge takeover).

### Subagents

- **Bus.** omp emits `task:subagent:progress` / `task:subagent:lifecycle` for a subagent on its spawner's session bus (that session's `pi.events`) and on a root observability bus that extensions cannot reach. The main session's binding mirrors its bus (direct subagents). Every subagent session loads the extension too: that binding hands its own bus (its children, which no bus an extension sees otherwise carries) to the owner copy through `owners[endpoint].relay`, at every depth. The owner sends each payload object once (two copies in one session relay the same object), unchanged, as a collab `bus` frame; progress is replaceable per `progress.id`.
- **Roster.** From omp's `AgentRegistry.global()` (`list()`, advisors excluded; `onChange` → `agents` frame). Without the registry: the main agent plus every subagent a lifecycle frame named (`started` → running, `completed` → idle, else aborted; `parentId` = the relaying session's agent id).
- **Transcripts.** Every roster entry carries `sessionFile`; hostd reads subagent transcripts from those files.
- **Control.** `agentCmd` (above) uses omp's `AgentLifecycleManager`, imported from `@oh-my-pi/pi-coding-agent/registry/agent-lifecycle` and used only when it is the instance omp runs (its `AgentRegistry` module is the one behind `pi.pi.AgentRegistry`).

## TUI mechanics (why some ops need the TUI)

- **Composer submit.** TUI-only commands (`/plan`, `/goal`, `/fork`, `/handoff`, `/export`, `/fast`, `/queue`, `slash`) run through the main composer's own Enter handler (`editor.onSubmit(text)`), exactly as if the operator typed them. No herdr keystroke injection is involved.
  - The operator's draft is protected: pasted images are held back from the submission and the draft text is restored if a command cleared it.
  - Submitted commands appear in the composer's ↑ history.
- **Finding the composer.** The extension reaches the TUI once by opening and immediately closing an empty `ctx.ui.custom()` component, restoring keyboard focus to whatever had it, and then locates the composer in the component tree.
- **Command context.** `navigateTree`, `branch` and `newSession` need an `ExtensionCommandContext`. The extension captures it once per process by submitting its own hidden command `/teleflock-control` (`/teleflock-attach` before 1.4.0) through the composer, waits ≤ 5 s for a handler to store it in the process slot (any 1.4.0+ copy's handler does), and keeps it for the life of the main session (`state.attached: true`). While omp compacts (or hands off) it queues submitted commands under "Steering" until it finishes: when `/teleflock-control` shows up there, the op fails at once with `busy` ("omp is compacting the session; try again when it finishes") instead of timing out, and the queued command still captures the context once the compaction ends. If no handler stored the context within 5 s, the op fails with `unsupported` "could not capture the session command context".
- **Focused subagent.** If the operator has focused a subagent in the TUI, composer submissions go to that subagent (omp behaviour).

## Side questions (`/btw`)

A TeleFlock side question is omp's own `/btw`, so it shows in the TUI, lands in the session's BTW history and can be continued from either side. `btwId` is omp's history topic id.

- **Ask.** `/btw <question>` (whitespace collapsed to one line) goes through the composer like the other TUI commands. omp shows its inline answer panel and checkpoints the topic to `<artifacts>/btw-history/entry-<id>.json`; the op returns once that file exists.
- **Follow up.** omp continues a conversation only from its BTW history panel (`f` on an answer opens the same composer). The extension opens the panel with `/btw` when it is closed, calls its `openFollowUp(btwId)`, pastes the question and submits it. The panel stays open in the TUI showing the conversation, exactly as after a follow-up typed there; Esc closes it (Esc while it still answers cancels, as in omp).
- **Streaming.** Three sources feed `btw_delta`, whichever comes first: the history files (read on every 1 s tick: turn start and end, also for `/btw` asked in the TUI), the inline answer panel and the history panel (the extension wraps their update methods on the instance; omp's originals always run first and wrapper failures are swallowed). The first scan of a session only learns the existing history.
- **Cancel.** The operator's Esc where omp listens for it: the history panel when open (`x` with native rendering), else the composer's Esc handler, which a visible `/btw` panel owns first.
- **Fallback.** Without the TUI, or for a session with no artifacts directory, `btw` runs a private `ctx.runEphemeralTurn` with omp's btw prompt, replaying the conversation's earlier turns (one provider lineage per run of successful turns, as in omp). Those conversations live in the extension's memory only (ids `tf-btw-…`), are listed by `getBtwHistory`, and are aborted when hostd disconnects.

## Schema dump (`TF_OMP_SCHEMA_OUT`, bridge ≥ 1.2.0)

Not a socket protocol: a one-shot mode tf-hostd uses for `omp.settings` (architecture §3.10). When `TF_OMP_SCHEMA_OUT=<file>` is set in omp's environment at load, the extension opens no socket, registers nothing and only:

1. imports `@oh-my-pi/pi-coding-agent/config/all-settings` (a literal specifier: omp's extension loader maps only statically named package paths) and calls `orderedSettings()`;
2. writes `{bridgeVersion, ompVersion, settings, error?}` to `<file>.<pid>.tmp` (mode 0600) and renames it to `<file>`. `settings` is every setting's `definition` in settings-panel order as plain JSON (`id, type, default, values, env, credential, items, pathScoped, protocolDefault, ui {tab, group, label, description, options | "runtime", condition, warning, editor, secret, ordered}`; validators, normalizers and env parsers are functions and drop out), or `null` with `error` when the module or function is missing (older omp);
3. exits the process right after loading (omp refuses `process.exit` during extension loading, so the exit is scheduled for the next tick).

hostd starts it as `omp --mode rpc --no-session --no-skills --no-rules --no-lsp --no-tools --no-extensions -e <home>/ext/teleflock-bridge.ts` with stdin at EOF (no model call, no session file), waits ≤ 20 s for the file and kills the child either way. hostd only does this when the deployed file contains the `TF_OMP_SCHEMA_OUT` marker: an older bridge would ignore the variable and run as a normal bridge.

## Settings write (`TF_OMP_SETTINGS_IN`, bridge ≥ 1.3.0)

Not a socket protocol either: a one-shot mode tf-hostd uses for `omp.settingsSet` batches that set a credential (architecture §3.10), so the value never appears in a command line. When both `TF_OMP_SETTINGS_IN=<in>` and `TF_OMP_SETTINGS_OUT=<out>` are set at load (paths only; values never travel in the environment), the extension opens no socket, registers nothing and only:

1. reads `<in>`, `{changes: [{key, text}]}` (`text`: the string `omp config set <key> <text>` would get, `null` = reset; hostd writes the file 0600 under `<home>/run`), and deletes it right away, read or not;
2. imports `@oh-my-pi/pi-coding-agent/config/settings` and `…/config/all-settings` (literal specifiers, as above) and applies the changes in order to `Settings.instance` exactly as omp's `config set|reset` does: `setting.set(store, setting.parse(text))` or `setting.unset(store)`, stopping at the first failure, then `store.flush()`;
3. writes `{bridgeVersion, results: [{key, ok, error?}], error?}` to `<out>.<pid>.tmp` (mode 0600), renames it to `<out>` and exits like the dump. `error` (input unreadable, modules missing, flush failed) means nothing can be assumed written. Values are never echoed.

hostd starts the same throwaway omp as for the dump, waits ≤ 20 s for `<out>`, kills the child, and removes both files either way. It only does this when the deployed file contains the `TF_OMP_SETTINGS_IN` marker; with an older bridge the credential write is refused (`unsupported`, hint: the setting's environment override) and nothing is written.

## Safety rules (extension)

- It never throws into omp. Socket callbacks, the ticker, promise chains, every event handler, the AgentSession listener and the dialog wrappers are wrapped in try/catch; a dialog wrapper that cannot race (unexpected arguments, its copy no longer bridging) calls omp's own dialog alone. The ticker uses `ctx.setInterval`, which omp clears on shutdown; the short throttle and debounce timers are unref'd one-shots.
- hostd's pace never reaches omp: a slow or stuck hostd costs queue memory bounded by the flow-control limits above, never a blocked omp event.
- It answers bad frames with nothing (or a `res` error) and never closes the TUI.
  - Lab-verified: garbage JSON, non-object frames, unknown ops, bad params, a 2 MB junk line, abrupt disconnects mid-request and mid-btw. omp kept the same pid throughout.
- Logs go to omp's debug log only (`pi.logger.debug`); nothing is printed into the TUI.
