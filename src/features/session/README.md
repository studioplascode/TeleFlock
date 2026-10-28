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

Parked agents (`Agent.parked`: Mark done closed the pane): `LinkGate` hands over to `ParkedGate`. With the read-only
snapshot `session.open` returns, the transcript shows under a "Done and closed" strip with Resume; when it fails
(`parked`), `ParkedNotice` (also used by the terminal view) explains it and offers Resume / Terminal. The composer
keeps working on a parked agent: sending calls `agent.prompt` (the host resumes it with the prompt), the composer
says "Resuming…" (`useResuming`) until the new agent appears, and the core redirects the route to it.

Transcript (`transcript/Transcript.tsx`): a virtualised list (TanStack Virtual) that sizes rows it hasn't rendered
yet from `transcript/estimate.ts` (`estimateRowHeight`, tested): per row from its content (a collapsed read / grep
call is a one-line card, open views by their capped bodies, text by its wrapped lines; phone metrics when dense),
so the scrollbar stays put while scrolling up measures older rows in (`?demo&long=2000`, production build: the
scroll height drifted −18.5% with 27 jumps up to 24k px before; +2.2% and no jump over 134 px after).

Toasts keep clear of the composer (`data-toast-anchor`; desktop only where it runs under the toast stack) and, on
desktop, of an open ask card, which calls `toastAnchorsChanged()` once it has landed or gone.
