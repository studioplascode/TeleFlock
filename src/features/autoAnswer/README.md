# features/autoAnswer: Decide for me (architecture §3.23)

When a question has a ★ recommended option and nobody answers in time, tf-hostd picks it itself
(never approvals, plan reviews, confirmations or free text; every pick is in Activity as
"Auto-answered ★ …"). Wire types: `AutoAnswer`, `AgentAutoAnswer`, `AutoAnswerCountdown`
(`@/core/gen`); methods `agent.setAutoAnswer`, `agent.autoAnswerCancel`, `agent.autoAnswerPostpone`,
`host.autoAnswerSet`. A host without `HostInfo.autoAnswer` (older tf-hostd) gets no controls.

| File | What |
|---|---|
| `format.ts` | Pure words and numbers (tested in `format.test.ts`): `formatCountdown` (`12:40`, `1:02:03`, never negative), `formatWait` (`20 min`, `1 h 30 min`), `policySummary` ("after 20 min · only with no app connected", "off"), `policyChipText` (Agent options chip, null for the host default), `hostDefaultLabel`, `clampPolicy` (1 min–24 h), `specAutoAnswer` (what a launch spec carries), `currentCountdown` (only when `countdown.requestId === needs.requestId`), `countdownState(countdown, now)` → phase `counting` / `due` (past deadline or `answering`) / `waiting` (`waitingForNoApp`, the clock stands) / `cancelled`, remaining ms, ask-card text, compact card text, tooltip. |
| `countdownActions.ts` | Pure (tested in `countdownActions.test.ts`): the ask-card strip's buttons per phase: Cancel, +10 min, +1 h while it counts or stands; Restart with the policy's whole wait once cancelled; none while it picks. |
| `CountdownChip.tsx` | `CountdownChip {agentKey, sunset?}`: the chip on needs-you cards (board card above its quick answers, white on the sunset hero card; phone Flock card): "auto-picks in 12:40", "when no app · 12:40 left", "auto-picking…", tooltip what it picks. Nothing without a countdown on the question shown, or once cancelled. |
| `AskCountdown.tsx` | `AskCountdown {agentKey, requestId, compact?}`: the strip on the sunset ask card (desktop and phone, gone once answered), only for the countdown on that request: the ask-card text with the buttons of `countdownActions` (`agent.autoAnswerCancel`, `agent.autoAnswerPostpone`). Buttons are off while a call is on its way and handle no keys (1–9 and Enter stay the card's); on phones they are 32 px tall and wrap under the text. Chip and strip are static; the second clock runs only while a countdown counts (`useCountdown`). |
| `hooks.ts` | `useCountdown(agentKey)` (the countdown on the question shown plus its words; re-renders each second only while it counts to a deadline, and no other agent update reaches it), `useHostAutoAnswer(hostId)` (`HostInfo.autoAnswer`), `useCanDecide(agentKey)` (an omp agent on a host with decide for me). |
| `actions.ts` | The calls: `cancelCountdown`, `postponeCountdown`, `setAgentAutoAnswer` (toast "push decides for you after 10 min", "push follows the host default"), `setHostAutoAnswer`; one call per agent (or host) at a time (`useAutoAnswerPending`), failures as error toasts with the host's words. |
| `PolicyEditor.tsx` | `PolicyEditor {value, onChange, hostDefault?}`: Host default · Off · On (Host default only where one applies; it says what the default does), then the wait (5, 10, 20, 30 min, 1 h, 2 h, or Custom in whole minutes 1–1440) and "Only while no app is connected". `AutoAnswerSection` (the Agent options section of the launches; "Update TeleFlock on this host" for a tf-hostd without it) and `autoAnswerChip` (its header chip, none for the host default). |
| `DecideDialog.tsx` | `openDecideDialog(agentKey)`, `DecideDialog` (mounted once in `app/App.tsx`; a bottom sheet on phones): a running or parked agent's own policy (`agent.setAutoAnswer`; Host default sends none). Shows the countdown of its question now, which a change applies to at once. Opened from "Decide for me…" in the board card's ⋯ / right-click menu and the session's ⋯ menu (`ACTIONS.decideForMe`, omp agents on a host with decide for me). |
| `HostDefaults.tsx` | Settings → Decide for me (`AutoAnswerSettings`, after Auto-resume): each host's default (`host.autoAnswerSet`) with Save / Undo, since a shorter wait applies to questions already waiting; offline: what it is, "connect the host to change it"; an older tf-hostd: "Update TeleFlock on this host". |

States a countdown shows: counting "auto-picks ★ Use SQLite in 12:40" · due "auto-picking ★ Use SQLite…" ·
waiting "auto-picks ★ Use SQLite when no app is connected · 12:40 left" · cancelled "Won't auto-pick
this question" (ask card only; cards show nothing).

Launches: `AutoAnswerSection` sits after the model roles in the Agent options of New agent and New
worktree (`workspace/shared/AgentFields.tsx`), each Fan out variant, the automation editor and
Dispatch's "More agent options", with `autoAnswerChip` in the header while set (Dispatch: in its
footer chip's text). A spec carries the policy through `specAutoAnswer(value, hostDecides(info))`,
so only when set and the host has decide for me: `toAgentSpec(draft, decides)`, Fan out's `specOf`,
Dispatch's `specOf(entry, hostId)` (checked against the host each task goes to: Auto sends none to
an older tf-hostd) and `automationDraft` (`AutomationDraft.autoAnswer`; editing loads
`Automation.autoAnswer`, the card's switch keeps it through `toDraft`). Templates don't carry it.

Demo (`?demo`, `src/core/demo/autoAnswer.ts`): forge's default is on (20 min), studio-pc's off; push's
★ question counts down from 12:40, flags (its own 30 min, only with no app) stands at 25:00 left;
the director leaves questions you cancelled or postponed to you.
