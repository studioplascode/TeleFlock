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
- `closed` events show a banner with the reason and **Reattach** / **Take over** actions.
- Reopens automatically when the host goes back to `online`.
- Font size comes from `useSettings().terminalFontSize`; pinch-zoom (mobile) and Ctrl +/−/0 (desktop) persist it.
