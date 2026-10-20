# features/shell (owner: FrontShell)

The app frame: desktop chrome (title bar, sidebar, split view, ambient glow), mobile shell
(bottom nav, sheets, edge-swipe back, pull to refresh), global keyboard map and the shortcuts sheet.
`src/app/App.tsx` mounts it; routing is FrontCore's `navigate`/`useRoute` from `@/core`.

## Public API (stable)

```ts
// @/features/shell/haptics
export type HapticKind = "tick" | "select" | "success" | "warning" | "heavy";
export function haptic(kind?: HapticKind): void;           // Android plugin via core when present, else navigator.vibrate, else no-op

// @/features/shell/PullToRefresh
export function PullToRefresh(props: { onRefresh?: () => Promise<unknown>; children: ReactNode; className?: string }): JSX.Element;
// default onRefresh = refreshAll(). The shell already wraps scrolling phone screens; only use it for your own nested scrollers.

// @/features/shell/MobileHeader
export function MobileHeader(props: { title: ReactNode; subtitle?: ReactNode; back?: boolean; actions?: ReactNode }): JSX.Element;
// sticky, safe-area aware top bar for mobile screens (back = history back with a spring).

// @/features/palette/registry
export interface PaletteCommand { id: string; title: string; group?: string; keywords?: string[]; icon?: ReactNode; shortcut?: string; hint?: string; run(): void | Promise<unknown> }
export function usePaletteCommands(commands: PaletteCommand[]): void; // contribute contextual commands while mounted

// @/features/shell/sheets
export function openSheet(sheet: { title: ReactNode; description?: ReactNode; content: ReactNode; footer?: ReactNode }): void; // bottom sheet on phones, dialog on desktop
export function closeSheet(): void;
```

## Layout contract
- Routes are FrontCore's (`navigate`/`useRoute`); `src/app/routes.tsx` maps them to screens.
- Full-bleed screens (session, terminal, review, desktop board) get an `h-full` box and manage their own scroll.
- Every other screen is wrapped in the shell's scroll container (phones: `PullToRefresh`, default `refreshAll`).
  Don't add your own outer scroller or pull-to-refresh; render `MobileHeader` yourself on phones.
- The phone bottom nav is in-flow below the view (never overlaps content).

Mounted once globally by the shell: FrontOps dialogs (`NewWorktreeDialog`, `NewAgentDialog`,
`PastSessionsDialog`), FrontBoard `AnswerNextHud`, the command palette, the notification center,
the host editor (`useUi().dialog.kind === "hostEditor"`), the shortcuts sheet (`kind: "shortcuts"`) and the toaster.

## Keyboard (desktop, spec §6)
Global: `Ctrl+K` palette · `Ctrl+J` answer next · `Ctrl+1…6` board/inbox/activity/usage/hosts/settings ·
`Ctrl+\` split · `Ctrl+B` sidebar · `N` new worktree · `?` shortcuts · `Esc` close overlay.
Board-local keys (`J/K`, `Enter`, `A`, `T`) belong to the board; session keys (`Esc` stop, `Ctrl+Enter`,
`Alt+Enter`) to the session. Global single-key shortcuts are ignored while typing in inputs.
