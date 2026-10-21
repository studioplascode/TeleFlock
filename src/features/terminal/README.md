# features/terminal (owner: FrontTerminal)

The real terminal escape hatch: xterm.js (WebGL, falls back to DOM) attached to herdr panes through
`term.open` / `term.resize` / `term.scroll` / `term.close`, frames from `termBus`, input via `core.termInput`.

## Public API (stable)

```ts
// src/features/terminal/TerminalPane.tsx — embeddable (split view, session, board tile)
export function TerminalPane(props: {
  hostId: string;
  target: TermTarget;            // from @/core/gen
  mode?: TermMode;               // "control" (default) | "observe" (read-only, crops, never resizes)
  compact?: boolean;             // board tiles: tiny font, no chrome, no banners, no input
  takeover?: boolean;            // initial open evicts another client's input lease (default false)
  autoFocus?: boolean;           // focus xterm after open (default: !compact && mode === "control")
  className?: string;
  onOpened?: (opened: TermOpened | null) => void; // termId/paneId once open; null on close
  onPhase?: (phase: TermPhase) => void; // idle | opening | live | closed(reason) | error(ApiError)
  handleRef?: Ref<TerminalHandle>;
  onModeChange?: (mode: TermMode) => void; // enables "Watch" on the busy/taken-over banner and "Take control" on the observe ribbon
}): JSX.Element;

export interface TerminalHandle {
  send(data: string): void;      // raw input (respects observe mode)
  focus(): void;
  fit(): void;
  reopen(takeover: boolean): void;
  readonly termId: string | null;
}

// src/features/terminal/TerminalView.tsx — the full route view (#/terminal/:hostId[/:target])
export function TerminalView(props: { hostId: string; paneId?: string; agentId?: string }): JSX.Element;

// src/features/terminal/useLocalhostUrls.ts — for PreviewButton (FrontOps)
export interface LocalhostUrl { url: string; host: string; port: number; seenAt: number }
export function useLocalhostUrls(hostId: string, termId: string | null | undefined): LocalhostUrl[]; // newest first, ≤ 6
```

Everything is also re-exported from `src/features/terminal/index.ts`.

## Behaviour notes
- `scrollback: 0`; wheel / PageUp / PageDown → `term.scroll` (herdr host scrollback; `docs/research/herdr.md` §6).
- `closed` events show a banner with the reason and **Reattach** / **Take over** (+ **Watch** with `onModeChange`) actions;
  a busy lease offers **Take over** / **Watch** / **Retry**.
- Reopens automatically when the host goes back to `online`.
- Font size comes from `useSettings().terminalFontSize`; pinch-zoom (mobile) and Ctrl +/−/0 (desktop) persist it.
- Renderer: WebGL by default; the context menu switches to xterm's DOM renderer (per device, `localStorage["tf.terminal.renderer"]`). Board tiles (`compact`) always use the DOM renderer.
- Keys inside the terminal go to the pane, except Ctrl+K, Ctrl+1…6 and Ctrl+Shift+(not C/V), which bubble to the app shell.
- Mode is always visible: control = purple liveness, observe = cyan liveness + a "Read-only" ribbon (it replaces the
  mobile extra keys). The status chip collapses to its orb while live and re-expands on every state change / hover.
- Keyboard focus draws an inset accent ring; the frame flash is skipped with reduced motion.
- `localhost:PORT` links in the output are clickable: they open a preview tunnel (`@/features/preview` store), then the
  browser (desktop) or the in-app preview sheet (mobile).
- Mobile extra keys: Esc/Ctrl/Alt pinned, the rest scrolls with edge fades; Ctrl/Alt tap = next key, double-tap or
  long-press = lock (haptic tick/select/heavy). Dimmed while detached.
- TerminalView shortcuts: Ctrl+Shift+M mode, Ctrl+Shift+T new shell, Ctrl+Shift+[ / ] previous/next pane, ←/→ in the pane tabs.
- Search: Ctrl+F (or context menu / palette "Terminal: Find on screen" / `handle.openSearch()`) opens a find bar (`@xterm/addon-search`): Enter / Shift+Enter next/prev, match count, case toggle, Esc closes. It searches the visible screen (scrollback is 0); scroll to bring older output into view.
- Tab strip: right-click / long-press a tab → Rename tab… (`tab.rename`), Close tab… (`tab.close`), Close pane… (`pane.close`, shell panes only), each destructive action confirmed.
