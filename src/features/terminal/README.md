# features/terminal (owner: FrontTerminal)

The real terminal escape hatch: xterm.js (WebGL, falls back to DOM) attached to herdr panes through
`term.open` / `term.resize` / `term.scroll` / `term.close`, frames from `termBus`, input via `core.termInput`.

## Public API (stable)

```ts
// src/features/terminal/TerminalPane.tsx — embeddable (split view, session, board tile)
export function TerminalPane(props: {
  hostId: string;
  target: TermTarget;            // from @/core/gen
  mode?: TermMode;               // "control" (default) | "observe" (read-only, shows the driver's grid, never resizes)
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

// src/features/terminal/TerminalView.tsx — the full route view (#/terminal/:hostId[/:target]).
// Phones: the bare route (no pane/agent) is the Terminal tab's "Attach to…" chooser (TerminalChooser.tsx):
// agents in lane order with status orbs, then shell panes of online hosts.
export function TerminalView(props: { hostId: string; paneId?: string; agentId?: string }): JSX.Element;

// src/features/terminal/lastTerminal.ts — what the phone Terminal tab reopens (persisted, `tf.terminal.last`)
export const useLastTerminal: UseBoundStore<{ last: TermSpot | null; lastSession: { hostId; agentId } | null; tabRoot: string | null; … }>;
export function terminalTabTarget(): TerminalRoute | null; // last terminal (agent preferred) → last session's agent → null (chooser); stale memory falls through
export function terminalRouteKey(r: { hostId; agentId?; paneId? }): string;

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
- A box too small for a usable grid (< 10 cols or < 2 rows: a closing split's exit animation squeezes it to zero
  width) keeps the current grid and never resizes the pane. A control resize sizes the real PTY and herdr keeps it
  after the client lets go, so a collapsed size would leave the agent re-wrapped at 2 columns for every later viewer
  (observers, such as the board's live tile, show the pane at its driver's size).
- Observe: frames come at the pane's own PTY grid (hostd attaches at it and re-attaches when the driver resizes the
  pane), and the view only scales that grid (`observeScale.ts`): the full view shows all of it (shrunk to fit, centred,
  never above the font size), a board tile fills its width and keeps the bottom rows (latest output, an agent's editor).
  Window, sidebar or DPR changes never reopen the observer or reach herdr.
- Font size comes from `useSettings().terminalFontSize`; pinch-zoom (mobile) and Ctrl +/−/0 (desktop) persist it.
- Font (every surface, `TERM_FONT_FAMILY` in `theme.ts`): bundled Fira Code (`@fontsource-variable/fira-code`, OFL,
  `src/assets/fonts/fira-code/LICENSE`), then bundled Symbols Nerd Font Mono (Nerd Fonts v3.5.1 symbols-only, MIT + icon-set
  licenses in `src/assets/fonts/symbols-nerd-font/`) restricted by `unicode-range` to the Nerd Font Private Use Area, so
  omp's `symbolPreset: nerd` icons render; other symbols fall back to system symbol fonts. Ligatures are off (the WebGL
  renderer draws cell by cell; the DOM renderer matches). All faces of both fonts are loaded up front (`loadTermFonts`);
  the first paint waits ≤ 120 ms for them, and any terminal-font face that lands later re-measures the cells and clears
  the WebGL texture atlas so fallback glyphs (tofu) never stay cached. WebGL draws box drawing / block elements itself
  (`customGlyphs`) and squeezes over-wide fallback symbols (`rescaleOverlappingGlyphs`).
- Renderer: WebGL by default; the context menu switches to xterm's DOM renderer (per device, `localStorage["tf.terminal.renderer"]`). Board tiles (`compact`) always use the DOM renderer.
- Keys inside the terminal go to the pane, except Ctrl+K, Ctrl+1…6 and Ctrl+Shift+(not C/V), which bubble to the app shell.
- Mode is always visible: control = purple liveness, observe = cyan liveness + a "Read-only" ribbon (it replaces the
  mobile extra keys). Phones label the toggle "Type" / "Watch". The status chip collapses to its orb while live and re-expands on every state change / hover;
  the orb's activity pulse is the only output indicator (no per-frame flash: frames arrive ~10×/s while omp streams).
- Phone Terminal tab: reopens the last terminal attached (remembered when a pane goes live), else the agent of the last
  session viewed, else the chooser; tapping it again on a terminal returns to the chooser. The screen the tab opened has
  no back chevron (it is the tab's root; `tabRoot` clears once you leave the terminal routes).
- Chooser "New shell" (one row per online host; a primary button for a host with no panes): `openNewShell` pushes
  `#/terminal/<host>?shell=<nonce>` (the router ignores the query) and TerminalView opens the shell from the in-memory
  request; Back returns to the chooser, a reload shows the chooser.
- Keyboard focus draws an inset accent ring.
- `localhost:PORT` links in the output are clickable: they open a preview tunnel (`@/features/preview` store), then the
  browser (desktop) or the in-app preview sheet (mobile).
- Mobile extra keys: Esc/Ctrl/Alt pinned, the rest scrolls with edge fades; Ctrl/Alt tap = next key, double-tap or
  long-press = lock (haptic tick/select/heavy). Dimmed while detached.
- TerminalView shortcuts: Ctrl+Shift+M mode, Ctrl+Shift+T new shell, Ctrl+Shift+[ / ] previous/next pane, ←/→ in the pane tabs.
- Search: Ctrl+F (or context menu / palette "Terminal: Find on screen" / `handle.openSearch()`) opens a find bar (`@xterm/addon-search`): Enter / Shift+Enter next/prev, match count, case toggle, Esc closes. It searches the visible screen (scrollback is 0); scroll to bring older output into view.
- Tab strip: right-click / long-press a tab → Rename tab… (`tab.rename`), Close tab… (`tab.close`), Close pane… (`pane.close`, shell panes only), each destructive action confirmed.
