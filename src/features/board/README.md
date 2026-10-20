# features/{board,inbox,activity,usage} (owner: FrontBoard)

The home of the app: the "is everything alive?" surface.

## Public API (stable)

```ts
// src/features/board/BoardView.tsx — desktop home (#/board, #/). Mounts <WhileAwayToast/> itself.
export function BoardView(): JSX.Element;
// src/features/board/FlockHome.tsx — mobile home (same routes on mobile). Mounts <WhileAwayToast/> itself.
export function FlockHome(): JSX.Element;
// src/features/inbox/InboxView.tsx — #/inbox (desktop + mobile)
export function InboxView(): JSX.Element;
// src/features/inbox/AnswerNextHud.tsx — global overlay, mount once. Renders while useUi().answerNextOpen.
// Starts at useUi().selectedKey when that agent needs you, else the oldest inbox item.
// Owns its in-overlay keys (1–9, Tab/J/K, Enter, Esc). Ctrl+J toggling is the shell's keymap.
export function AnswerNextHud(): JSX.Element | null;
// src/features/activity/ActivityView.tsx — #/activity
export function ActivityView(): JSX.Element;
// src/features/activity/WhileAwayToast.tsx — reconnect digest (finished / needs / cost delta per host)
export function WhileAwayToast(): null;
// src/features/usage/UsageView.tsx — #/usage
export function UsageView(): JSX.Element;

// src/features/board/QuickAnswer.tsx — reusable inline answer chips for a NeedsYou (agent.answer)
export function QuickAnswer(props: { agentKey: string; size?: "sm" | "md" | "lg"; max?: number; onAnswered?(): void }): JSX.Element | null;
```

Everything is re-exported from `src/features/board/index.ts`.

## Board keyboard (desktop, only while the board is mounted and focus is not in a text field)
`J`/`K` (or arrows) move selection (`useUi().select`), `Enter` open session, `A` answer (opens the HUD at the
selected card), `T` terminal split, `/` focus search, `Esc` clear selection.
