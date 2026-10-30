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
export function AskCard(props: { agentKey: string; request: UiRequest; compact?: boolean; onAnswered?(): void }): JSX.Element;
export function Markdown(props: { text: string; streaming?: boolean; className?: string }): JSX.Element;
```

Keyboard (session owns): `Esc` stop turn (when the composer is empty / not in a popup), `Enter` send (steer while
the agent works), `Shift+Enter` newline, `Alt+Enter` queue follow-up (while it works), `1–9` answer the sticky ask
card, `/` slash palette, `@` file mention. Phone: the ⋯ menu is a bottom sheet (its Terminal item opens the full
terminal view); a "Next waiting" chip docks above the composer while other agents need you. `F5` / `Alt+R` resume a
failed or stopped turn (below).

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
bubbles and threads); opening another subagent switches it. Right-side drawer on desktop, full-screen
sheet on phones. `[` / `]` previous / next subagent, `Esc` close, `Enter` steer/message, `Shift+Enter` newline.
The viewer offers **Retry** for a failed or aborted subagent when the session has `caps.subagentRetry`
(`resume/SubagentRetry`: `agent.retry {agentId, subagentId}`; omp revives it and its result reaches the parent).

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
