# features/{board,inbox,activity,usage} (owner: FrontBoard)

The home of the app: the "is everything alive?" surface.

## Public API (stable)

```ts
// src/features/board/BoardView.tsx — desktop home (#/board, #/). Mounts <WhileAwayToast/> itself.
// Toolbar: repo filter (each repo with its accent icon), search, Status|Repo; the host filter is the title-bar pill and "New task" (D → Dispatch) is the sidebar's primary button.
// Bento row: [First steps] · Stats (today's spend, tokens, lane bar, tightest subscription window → Usage) ·
// Hosts (one row per host: orb, name + hostAccent swatch, latency/phase, cpu, ram bar, load → Hosts) · live terminal.
// Windows ≤ 820 px tall (`short:`) get the same facts in one ~72 px strip (BentoStrip).
// Lanes (vocab LANE_ORDER/LANE_TITLE/LANE_LEGEND): Needs you (header links to Inbox; top card gets the sunset
// hero treatment) · Running · Review · Done (footer: Older → Activity, Closed panes → Past sessions).
export function BoardView(): JSX.Element;
// src/features/board/FlockHome.tsx — mobile home (same routes on mobile). Mounts <WhileAwayToast/> itself.
// Header: repo chip (FlockActions.tsx `RepoChip`: shown once the agents in view span 2+ repos, or while one is picked;
// its sheet sets useBoard().repo, the same filter as the desktop toolbar) and host chip (one host → Hosts; several →
// host-filter sheet driving useHosts().setFilter), "+" FAB above the bottom nav → create sheet (new worktree / agent,
// fan out, open folder, past sessions).
// Acting tiles: "need you · Answer →" opens the HUD, "running ↓" scrolls to Running (counts quiet agents: working,
// no events for QUIET_AFTER_MS), "$ … today ›" opens Usage. One-line offline strip per host (connAction verb) plus
// <SetupGaps/>. Rows: name · RepoTag, ⋯ (CardMenuButton mobile; Review/Done rows add "Delete worktree…" once the PR
// is merged or closed), Review rows with Mark done + Review, ctx/subs/diff/Connect/model meta, swipe Stop turn on
// running rows. Needs cards show the RepoTag under the agent pill.
export function FlockHome(): JSX.Element;
// src/features/inbox/InboxView.tsx — #/inbox (desktop + mobile): "Needs you" (today's needs cards, oldest first) then "Updates"
// (unread notifications via notify/NotificationCenter `useUpdates`/`UpdatesList`, 20 then "N more in Activity →").
export function InboxView(): JSX.Element;
// src/features/inbox/AnswerNextHud.tsx — global overlay, mount once. Renders while useUi().answerNextOpen.
// Starts at useUi().selectedKey when that agent needs you, else the oldest inbox item. Tab/J/K, Enter, Esc here;
// 1…N (Other = N+1) come from its QuickAnswer (`hotkeys`). Footer link "All in Inbox · Ctrl 2". Ctrl+J toggling is the shell's keymap.
export function AnswerNextHud(): JSX.Element | null;
// src/features/activity/ActivityView.tsx — #/activity
export function ActivityView(): JSX.Element;
// src/features/activity/WhileAwayToast.tsx — reconnect digest (finished / needs / cost delta per host)
export function WhileAwayToast(): null;
// src/features/usage/UsageView.tsx — #/usage: cost/tokens (`host.usage`) + "Subscriptions & limits"
// (LimitsSection.tsx, `host.limits` via `useAccountLimits`): one tile per account (merged across hosts by
// `LimitAccount.key`), each window's % left, reset countdown, %/h pace and "hit the limit in ~X" /
// "resets before you run out"; striped bar = projected use at reset. `limitsUi.ts` (provider names,
// tint) is shared with the inspector LimitsTile / header LimitsChip and the board Stats tile.
export function UsageView(): JSX.Element;

// src/features/board/QuickAnswer.tsx — inline answer controls for a NeedsYou (agent.answer), drawn with the shared option
// model in src/features/inbox/AnswerParts.tsx (also used by session AskCard): number badges, "★ recommended" outline,
// descriptions inside the buttons, "+N more" → HUD past `max`, "Answer…" → HUD for input requests on cards,
// textarea + Skip on `full` surfaces (Inbox, HUD).
export function QuickAnswer(props: { agentKey: string; appearance?: "card" | "hero" | "big"; max?: number; full?: boolean; numbered?: boolean; hotkeys?: boolean; mobile?: boolean; chat?: boolean; onAnswered?(): void; className?: string }): JSX.Element | null;

// src/features/board/agentActions.ts — shared agent actions (board, phone, review, palette)
export function archiveWithUndo(keys: readonly string[]): Promise<void>; // Mark done (+ close: Settings.closeDone) + Undo toast (no confirm)
export function markDoneAndRemove(key: string): Promise<void>; // confirm → worktree.remove (dirty → force confirm, trust prompt) → archive; never rejects
export function deleteWorktree(key: string): Promise<void>; // the same flow for shipped PRs ("Delete worktree…"); archives only agents not done yet
export function resumeParked(key: string): Promise<string | null>; // agent.resume of a parked agent → new key (failures toast; old hosts: "update")
// also: setArchived (unarchiving a parked agent resumes it), answerAgent, stopAgent, openAgent, promptAgent,
// openTerminal (parked: resume first, then the new pane), openAnswerHud, canReview, setMuted, useMuted

// src/features/board/StaleHosts.tsx — host strips above the lanes
export function StaleHosts(): JSX.Element; // offline/snapshot strip per host (connAction verb) + SetupGaps
export function SetupGaps(): JSX.Element;  // online host without session sharing / herdr integration → "Fix…" = #/hosts?setup=<id>; dismiss per host (tf.board.setupGaps)

// src/features/board/LiveBits.tsx — card parts shared with the phone rows
// AgentOrb, AgentHeartbeat ("last event 4s ago"), useQuiet, QuietChip, ToolChip, LiveLine, TpsSparkline ("tok/s"),
// ContextMeter ("ctx 61%", neutral until 80 %), SubagentsDone ("subs 59%"), ConnectLinkButton (not-shared → /collab)

// src/features/board/RepoTag.tsx — where an agent works, on every agent surface (cards, phone rows, Inbox/HUD header)
export function RepoTag(props: { hostId: string; repo?: string; branch?: string; cwd?: string; sunset?: boolean; className?: string }): JSX.Element | null;
export function repoAccent(repo: string): string; // agentGlyphTheme(repo).from: the Repo grouping glyph's colour

// src/features/board/worktreePr.tsx — merged/closed PR of a Review/Done card's linked worktree (lazy gh.prStatus)
export function useShippedPr(agentKey: string): { state: "MERGED" | "CLOSED"; number?: number } | null;
export function PrProbe(props: { agentKey: string }): JSX.Element | null; // invisible; mount inside the card's positioned surface

// src/features/board/shipMemo.ts — what Review last saw of a worktree's ship pipeline (fed by ReviewView, read by review cards)
export function rememberShip(hostId: string, workspaceId: string, memo: { stage: number; blocked: boolean; next: string; pr?: number }): void;

// src/features/board/firstSteps.ts — First steps checklist (demo: 6 steps; fresh real host: setup → first agent → first answer),
// ticked by state changes (activity "You answered…", steer queue, Review/palette opened, dispatch/ worktrees), persisted in tf.firstSteps.
```

Everything is re-exported from `src/features/board/index.ts`.

## Cards

Five fixed zones on every lane: (1) state strip (`agentStateWord` + tool, `stateTime` top-right), (2) identity (todo
ring/glyph · name · host chip when > 1 host · repo chip · branch), (3) title, (4) lane body, (5) meters in one order that
wraps (`ctx` · `subs` · diff · ✦ model · 🧠 thinking). Motion budget: in Calm (default) running cards keep only the
heartbeat trace and a standing tool ring; needs-you glow/pulse play three cycles on arrival, then the 20 s nudge repeats;
Lively restores looping glow/breath/orbits. Per-second work stays out of the card: `useQuiet` is a threshold timer,
`QuietChip`/the heartbeat age own their 1 s clock, and `TpsSparkline` stops sampling a flat zero line.

**Repo chip** (`RepoTag`, also on phone rows, phone needs cards and the Inbox/HUD needs header): FolderGit2 + repo name
on a soft tint of the repo's accent (`repoAccent`, so a repo has the same hue as its Repo-grouping glyph and its
filter icon); white on a dark tint on the sunset hero card. An agent outside a git repo gets a neutral folder chip
(FolderOpen + cwd basename, `~` for the host's home). The branch follows as secondary mono text and truncates first.
Static styles only: no animation, blur or layer.

**Delete worktree** (Review and Done cards that ran in a linked worktree whose pull request is merged or closed): a
danger button on the desktop card and "Delete worktree…" in the ⋯/right-click menu (on Review it takes the place of
"Mark done & remove worktree…"). The worktree is `agentWorktree(agent)`: the live workspace's, else the parked card's
`Agent.parked.worktree` (Mark done closed that workspace; hosts ≥ 0.5.2, older ones omit it and show no button).
It runs `deleteWorktree`: `removeWorktreeTarget`'s confirm, force confirm when dirty, trust prompt for repos owned by
another user, toast; a Review agent is marked done afterwards. A parked card's worktree goes by path
(`worktree.remove {workspaceId: "", path}`), and the card stays in Done with its transcript. The PR state
comes from Review's memo (stage merged) or from `worktreePr.tsx`: each such card (not fresh, host online) carries an
invisible `PrProbe`; after 600 ms on screen it queues `gh.prStatus {cwd: worktree}` (2 in flight per host, none
while the window is hidden), cached per host + worktree path + branch. Answers hold 30 min (merged/closed), 5 min
(open), 10 min (no PR); a card still on screen asks again when its answer expires. Failures never toast: timeouts
and offline hosts keep the last answer and retry in 1 min; gh missing or signed out (or a host without
`gh.prStatus`) means no button and no further asks to that host for an hour; other gh errors (no GitHub remote)
hide the button for that worktree for an hour.

**Parked agents** (Mark done closed their pane, `Agent.parked`): a quiet "closed" chip (`ParkedChip`, "resuming…"
while it resumes) on the card and the phone row; the ⋯ menu offers Open, Resume, Terminal (resumes first),
Reopen (resumes too) and, once its worktree's pull request is merged or closed, Delete worktree…; no Review (the
worktree workspace may be gone), no Connect. Dragging one back to Review
resumes it; the card then reappears under the new id (the optimistic move clears when the old one leaves).

## Board keyboard (desktop, only while the board is mounted and focus is not in a text field)
`J`/`K` (or arrows) move selection (`useUi().select`), `H`/`L` jump lanes, `Enter` open session, `A` answer (opens the
HUD at the selected card), `T` terminal split, `X` select, `/` focus search, `Esc` clear selection.
