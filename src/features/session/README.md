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

Keyboard (session owns): `Esc` stop (when the composer is empty / not in a popup), `Enter` / `Ctrl+Enter` send,
`Alt+Enter` queue follow-up, `1–9` answer the sticky ask card, `/` slash palette, `@` file mention.
