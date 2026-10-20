# omp surface map for TeleFlock (omp 18.12.3)

Phase A research: what a user can do in omp, and how TeleFlock can reach each item remotely.
Written by ResearchOmpSurface. The collab wire protocol itself is out of scope here; it is covered in `docs/research/omp-collab.md` (written by ResearchOmpCollab).

**Evidence tags**
- `[observed]`: I ran it, in the lab herdr session `tf-lab-omp` or with read-only CLI calls on this host.
- `[source]`: I read it. Paths are relative to `.research/omp-src/package/src/` unless they start with `pi-tui/`, `pi-wire/` (both under `.research/omp-src/`), `omp://` or `~`.
- `[inferred]`: my conclusion, not verified.

Samples live in `docs/research/omp-samples/`; there is an index at the end.

---

## 0. Decisions and top findings

1. **Recommended backbone: collab guest + a TeleFlock companion extension, with herdr injection as the fallback.**
   - **The TUI stays in the herdr pane.** That keeps herdr state tracking and the real terminal working.
   - **Collab carries the data plane:** entries, events, approvals and ask, and subagent chat, kill and revive.
   - **A per-process extension handles structured control** that collab and the TUI lack. TeleFlock loads it with `omp -e <tf-bridge.ts>`, and it touches no global config. It covers model, thinking, fast/slow, the follow-up queue, rename, compact, abort, tree navigation, branch, and plan-review answers. **This was proven in the lab** (§9.3).
   - **Slash injection through herdr is the fallback** for sessions TeleFlock did not launch.
   - **RPC is rejected as the backbone.** A second process cannot attach to a live TUI session: the session ownership lease forks it into a sibling file (§5.6, §9).
2. **Slash injection works but is fragile.** All of the following were `[observed]`:
   - An unknown slash command such as `/thinking` is **sent to the model as a prompt**.
   - Autocomplete **eats the Enter** when an argument isn't typed exactly as the completion.
   - Overlays (`/session`, `/btw`, `/context`, selectors) **swallow the next injected input**.
   - herdr refuses `agent prompt` while omp is blocked.
   - Esc-abort moves queued follow-ups **back into the composer**.
3. **Several capabilities are selector-only in the TUI**, with no argument form: `/model`, `/tree`, `/branch`, `/resume` (with no argument), `/settings`, `/agents`, `/hub`. Use these instead:
   - **Model:** `/switch <provider/id[:level]>` changes the model for the session only.
   - **Thinking:** `/effort <level>`.
   - **Tree and branch:** only the extension (`navigateTree`/`branch`) or RPC (`branch`/`get_tree`) can do these non-interactively.
4. **`/plan` swaps to the `plan` model role.** On this host that is `anthropic/claude-opus-5-5:max`, an expensive model. It is a 3-state toggle (on → paused → off) `[observed]`.
5. **What herdr reports:**
   - **States:** `working`, `blocked` and `idle`; never `done`.
   - **`blocked`** comes only from the ask tool, tool approvals, a persistent retryable provider error, or an extension-emitted `herdr:blocked` event.
   - **Not reported as blocked:** plan review, the goal menu, hook confirms, and the "Exit plan mode?" confirm (§8).

---

## Lab session recipe (`tf-lab-omp`)

The default herdr session was never mutated. Every mutating command used the wrapper below, which points at the lab socket.

```sh
# start a private herdr server (I ran this as a long-lived service; ResearchHerdr recommends:
#   cd ~ && setsid -f herdr --session tf-lab-omp server </dev/null >/tmp/tf-lab-omp.out 2>&1 )
env -u HERDR_SOCKET_PATH -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_ENV \
  herdr --session tf-lab-omp server
# wrapper /tmp/tf-lab-omp/h : forces the lab socket, drops inherited pane ids
exec env -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
  HERDR_SOCKET_PATH=/root/.config/herdr/sessions/tf-lab-omp/herdr.sock herdr "$@"
# workspace in a scratch git repo
mkdir -p /tmp/tf-lab-omp/work && git -C /tmp/tf-lab-omp/work init
h workspace create --cwd /tmp/tf-lab-omp/work --label omp-lab      # → w1:p1
h agent start lab1 --kind omp --pane w1:p1 -- --model openai-codex/gpt-6-luna --thinking low
# stop: herdr session stop tf-lab-omp
```

**Lab model.** The `tiny` role is `openai-codex/gpt-6-luna:low` (`omp config get modelRoles --json`) `[observed]`. All lab prompts used it, except the one accidental `/plan` model swap, during which no prompt was sent.

**Codex capacity.** Codex returned `turn_rate_limit_exceeded` several times. omp retried automatically (up to 10 times) and showed `Retrying (n/10)…` in the TUI `[observed]`.

---

## 1. Slash command catalog

### 1.1 Dispatch mechanics `[source]`

- **Parsing:** `parseSlashCommand` splits at the first whitespace **or `:`**, so `/foo bar` ≡ `/foo:bar` (`slash-commands/helpers/parse.ts:16-35`).
- **Lookup order:** TUI builtins are dispatched on editor submit, before the prompt path. A builtin without `allowArgs` falls through to the prompt path when given arguments (`slash-commands/builtin-registry.ts:140-177`, `modes/controllers/input-controller.ts:958-1087`).
- **Non-builtin commands** are resolved inside `AgentSession.prompt()` in this order:
  1. extension commands
  2. custom TS/MCP commands
  3. file commands
  4. prompt templates
  5. `/skill:<name>`

  **Anything unmatched is sent to the model as literal text** (`session/agent-session.ts:7666-7693`). `[observed]`: `/thinking medium` produced the assistant reply "What would you like me to think through?" and cost tokens.
- **While streaming,** Enter submits text with `streamingBehavior:"steer"`; Ctrl+Q / Ctrl+Enter submit it as `"followUp"`. Builtins still run first (`input-controller.ts:1228-1279,1878-1962`).
- **Collab guests:**
  - A guest's **prompt frame bypasses the slash dispatcher entirely**. It becomes `session.promptCustomMessage({customType: COLLAB_PROMPT_MESSAGE_TYPE, …}, {streamingBehavior:"steer"})` (`collab/host.ts:978-1003`).
  - A guest can run only a local allowlist on its own replica: `dump, export, copy, open, help, hotkeys, theme, settings, leave, collab, exit, quit` (`collab/guest.ts:49-64`).
  - **⇒ A collab guest cannot run host slash commands, and cannot send a follow-up instead of a steer.**

### 1.2 Injection rules learned in the lab `[observed]`

| # | Behavior | Evidence | Rule for TeleFlock |
|---|---|---|---|
| I1 | `herdr agent prompt <a> "<text>"` sends a bracketed paste, then Enter about 300 ms later (ResearchHerdr). | All runs. | Use it for idle submits. |
| I2 | **If the argument doesn't match a completion exactly, the autocomplete popup consumes the Enter.** | `/switch :medium` became composer text `/switch openai-codex/gpt-6-luna:medium` and was not submitted. A second `send-keys enter` submitted it. `/switch openai-codex/gpt-6-luna:low`, `/fast status`, `/fast on`, `/todo append …` and `/rename …` all submitted on the first Enter. | Always inject the **canonical full form**. Afterwards read the pane: if the composer still holds the text, send `enter` once more. |
| I3 | Unknown commands go to the model. | `/thinking medium`. | Never inject a name that isn't in `get_available_commands` (the RPC sample lists 100+ names) or in this catalog. |
| I4 | **Overlay panels capture input.** | After `/session info`, the next injected `/context` was swallowed by the panel and lost. `/btw` and `/branch` also show modal UIs ("Esc to close"). | Before injecting, check that the pane's last line is the composer. Close an overlay with `esc` **only if one is visible**, because Esc on a streaming composer aborts the turn. |
| I5 | `agent prompt` is rejected while omp is blocked. | `{"error":{"code":"agent_blocked",…}}` during an ask dialog. | Answer asks and approvals through collab `ui-response` or `send-keys` (ask: `down`, `enter`; approval: `ctrl+q` approves, `esc` denies). |
| I6 | Enter while streaming is a **steer**. | The steer is recorded as user message `"steering":true`. | Follow-up: `pane send-text <p> "<text>"`, then `agent send-keys <a> ctrl+q`. The TUI showed "After yield · 1". |
| I7 | **Esc aborts and restores queued follow-ups into the composer.** | The queued text reappeared in the editor. | After a remote abort, send `ctrl+c` to clear the draft (or keep it as a draft on purpose). |
| I8 | Background jobs re-wake the agent after an abort. | After the abort, `[async-result]` of `bg_1` started a new turn ("done steered"). | Abort does not cancel `/jobs`. Use `/jobs kill all` to stop background jobs. |
| I9 | `/rename <t>` is asynchronous: a title card is generated first. | Two injected `/rename` attempts right after a goal turn produced no `title_change` (cause unknown; they may have been superseded). A third attempt landed about 2 s after submit. | Treat rename as eventually consistent, and confirm it from the title slot or `title_change`. The bridge's `pi.setSessionName` is instant. |
| I10 | `/compact` on a small session fails. | "Compaction failed: Nothing to compact (session too small)". | Surface the error to the user. |

### 1.3 Builtins

The catalog comes from the source (SlashCatalog scout, `slash-commands/*.ts`) plus lab checks.

**Column meanings**
- **Full args:** "direct" means the command acts without UI. "SEL" opens a selector or dialog, named in the cell. "panel" opens a modal info panel (rule I4).
- **Guest:** Y means a collab guest can run it on its replica, which does not affect the host. N means host only.
- **Injectable:** can it be driven by herdr text injection?

#### Modes and model

| Command | Syntax | No args → / full args → | Guest | Effect | Injectable |
|---|---|---|---|---|---|
| `/model` (`/models`) | none in the TUI | Always **SEL `ModelHubComponent`**. **The TUI ignores args** (`builtin-modes.ts:494-497`). ACP/RPC accept a selector. | N | Pick role models. | No: use `/switch`. |
| `/switch` | `[selector]`: fuzzy id, `provider/id`, `@role`, `:level` suffix | No args → SEL `ModelPickerComponent` (temporary). Args → direct. | N | Session-only model switch. Writes `model_change{role:"temporary"}` and `thinking_level_change` `[observed]`. | Yes. **Exact form required (I2).** |
| `/effort` | `[off\|minimal\|low\|medium\|high\|xhigh\|max\|auto]` | No args → SEL `ThinkingSelectorComponent`. Level → direct. | N | Sets thinking ("Thinking set to medium.", `thinking_level_change`) `[observed]`. | Yes |
| `/fast` | `[on\|ultra\|off\|status]`; no args toggles | direct | N | Service tier priority/ultrafast → `service_tier_change{serviceTier:{openai:"priority"}}` / `null` `[observed]`. | Yes |
| `/slow` | `[on\|off\|status]` | direct | N | flex tier (OpenAI/Google). For Anthropic it is a global settings flag (`providers.anthropic.slowMode`). | Yes |
| `/plan` | `[prompt]` | Toggles **off → on → paused → off** `[observed]`. With a prompt: enter and submit. Exiting with a draft plan opens **confirm "Exit plan mode?"** (`showHookConfirm`, not mirrored to collab) `[source] interactive-mode.ts:6093-6101`. | N | Swaps to the `plan` role model `[observed: Opus 5.5 max]`. Writes `mode_change` `plan`{planFilePath}, `plan_paused` and `none`. | Yes |
| `/plan-review` | none | **SEL plan-review overlay** | N | Re-open plan approval. | Open yes; answer no (use the extension's `resolvePlanReview`). |
| `/goal` | `[objective] \| set <obj> \| show \| pause \| resume \| drop \| budget <N\|off>` | No goal + no args → SEL editor "Goal objective". Active/paused goal + no args → SEL goal menu. Subcommands → direct. | N | Autonomous objective (§3). | Yes, with subcommands |
| `/guided-goal` | `[rough objective]` | direct (chat interview) | N | Interview, then goal. | Yes |
| `/vibe` | `[prompt]` | toggle | N | Director mode with worker sessions. | Yes |
| `/loop` | `[count\|duration] [--while\|--until '<cmd>'] [prompt]` | toggle/config | N | Re-submit a prompt after every yield. Esc suspends. | Yes |
| `/queue` | `<message>` | direct | N | Queue a follow-up for after the yield. **An idle-safe way to inject a follow-up.** | Yes |
| `/skillful` `/extended-context` `/computer` | `[on\|off\|status]` | direct | N | Session toggles. | Yes |
| `/prewalk` | `[restart\|off]` | direct | N | Arm switching to `@smol` at the first edit. | Yes |
| `/modelpreset` | `[list\|save <n>\|switch <n>\|delete <n>]` | No args → SEL | N | Role and thinking presets. | With args |
| `/ratchet` | `[flow and goal]` | direct | N | Eval hill-climb. | Yes |
| `/security` | `<plan\|scan\|status\|…>` | direct (no args = `scans`) | N | Security scans. | Yes |
| `/settings` | none | **SEL `SettingsSelectorComponent`** | Y | Settings UI. | No |
| `/setup` (`/providers`) | `[providers]` | SEL wizard | N | Provider setup. | No |

#### Session

| Command | Syntax | Behavior | Guest | Effect | Injectable |
|---|---|---|---|---|---|
| `/new` | none | direct | N | Starts a new session (new file). `session_switch` → herdr re-reports the session path. | Yes |
| `/resume` | `[id\|@claude\|@codex]` | No args → **SEL `SessionSelectorComponent`**. Id → direct. | N | Switch to another session in this process. | With id |
| `/fork` | `[pane\|window\|tab]` | No args → in-place fork. **`pane`/`window` → native herdr launch** `[observed]` | N | New JSONL with `parentSession` (§5.4). | Yes |
| `/branch` (`/rewind`) | none | **SEL `RewindSelectorComponent`** ("↑/↓ step ←/→ user turns f filter ⏎ rewind") `[observed]` | N | Move the leaf to before a user message. | No: use the extension's `branch`. |
| `/tree` | none | **SEL `TreeSelectorComponent`** (full entry list) `[observed]` | N | Switch branches. | No: use the extension's `navigateTree`. |
| `/rename` | `[title]` | direct, async (I9). No args → model-generated title. | N | `title_change` + title slot + `history.db.session_titles`. | Yes |
| `/handoff` | `[focus]` | direct. **Refuses while streaming.** | N | Summarize and compact in place (`compaction` method `handoff`). | Yes, when idle |
| `/compact` | `[soft\|remote\|snapcompact] [focus]` | direct | N | `compaction` entry. | Yes |
| `/shake` | `[elide\|images\|thinking]` | direct | N | Drop heavy context. | Yes |
| `/clear` `/fresh` `/delete` | none | direct | N | Reset context / reset provider stream / delete session. | Yes (`/delete` is destructive) |
| `/btw` | `[question]` | No args → SEL history. Question → **overlay** with the answer ("c copy · f follow up · b branch · esc close") `[observed]` | N | Side question. **Not in the JSONL.** Stored in `<artifacts>/btw-history/entry-<id>.json` `[observed]`. | Yes, then `esc` |
| `/tan` | `<work>` | direct | N | Background tangential agent. | Yes |
| `/seance` | `[id\|path] [--model sel]` | No args → SEL | N | Consult a saved session. | With args |
| `/pin` | `[id]` | direct | N | Pin in the resume list. | Yes |
| `/todo` | `[edit\|copy\|expand\|collapse\|export [p]\|import [p]\|append [phase] <task>\|start <t>\|done [t\|ph]\|drop [t\|ph]\|rm [t\|ph]]` | No args → shows the list. `edit` → $EDITOR. | N | Writes `custom{customType:"user_todo_edit",data:{phases}}` + a developer reminder message `[observed]`. | Yes. The phase name is fuzzy-parsed; `/todo append Lab phase X` created phase "Lab", task "Phase X" `[observed]`. |
| `/session` | `[info\|delete\|pin [acct]]` | info → **panel** (auth, tokens, cost, MCP) `[observed]` | N | Info. | Panel |
| `/context` `/tools` `/jobs` `/usage` `/changelog` `/hotkeys` `/stats` `/trace` | — | panels or reports | hotkeys Y | Info and dashboards. `/jobs kill <id>\|all` is direct. | Panel |
| `/export` | `[--themes] [path]` | direct → "Session exported to: <path>" `[observed]` | Y | HTML export. | Yes |
| `/dump` | `[all\|anon]` | direct (clipboard / zip in tmp) | Y | Transcript dump. | Yes |
| `/share` | none | direct (encrypted link) | N | Share. | Yes |
| `/copy` `/open` | `[code\|cmd\|link]` | No args → SEL | Y | Clipboard on the **host** (useless remotely). | — |
| `/agents` `/hub` `/extensions` (`/status`) `/debug` | none | **SEL dashboards** | N | Agent Hub, Extension Control Center. | No |
| `/git` | `[revision]` | fullscreen git UI | N | Diff, stage, commit. | No (use the terminal) |
| `/move` `/wt` `/add-dir` `/remove-dir` `/dirs` | paths | direct (`/move` no args → SEL) | N | Workspace roots and worktrees. | Yes |
| `/login` `/logout` | `[provider]` | SEL OAuth | N | Auth. | No |
| `/mcp` | `<add\|list\|remove\|test\|reauth\|enable\|disable\|reload\|resources\|prompts\|…>` | Mostly direct reports. `add` with no args → wizard. | N | MCP management. | Yes (report subcommands) |
| `/memory` | `[view\|stats\|diagnose\|queue\|sync\|clear\|reset\|enqueue\|rebuild\|mm …]` | panels or direct | N | Memory backend. | Yes |
| `/skills` | `search <q>\|install <pkg>\|installed\|update` | direct | N | Skill registry. `/skill:<name> [args]` invokes a skill. | Yes |
| `/advisor` | `[on\|off\|status\|dump [raw]\|configure]` | direct; `configure` → SEL overlay | N | Advisor toggle. | Yes |
| `/collab` | `[start\|view\|list\|stop\|status] [relayUrl]` | direct (shows the link) | Y* | Live share (see the collab doc). | Yes |
| `/join` `/leave` | `<link>` / none | direct | `/leave` Y | Guest join and leave. | Yes |
| `/force` (`/force:`) | `<tool> [prompt]` | direct | N | Force the next tool. | Yes |
| `/pause` | none | pause screen (Esc/Enter/Space resumes) | N | Freeze all agents. | Partly |
| `/live` `/record` | none | voice / recording | N | — | No |
| `/forget-approvals` | none | direct | N | Clear remembered grants. | Yes |
| `/marketplace` `/plugins` `/reload-plugins` | subcommands | direct, or SEL without a target | N | Plugins. | Yes |
| `/retry` `/restart` `/exit` `/quit` (`/q`) | none | direct | exit/quit Y | Retry, restart the process, quit. On quit omp prints `omp --resume <uuid>` `[observed]`. | Yes |
| `/browser` `/ssh` `/omfg` `/cleanse` | args | direct, or panel/SEL | N | Misc. | Mostly |

**Not commands:** there is no `/thinking`, `/name`, `/title`, `/cost`, `/irc`, `/approval` or `/continue` builtin.

### 1.4 TUI keybindings that matter for injection

Sources: `[source] pi-tui/package/src/app-keybindings.ts:89-179`, `keybindings.ts:128-145` and `omp://keybindings.md`. User remaps live in `~/.omp/agent/keybindings.yml`; **check that file on each host before relying on a chord**.

| Action | Default chord | herdr key name | Notes |
|---|---|---|---|
| Submit | Enter | `enter` | While streaming this is a **steer** `[observed]`. |
| Newline | Shift+Enter, Ctrl+J | — | — |
| Follow-up | **Ctrl+Q**, Ctrl+Enter | `ctrl+q` | `[observed]` "After yield · 1". **During an approval, Ctrl+Q approves.** |
| Dequeue the last queued message | Alt+Up, Shift+Up | — | — |
| Abort | Esc | `esc` | Aborts the turn, closes an overlay or popup, or dismisses autocomplete. **Double Esc** on an empty idle editor (within 500 ms) opens rewind (default; configurable to tree or none). |
| Clear the draft / quit | Ctrl+C / Ctrl+C×2 within 500 ms, Ctrl+D | `ctrl+c` | `[observed]` A single `ctrl+c` cleared the restored draft. |
| Cycle thinking level | **Shift+Tab** | — | Not "toggle thinking display". |
| Toggle display of thinking blocks | Ctrl+T | — | Display only. |
| Cycle role models / temporary picker / role picker | Ctrl+P, Shift+Ctrl+P / Alt+P / Alt+M | — | — |
| Plan toggle | Alt+Shift+P | — | — |
| Expand tool output | Ctrl+O | — | Also expands ask/approval details. |
| Approve tool | Ctrl+Enter, Ctrl+Q | `ctrl+q` | `[observed]` approved. **Esc denies.** Typing text denies and steers. |
| Hide ask | Alt+H | — | — |
| Retry a failed turn | F5, Alt+R | — | "F5 to retry" is shown after an abort `[observed]`. |
| Agent Hub | Alt+A | — | — |
| External editor | Ctrl+G | — | — |
| Paste image | Ctrl+V (Win: Alt+V) | — | Reads the **host** clipboard. Remote images must go through collab `prompt.images`. |
| Push-to-talk | Space (hold), when STT is enabled | — | Host microphone only. |

Ask dialog keys `[observed]`: "⏎ select · n note · ↑/↓ move · esc cancel · Alt+H hide". An "Other (type your own)" row is always appended.

---

## 2. Models and thinking

### 2.1 Listing models and roles on a host

- **`omp models --json`** `[observed]` → `{models: ModelJson[]}` with 35 models (anthropic, openai-codex) on this host. Sample: `omp-samples/models.json`.

  ```ts
  interface ModelJson { provider: string; kind: "chat"|"tiny"|"image"|"tts"|"stt"|"search"|"judge";
    id: string; selector: string; name: string; contextWindow: number|null; maxTokens: number|null;
    reasoning: boolean; thinking: Effort[]|null; input: ("text"|"image")[];
    cost: {input:number; output:number; cacheRead:number; cacheWrite:number}; pricingStatus: string }
  ```
  `[source] cli/models-cli.ts:76-133`
- **Other forms:** `omp models --kind all --json`, `omp models find <substr>`, `omp models <provider>`. `omp models refresh` forces a fetch. The list contains authenticated or keyless providers only. The cache is `~/.omp/agent/models.db` (24 h TTL) `[source] omp://models.md`.
- **Roles:** `omp config get modelRoles --json` `[observed]` → `{key, value:{default, smol, slow, designer, tiny, advisor, plan, task}, type:"record"}`. Built-in role names are: `default, smol, slow, vision, plan, commit, tiny, memory, task, advisor, widget`, plus the kind roles `image, web, speech, dictation, judge`. Custom roles such as `designer` are allowed `[source] config/model-roles.ts:56-100`. **`omp config list|get|path` are read-only. `set`/`reset` write the global `config.yml`, so never call them.**
- **No LLM call:** `omp --mode rpc --no-session` → `get_available_models` and `get_available_thinking_levels` (`{levels:["off","low","medium","high","xhigh","max"]}` for gpt-6-luna) `[observed]`.

### 2.2 Setting the model and thinking level

| Where | How | Persisted as |
|---|---|---|
| Launch | `--model <provider/id[:level]\|@role\|fuzzy>` and `--thinking <off\|minimal\|low\|medium\|high\|xhigh\|max\|auto>` `[observed]`. `--models a,b` limits the Ctrl+P cycle. `--smol/--slow/--plan <id>` override roles for the process. `PI_SMOL_MODEL`, `PI_SLOW_MODEL` and `PI_PLAN_MODEL` env vars do the same. | First entries: `model_change`, `thinking_level_change` (`configured:null`) `[observed]`. |
| TUI injection | `/switch provider/id:level` (session-only, role `temporary`); `/effort <level>`. | `model_change{role:"temporary"}`, `thinking_level_change{thinkingLevel, configured}` `[observed]`. |
| Extension (bridge) | `pi.setModel(ctx.models.resolve(spec))`; `pi.setThinkingLevel(level)` | Same entries; the TUI status line updates live `[observed]`. |
| RPC | `set_model{provider,modelId}`, `set_thinking_level{level}`, `cycle_*` | Same entries `[source]`. |
| Collab | No command. Thinking and model are only **observed** (`SessionState.model`, `thinkingLevel`; event `thinking_level_changed`) `[source] pi-wire/src/index.ts:225-236`. | — |

Thinking levels are clamped per model (`clampThinkingLevelForModel`) `[source] config/model-resolver.ts:2389-2401`. `defaultThinkingLevel` defaults to `high`.

---

## 3. Modes

| Mode | Enter/exit | TUI surface | Session JSONL | Collab | herdr |
|---|---|---|---|---|---|
| **Plan** | `/plan` (on → paused → off), Alt+Shift+P, `--plan-yolo` (auto-approve the first plan, then implement on `smol`). Overlay `plan.defaultOnStartup: true` via `--config`. | Status line shows "Plan", or "Plan ⏸" when paused. Model swaps to the `plan` role `[observed]`. Writes are blocked except `local://`. The plan is proposed with `write xd://propose`. | `mode_change{mode:"plan",data:{planFilePath:"local://PLAN.md"}}`, then `plan_paused`, then `none` `[observed]`. | Replicated entries `[inferred]`. **The plan-review overlay is not a collab ui-request** `[source] interactive-mode.ts:5539` (a custom overlay). | Plan review does **not** report blocked. |
| **Plan review** | Opens when the agent proposes. Choices are `execute\|compact\|keep\|refine\|save` (labels: "Approve and execute", "Approve and compact context", "Continue with … context", "Refine plan", "Save and quit"). | Overlay | — | Not mirrored. **The extension API can answer it:** `plan_review_requested` event, `ctx.getPendingPlanReview()`, `ctx.resolvePlanReview(reviewId, choice, {feedback?, role?})` `[source] omp://extensions.md` "Plan review lifecycle", `interactive-mode.ts:5590-5621`. | — |
| **Goal** | `/goal set <obj>`, `/goal pause\|resume\|drop\|budget N\|off`, `--goal "<obj>"` (interactive only). The model calls `goal({op:"complete"})`. | Goal card: "Goal: complete ⟨complete⟩", tokens, elapsed, Report `[observed]`. | `mode_change{mode:"goal",data:{goal:{id,objective,status,tokensUsed,timeUsedSeconds,createdAt,updatedAt}}}` (repeated as it progresses), `custom_message{customType:"goal-mode-context"}`, final `mode_change none` + `custom{customType:"goal-completed",data:{objective,tokensUsed,timeUsedSeconds}}` `[observed]`. Status values are `active\|paused\|budget-limited\|complete\|dropped`. | Entries replicate. RPC has `goal_updated`. | Plain working/idle. |
| **Fast / slow** | `/fast [on\|ultra\|off\|status]`, `/slow …`, `--service-tier <tier>` | Status-line icon ⚡ `[observed]`. | `service_tier_change{serviceTier:{openai:"priority"}\|null}` `[observed]`. Anthropic slow mode is global settings, not a journal entry. | Entries only. RPC `get_state.fastModeEnabled`. | — |
| **Approval** | `--approval-mode always-ask\|always-ask-cached\|write\|yolo` (**the default is `yolo`** on this host, where no approval prompts appeared `[observed]`); `--auto-approve`; `tools.approval.<tool>: allow\|deny\|prompt` | Dialog "Allow tool: bash / Command: … / ▸ Approve / Approve bash for this session / Deny", with footer "↑/↓ choose · ⏎ select · Ctrl+⏎/Ctrl+Q approve · Esc deny · Ctrl+O details · type to deny and steer" `[observed]`. | **Nothing**: approvals are not journaled `[observed]`. Events `tool_approval_requested/resolved`. | **Mirrored as a collab `ui-request` select** whose options are the same labels. The first answer wins. A queued steer denies the call `[source] modes/controllers/extension-ui-controller.ts:663-711`. | `blocked`, message = reason or "`<tool>` approval" `[observed: agent_status "blocked"]`. |
| **Auto-compaction** | On by default (`compaction.enabled`, methodOrder `remote, snapcompact, handoff, shake, soft`). Disable per process with a `--config` overlay `compaction: {enabled: false}` `[observed]` via RPC `get_state.autoCompactionEnabled:false`. | Context meter on the status line ("3%" … "272K") `[observed]`. | `compaction{summary, firstKeptEntryId, tokensBefore, tokensAfter?, method}` `[source] session/session-entries.ts:143-162`. | Events `auto_compaction_start{reason,action}` and `_end` are forwarded `[source]`. `contextUsage` is in `SessionState`. | Stays working. |
| **Vibe / loop** | `/vibe`, `/loop` | — | `mode_change{mode:"vibe"}`, `custom vibe-session-lifecycle` | Entries | — |

**Ask tool** `[observed]`:
- **Call:** the assistant `toolCall` has `name:"ask"`, `arguments:{questions:[{id,question,options:[{label,description,preview}],multi,recommended,header}]}`.
- **TUI:** an "Ask" dialog.
- **herdr:** `blocked` with the first question as its message.
- **Result:** `toolResult{content:"User selected: blue", details:{question, options, multi, selectedOptions:["blue"]}}`.
- **Collab:** delivered question by question as `select` (plus `editor` for "Other") ui-requests `[source] extension-ui-controller.ts:929-1089`.

---

## 4. Launching omp in a herdr pane

### 4.1 Recommended recipe (verified)

```sh
herdr agent start <name> --kind omp --pane <paneId> [--timeout 30000] -- \
  --model <provider/id> --thinking <level> \
  [-e /path/to/tf-bridge.ts] \
  [--approval-mode always-ask|write|yolo] \
  [--config /path/overlay.yml]... \
  [--resume <id-prefix|path> | --continue | --fork <session.jsonl> | --goal "<objective>"] \
  [--no-title] ["<initial prompt>"]
```

- **Observed result:**
  ```
  {"result":{"agent":{agent:"omp", agent_session:{kind:"path", source:"herdr:omp", value:"<session.jsonl>"}, agent_status:"idle", interactive_ready:true, …}, argv:["omp","--model",…], type:"agent_started"}}
  ```
  - It took about 3 s. **`agent_session.value` already holds the session file path before the first prompt**, even though the file is not written to disk until the first entry is flushed (`[observed]` lab5: `ls` failed until the first prompt).
  - Verified variants: model + thinking (lab1), `--approval-mode always-ask --no-title` (lab2), `--resume 01a15b51` (lab3), `-e tf-bridge-probe.ts` (lab5).
- **The pane must be at an idle shell prompt** (herdr `agent start` contract). Use `herdr pane split <pane> --direction right|down` to make one.
- **cwd:** the pane's cwd, or `--cwd <dir>`. Starting in `~` auto-switches to a temp dir unless `--allow-home` is passed `[source] cli/startup-cwd.ts`.
- **Session name:** there is **no launch flag**. Set it after launch with the bridge's `pi.setSessionName` or inject `/rename <title>`. `--no-title` or `PI_NO_TITLE=1` disables auto titles.
- **Plan mode at start:** there is no plain flag. `--plan <id>` is the plan-role model. Either use `--config` with `plan: {defaultOnStartup: true}` (new sessions only), or inject `/plan` after start.
- **Initial prompt:** a positional message (`@file` attaches a file). It is not allowed together with `--goal` `[source] cli/args.ts:130-190`.
- **Config overrides:** repeatable `--config <yaml>` or `PI_CONFIG_FILES=a.yml:b.yml`. These are never persisted `[observed]` for `--config`. Use `--profile <name>` / `OMP_PROFILE` for a fully isolated agent dir. `PI_CODING_AGENT_DIR` relocates the default profile.
- **Env that herdr sets per pane:** `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, `HERDR_SESSION`. The herdr extension needs the first three (§8).
- **Tunables:** `HERDR_OMP_IDLE_DEBOUNCE_MS` (250) and `HERDR_OMP_RETRY_GRACE_MS` (2500).
- **omp's own launch of a fork in a new herdr pane** (`/fork pane`) `[observed]`:
  - Commands: `herdr pane split` + `herdr pane run <pane> "/tmp/omp-herdr-XXXX/launch"`.
  - Child argv: `omp --model … --thinking … --prompt-cache-key <parentId> --fork <parent.jsonl>`.
  - `[source] subprocess/terminal-launch/herdr.ts:37-133`.
  - Not supported on Windows.

### 4.2 Resume, continue and restore

| Flag | Meaning |
|---|---|
| `--resume <v>` / `-r <v>` / `--session <v>` | A value containing `/`, `\` or `.jsonl` is treated as a path. Otherwise it matches an id prefix, a filename prefix or an id suffix (case-insensitive, newest first). With no value it opens a picker (avoid). `[source] main.ts:1277-1327`, `session/session-listing.ts:928-1038`; `[observed]` `--resume 01a15b51`. |
| `--continue` / `-c` | First the terminal breadcrumb `~/.omp/agent/terminal-sessions/<terminal-id>`, otherwise the newest non-empty session in the cwd bucket. |
| `--restore <v>` | Resume, then continue the interrupted turn and its subagents. |
| `--fork <file>` | Copy the session into a new file and continue there. |

**⚠ Resuming a session that is live in another process forks it.** It does not attach.
- `[observed]` lab4 `--resume 01a15b4f` while lab2 was live: the new file `01a15b52…` had a header with `parentSession:"01a15b4f…"` and `providerPromptCacheKey`.
- The TUI warns: "Session X is open for writing in another omp process, so this session now saves to Y…".
- Mechanism `[source] session/session-manager.ts:1090-1125,1260-1284`, `session/session-storage.ts:518-643`: an ownership lease (Linux abstract socket / Windows mutex / flock), then `#moveOffSessionFile("open-elsewhere")`.
- **TeleFlock must check `herdr agent list` → `agent_session.value` (and `omp collab list`) before offering "resume" on a session that is already live.**

---

## 5. Sessions

### 5.1 Layout `[observed]` + `[source]`

```
~/.omp/agent/sessions/<cwd-bucket>/<ISO-ts with :.→->_<uuidv7>.jsonl
~/.omp/agent/sessions/<cwd-bucket>/<same stem>/            # artifacts dir
    __advisor.<slug>.jsonl      # advisor transcripts (read-only peers)
    btw-history/entry-<id>.json # {question, answer, status, createdAt, updatedAt, id, leafId}
    <subagent-id>.jsonl / .md   # task subagent transcripts + outputs
~/.omp/agent/blobs/<sha256>     # image blobs
~/.omp/agent/history.db         # prompt history (FTS), session_titles, session_recaps
~/.omp/stats.db                 # usage/cost (§7)
```

**Cwd bucket encoding:**
- Under `$TMPDIR`: `-tmp-<rel>`, e.g. `/tmp/tf-lab-omp/work` → `-tmp-tf-lab-omp-work`.
- Under home: `-<rel>`.
- Anything else: `--<abs with / → ->--`.

`[source] session/session-paths.ts:45-119`

### 5.2 File format and entry types

- **Line 1** is a fixed 256-byte **title slot**, rewritten in place: `{"type":"title","v":1,"title":"…","source":"user"|"auto","updatedAt":"…","pad":"   "}`.
- **Line 2** is the header: `{"type":"session","version":3,"id":"<uuidv7>","timestamp","cwd", parentSession?, providerPromptCacheKey?, title?, titleSource?}`.
- After that come the tree entries `{type, id(8 hex), parentId, timestamp, runtime:{version}}` `[observed]`.

The `SessionEntry` union has 16 types `[source] session/session-entries.ts:227-338`:

| type | Key fields | Seen in lab |
|---|---|---|
| `message` | `message: {role:"user"\|"assistant"\|"toolResult"\|"developer"\|"custom"…, content[], …}`. Assistant messages carry `api, provider, model, usage{input,output,cacheRead,cacheWrite,totalTokens,cost{…,total}}, stopReason`. A user steer carries `steering:true`. | ✓ |
| `model_change` | `model:"provider/id", role?, resolvedModelIsFallback` | ✓ |
| `thinking_level_change` | `thinkingLevel, configured` | ✓ |
| `service_tier_change` | `serviceTier: {openai:"priority"} \| null` | ✓ |
| `mode_change` | `mode:"plan"\|"plan_paused"\|"goal"\|"goal_paused"\|"vibe"\|"none", data?` | ✓ |
| `title_change` | `title, source, previousTitle?, trigger?` | ✓ |
| `custom` | `customType`: `system-prompt-digest`, `tool_execution_start{toolCallId,toolName,startedAt,args,intent}`, `user_todo_edit{phases}`, `goal-completed`, `session_exit`, `vibe-session-lifecycle`, … | ✓ |
| `custom_message` | `customType` (`goal-mode-context`, `async-result`, collab prompts), `content, display, details?, attribution?` | ✓ |
| `credential_pin` | `provider, hash` | ✓ |
| `compaction` | `summary, shortSummary?, firstKeptEntryId, tokensBefore, tokensAfter?, method` | — |
| `branch_summary` | `fromId, summary` | — |
| `model_usage` | Out-of-transcript LLM calls (title, advisor…): `purpose, role?, api, provider, model, usage, stopReason` | — |
| `label` `ttsr_injection` `session_init` `reset_boundary` | See the source. `session_init` is the first entry of subagent transcripts. | — |

Samples: `omp-samples/session-lab1-main.jsonl`, covering the model/thinking/fast/plan/goal/todo/steer/abort/ask/async-result/title entries. Also `session-lab2-approval.jsonl` and `session-lab5-bridge.jsonl`.

Entry counts in lab1:
- messages: 17 assistant, 6 user, 5 developer, 4 toolResult
- 5 `model_change`, 5 `thinking_level_change`
- `mode_change`: 3 goal, 2 none, 1 plan, 1 plan_paused
- 2 `service_tier_change`, 1 `title_change`

**Todos are not a standalone entry.** Their state comes from the latest `todo` toolResult `details.phases` or `custom user_todo_edit` on the active branch. The type is `TodoPhase{name, tasks:[{content, status:"pending"|"in_progress"|"completed"|"abandoned"|"blocked", blocker?, details?, notes?}]}` `[source] pi-tui/src/tools/todo.ts:17-55`.

### 5.3 Listing past sessions (over SSH)

There is no `omp sessions` command. `omp session` exists, but it is `pack|unpack|moved` (a transfer tool) `[observed]`. Scan the files instead:

1. `find ~/.omp/agent/sessions -maxdepth 2 -name '*.jsonl' -printf '%T@ %s %p\n'`. Skip artifact subdirectories (depth 3+).
2. Per file:
   - `head -c 256`: the title slot gives `title` and `source`.
   - Line 2: the header gives `id`, `cwd`, `parentSession`.
   - The tail: the last assistant `stopReason` and timestamp give the status. omp itself reads a 4 KiB prefix plus a 32 KiB tail; its statuses are `complete|interrupted|aborted|error|pending|unknown` `[source] session/session-listing.ts:17-110`.
3. Faster titles: `sqlite3 -readonly ~/.omp/agent/history.db 'select session_id,title,updated_at from session_titles'` `[source]`.
4. Mark live sessions:
   - `herdr agent list` gives `agent_session.value` for each omp pane `[observed]`.
   - `omp collab list --json` gives `{version:1, hosts:[{instanceId, pid, sessionId, sessionName, cwd, model:{provider,id}, participants, relayConnected, inputRequired, busy, access}]}` `[observed]`, sample `collab-list.json`.

### 5.4 Tree, branch and fork semantics `[source]` + `[observed]`

- Entries form an append-only tree (`id`/`parentId`). The **leaf is not persisted.** It is reconstructed on load from the last self-selecting entry.
- `/tree` and `/branch` move the leaf within the **same file**. The next append becomes a child of the new leaf. They optionally add `branch_summary` (when `branchSummary.enabled` is set).
  - `[observed]` The bridge's `navigateTree("647bf9fc")` set `leafId` to that entry and the TUI printed "Navigated to selected point".
- `/fork`, `--fork` and `SessionManager.fork()` create a **new file** with all entries, `parentSession:<old id>` and the inherited `providerPromptCacheKey` `[observed]` (sample `session-lab3-fork-header.jsonl`).
- `createBranchedSession(leaf)` (the tree "branch to new session") writes only the root→leaf path, with `parentSession` set to the old *path*.
- `/handoff` writes a `compaction` with `method:"handoff"` in the same file. It does **not** create a new session.
- `/new` creates a new file and emits `session_switch`.

### 5.5 Names and titles

- **Auto titles** use the "fork" generator by default. They are generated after the first assistant block, are prefixed with a "card" icon, and never override a user title.
- **`setSessionName(name, "user")`** updates the slot, the header, a `title_change` entry, and `history.db.session_titles` `[source] session/session-manager.ts:3336-3373`.
- **herdr:** `terminal_title` changes to `"π > <title>"` `[observed]`, which gives TeleFlock a cheap live title.

---

## 6. Remote observability and control

| Area | Observe | Control | Best path |
|---|---|---|---|
| **Subagents (task tool)** | Collab `AgentSnapshot{id, displayName, kind:"main"\|"sub", parentId, status:"running"\|"idle"\|"parked"\|"aborted", hasSessionFile, createdAt, lastActivity}` and the task lifecycle and progress channels (`AgentProgress{status, task, lastIntent, currentTool…}`) `[source] pi-wire/src/index.ts:238-280`. Transcripts are `<artifacts>/<id>.jsonl` (fetchable via collab `fetch-transcript`). | Collab `agent-cmd{cmd:"chat"\|"kill"\|"revive", agentId, text?}`; advisors are rejected `[source] collab/host.ts:1150-1197`. RPC has `steer_subagent` and `cancel_subagent`. | Collab |
| **Agent Hub** | TUI only (`/hub`, Alt+A) | — | Rebuild it in TeleFlock from collab data. |
| **Todos** | Entries (§5.2). RPC `get_state.todoPhases`. Collab replicates the entries but has no todo state field. | `/todo append\|start\|done\|drop\|rm` injection `[observed]`. RPC `set_todos{phases}`. | Read the entries; inject `/todo` commands. |
| **IRC** | Inbound IRC arrives as `custom_message` entries / RPC `irc_message` `[source]`. | **No external endpoint.** The bus is in-process (`irc/bus.ts`). An external client must use collab `agent-cmd chat`, or `prompt` for the main agent. | Collab |
| **Advisor** | `__advisor.<slug>.jsonl` in artifacts; `byAgentType advisor` in stats. RPC events `advisor_cost_changed`, `advisor_yielded`. | `/advisor on\|off\|status` injection; `--advisor` at launch. | Inject |
| **Memory** | Backend `off\|local\|hindsight\|mnemopi\|sharpshooter` (default off). Local files under `~/.omp/agent/memories/<project>/`. | `/memory view\|stats\|sync\|…`; the output is a panel (I4). | Inject, plus read the files over SSH. |
| **MCP** | `/mcp list` (config), `/session info` "MCP Servers" panel `[observed]`. Config lives in `.omp/mcp.json` and `~/.omp/agent/mcp.json`. **Live connection status is not in collab or RPC state.** | `/mcp enable\|disable\|reload` | Read the config over SSH; inject. |
| **Skills** | Dirs `.omp/skills/<n>/SKILL.md` and `~/.omp/agent/skills/`. RPC `get_available_commands` lists `/skill:*`. | `/skill:<name> args` | Inject. Collab `prompt` does **not** expand skills `[inferred from 1.1]`. |
| **Extensions** | `~/.omp/agent/extensions/`, `.omp/extensions/`, `-e`. `/extensions` is a TUI dashboard. | `--no-extensions`, `-e` at launch; `/reload-plugins` | Launch flags |
| **Background jobs** | Status line "⚙ 1"; `/jobs` panel `[observed]` | `/jobs kill <id>\|all` | Inject |
| **Tool cards and thinking blocks** | Collab `message_update` / `tool_execution_*` events and replicated entries. Thinking content arrives in assistant content blocks. | — | Collab |
| **Context meter** | Collab `SessionState.contextUsage{tokens, contextWindow, percent}`; bridge `ctx.getContextUsage()` `[observed]` | `/compact` | Collab |
| **tok/s** | RPC `get_state.tokensPerSecond`; stats `avgTokensPerSecond` | — | Derive from collab `message_update` timing, or stats. |

---

## 7. Usage and cost

1. **Per message (live):** every assistant `message` entry carries `usage{input, output, cacheRead, cacheWrite, totalTokens, cost{input,output,cacheRead,cacheWrite,total}}` and `model`/`provider` `[observed]`. Sum these per session to get session cost. The TUI status line shows `0.00 + ⟦⟧0.08`, i.e. the running cost for the main session and its subagents/advisors.
2. **`omp stats --json`** `[observed]`. It **first syncs session files into `~/.omp/stats.db`**, which is a write to omp's own DB and normal omp behavior, then prints:
   - `overall` (`totalRequests`, `failedRequests`, `errorRate`, token totals, `cacheRate`, `cacheSavings`, `totalCost`, `avgDuration`, `avgTtft`, `avgTokensPerSecond`, first/last timestamps)
   - `byModel`, `byFolder` (the cwd bucket), `byAgentType` (`main`/`subagent`/`advisor`)
   - `timeSeries` and `modelSeries`/`modelPerformanceSeries` (**hourly** buckets)
   - `costSeries` (**daily**, midnight UTC)

   Sample: `stats-json.trimmed.json`. `omp stats --summary` prints text. Plain `omp stats` starts a dashboard on `127.0.0.1:3847`.
3. **Direct SQL over SSH** (read-only, current up to the last sync):

   ```sh
   sqlite3 -readonly ~/.omp/stats.db "select date(timestamp/1000,'unixepoch') d, agent_type, model, sum(cost_total), sum(total_tokens), count(*) from messages group by 1,2,3"
   sqlite3 -readonly ~/.omp/stats.db "select session_file, requests, cost_total, total_tokens, models, tool_calls, started_at, ended_at from session_rollup"
   ```

   - Tables: `messages` (one row per request: `session_file, entry_id, folder, model, provider, timestamp, duration, ttft, stop_reason, *_tokens, cost_*, agent_type, service_tier`), `session_rollup`, `message_rollup` (bucket = hourly ms), `tool_calls`, `tool_rollup`, `user_messages`, `file_offsets` `[observed schema]`.
   - **Per-agent dashboard:** join `messages.session_file` to herdr's `agent_session.value`. Subagent rows have their own `session_file` under the parent's artifacts dir.
   - Observed on this host: 4171 rows (main 426 / subagent 3422 / advisor 323).
4. **Provider quota:** `omp usage --json --redact` `[observed]` returns `{generatedAt, reports:[{provider, limits:[{id, label, window:{durationMs, resetsAt}, amount:{used, limit, remaining, usedFraction, unit}, status}], metadata}], accountsWithoutUsage, disabledCredentials, capacity}`. Sample: `usage-json.redacted.json`. Good for a "plan limits" widget.
5. **Per-session panel:** `/session info` (tokens, cost, auth) is TUI only. RPC `get_session_stats` returns `SessionStats{tokens{…}, cost, premiumRequests, contextUsage}`.

---

## 8. herdr integration extension (`~/.omp/agent/extensions/herdr-omp-agent-state.ts`, integration v9)

`[source]`, read in full; behavior `[observed]` in the lab.

- **Activation:** only if `HERDR_ENV==="1"`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are set, **and** `ctx.hasUI===true` (the root TUI session only; never subagents).
- **Transport:** raw newline-JSON over the herdr unix socket (a named pipe on Windows). The first attempt has a 500 ms timeout, then one retry at 1500 ms; requests are serialized.
- **Reports:**
  1. `pane.report_agent_session {pane_id, source:"herdr:omp", agent:"omp", seq, session_start_source, agent_session_path | agent_session_id}`. Sent on `session_start` ("startup"), `session_switch` (the reason, or "resume"), and every `agent_start`.
  2. `pane.report_agent {pane_id, source, agent, state:"working"|"blocked"|"idle", message?, seq, agent_session_path|id}`. It is deduplicated (sent only when the state or message changes).
- **State machine:**
  - **`working`** on `agent_start`.
  - **`idle`** 250 ms after a final `agent_end`. The `idle` transition is skipped when `willContinue:true` or for duplicate end events.
  - **`blocked`** while a tool approval is pending (`tool_approval_requested` → `_resolved`). The message is the reason, or "`<tool>` approval".
  - **`blocked`** while the `ask` tool runs (`tool_execution_start/end` with `toolName:"ask"`). The message is the first question.
  - **Retryable provider errors** (a regex over rate limit, 429, 5xx, network…) hold `working` for 2.5 s, then switch to `blocked` with the error text.
  - **Third-party extensions** can drive blocked through `pi.events.emit("herdr:blocked", {active, label})`. **No omp core code emits this** (grep, `[source]`).
  - **`done` is never reported.** herdr derives `done` itself.
- **Not reported as blocked:** plan review, the "Exit plan mode?" confirm, the goal menu, `/btw` and info overlays, and selectors that were opened by injection. TeleFlock must detect these from collab, the bridge, or the pane screen.
- `[observed]` `agent_status` went `idle → working → blocked` (ask) `→ idle`, and `blocked` during the bash approval. `herdr agent prompt` was refused with `agent_blocked` while blocked.

---

## 9. RPC alternative and recommendation

### 9.1 RPC mode summary (`omp://rpc.md`, `modes/rpc/*`)

- **Launch:** `omp --mode rpc|rpc-ui [--no-ui] [normal flags]`. Communication is JSONL on stdin/stdout.
- **Handshake:** `ready{protocolVersion:1, supportedProtocolVersions:[1,2], maxFrameBytes:1048576, maxReassembledFrameBytes:67108864}`. v2 (`negotiate_protocol`) chunks large outbound frames `[observed]`.
- **About 70 commands**, covering:
  - prompting: `prompt{streamingBehavior}`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, queue edits
  - model and thinking: `set_model`, `set_thinking_level`
  - modes: `set_fast_mode`, `set_slow_mode`, `goal{op}`, `set_todos`, `set_auto_compaction`
  - session: `compact`, `handoff`, `branch{entryId}`, `fork`, `get_tree`, `get_entries{since}`, `switch_session`, `new_session`, `set_session_name`, `export_html`, `get_session_stats`
  - subagents: `get_subagents`, `steer_subagent`, `cancel_subagent`
  - side questions: `btw`
  - discovery: `get_available_commands`, `get_available_models`
  - auth: `login`
  - voice: `live_*`

  Full union in the RpcObserve notes (`modes/rpc/rpc-types.ts:35-158`).
- **Events:** all session events plus `queue_update`, `goal_updated`, `todo_reminder`, `irc_message`, `thinking_level_changed`, `auto_compaction_*`, `auto_retry_*`, subagent frames, and `prompt_result`/`session_settled`.
- **UI:** `extension_ui_request{method: select|confirm|input|editor|ask|notify|setStatus|setWidget|setTitle|set_editor_text|open_url}` ↔ `extension_ui_response`. Tool UI (ask) needs `rpc-ui` + `set_ask_dialog`.
- **Slash commands:**
  - Text builtins work via `prompt` and return `command_output`.
  - `[observed]` `prompt "/fast status"` → `command_output{"Fast mode is off."}` and `response{agentInvoked:false}`.
  - Selector-only TUI commands are unavailable.
- `[observed]` `get_state` keys: `model, thinkingLevel, isStreaming, isCompacting, steeringMode, followUpMode, interruptMode, sessionId, autoCompactionEnabled, queuedMessageCount, queuedMessages{steering, followUp, liveSteered}, hasPendingAsyncWork, isSettled, todoPhases, fastModeEnabled, fastModeActive, slowMode*, tokensPerSecond, messageCount, systemPrompt, dumpTools, contextUsage, goal`. Sample: `rpc-probe.jsonl`.

### 9.2 Honest comparison

| Criterion | Collab guest (TUI in a herdr pane) | RPC process | Companion extension (`-e tf-bridge`) |
|---|---|---|---|
| **Coverage** | Transcript, live events, state, subagents (chat/kill/revive), approvals and ask (select/editor), images in prompts. **Missing:** model, thinking, fast, follow-up, todos, tree, branch, compact, rename. Prompts are always steer. Slash commands aren't run. | **Most complete structured API**, including tree, branch, todos and queue. | Everything the ExtensionAPI offers: model, thinking, tiers, name, follow-up/steer/aside, abort, compact, `navigateTree`/`branch`/`newSession`/`switchSession` (after one `/tf-attach`), plan review, context usage, async jobs, and all events. **No ui-request answering** for ask/approval; leave those to collab. |
| **Persistence across disconnects** | The session lives in omp. A guest re-joins (relay) and gets a snapshot plus replicated entries. | **The RPC process dies with its stdio pipe.** Over SSH an exec channel drop kills the session unless it is wrapped (tmux/herdr pane + fifo). | omp owns the socket and survives disconnects. TeleFlock reconnects to `/tmp/omp-<pid>.sock` through an SSH `direct-streamlocal` channel. |
| **TUI coexistence** | ✓ Same process as the TUI. | ✗ **Cannot attach to a live TUI session.** The ownership lease makes it fork into a sibling file (§4.2). There is no TUI in the pane. | ✓ Same process; the TUI updates live `[observed]`. |
| **herdr state tracking** | ✓ The extension runs (`hasUI`). | ✗ Not a TUI. In a pane, herdr would see a non-interactive process. | ✓ Unchanged. |
| **Install footprint** | None. `/collab` with a local relay (see the collab doc). | None. | One file passed with `-e` per launch. No global config needed. Optional install to `~/.omp/agent/extensions/` (like herdr's own integration) to cover sessions the user starts manually; **needs user consent**. |
| **Risk** | Protocol owned by omp (versioned wire). | Stable, documented. | ExtensionAPI is public and documented, but runs in-process: an uncaught error kills the session (use `ctx.setTimeout`, try/catch). |

### 9.3 Bridge proof `[observed]` (`omp-samples/tf-bridge-probe.ts`, `session-lab5-bridge.jsonl`)

Over `/tmp/omp-<pid>.sock`, with no TUI keystrokes except one `/tf-attach`:

| Request | Result |
|---|---|
| `state` | `{model, thinking, idle, sessionName, sessionFile, leafId, context{tokens, contextWindow, percent}, serviceTiers}` |
| `thinking medium` | `thinking_level_change` entry; the TUI icon updated |
| `rename` | Instant `title_change` + slot |
| `fast priority` / `off` | `service_tier_change` entries |
| `send` | Starts a turn. Events `agent_start`, `turn_end` and `agent_end` were streamed to the socket client |
| `tree` (after `/tf-attach`) | Leaf moved; "Navigated to selected point" |
| `abort` | Aborted a running bash call |

**Caveat:** a `send{deliverAs:"followUp"}` queued during streaming was **not shown in the TUI queue chip, and was dropped by `ctx.abort()`**. If a follow-up must survive an abort, use RPC-style restore semantics (TUI Esc) or re-send it.

### 9.4 Recommendation

- **Use collab as the data plane.** It carries entries, events, approvals/ask ui-requests, the subagent roster and `agent-cmd`, and plain prompts with images.
- **Use the `tf-bridge` extension as the structured control plane** for every session TeleFlock launches (`herdr agent start … -- … -e <tf-bridge.ts>`). It covers model, thinking, fast/slow, follow-up, rename, compact, abort, tree, branch, new and switch session, plan review, and todos (via injected `/todo` or a bridge op).
- **Fall back to herdr injection,** using the I1–I10 rules, for sessions without the bridge.
- **Use RPC only for headless helpers:** catalogs (`get_available_commands`, `get_available_models`, thinking levels), stats, and future "background agents". Never for the user's interactive sessions.

---

## 10. Capability mapping table

**Status values**
- **proven:** exercised in the lab.
- **documented:** read in the source or docs, not run.
- **gap:** no clean remote path.

**Mechanism abbreviations:** C = collab guest · B = tf-bridge extension · I = herdr injection (`agent prompt` / `send-keys`) · F = file read over SSH · R = RPC (not for live TUI sessions).

| Capability | Mechanism (preferred → fallback) | Status |
|---|---|---|
| Prompt (idle) | C `prompt` → B `send` → I `agent prompt` | B, I proven; C documented (collab doc) |
| Steer while streaming | C `prompt` (always steer) → B `send{deliverAs:"steer"}` → I Enter | I proven (`steering:true`); B documented |
| Follow-up queue | B `send{deliverAs:"followUp"}` → I `send-text` + `ctrl+q` → I `/queue <msg>` | I proven ("After yield · 1"); B proven queued but not shown in the TUI chip and dropped on abort |
| Dequeue / edit the queue | I Alt+Up; R `remove_queued_message` | documented |
| Stop / abort | C `abort` → B `abort` → I `esc` | B, I proven; queued follow-ups are restored to the composer (I) |
| Model | B `setModel` → I `/switch provider/id[:lvl]` | B, I proven |
| Thinking level | B `setThinkingLevel` → I `/effort <lvl>` / `/switch …:lvl` | B, I proven |
| Fast / slow | B `setServiceTier` → I `/fast on\|off`, `/slow on\|off` | B, I proven (fast) |
| Plan mode on/off | I `/plan` (3-state) | proven; ⚠ swaps to the plan-role model |
| Plan review approve/refine | B `resolvePlanReview` / `plan_review_requested` | documented; **not** via C or I text |
| Goal set/pause/resume/drop/budget | I `/goal …`; R `goal{op}` | proven (set → complete) |
| Builtin slash commands with args | I (rules I1–I4); R `prompt` text | proven (switch, effort, fast, slow, plan, goal, todo, rename, export, btw, compact, fork pane, session info) |
| Selector-only commands (`/model`, `/tree`, `/branch`, `/settings`, `/hub`, `/agents`, `/resume` without args) | B (`navigateTree`, `branch`, `switchSession`) or rebuild the UI from data | tree proven via B; others **gap** (TUI only) |
| `@file` mentions | Typed text through C/I (`@path` is expanded by the host TUI editor/prompt pipeline); a positional `@file` at launch | documented `[inferred]` for C (C uses `promptCustomMessage`, so expansion is unverified) |
| Images | C `prompt{images}` (base64 ImageContent) → B `sendUserMessage([…image])` | documented; I can't send images |
| Voice | `/live`, push-to-talk and STT run on the **host's** audio devices | **gap**: do speech-to-text in TeleFlock and send text |
| Ask (questions) | C ui-request select/editor → I `send-keys` (arrows/enter) | I proven; C documented |
| Approvals | C ui-request select (exact labels) → I `ctrl+q` approve / `esc` deny | I proven; C documented |
| Todos view | F/C entries (`todo` toolResult `details.phases`, `user_todo_edit`); R `get_state.todoPhases` | proven (entries) |
| Todos edit | I `/todo append\|start\|done\|drop\|rm` | proven |
| Subagents list / transcript | C `AgentSnapshot` + `fetch-transcript`; F `<artifacts>/<id>.jsonl` | documented |
| Subagent steer / cancel | C `agent-cmd chat\|kill\|revive` | documented |
| Tool cards | C `tool_execution_*` + entries `custom tool_execution_start` + `toolResult` | entries proven; events documented |
| Thinking blocks | C `message_update` thinking deltas + assistant content; display toggle only via Ctrl+T | documented |
| Context meter | C `SessionState.contextUsage`; B `getContextUsage()` | B proven |
| Compaction (manual / auto) | B `compact()` → I `/compact [mode] [focus]`; auto events via C | I proven (fails when the session is too small); auto documented |
| Cost | Entries `usage.cost`; `omp stats --json`; `stats.db` SQL; `omp usage --json` | proven |
| tok/s | Stats `avgTokensPerSecond`; R `tokensPerSecond`; derive from C stream timing | proven (stats) |
| Session tree view | F JSONL (`id`/`parentId`) | proven |
| Fork | I `/fork` / `/fork pane` (native herdr) → launch with `--fork <file>` | proven |
| Branch / rewind / navigate | B `navigateTree` / `branch` | proven (navigateTree) |
| Rename | B `setSessionName` → I `/rename <t>` (async) | proven |
| Export | I `/export <path>` → `omp --export <file> [out]` (CLI, no session needed) | proven (`/export`) |
| Handoff | I `/handoff [focus]` (idle only); R `handoff` | documented |
| New / resume | I `/new`, `/resume <id>`; new pane: `agent start … -- --resume <id>` | resume in a new pane proven; ⚠ resuming a live session auto-forks it |
| BTW side question | I `/btw <q>`, then `esc`; F `btw-history/entry-*.json`; B `runEphemeralTurn` | proven |
| Changed files / diff / commit / PR | Not in omp's structured state. Use git over SSH exec (`git status --porcelain`, `git diff`), `omp commit`, `gh`; `/git` is a TUI | **gap in omp**; use git directly (documented) |
| Agent working/blocked state | herdr `agent_status` (+ C `isStreaming`) | proven |
| Live session discovery | `herdr agent list` (`agent_session.value`), `omp collab list --json` | proven |
| Model / role catalog | `omp models --json`, `omp config get modelRoles --json`, R `get_available_*` | proven |

---

## Open risks

1. **Injection fragility (I2, I4, I7).** Mitigate with the bridge. Where injection is still used, always read the pane after injecting and verify that the composer is empty.
2. **Bridge `/tf-attach` requires one injection.** The command context captured from that invocation was still valid on later calls `[observed]`. Whether it survives `/new` or `/resume` (a session switch) is untested `[inferred: re-attach on session_switch to be safe]`.
3. **`sendUserMessage(followUp)` is invisible and abort-dropped** (§9.3).
4. **The stats sync is a side effect** of `omp stats --json`. It writes `~/.omp/stats.db`, which is omp's own DB, not config, so it is acceptable.
5. **Keybindings may be remapped** per host (`~/.omp/agent/keybindings.yml`).
6. **`@oh-my-pi/omp-stats` source is not in `.research`.** The bucket semantics in this doc are observed (hourly/daily), not read in code.

---

## Samples index (`docs/research/omp-samples/`)

| File | What |
|---|---|
| `session-lab1-main.jsonl` | Full lab session: model, thinking, fast, plan, goal, todo, steer, abort, async-result, ask, title |
| `session-lab2-approval.jsonl` | `--approval-mode always-ask` run (approval not journaled) |
| `session-lab3-fork-header.jsonl` | Fork header with `parentSession` and `providerPromptCacheKey` |
| `session-lab5-bridge.jsonl` | Entries produced through the bridge extension |
| `tf-bridge-probe.ts` | The companion-extension probe (unix socket, newline JSON) |
| `rpc-probe.jsonl` | RPC `ready`, `get_state` (trimmed), thinking levels, command list (names), `command_output` |
| `models.json` | `omp models --json` |
| `stats-json.trimmed.json` | `omp stats --json` (first 2 items per list) |
| `usage-json.redacted.json` | `omp usage --json --redact` |
| `collab-list.json` | `omp collab list --json` |
| `herdr-agent-get-omp.json` | `herdr agent get` for an omp pane |
| `btw-history-entry.json` | BTW sidecar record |
