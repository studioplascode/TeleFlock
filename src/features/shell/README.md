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

// @/features/shell/vocab — one word per lane, state and action; `VIEWS`: label, shortcut, description and icon of
// every page, read by each way to it (sidebar, More, palette, Settings, host cards, the omp area strip); `OMP_PAGES`:
// the omp area's pages (omp settings, MCP servers, Accounts) in order.

// @/features/shell/Ticks
export function Ticks(props: { text: string; className?: string }): JSX.Element; // `backticked` spans as inline code (hostd's commands, omp's setting descriptions)
export function splitTicks(text: string): { text: string; code: boolean }[];     // an unpaired backtick or an empty pair stays literal (Ticks.test.ts)

// @/features/shell/OmpArea
export function OmpAreaNav(props: { current: OmpAreaPage; hostId?: string; className?: string }): JSX.Element; // the strip linking omp settings, MCP servers, Accounts
export function OmpAreaFrame(props: { current: OmpAreaPage; hostId?: string; mobile: boolean; children: ReactNode }): JSX.Element;
// the frame each omp-area page renders in (strip + one width, padding and gap), so the strip never moves between them
```

## Layout contract
- Routes are FrontCore's (`navigate`/`useRoute`); `src/app/routes.tsx` maps them to screens.
- Full-bleed screens (session, terminal, review, desktop board) get an `h-full` box and manage their own scroll.
- Every other screen is wrapped in the shell's scroll container (phones: `PullToRefresh`, default `refreshAll`;
  desktop: a stable scrollbar gutter, so a page that scrolls sits exactly where one that doesn't would).
  Don't add your own outer scroller or pull-to-refresh; render `MobileHeader` yourself on phones.
- The phone bottom nav is in-flow below the view (never overlaps content). Pushed screens keep their parent tab
  lit: everything opened from More (Hosts, Settings, Usage, Activity, Automations and the omp area) lights More.
- `prefetchViews` (`src/app/routes.tsx`) warms the screens a tap away once the first one is up, one per idle
  period: session, board / Flock, inbox, Dispatch, terminal, then the omp area (MCP servers, Accounts, omp settings).
- Toasts keep clear of `[data-toast-anchor]` elements (`src/design/ui/Toast.tsx`): on phones anything along the
  bottom (tab bar, Flock "+", a session's composer dock, Dispatch's composer); on desktop only what runs under the
  stack's column (a session's composer and its open question, Dispatch's composer). An anchor that appears without
  a resize or route change calls `toastAnchorsChanged()`; floating bars may instead publish `--tf-toast-lift`.

Mounted once globally by the shell: FrontOps dialogs (`NewWorktreeDialog`, `NewAgentDialog`,
`PastSessionsDialog`), FrontBoard `AnswerNextHud`, the command palette, the notification center,
the host editor (`useUi().dialog.kind === "hostEditor"`), the shortcuts sheet (`kind: "shortcuts"`) and the toaster.

## Desktop sidebar
Top to bottom: **＋ New task** (`D`, opens Dispatch) · launcher row (New worktree · New agent · Fan out ·
Open folder · Past sessions; labelled from 240 px, wrapping onto a second or third row, icon-only below; drag the right edge to
resize, double-click resets) · nav Board · Inbox · Activity · Usage (Inbox badge = needs count, dot =
unread updates) · HOSTS (header "Manage ›" → Hosts; each row: orb · colour swatch · name · latency, then
CPU sparkline + RAM bar, or the phase/reason and a Connect/Retry/Sign in/Verify button) · WORKSPACES tree
(all remaining height) · footer ⚙ Settings + collapse. Labels, keys and tooltips come from `vocab.ts`.

## Keyboard (desktop, spec §6)
`SHORTCUTS` in `keyboard.ts` feeds the `?` sheet and is built from `vocab.ts` (`ACTIONS`, `VIEWS`, `SEND_KEYS`);
the sheet ends with the glossary's Terms.
Global: `Ctrl+K` palette · `Ctrl+J` answer next · `Ctrl+1…6` board/inbox/activity/usage/hosts/settings ·
`Ctrl+\` split · `Ctrl+B` sidebar · `D` new task · `N` new worktree · `?` shortcuts · `Esc` close overlay →
leave focus mode → stop turn. Message boxes: `Enter` send/steer · `Shift+Enter` newline · `Alt+Enter`
follow-up while the agent works; multi-field forms submit with `Ctrl+Enter`.
Board-local keys (`J/K`, `H/L`, `Enter`, `A`, `T`, `X`) belong to the board; session keys (`Esc` stop turn,
`1…9`, Other = N+1) to the session. Global single-key shortcuts are ignored while typing in inputs.
