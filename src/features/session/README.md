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
the agent works), `Shift+Enter` newline, `Alt+Enter` queue follow-up (while it works), `1–9` answer the sticky ask
card, `←` its previous question (multi-question asks), `/` slash palette, `@` file mention. Phone: the ⋯ menu is a
bottom sheet (its Terminal item opens the full terminal view); a "Next waiting" chip docks above the composer while
other agents need you. `F5` / `Alt+R` resume a failed or stopped turn (below).

Chats (`Agent.chat`, features/chats): the desktop header and the phone top bar's subtitle show the "Chat" chip
(`ChatTag`) where repo · branch go; the ⋯ menu (dropdown and phone sheet) leaves out Move to host… and adds
"Delete chat…" under End session; the inspector's Changed files lists them without Review links.

Inspector cards (`inspector/`; architecture §6.3): every card (Session, Todos, btw, Subagents, Background jobs,
Artifacts, Changed files, Agent chat, Session tree on the desktop rail and the phone's tab bodies, and the Session
card's Spend and Throughput tiles) is an `InspectorCard` / `CollapsibleTile`: a chevron button (`aria-expanded`) and a
click on the title collapse it; the card's id (`cards.ts` `CardId`) is remembered on this device (`tf.inspector`,
`useInspectorCards`; only collapsed ids are stored) and a collapsed card shows a one-line summary
(`summaries.ts`: Session `ctx 41% · limit 58% left · $2.41`, Todos `3/7 · <task in progress>`, Subagents `2 running · 1 failed`, else `3 done · 1 stopped`,
Changed files `9 files +531 −63`, tree, btw, jobs, artifacts) in place of its body, which unmounts (a collapsed tree
does no layout; the transcript's width does not change). `setTab` (a `/btw` or `/todos` request, a phone tab pick)
opens a collapsed card. Side questions: each row collapses (question + turn count stay; Follow up and Cancel hide) and
can be dismissed (×; not while answering); the card has Collapse all / Dismiss all from two side questions on, and
hides itself when every one is dismissed (a `/btw` or the phone's btw tab brings it back with its input). Both marks
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
delivery line (sending / delivered / woke it / 5/6 delivered / not delivered: why), consecutive messages of the
same sender to the same recipients folded; a "New" divider above what arrived since the board was last open on this
device (it opens there when more than the last few rows are new) and Jump to latest. Filters: by agent (one: what it
sent or got; two: only between them; also from a name's menu) and a literal, case-folded search over texts and names.
Unread: `irc/seen.ts` (`tf.ircSeen` v1, the newest `at` read per session: host + omp session id once known, so a parked
agent resumed under a new agent id keeps it, else the agent key, whose mark moves over; 200 sessions; the user's own
never count).
Composer: one subagent or All running subagents (`agent.subagent` chat; one request per running subagent with
`broadcast: true`, which the log shows as one message), Enter sends; the main agent takes the session's composer.
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

Provider limits in the transcript (`transcript/limitRuns.ts`, tested): consecutive failed attempts that said only a provider
limit (an error row with no text, HTTP 429/503/529 or a rate / usage / overload text) fold into one row, "Rate limited ×4 ·
16:54–16:59" (`LimitRunRow`; tap to expand each failure and the system turns omp's background deliveries started between
them; a system turn after the last error stays its own row). Presentation only: the rows stay in the session, and while
Find is open nothing is folded so every match can be reached. omp's "Retrying (n/m) in 294.0s" notice counts down live
("Retrying (1/10) in 4:54: …", "now" once due) while that retry is the one `OmpInfo.retry` names. Under the header
(`RetryStrip`, desktop and phone) the same wait reads "Rate limit · retrying in 4:54 (1/10)"; the auto-resume strip takes
over once omp gave up.

Toasts keep clear of the composer (`data-toast-anchor`; desktop only where it runs under the toast stack) and, on
desktop, of an open ask card, which calls `toastAnchorsChanged()` once it has landed or gone.

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
  a card shows: message text, thinking, tool titles/arguments/outputs (ANSI stripped), rich-view fields, errors and
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

- `artifacts/`: `session.artifacts` per agent key (zustand list, refreshed when a turn ends, a subagent settles or a plan review opens; ≤ every 3 s), `artifactRows` (pending review pinned, then plans, reports & notes, subagent outputs, handoffs), the rail panel / phone "Docs" tab and the viewer (Markdown, Copy, Copy path, Mention into the composer draft).
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
