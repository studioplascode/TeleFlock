# features/session (owner: FrontSession)

Native GUI for one agent session (desktop + mobile). Import from `@/features/session`.

```ts
// Route entry (FrontShell mounts it for #/agent/:hostId/:agentId). Adapts to mobile and
// includes the mobile agent pager; non-omp agents get a terminal-first view.
export function SessionView(props: { hostId: string; agentId: string }): JSX.Element;

// Embeddable pieces (split view, wall tiles, inbox, HUD):
export function SessionPane(props: { agentKey: string; compact?: boolean; header?: boolean; composer?: boolean; bloom?: boolean }): JSX.Element; // transcript + ask + composer
// compact: split view / wall tile (tight padding, no global hotkeys); composer={false}: no composer (wall tiles other
// than the active one); bloom={false}: no blurred sunset layer behind the ask card (nine wall tiles skip it).
export function AskCard(props: { agentKey: string; request: UiRequest; compact?: boolean; hotkeys?: boolean; onAnswered?(): void }): JSX.Element;
// What the agent wrote before asking (ask card, Inbox, HUD, board cards): Markdown folded to `lines` with Show more / Show
// less when longer; `sunset` re-maps the text tokens to the sunset's own text colour. Helpers (tested): ask/askContext.ts.
export function AgentSaid(props: { text: string; variant: "ask" | "panel" | "card" | "phone"; sunset?: boolean; lines?: number; className?: string }): JSX.Element;
// Markdown renderer of the transcript, plan reviews, documents and tool cards. `imageSrc` maps a `![alt](src)` source to what is
// shown (only `data:image/*` results are; without it only such sources are, everything else shows its alt text). Parsing
// (markdown/parse.ts `parseBlocks` / `parseInline`) takes time linear in the text, however it is written; nesting past 16
// block / 8 inline levels stays text.
export function Markdown(props: { text: string; streaming?: boolean; className?: string; imageSrc?(src: string): string | undefined }): JSX.Element;
// Figures (markdown/Figures.tsx): MermaidFigure({ code }), SvgFigure({ code }), InlineMath / DisplayMath({ tex }) for other surfaces.
// svg.ts: prepareSvg / svgDataUrl / previewKind(path) (svg | mermaid | markdown); tools/preview.ts: previewOf(FileDiff).
```

Keyboard (session owns): `Esc` stop turn (when the composer is empty / not in a popup), `Enter` send (steer while
the agent works; a quick command runs), `Shift+Enter` newline, `Alt+Enter` queue follow-up (while it works), `1–9` answer the sticky ask
card, `←` its previous question (multi-question asks), `/` slash palette, `@` file mention, `Ctrl/Cmd+Z` undo and
`Ctrl/Cmd+Shift+Z` or `Ctrl+Y` redo in the composer (below). Phone: the ⋯ menu is a
bottom sheet (its Terminal item opens the full terminal view); a "Next waiting" chip docks above the composer while
other agents need you. `F5` / `Alt+R` resume a failed or stopped turn (below).

Command palette (`composer/SlashPalette.tsx` `useSlashPalette`, `composer/slash.ts`): `/` lists omp's builtins and the
session's skills, prompt templates and extension commands (`agent.commands`) with argument hints and how each runs, then a
command's argument choices once its name is typed (`slashPopupAt`; on the draft's first line, more lines may follow);
↑↓ move, Tab or Enter picks, Esc closes. A pick replaces only what is typed before the caret (`spliceSlash`): the text
after it stays, so `/pl` typed in front of a written task gives `/plan <task>`, the caret after `/plan `. A pick that
takes no arguments runs at once (`runSlash`) and leaves that text in the box. Dispatch's composer uses the same palette
narrowed to what a new agent can run (`features/dispatch/commands.ts`), where a pick only completes the text. Tests:
`bun test src/features/session/composer/slash.test.ts`.

Undo (`composer/undo.ts`, `composer/useUndoHistory.ts`): the composers (this one, Dispatch's, Quick capture's) keep
their own history, because the browser's can't serve them: WebKitGTK binds no key to undo, every draft write the app
makes (a slash completion, a send, a picked file) empties Chromium's stack and leaves WebKit's stale, and React
rewriting the controlled textarea on each keystroke makes Chromium undo one character at a time. Every change of the
draft is a step that puts back its text and selection: typing and deleting at the caret group until a pause of 1 s,
a jump elsewhere or the other kind of edit; a paste, a cut, a deleted or replaced selection and the app's own edits
(slash completion, a picked `@` file, paste markers and chips, dictation, Edit on a queued message) are steps of
their own; an input method's composition is one step once it ends. A send starts over (what was sent is not undone
into the box); another draft key (agent, Dispatch target or repository) has its own history; at most 100 steps and
1M characters. The browser's own undo (its menu, a key it binds) runs this history too. Elsewhere in the app the
fields use the browser's undo; on Linux `src-tauri/src/edit_keys.rs` gives WebKitGTK's the keys. Tests:
`bun test src/features/session/composer/undo.test.ts`.

Queued strip (`composer/QueueStrip.tsx`, `composer/queue.ts`): steers and follow-ups sent while the agent works, the
host's queue (`meta.queue` / `omp.queue`) plus this client's sends until the host lists them or their user rows land.
With bridge 2.4.0 every queued steer reaches the model together at the next step boundary. A send whose row landed
hides one host listing of its text while the host's queue still has it (`reconcileQueue`), so delivered messages
leave the strip with their rows, together when they land together. omp pulls back only its last queued message (the
last steer, else the last follow-up), so the pencil and × sit on that chip alone; a pull that finds nothing left
(`agent.dequeue` → `{}`) says "Already delivered" and clears this client's settled sends (hostd drops its own list).
Tests: `bun test src/features/session/composer/queue.test.ts`.

Quick commands (`@/core/quickCommand`, `composer/quick.ts`, `composer/QuickCue.tsx`, `composer/RunStrip.tsx`;
architecture §3.4): a draft without attachments that omp's composer would read as `!cmd`, `!!cmd`, `$ code` or
`$$ code` (judged on what was typed, trimmed; a `$` line that reads like a shell command, such as `$ git status`, is
a message, as in omp) shows a cue above the text (`!` badge, "Shell command · output goes to the agent" / "· output not
added to the context", Python likewise), and Enter (or the send button, then a terminal icon) runs it with
`agent.shell`, the paste tokens expanded: never a steer or a follow-up, also while the agent works. The draft clears once
the host took it, an error toasts, and the "Running" strip shows the run until its row lands (`useRuns`; "Still
running" when omp had not finished after 15 s). A session without `caps.shell` (an older bridge, no TUI) says so in the
cue and on Enter, and sends nothing. Rows (`transcript/rows.tsx` `UserRunRow`): a tool row with `userRun` is the
user's, right-aligned under "You ran" ("not in context" for `!!` / `$$`), its bash card labelled with the prefix and
its output in ANSI colours; it is off the tool-call timeline and ends `lastTurnRetryable`'s walk like a user row. Tests:
`bun test src/core/quickCommand.test.ts src/features/session/composer/quick.test.ts src/core/demo/quickRuns.test.ts`.

Chats (`Agent.chat`, features/chats): the desktop header and the phone top bar's subtitle show the "Chat" chip
(`ChatTag`) where repo · branch go; the ⋯ menu (dropdown and phone sheet) leaves out Move to host… and adds
"Delete chat…" under End session; the inspector's Changed files lists them without Review links.

Inspector cards (`inspector/`; architecture §6.3): every card (Session, Todos, btw, Subagents, Background jobs,
Artifacts, Changed files, Agent chat, Session tree on the desktop rail and the phone's tab bodies, and the Session
card's Spend, Throughput and Resources tiles) is an `InspectorCard` / `CollapsibleTile`: a chevron button (`aria-expanded`) and a
click on the title collapse it; the card's id (`cards.ts` `CardId`) is remembered on this device (`tf.inspector`,
`useInspectorCards`; only collapsed ids are stored) and a collapsed card shows a one-line summary
(`summaries.ts`: Session `ctx 41% · limit 58% left · $2.41`, Todos `3/7 · <task in progress>`, Subagents `2 running · 1 failed`, else `3 done · 1 stopped`,
Changed files `9 files +531 −63`, tree, btw, jobs, artifacts) in place of its body, which unmounts (a collapsed tree
does no layout; the transcript's width does not change). `setTab` (a `/btw` or `/todos` request, a phone tab pick)
opens a collapsed card. Side questions: each row collapses (question + turn count stay; Follow up and Cancel hide) and
can be dismissed (×; not while answering); the card has Collapse all / Dismiss all from two side questions on, and
stays with its input when every one is dismissed (fold it like any card to put it away). Both marks
persist per session on this device in `tf.inspector` (`sessionScope`: host + omp session id, so a reopened pane keeps
them; the newest 300 ids of the newest 40 sessions). Subagents (`subagents/SubagentList.tsx`, `subagents/grouping.ts`):
a tree, each subagent's own subagents under it at any depth (`Subagent.parentId`, else the dotted id `A.B.C` → `A.B`;
a subagent whose parent the roster lacks stays at the top level with "from <id>"; rows in a branch drop the parent's
name, `Shots` under `Lab.Ui`). A parent with subagents gets a rail and a roll-up line ("3 subagents · 2 running · 1
failed") that folds them; a branch is open while anything below it runs or failed, and what the user picks is kept
per session in `tf.inspector` (`subs`, same caps). Each level: running, then failed (counting what is below), then
finished, latest end first; branches that finished entirely go into the collapsed "N completed" group (open state
per agent key while the app runs), the rest stay on top, a done parent of a failed grandchild included. The card's
header and collapsed summary count every depth (`tallySubagents`). The viewer's `[` / `]` follow the tree order
(`treeOrder`) and its header shows "under Lab › Ui" (each opens that parent) and the roll-up, which opens the first
child. Changed files lists the repository's files only: `repoFiles` drops
omp-internal paths (`local://…`, `artifact://…`, omp's session folder) that hosts before 0.9.0 still put in
`SessionMeta.files`; tf-collab's replica no longer records them (architecture §3.20). Background jobs lists
commands only (`withoutSubagents`: `task` jobs are subagents, shown under Subagents at any nesting depth; a command a
subagent started stays, labelled "by <subagent>"); its count and the "Waiting for N background jobs" line count
commands (`commandSummary`), and the bridge's `jobs` summary counts them the same way (the wait still covers
subagents: omp resumes the turn when one reports back). Tests: `bun test src/features/session/inspector
src/features/session/jobs src/features/session/subagents src/core/demo/subagents.test.ts`.

Progress and time left (`@/core/progress`, pure and tested; board `ProgressChip.tsx` for `useTurnProgress`): the main
agent's own estimate of its turn (`OmpInfo.progress {pct, stage?, at, since}`: TeleFlock's bridge ≥ 2.6.0 asks omp
about 2, 5, 10, 30 and 60 minutes into a turn; hostd drops it when the turn ends) shows only while the agent runs on an
online host with herdr up: under the session's name as `header/ProgressLine` (a bar, "64% done", its step in its own
words, which gives way first, "~7m left"; on the desktop while the inspector rail is not on screen, on the phone under
the chips, where the recap stands once the agent is idle) and as the Session card's first tile (`inspector/ProgressTile`:
bar, "64% done", the step, time left, "estimated 3m ago"; folded, the card's summary starts with "64% done · ~7m left",
`ProgressSummary`). Time left is the pace so far, `(at − since) × (100 − pct) /
pct`, counted down from `at`: none under 5 % or with less than a minute behind the estimate; past its end "any minute"
for a fifth of the estimated whole (1–5 min), then "over estimate", never a negative time; the tooltips give the basis
("64% after 12m: at that pace about 7m more"). Subagents show it after their percentage (`SubagentMeters`: Subagents
card, task card rows, viewer header; `since` = `startedAt`, `at` = `Subagent.completionAt`, hosts ≥ 0.9.5), and a task
card's summary reads "2 live · ~40% done · ~3m left" once every running subagent's estimate tells (`timeLeftOfAll`:
the one ending last). Demo: the agents seeded mid-turn (kanban, pool, ci, quota) open with the answer to the bridge's
last ask; new turns are asked ten times faster than the bridge asks (12 s, 30 s, 60 s, 3 min, 6 min, then every 6 min:
time left from the 60 s answer on), never during omp's retry wait (quota goes "over estimate"); answer pool's question
and its load test runs two subagents for about 2.5 minutes, with time left on the task card from about 80 s in. Tests:
`bun test src/core/progress.test.ts src/core/demo/progress.test.ts`.

Spend and throughput by model (`spend.tsx`; tf-hostd ≥ 0.9.5 fills `CostSplit.models` / `TpsSplit.models`, see
`crates/tf-collab` "Spend by model"): each spender row of the Spend tile (Main agent, Subagents, Advisor) and of the
Throughput tile opens that spender's figure by model, the largest first: model id, provider, value (USD or tok/s),
share and a share bar in the Usage page's model colours (`agentGlyphTheme("provider/model")`), then the glossary line
the row's label carried as a `<Term>`. `SpenderRow`: a tooltip on hover or focus (to the left of a Spend row, below
a Throughput one), a popover on tap on touch; a row without a split (an older host, a spender at 0) stays plain with
its `<Term>` label. The header's cost tooltip (shown while the inspector rail is not) lists each spender's models
under it. Demo: every omp agent's spend splits by model (its own model, its side calls on the smol model, each
subagent's model, the advisor's), and while `pool`'s subagents stream, Throughput splits by the models streaming.
Tests: `bun test src/core/demo/modelShares.test.ts`.

Resources (`inspector/ResourcesTile.tsx`, data in `features/hosts/agentLoad.ts`; tf-hostd ≥ 0.9.5 fills
`HostHealth.agents`, see `crates/tf-hostd` "Agent loads"): the Session card's last tile, while the agent runs a
process on an online host: CPU as a share of the whole host ("22% of host", the cores in use under it) and
resident memory ("2.4 GB", its share of the host's memory and the process count) of the agent's process and
everything it started, each bar warm from the board card's threshold on (`loadLevel`), then the CPU of the last 3
minutes as a sparkline (one sample per 5 s health tick; a flat line with "idle · under 1% of the host's CPU" below
1 %). Collapsed it reads `cpu 22% · 2.4 GB`; the tooltip names the host and what counts. Demo: prompt a forge agent
with "fix the flaky test": its `bun test` runs take 5–8 of forge's 16 cores and about 2 GB. Tests: `bun test
src/features/hosts/agentLoad.test.ts src/core/demo/agentLoads.test.ts`.

Large pastes (`composer/usePasteAttach.ts`, `composer/PasteChips.tsx`, `composer/pasteThreshold.ts`; model
`@/core/pastes`, store `@/core/draftPastes`; architecture §6.5): a paste of more than 10 lines or 1000 characters
becomes omp's marker `[Paste #N, +L lines]` in the text and a chip above it (first line, `#N`, size, inline or
attachment block); from the host's omp `paste.largeMenuThreshold` lines on (`omp.settingValues`, default 100) omp's
menu opens: **Attach as a wrapped block** (sent as `<attachment>…</attachment>`), **Attach as local file**
(`session.writeLocal` → `local://paste-N.md` in the message) or **Paste inline** (↑↓ Enter; Esc, typing or clicking
away keeps it inline). The chip opens the same menu (current choice checked) plus Edit as text and Remove; × removes.
Markers delete, copy, cut and take the caret as one unit; the send expands them as omp does on submit. Pastes stay
with the draft (IndexedDB, like images) and go when sent. Tests: `bun test src/core/pastes.test.ts
src/core/draftPastes.test.ts src/features/session/composer/pasteMenu.test.ts src/core/demo/pastes.test.ts`.

Roles (this session): "Roles (this session)…" at the foot of the desktop Model popover and of the phone "Model &
thinking" sheet opens `SessionRolesDialog` (`features/agentRoles`, mounted by `SessionDialogs`, `dialog: "roles"`):
`agent.getRoleModels` → the agent's own model roles and fallback chains over the host's, Save →
`agent.setRoleModels` with the complete maps (a changed Default switches the session's model). The host's omp
settings stay as they are; an older bridge (`unsupported`) or hostd (`unknown_method`) says what to update.
Above the roles, the model presets (`ModelPresetsSection` with `session`, `features/agentRoles`): a preset fills the
dialog's maps (its main model becomes the Default role, `sessionMaps`; nothing applies before Save), Save as preset
keeps what the dialog shows (`sessionFields`), One model for every role sets Default and every chat role, Reset all
clears the session's own roles and chains.
The Model popover's "Roles" rows show the agent's own bindings (`useSessionRoles`: `agent.getRoleModels` over the
host's `catalog.roles`), so `@smol` names the model picking it switches to; without the call they show the host's.

Subagent viewer (`subagents/SubagentViewer`, one per session, mounted by `SessionPane`): open it with
`useSessionUi.getState().openSubagent(agentKey, subagentId)` (inspector Subagents pane, task cards, IRC
bubbles, a name's menu on the message board); opening another subagent switches it. Right-side drawer on desktop, full-screen
sheet on phones. `[` / `]` previous / next subagent, `Esc` close, `Enter` steer/message, `Shift+Enter` newline.
The viewer offers **Retry** for a failed or aborted subagent when the session has `caps.subagentRetry`
(`resume/SubagentRetry`: `agent.retry {agentId, subagentId}`; omp revives it and its result reaches the parent).

Agent chat and the message board (`irc/`; architecture §6.17, host side §3.34): every omp IRC message of the
session's whole agent tree (Main, subagents at any depth, the user's own sends as "You"). `irc/store.ts` holds one copy
per agent key: `session.agentChat` whole once, then `{epoch, after: rev}` whenever `SessionMeta.agentChat` names a newer
revision or another epoch (`chat.ts` `mergeChatPage`: changed messages replace theirs by id, new ones join in time
order, 2,000 kept); a log the host reads from files (`live: false`, older bridge) is fetched again every 3 s while
the board shows (10 s for the card). Without the field (hosts before 0.9.0) the board shows the session's own IRC
rows (`fromTranscript`) and says so. The inspector's Agent chat card shows the newest three messages, unread (a dot,
"N new") and counts; its title, Open message board and each preview (at that message) open the board, and so do
"Message board" in the session menu (the phone's ⋯ sheet too) and the palette's "Open agent message board", both for
sessions with subagents or agent chat (`useHasAgentChat`) (`boardUi.tsx` `openBoard`): the split panel beside the
session (`SplitState` kind `agentChat`, `SplitHeaderRow`, Full
screen) on desktop, `FullscreenFrame` on phones and in focus mode (`AgentChatOverlay`, mounted once by the app). The
board (`MessageBoard.tsx`, virtualised with `TranscriptLog`): one chronological channel, sender glyph and name
(nested ones "under PoolBench › Sweep"), → recipients or everyone (a broadcast; who got it in the tooltip), time,
the quote it answers (a click brings it into view), Markdown body (long ones clamped), progress notes lighter, the
delivery line (sending / queued / delivered / woke it / 5/6 delivered · 1 queued / not delivered: why), consecutive messages of the
same sender to the same recipients folded; a "New" divider above what arrived since the board was last open on this
device (it opens there when more than the last few rows are new) and Jump to latest. Filters: by agent (one: what it
sent or got; two: only between them; also from a name's menu) and a literal, case-folded search over texts and names.
Unread: `irc/seen.ts` (`tf.ircSeen` v1, the newest `at` read per session: host + omp session id once known, so a parked
agent resumed under a new agent id keeps it, else the agent key, whose mark moves over; 200 sessions; the user's own
never count).
Composer: one subagent or All running subagents (`agent.subagent` chat; one request per running subagent with
`broadcast: true`, which the log shows as one message), Enter sends; the main agent takes the session's composer.
Delivery (`chat.ts` `deliveryOf`, `DeliveryState.tsx`, the same on the board and in the transcript's IRC bubbles): omp's
`injected` means queued: the recipient was busy and takes the message in when its current step ends (after a long tool
call, maybe minutes later). It shows "queued" (tooltip "Waiting for X to finish its current step") until the log says
`received` (the recipient's transcript has it; tf-hostd ≥ 0.9.5 reads the session's files every 2 s while a message
waits, so the log's revision moves when it arrives), then "delivered"; `woken` / `revived` show "woke it" / "revived
it"; several recipients "2/3 delivered · 1 queued · not to Sweep". An outbound IRC bubble finds its message in the log
(`store.ts` `useLoggedSend` → `chat.ts` `logEntryOf`: the transcript's agent as sender, the same recipient and text,
the first sent at or after the row's time, so identical sends pair up in order) and takes its `received`
(`rowReceipts`); the log is read only for a send omp queued. Without the log's word (no log, not found yet, a tf-hostd
before 0.9.5) it stays "queued" and the tooltip says TeleFlock can't tell.
Demo: in pool's task Main's answer to QueryScout (8.6 s in) stays "queued" for about 12 s (QueryScout is tracing
`db.Open` call sites), then turns "delivered" and shows in QueryScout's transcript; other queued messages arrive about
2 s after they settle.
Tests: `bun test src/features/session/irc src/core/demo/agentChat.test.ts`.

Resume (`resume/`, hosts ≥ 0.7.0), omp's F5: the header (desktop, and the phone top bar) shows **Resume** while the
agent is idle (not running, nothing asked), `caps.retry` isn't false and its last loaded turn failed or was stopped
(`@/core/retryable` `lastTurnRetryable`, tested: from the newest row, past notice/mode/compaction/IRC rows, an
assistant row that ended in an error or abort, or failed/aborted tool calls with no reply after them). The button,
**F5** and **Alt+R** (focus anywhere in the session view, or on nothing at all for the route's session; always
`preventDefault`, so the webview never reloads; they run even without the button) and `/retry` call `agent.retry`
(`resume/actions.ts`): `started:false` toasts "Nothing to resume" and why, `via:"command"` "Sent /retry to omp",
and a tf-hostd without the method (`unknown_method`) gets `/retry` typed into omp (`agent.slash`). While the agent
has an auto-resume ticket (`Agent.autoResume`, any kind) the button gives way to `AutoResumeStrip` under the header
(wording in `resume/words.ts`, tested): "Usage limit · resumes ~03:00 · +1 subagent" (`~`: an estimate; weekday or
date when not today; `checks again` on backoff), "Checking usage…", "Resuming…", "Won't resume by itself —
<reason>"; an ended card's restart (`Agent.parked.ended`, §3.25) "Bringing it back in 0:05" / "Bringing it back…" /
"Ended: herdr stopped · <why it waits>" (the host's setting, Don't, failed tries), a live agent cut off mid-turn
"Continuing where it stopped in 0:42" / "Cut off mid-turn · <why>"; kinds it doesn't know read "Stopped · …".
Actions: Resume now / Continue (now) (`agent.autoResumeNow`) and Don't auto-resume / Don't auto-continue / Dismiss
(`agent.autoResumeCancel`), each with its own hint; the tooltip has the reason, provider · model and since, or for
an ended card when it ended and what it was doing. An ended card without a ticket (herdr is down: hostd makes none)
gets a status line instead, no buttons: "Ended at 13:58 (herdr stopped) · comes back when herdr runs again" (the
clause while `useHerdrDown`). Minute clock (seconds only for a restart's countdown), no animation; on the phone the
line wraps to two lines instead of truncating.

Refusals (`transcript/RefusalActions.tsx`, `features/refusal`, architecture §3.22; sessions with `caps.refusalRetry`, bridge ≥ 2.3.0
and tf-hostd ≥ 0.9.0): the refusal row that ended the session's last turn (`@/core/refusal` `lastRefusalRowId`; only the store's own
row, not an older refusal, a preview or a subagent transcript) offers, while the agent is idle on a live link, **Retry with
<model>** (`agent.refusalRetry`: the model of the host's rule for it, else Sonnet; the chevron picks another from the host's list)
and **Always do this for <category> refusals on <model>** (a rule of the host, first in order, with an Undo toast, and this turn goes
on now). The header's Resume gives way to it, since omp has nothing to retry after a refusal (F5 says so); an agent whose omp lacks
the bridge says to Mark it done and Resume it. Tests: `bun test src/features/refusal src/core/refusal.test.ts`.

Parked agents (`Agent.parked`: Mark done closed the pane): `LinkGate` hands over to `ParkedGate`. With the read-only
snapshot `session.open` returns, the transcript shows under a "Done and closed" strip with Resume (not for an ended
card: the header strip says what happened and offers Continue); when it fails (`parked`), `ParkedNotice` (also used
by the terminal view) explains it and offers Resume / Terminal. The composer keeps working on a parked agent: sending
calls `agent.prompt` (the host resumes it with the prompt), the composer says "Resuming…" (`useResuming`) until the
new agent appears, and the core redirects the route to it.

Transcript (`transcript/Transcript.tsx`): a virtualised list (TanStack Virtual) that sizes rows it hasn't rendered
yet from `transcript/estimate.ts` (`estimateRowHeight`, tested): per row from its content (a collapsed read / grep
call is a one-line card, open views by their capped bodies, text by its wrapped lines; phone metrics when dense),
so the scrollbar stays put while scrolling up measures older rows in (`?demo&long=2000`, production build: the
scroll height drifted −18.5% with 27 jumps up to 24k px before; +2.2% and no jump over 134 px after).
A transcript opens at the bottom: the virtualiser starts at its estimated height less one viewport
(`initialScrollOffset`), so one shorter than the viewport starts at 0 and shows its first rows (a phone used to open a
short session with its first rows missing and a gap in their place).

Code in tool cards (`tools/CodeCard.tsx`, `tools/evalArgs.ts`, tested): an omp `eval` call opens on its code, as a bash
call opens on its output: one card per cell (`{language, code, title}`, older omp's `{cells: […]}`) with the language
(python, or javascript for `js`), the cell's title when the call has several, Copy and the code as the model wrote it,
its lines and indentation kept, highlighted, long lines wrapped, folded past 16 lines ("Show N more lines"; Find's
current match in it unfolds it). Under the code what it printed (ANSI, followed while it runs), then an image it
returned (a browser screenshot's `ImageView`, which used to replace the code). While the model is still writing the
call it reads "writing the code…"; arguments without code fall back to the generic args/output card. A bash card shows
its command in the same card (bash; python for a `$` quick command) whenever the header doesn't show it whole: several
lines, or a line its header cuts off (measured, `useClipped`; the folder it ran in becomes the card's title), and the
header's copy then leaves Find, so the command still counts once. Find (`find/rowText.ts`, and tf-hostd's
`find/rows.rs` for rows not loaded yet) searches an eval call's code as shown, not its JSON arguments, which escaped
quotes and line breaks; the row estimate sizes the open card, wrapped lines included. The highlighter
(`lib/highlight.ts`, tested) reads f-strings (fields as code, `!r` / `:>8` as keywords) and string prefixes in
Python, template literals (`${…}` as code) and regex literals in JS / TS, a member named like a keyword
(`map.get`, `re.match`) as a member, and shell commands, flags, `$(…)` and backticks (inside double quotes too),
assignments, comments that start a word and heredoc bodies; nesting stays linear (code in code at most 4 deep). Demo:
the kanban agent's turn runs JavaScript and Python cells (one a board screenshot) and a long `rg … | sort | uniq -c`
one-liner; a multi-line `$` quick command shows the python card. Tests: `bun test src/features/session/tools
src/features/session/lib src/features/session/find src/features/session/transcript`.

Jump to the last message (`TranscriptLog` `jumpBack`, `transcript/lastMessage.ts`, tested): scrolled up, beside Jump to
latest ("N new", "Streaming") a second pill goes to the newest message, the agent's last text or the user's last prompt,
whichever comes first going up from the bottom (thinking, tool calls, notices, compactions, IRC, omp's system turns and
attempts that only failed are passed over; a text row counts once it has text, so the pill follows a reply streaming in).
"↑ Agent's last message" / "↑ Your last message" ("Agent's message" / "Your message" where the list is narrower than 26rem:
phones, split panes) brings that row's top to the top of the list, just under the fade, and lets go of the bottom like
scrolling up: a row not rendered yet comes in by the virtualiser's estimates, then the row itself is placed frame by frame
until it holds still (any input on the list ends that). The pill hides while the row's top is there or when the list can't
scroll it up that far (the jump would end at the bottom, where Jump to latest goes), and points down while the row is below
the view. The subagent viewer has it too ("Last prompt" for its task or a later prompt); the message board and Past sessions
don't. Demo: `?demo&long=2000`, the pool agent, scroll up. Tests: `bun test src/features/session/transcript`.

Provider limits in the transcript (`transcript/limitRuns.ts`, tested): consecutive failed attempts that said only a provider
limit (an error row with no text, HTTP 429/503/529 or a rate / usage / overload text) fold into one row, "Rate limited ×4 ·
16:54–16:59" (`LimitRunRow`; tap to expand each failure and the system turns omp's background deliveries started between
them; a system turn after the last error stays its own row). Presentation only: the rows stay in the session, and while
Find is open nothing is folded so every match can be reached. omp's "Retrying (n/m) in 294.0s" notice counts down live
("Retrying (1/10) in 4:54: …", "now" once due) while that retry is the one `OmpInfo.retry` names. Under the header
(`RetryStrip`, desktop and phone) the same wait reads "Rate limit · retrying in 4:54 (1/10)"; the auto-resume strip takes
over once omp gave up.

Toasts keep clear of the composer (`data-toast-anchor`; desktop only where it runs under the toast stack) and of an
open ask card or terminal-wait card (phones too), which call `toastAnchorsChanged()` once they have landed or gone.

A wait only the agent's terminal can answer (`needs.answerable` false, no dialog open in the session: an omp prompt the
host can't bring here, herdr's `blocked`) shows where the ask card goes (`ask/TerminalWait.tsx`, `terminalWait`): its
question and detail and **Answer in terminal** (desktop: the terminal beside the session; phone: the terminal view), as
the board, Inbox and Answer-next HUD offer it. Before, the session showed nothing above "Answer above, or steer…".

Decide for me on the ask card (`features/autoAnswer/AskCountdown`, hosts ≥ 0.7.0): while the card's question has a
decide-for-me countdown (`Agent.autoAnswer`, same request), a strip above Chat about this / Skip says "auto-picks ★
Use SQLite in 12:40" (seconds clock) or "… when no app is connected · 25:00 left", with Cancel
(`agent.autoAnswerCancel`), +10 min and +1 h (`agent.autoAnswerPostpone`); once cancelled "Won't auto-pick this
question" with Restart (the policy's whole wait); no buttons while it picks. It goes once you answer. Its buttons
take no keys (1–9 and Enter still answer the card); on phones they are 32 px tall and wrap under the text. The
session menu's "Decide for me…" (omp agents, hosts with decide for me) opens `features/autoAnswer/DecideDialog`.

What the agent said, and Back (`ask/AskCard.tsx`, `ask/AgentSaid.tsx`, `ask/askContext.ts`): above the question the card
shows what the agent wrote before asking, under "Agent said": `UiRequest.context` (asks, hosts ≥ 0.8.0) as Markdown,
four lines (three on phones) with a fade and Show more / Show less only when it runs longer (measured). Trailing
paragraphs that only repeat the question are dropped (`withoutQuestion`: Markdown markers, case and spacing ignored; a
paragraph ending with the question keeps what leads up to it: its sentences always, a lead-in of three words or fewer
after them, such as "So," or "My question:", not), so the question never shows twice; `context: ""` shows
nothing. Without the field (older hosts) an ask reads it from the rows the session holds (`contextFromRows`): the text
rows of the message carrying the ask call (`callId`, same `at`), else the latest text since the last prompt (a
non-synthetic user row) with the rest of its message; never thinking; a longer text keeps its last ~4 KB, led by `…`
(`clipContext`, cut as hosts cut it: from a paragraph start, else a line start, reopening a code block's fence). A
multi-question ask (`UiRequest.step`, bridge ≥ 2.2.0) reads "Question 2 of 3" in the card's pill and, from the second
question on, offers ← Back (button; `←` with the card's keys, not while typing nor from a dialog or menu over the
session, like `1–9`) → `agent.answer {back:true}`. The card then locks ("Back ·
waiting for omp") until the previous question arrives as a new request, and so a new card, with its earlier answer:
a multi-select's `step.choices` ticked, a single-select's option lit with Enter / Send answer sending it again (a tap
on any option answers as before), else `step.text` in the open Other field. Without `step` (single questions, older
hosts) there is no progress and no Back. Tests: `bun test src/features/session/ask src/core/demo/demo.test.ts`.

## Find in transcript (architecture §3.27)

- Ctrl+F / Cmd+F in a session (the selected text becomes the query) or "Find in transcript" in the session menu
  (the phone's bottom sheet too) opens `find/FindBar.tsx` over the transcript. Enter: older match, Shift+Enter (Ctrl+G /
  Shift+Ctrl+G, F3): newer, wrapping; `n/total` counts from the newest; Match case; Esc closes and gives the composer
  its focus back.
- Matching (`find/match.ts`, `find/rowText.ts`, tested in `find/find.test.ts`) is literal and case-folded, over what
  a card shows: message text, thinking, tool titles/arguments/outputs (ANSI stripped; an eval call's code as written,
  not its JSON), rich-view fields, errors and
  refusals, notices, summaries. tf-hostd matches the same fields (`crates/tf-hostd/src/find/rows.rs`) for the rows
  not loaded yet (`session.find`, once per query); stepping onto one pages older rows in (`find/SessionFind.tsx`).
- Highlights (`find/painter.ts`) use the CSS Custom Highlight API over the rendered rows only (no DOM or React
  changes), repainted at most every 90 ms; card chrome carries `data-find-skip`. A jump scrolls the virtual list,
  opens the part hiding the match (`useOpenOnFind` from `find/reveal.ts`: tool cards, diff files, thinking, summaries,
  system turns) and centres the occurrence, inner scrollers included; a one-line text cut off with an ellipsis (a
  long command in a tool header) scrolls sideways to it, clipped until the next jump. The jump keeps the occurrence in
  view for 1.5 s while rows measure in or older rows land; wheel, touch, pointer or key input on the list ends it.
- State per scope (agent key, or a preview's own key) in `find/store.ts`; `openFind(scope, {query, target})` is how
  Past sessions opens a session at a match: the target's row once it is among the matches (the host's included),
  else, after the host answered, the first match from the snippet's time.
- Tests: `bun test src/features/session/find` (matching, row texts, the match model, the store).

## Artifacts and context X-ray (architecture §3.20)

- `artifacts/`: `session.artifacts` per agent key (zustand list, refreshed when a turn ends, a subagent settles or a plan review opens; ≤ every 3 s), `artifactRows` (pending review pinned, then plans, reports & notes, subagent outputs, handoffs), the rail panel / phone "Docs" tab and the viewer (Markdown, Copy, Copy path, Mention into the composer draft). Presented documents by kind (`ArtifactView.tsx`): pages, Markdown, drawings, Mermaid (`MermaidFigure`), code, tables, JSON, text; images, PDFs (Review's `PdfView`), audio and video (Review's players) read in ranges with progress (`load.ts`, Review's `readMedia`); a file to save as a card with Save and Open (`useDocActions`, `readFile`). Tests: `bun test src/features/session/artifacts` (kinds, file names, what opens as it is, ranged and older-host reads, files).
- `xray/`: the session dialog `context` (`/context`, the inspector's context meter): omp's `/context` breakdown from `session.context`, Compact with focus (`agent.compact`), Drop images (`agent.slash /shake images` when the answer allows it), jump to a tool row, and the totals + terminal fallback for `unsupported`.
- Tests: `bun test src/features/session/xray` (rows, shares, bar, focus suggestion, the demo methods).

## herdr not up (architecture §6.6; `HerdrGate.tsx`, `features/hosts/herdrHealth.ts`)

An agent shown while its host's herdr server is not up (`useHerdrDown`) never says Running or "collab room":
`LinkGate` renders `HerdrGate`: "herdr stopped at 13:58, so this agent's omp ended. TeleFlock brings it back when herdr runs
again." with the status line ("Starting it again in 12s") and **Restart herdr** / **Terminal**, over the kept transcript (or
as the whole view without one). The header pill (desktop, focus, phone) reads "herdr stopped" / "herdr restarting" /
"herdr not answering" instead of the state and the mode controls go; the `turn` timer, the "Working…" footer, tool-call
timers and a live thought freeze or stop at the outage start (`useHerdrFreeze`, `Elapsed until`); the composer is disabled
with "herdr isn't running on forge". Per-agent ended cards (`Parked.ended`) are Lifeboat's.
