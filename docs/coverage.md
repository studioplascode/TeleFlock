# TeleFlock feature coverage matrix

Audit date 2026-10-21. Sources: `docs/spec.md` §2–§6, `docs/research/omp.md` §1 and §10, `docs/research/herdr.md` §13.
Each row traces the path **UI entry (desktop / mobile) → frontend call → host/app method → hostd path → status**.

**Status key**
- ✅ **verified**: the code path was traced end to end and exercised. "demo" means it was run in headless Chromium on `?demo` at 1440×900 and/or 412×892. "test" means a unit test covers it.
- ⚠️ **implemented, unverified or partial**: the code path exists, but it was not exercised against a real host, or one platform/variant is missing.
- ❌ **missing**: there is no UI path.

**hostd path legend**: C = collab guest · B = tf-bridge extension · I = herdr keystroke injection (guarded by §3.6, idle-only) · H = herdr API · G = git/gh/fs exec · L = local client (tf-client / Tauri).

## Before → after (this audit)

| Status | Before | After |
|---|---|---|
| ✅ | 74 | 84 |
| ⚠️ | 44 | 41 |
| ❌ | 17 | 10 |

What closed the ❌ and ⚠️ rows:
- **Slash catalog.** The `/` palette now lists all 87 omp builtins plus their aliases, with argument pickers. hostd's catalog previously rejected 32 of them as unknown.
- **Custom commands.** Extension, prompt-template and skill commands are listed in the palette (`agent.commands`) and accepted by hostd.
- **Queue editing.** Queued chips can be edited or removed (`agent.dequeue`).
- **`/copy`, `/dump`, `/open`.** These now act on this device instead of the host's clipboard or browser.
- **Plan review.** Free-text "Other" now becomes `refine` + feedback, and disabled choices are hidden.
- **Mobile terminal.** Mobile now opens the terminal from the composer (`/terminal` and the TUI-only commands); before, it set an invisible split.

## §2 Hosts and connections

| Capability | Desktop entry | Mobile entry | Frontend → method | hostd/app path | Status |
|---|---|---|---|---|---|
| Tailscale-SSH host | Hosts → HostEditor (address/user/port, Test) | More → Hosts → editor sheet | `hosts.save/test/connect` | L `tf-client/engine.rs`, `tf-transport` SSH | ⚠️ real SSH not exercised in this audit (demo rejects real profiles) |
| Local host | HostEditor kind "Local" | — (Android: SSH + demo only, by spec) | `hosts.save/connect` | L `tf-transport/local.rs` | ⚠️ Windows build not run here |
| WSL host + distro picker | HostEditor kind "WSL" → distro select | — (by spec) | `wsl.distros`, `hosts.save` | L `tf-transport/wsl.rs` (`wsl.exe -d`) | ⚠️ needs Windows |
| Demo host | HostEditor kind "Demo" | same | all host methods | `src/core/demo` | ✅ demo |
| Multi-host aggregate + filter | Title-bar host pill, BoardToolbar host select | Flock host pill only navigates to Hosts | `useHosts().setFilter` | frontend | ⚠️ desktop ✅ demo; **mobile has no filter control** (handed to MobileUx) |
| herdr session per host | HostEditor → Advanced "herdr session" | same sheet | `hosts.save` → attach `--session` | L `conn.rs`, hostd `daemon.rs` | ✅ (lab sessions use it) |
| Several devices on one host (desktop + phone, apps on different versions) | automatic | automatic | — | L `deploy.rs` never replaces a newer tf-hostd; hostd `attach --replace` / `stop` only move the host forward (architecture §3.2) | ✅ real binaries: a 0.2.0 app reconnecting to a newer daemon attaches to it instead of restarting it; upgrades drop older clients once |
| Phases + Open browser + host-key trust | ConnStatusCard (Open browser, Trust and connect) | More → inline card | `app.openExternal`, `hosts.trustKey` | L `conn.rs` | ✅ demo (simulated auth + fingerprint) |
| Backoff countdown, Retry now, latency | ConnStatusCard, host pill | same | `hosts.connect` | L `conn.rs` | ✅ demo |
| Resume on foreground/network | automatic | automatic (Android network callback) | `Engine::resume` | L `src-tauri/lib.rs` | ⚠️ needs a device |
| Offline-first stale cache | board/sidebar stale treatment | StaleHosts strip | cached `HostState` | L `engine.rs` | ✅ demo (studio-pc host is stale) |
| Setup checklist + one-tap fixes | Hosts → Host setup | More → Hosts | `host.setup/setupApply` | H/B `ops/host.rs` | ⚠️ 8 rows, there is no separate "SSH OK" row; a relay that is down cannot be fixed with one tap (hostd owns the port) |
| Host health | Hosts view, sidebar footer, bento tile | More → Hosts | state push (`host.health` exists but is not called directly) | L `ops/host.rs` | ✅ demo |

## §3 Information architecture

| Capability | Desktop | Mobile | Status |
|---|---|---|---|
| Title bar (logo, host pill, heartbeat, Ctrl+K, needs counter, window controls/Snap) | DesktopShell/TitleBar | — (More shows heartbeat + Search) | ✅ demo |
| Sidebar tree + quick actions + health footer | Sidebar | — (actions via palette) | ✅ demo |
| Board / Session+inspector / Terminal / Review / Activity / Usage / Settings | sidebar | bottom nav + More | ✅ demo |
| Split session+terminal, session+session | Ctrl+\\, "Terminal beside" / "Open beside" | — (mobile opens the full terminal view instead) | ✅ demo (desktop) |
| Palette, wizards, answer HUD, notification center, toasts | global overlays | More → Search / Notifications | ✅ demo |
| Mobile: bottom nav, Flock widgets, session pager, inspector sheet, terminal extra keys + pinch, swipe rows, long-press, pull-to-refresh, haptics | — | MobileShell, FlockHome, MobileSession, ExtraKeys, SwipeRow | ⚠️ pull-to-refresh skips full-bleed routes; haptics are tied to actions, not every state change (MobileUx scope) |

## §4 Liveness

Board cards, Flock rows and the session header render every encoding listed in the spec table: streaming, tool ring, thinking, swarm, needs-you glow, quiet chip, done flight, calm, stale, global heartbeat/glow/tray. ✅ demo on desktop. On mobile it is ⚠️: there is no sparkline, burst ring or per-agent last-seen on Flock rows.

## §5 Features

| Capability | Desktop entry | Mobile entry | Frontend → method | hostd path | Status |
|---|---|---|---|---|---|
| Board columns, drag Review↔Done, live-lane bounce | Kanban | Flock sections + swipe Archive/Reopen | `agent.archive` | state persist | ✅ demo |
| Card contents, quick answers, approvals | AgentCard/QuickAnswer | Flock needs cards | `agent.answer` | C | ✅ demo |
| Review card: Review diff / Archive | AgentCard | Flock card | route + `agent.archive` | — | ⚠️ no "Open PR" on the card (it lives in Review → Ship) |
| Bento row | BentoRow | Flock widgets | state | — | ✅ demo |
| Filters/search/group/J-K | BoardToolbar, useBoardKeys | — | frontend | — | ⚠️ desktop only |
| Multi-select (P1) | — | — | — | — | ❌ not built (P1) |
| Transcript, tool cards, thinking | SessionPane | MobileSession pager | `session.open/history` | C replica | ✅ demo |
| Ask card: select/multi/editor/confirm/input | AskCard | same | `agent.answer` | C ui-response | ✅ demo |
| Plan review answer | AskCard (planReview) | same | `agent.answer` | B `resolvePlanReview` (ids execute/compact/keep/refine/save) | ✅ code + test. Fixed here: "Other" text → `refine` + feedback; disabled choices hidden; Dismiss is hidden for plan reviews and hostd rejects `cancel` with a hint |
| Prompt / steer | Composer Enter | Composer send | `agent.prompt` (auto) | C → B → I | ✅ demo |
| Queue follow-up | Alt+Enter, `/queue` | queue button | `agent.prompt` (followUp) / `agent.slash /queue` | B `/queue` → I `ctrl+q` | ✅ demo |
| **Edit / remove queued chips** | ✎ / ✕ next to the queue chips (on the chip omp pops next, highlighted) | same | **`agent.dequeue` (new)** | B `editor.onDequeue()` (operator draft preserved) | ✅ demo (pull back → composer; remove). Sessions without the bridge get a "needs the bridge" error |
| Stop | Esc, header Stop | composer Stop | `agent.abort` | C → B → I `esc` | ✅ demo |
| `/` palette | Composer | Composer | see the slash table below | | ✅ demo + test |
| `@` mention | Composer | Composer | `fs.search` | G | ✅ demo |
| Image paste/drop | Composer | attach button | `agent.prompt{images}` | C `prompt.images` | ⚠️ needs a collab link; follow-ups with images are rejected (omp's TUI queue has no remote image path) |
| Drafts: every text field keeps its value (composers, answers, dialogs, filters) + composer images | everywhere | same | `drafts` / `useDraft` (localStorage `tf.drafts`), images in IndexedDB | — | ✅ demo (survives view switches and reloads; cleared on a successful send/submit) |
| Image viewer: zoom (wheel, pinch, double-click/tap, 1:1), pan, gallery | click a transcript attachment, a tool image or a composer thumbnail | tap; pinch, swipe, swipe down to close | `Lightbox` (`@/design`) | — | ✅ demo. Markdown images are not rendered (the parser has no `![]()`) |
| Voice dictation | — | mic (Web Speech) | text → `agent.prompt` | — | ⚠️ depends on the WebView's SpeechRecognition |
| Header model/thinking/plan/fast | Controls | header chips | `agent.setModel/setThinking/setPlan/setFast` | B → I | ✅ demo |
| Goal (objective + budget) | Goal chip → dialog | same | `agent.goal` | B `/goal …` | ⚠️ the call works; **the goal chip state is read from collab meta only**: the bridge `CtlState.goal` is not in `MetaOverlay` (`omp.rs`); HostdCore owns this |
| Inspector: context, cost, tok/s, todos, files | Inspector | inspector sheet | session meta | C/B | ✅ demo |
| Subagents steer/kill/revive/transcript | Inspector → Subagents | sheet | `agent.subagent`, `session.subagentTranscript` | C `agent-cmd`, `fetch-transcript` | ✅ demo; ⚠️ real host needs collab |
| Agent chat (omp IRC): inline chat bubbles (inbound left, sends right with delivery state, grouped), Chat tab grouped by peer with unread, jump-to-row, open subagent, direct message | Transcript rows; Inspector → Agent chat | sheet → chat tab | `TranscriptItem::Irc`, `ToolView::Irc`; direct message = `agent.subagent` chat | C replica (`irc:incoming`, parent `<irc>` steer, `write agent://`, `wait`) | ✅ demo + real host (golden samples 18/18b). Direct messages land as the user's message in the subagent, not as IRC (no external IRC endpoint); agent↔agent relays between subagents aren't visible (omp doesn't mirror them) |
| Subagent completion estimate + context % (omp TUI `· 40%` / `· 2.4%/272K`) | Subagents panel, task tool card (+ header "1 live · 40% done"), subagent viewer, board card footer (mean of running subagents) | same | `Subagent.completionPct` / `Subagent.context`, `SubagentSummary.completionPct` | C `AgentProgress.completionPercent` / `contextTokens` / `contextWindow` | ✅ demo + real host (estimate first arrives after ~2 min, interactive omp TUI only) |
| Session tree navigate/branch/fork-from | Inspector → Tree | sheet | `agent.navigate/branch/fork` | B | ✅ demo; ⚠️ fork-from-entry needs the bridge |
| Compact / handoff / export / rename / new / btw | Actions menu + dialogs | Session actions | `agent.compact/handoff/export/rename/newSession/btw` | B → I | ✅ demo |
| Rename herdr handle | — | — | `agent.renameHandle` (no UI caller) | H `agent rename` | ❌ **no UI**: the method exists; needs a field in the Rename dialog (FrontSession) |
| Non-omp agents: terminal-first + send-keys | NonOmpView | same | `agent.keys` | H | ✅ demo |
| Terminal attach, pane tabs, takeover, send-keys, copy/paste, font | TerminalView/Pane | Terminal tab + ExtraKeys | `term.*` | H `terminal session control` | ✅ demo |
| Terminal search (P1) | — | — | — | — | ❌ no xterm search addon |
| New shell pane (tab / split right / down) | TerminalView "New shell" | same | `term.open{shell,split}` | H | ✅ demo |
| Close a shell pane / rename tab / close tab | — (agent panes: "Close pane" = `agent.stop closePane`) | — | — | H has `pane.close`, `tab.rename/close` (`tf-herdr/api.rs`) | ❌ **blocked on tf-proto**: needs `pane.close`, `tab.rename`, `tab.close` host methods (orchestrator) |
| Worktree wizard (browser, badges, recents, new/existing branch, base, path, label, agent, preview) | NewWorktreeDialog | responsive sheet | `fs.list`, `git.branches`, `worktree.create{existing}` | G + H `worktree create` | ✅ demo; ⚠️ an *already checked-out* worktree is opened via "Open folder", not `worktree.open` |
| Open folder / agent in workspace | NewAgentDialog | palette | `workspace.create`, `agent.start` | H | ✅ demo |
| Dispatch: one message → worktree + omp agent, live thread per repo | Sidebar Dispatch, `D`, palette | Dispatch tab | `git.branches`, `fs.list`, `worktree.create{agent}`, `agent.answer` | H `worktree create` + agent start | ✅ demo; ✅ real stack (tf-devserver + herdr/omp) |
| Remove worktree (dirty/force), close workspace (+group), rename workspace | Sidebar workspace menu | Review → Workspace actions | `worktree.remove`, `workspace.close{group}`, `workspace.rename` | H | ✅ demo (desktop) |
| Inbox, Answer-next HUD (Ctrl+J) | Inbox, Ctrl+J | Inbox tab, palette | `agent.answer` | C | ✅ demo |
| Notifications with actions / inline reply | Windows toast actions | Android action buttons + reply | `agent.answer` from `NotifyAction` | L `platform.rs`, `Notifications.kt` | ⚠️ needs a device |
| Quiet hours | Settings | Settings | `settings.set` | L `settings.rs` | ✅ code |
| Per-agent mute (P1) | — | — | — | — | ❌ not built |
| Command palette | Ctrl+K | More → Search | — | — | ✅ demo; raw "Run a slash command…" now goes through the same router as the composer |
| Review & ship (diff, commit, ask agent, push, PR create/checks/merge) | Review + ShipPanel | Review | `git.*`, `gh.*` | G | ✅ demo; ⚠️ archive on merge is a manual button |
| Activity + while-away | Activity | More → Activity | `host.activity` | state | ✅ demo |
| Usage | Usage | More → Usage | `host.usage` | `omp stats` | ✅ demo; ⚠️ no budget hints |
| Subscription limits (per account/window, reset countdown, pace projection; inspector tile + header chip < 20 % left) | Usage → Subscriptions & limits; inspector Session pane; session header | More → Usage; session inspector | `host.limits` | `omp usage --json` + `--history --json`, `agent.db` session pin (read-only) | ✅ demo; ✅ real stack (omp 18.12.3, 3 Claude + 1 Codex account) |
| Preview tunnels | link buttons in transcript/terminal | same (in-app webview) | `tunnel.open` | L SSH forward | ✅ demo |
| Session history + resume in new pane | Past sessions | palette | `host.sessions/resume` | G scan + H start `--resume` | ✅ demo |
| Fan-out (P2), templates (P2), focus mode (P2) | — | — | — | — | ❌ stretch, not built (prompt templates are reachable as custom `/` commands) |
| Settings honoured | Settings | Settings | `settings.set` | L | ✅ except **`confirmArchive` ❌ (stored, no consumer)** |

## §6 Keyboard map

Ctrl+K, Ctrl+J, Ctrl+1…6, J/K, Enter, A, T, N, D, Esc, Ctrl+Enter, Alt+Enter, Ctrl+\\, Ctrl+B and ? are all handled (`shell/keyboard.ts`, `useBoardKeys.ts`, `Composer.tsx`, `SessionPane.tsx`). ✅ demo on desktop. Mobile has no keyboard map, by design.

## omp §1: slash commands (all 87 builtins)

Every builtin is reachable from the session `/` palette, on desktop and mobile. The palette shows argument hints, and its sub-pickers are built from omp's own subcommand metadata. Routing is decided per argument form (`src/features/session/composer/slash.ts`, catalog in `src/core/ompCommands.ts`). hostd accepts exactly the same names (`inject.rs::CATALOG`); `slash.test.ts` asserts that the two lists match.

| Mode | Meaning | Commands |
|---|---|---|
| native | Runs a TeleFlock control | `/model` `/switch` (picker or `agent.setModel`), `/effort`, `/fast on/off`, `/plan` (toggle), `/goal` (dialog; set/pause/resume/drop/budget), `/compact [focus]`, `/handoff`, `/rename`, `/fork [pane]`, `/new`, `/export`, `/btw`, `/tree` and `/branch`/`/rewind` (inspector tree), `/todo` (inspector) and `/todo copy`, `/copy [code\|cmd\|link]`, `/open`, `/dump` (local clipboard), `/collab [start]` (`agent.connect`), plus app-only `/stop` and `/terminal` |
| direct | `agent.slash` (B, or guarded I); the effect shows in the session | `/switch …`, `/effort <lvl>`, `/fast ultra`, `/slow`, `/plan <prompt>`, `/guided-goal`, `/vibe`, `/loop`, `/queue`, `/skillful`, `/extended-context`, `/computer`, `/prewalk`, `/modelpreset save/switch/delete`, `/ratchet`, `/advisor on/off`, `/force`, `/resume <id>`, `/fork window/tab`, `/pin`, `/seance <id>`, `/tan`, `/session pin`, `/delete`*, `/join`, `/leave`, `/todo append/start/done/drop/rm/export/import/expand/collapse`, `/compact <mode>`, `/shake`, `/clear`*, `/fresh`, `/retry`, `/forget-approvals`, `/move <p>`, `/wt`, `/add-dir`, `/remove-dir`, `/jobs kill`, `/cleanse`, `/omfg`, `/browser`, `/reload-plugins`, `/usage reset`, `/logout <p>`, `/restart`*, `/exit` `/quit` `/q`* (* = confirmation toast with a Run button) |
| report | `agent.slash`, then the agent's terminal opens, because omp prints the result only in its TUI | `/fast status` and the other `… status` forms, `/goal show`, `/modelpreset list`, `/advisor status/dump`, `/export <path>`, `/dump all/anon`, `/share`, `/session [info]`, `/collab view/list/status/stop`, `/context`, `/memory …`, `/dirs`, `/jobs [full]`, `/tools`, `/skills …`, `/mcp …`, `/security …`, `/ssh …`, `/marketplace …`, `/plugins …`, `/usage`, `/changelog`, `/hotkeys`, `/stats`, `/todo` (bare, in omp) |
| terminal | "Opens in terminal": one click opens the split terminal (mobile: the terminal view) and runs the command there, so the user continues in omp's own selector | `/model roles`, bare `/switch` `/effort` `/resume` `/seance` `/modelpreset` `/move` `/logout`, `/plan-review`, `/settings`, `/setup` `/providers`, `/login`, `/advisor configure`, `/session delete`, `/todo edit`, `/mcp reauth`, `/marketplace` (bare), `/trace`, `/agents`, `/hub`, `/extensions` `/status`, `/debug`, `/git`, `/pause`, `/live`, `/record` |
| custom | listed from the session (`agent.commands` → B `pi.getCommands()`), sent via `agent.slash` (hostd checks the name against the same list) | prompt templates, extension commands, `/skill:<name>` (free-text `/skill:<name>` still works without the bridge) |

Verification: demo at 1440×900 and 412×892. The sessions exercised the following:
- 91 palette options rendered.
- `/rev` matched the demo's `review` (prompt) and `deploy-preview` (extension) commands.
- `/jobs ` showed the `full` / `kill` picker; `/jobs kill all` ran.
- `/settings` opened the split terminal with an "opens in the terminal" toast.
- `/delete` showed the confirmation toast.
- `/tree` focused the inspector tree.
- `/hotkeys` on mobile navigated to `#/terminal/forge/a/pool`.
- `tab.errors()` was empty.

`bun test` `slash.test.ts` (7 tests) and `cargo test -p tf-hostd` (`catalog_validation`, `command_names`) also cover the routing.

## omp §10 capability table

| Capability | Path | Status |
|---|---|---|
| Prompt idle / steer | C prompt → B → I | ✅ demo; ⚠️ without collab, the bridge fallback queues instead of steering |
| Follow-up queue / dequeue-edit | B `/queue` + `onDequeue` → I `ctrl+q` | ✅ demo |
| Stop | C abort → B → I esc | ✅ |
| Model, thinking, fast/slow, plan | B → I `/switch`, `/effort`, `/fast`, `/slow`, `/plan` | ✅ demo; ⚠️ the injection fallback is idle-only |
| Plan review | B `resolvePlanReview` | ✅ (fixed: Other→refine, disabled hidden) |
| Goal | B/I `/goal …` | ⚠️ the chip does not show a goal set through the bridge (`MetaOverlay` lacks goal) |
| Builtin slash with args / selector-only | B submit / I guarded; selector-only → terminal mode | ✅ |
| `@file` | literal text through C | ⚠️ expansion in a collab prompt is unverified upstream |
| Images | C `prompt.images` | ⚠️ collab only |
| Voice | app-side dictation → text | ⚠️ Web Speech availability |
| Ask, approvals | C ui-response | ✅ |
| Todos view / edit | C entries / `/todo …` | ✅ |
| Subagents list / transcript / steer / kill / revive | C | ✅ demo |
| Tool cards, thinking, context, cost, tok/s | C (+B context) | ✅ |
| Compaction, handoff, export, rename, new, resume, btw, fork, branch, tree | B → I | ✅ demo |
| Changed files / diff / commit / PR | G | ✅ demo |
| Working/blocked, discovery, model catalog | H + C, `omp models` | ✅ |

## herdr §13 mapping

| Feature | herdr call | Status |
|---|---|---|
| Connect/health, board bootstrap, columns | `status`, `session.snapshot`, `events.subscribe` | ✅ |
| Card name/cwd/kind, live line, todos/ctx | `agent list`, title + collab | ✅ desktop; ⚠️ cwd not displayed |
| Start / stop agent | `workspace create`, `agent start`, send-keys, `pane close` | ✅ |
| Prompt / slash / answer | `agent prompt`, send-keys (fallbacks) | ✅ |
| New worktree / open folder | `worktree create`, `workspace create` | ✅ |
| Terminal + preview | `terminal session control/observe` | ✅ |
| Workspace rename/close(+group) | `workspace rename/close --group` | ✅ |
| Tab rename/close, generic pane close | `tab rename/close`, `pane close` | ❌ blocked on tf-proto host methods |
| Agent handle rename | `agent rename` via `agent.renameHandle` | ❌ no UI |
| Host stats | exec `/proc` | ✅ |
| Notifications | derived from status transitions | ✅ |
| herdr sessions picker | `session list --json` | ⚠️ the session name is typed in the host editor; no list picker |
| Correlate omp | `agent_session` → collab | ✅ |

## Remaining gaps and their blockers

1. **`pane.close`, `tab.rename`, `tab.close`.** These need new tf-proto methods (orchestrator). hostd/herdr support exists in `tf-herdr/src/api.rs`.
2. **Goal chip with the bridge only.** Add `goal` to `MetaOverlay` in `tf-hostd/src/omp.rs` (HostdCore). The call itself works.
3. **Herdr handle rename UI.** `agent.renameHandle` works; it needs a field in the session Rename dialog (FrontSession).
4. **`confirmArchive` setting.** It needs a consumer in `board/agentActions.setArchived` (FrontBoard).
5. **Mobile host filter on Flock.** Handed to MobileUx.
6. **Not built.** Terminal search (P1), multi-select (P1), per-agent mute (P1), fan-out / templates / focus mode (P2). None of these block daily use; prompt templates are already reachable as custom commands.
7. **Needs real devices or hosts.** Windows local/WSL, Android notification actions and the real SSH connect stay ⚠️ until they are run on a device or host.
