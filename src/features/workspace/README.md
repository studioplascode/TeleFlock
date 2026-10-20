# features/{worktree,workspace,review,preview,history} (owner: FrontOps)

herdr actions and the ship flow. Everything talks to the host through `@/core` (`core.host(id).call`)
and renders with `@/design`.

## Public API (stable)

```ts
// Dialogs — mount once (the shell does); each renders while useUi().dialog.kind matches.
// @/features/worktree/NewWorktreeDialog   kind "newWorktree" { hostId?, cwd? }
export function NewWorktreeDialog(): JSX.Element | null;
// @/features/workspace/NewAgentDialog     kind "newAgent" { hostId?, workspaceId? } — also hosts the confirm/rename overlays
export function NewAgentDialog(): JSX.Element;
export function openNewAgent(opts?: { hostId?: string; workspaceId?: string; mode?: "workspace" | "folder"; openFolder?: boolean }): void;
//   "Open folder" = openNewAgent({ hostId, openFolder: true })  (folder browser, agent off → workspace.create)
// @/features/history/PastSessionsDialog   kind "pastSessions" { hostId? }
export function PastSessionsDialog(): JSX.Element | null;
export function openPastSessions(opts?: { hostId?: string; cwd?: string; workspaceId?: string }): void;

// @/features/workspace/workspaceActions
export interface WorkspaceAction {
  id: "review" | "newAgent" | "newShell" | "newWorktree" | "pastSessions" | "rename" | "close" | "removeWorktree";
  label: string; icon: LucideIcon; danger?: boolean; group: "create" | "manage" | "danger";
  run(): Promise<void>;                 // owns its confirms/toasts/errors; never rejects
}
export function workspaceActions(hostId: string, ws: Workspace): WorkspaceAction[];   // pure
export function WorkspaceActionsMenu(props: { hostId: string; workspace: Workspace; children: ReactNode; mode?: "dropdown" | "context"; home?: string }): JSX.Element;
export function openReview / newAgentIn / newWorktreeFrom / revealPastSessions / newShell / renameWorkspace / closeWorkspace / removeWorktree: (hostId: string, ws: Workspace) => Promise<void>;

// @/features/review/ReviewView           route #/review/:hostId/:workspaceId
export function ReviewView(props: { hostId: string; workspaceId: string }): JSX.Element;

// @/features/preview
export function PreviewButton(props: { hostId: string; port: number; label?: string; size?: "sm" | "md"; className?: string }): JSX.Element;
export function PreviewList(props: { className?: string }): JSX.Element;
export function PreviewSheet(props: { tunnel: TunnelInfo | null; onClose(): void }): JSX.Element;   // mobile in-app preview

// @/features/worktree/FolderBrowser       remote folder picker (fs.home / fs.list, git badges, keyboard)
export function FolderBrowser(props: { hostId: string; mode: "repo" | "folder"; value?: string; onSelect(p: FolderPick): void; onConfirm?(p: FolderPick): void; initialPath?: string; autoFocus?: boolean; className?: string }): JSX.Element;
```

## Behaviour notes
- Worktree failures map to fixes (`shared/errors.ts`, tf-hostd codes `untrusted_repo`, `branch_in_use`,
  `branch_exists`, `path_exists`, `dirty_worktree`, `group_close_required`, plus raw herdr/git messages):
  trust-repository confirm, "use existing branch", "branch off it instead", another path, open the existing checkout.
- After `worktree.create` / `agent.start` / `host.resume`, the dialog shows a success burst and navigates to the
  new agent's session as soon as it appears in host state (falls back to the pane's terminal after 15 s).
- Review: `git.status` + `git.diff`; virtualized diff (unified/split, wrap, per-file collapse, pinned file header,
  intra-line change spans, line-level syntax highlighting in `review/diff/highlight.ts`), refreshes when an agent in
  the workspace finishes a turn. Ship pipeline: commit (or ask the omp agent to write the message via `agent.prompt`
  and read its reply) → push → `gh.prCreate` → checks (polled) → `gh.prMerge` → archive agents / remove worktree.
