# features/session (owner: FrontSession)

Native GUI for one agent session (desktop + mobile). Import from `@/features/session`.

```ts
// Route entry (FrontShell mounts it for #/agent/:hostId/:agentId). Adapts to mobile and
// includes the mobile agent pager; non-omp agents get a terminal-first view.
export function SessionView(props: { hostId: string; agentId: string }): JSX.Element;

// Embeddable pieces (split view, inbox, HUD):
export function SessionPane(props: { agentKey: string; compact?: boolean }): JSX.Element; // header-less transcript + ask + composer
export function AskCard(props: { agentKey: string; request: UiRequest; compact?: boolean; onAnswered?(): void }): JSX.Element;
export function Markdown(props: { text: string; streaming?: boolean; className?: string }): JSX.Element;
```

Keyboard (session owns): `Esc` stop turn (when the composer is empty / not in a popup), `Enter` send (steer while
the agent works), `Shift+Enter` newline, `Alt+Enter` queue follow-up (while it works), `1–9` answer the sticky ask
card, `/` slash palette, `@` file mention. Phone: the ⋯ menu is a bottom sheet (its Terminal item opens the full
terminal view); a "Next waiting" chip docks above the composer while other agents need you.

Subagent viewer (`subagents/SubagentViewer`, one per session, mounted by `SessionPane`): open it with
`useSessionUi.getState().openSubagent(agentKey, subagentId)` (inspector Subagents pane, task cards, IRC
bubbles and threads); opening another subagent switches it. Right-side drawer on desktop, full-screen
sheet on phones. `[` / `]` previous / next subagent, `Esc` close, `Enter` steer/message, `Shift+Enter` newline.
