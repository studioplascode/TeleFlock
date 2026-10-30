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
  id: "review" | "newAgent" | "newShell" | "newWorktree" | "pastSessions" | "rename" | "close" | "removeWorktree"
    | `renameTab:${string}` | `closeTab:${string}` | `closePane:${string}`;
  label: string; icon: LucideIcon; description?: string /* menu tooltip, from ACTIONS */; danger?: boolean; group: "create" | "manage" | "tabs" | "danger";
  section?: string;                     // tab label for per-tab actions
  run(): Promise<void>;                 // owns its confirms/toasts/errors; never rejects
}
export function workspaceActions(hostId: string, ws: Workspace): WorkspaceAction[];   // pure
export function WorkspaceActionsMenu(props: { hostId: string; workspace: Workspace; children: ReactNode; mode?: "dropdown" | "context"; home?: string }): JSX.Element;
export function openReview / newAgentIn / newWorktreeFrom / revealPastSessions / newShell / renameWorkspace / closeWorkspace / removeWorktree: (hostId: string, ws: Workspace) => Promise<void>;
export function renameTab(hostId: string, tab: Tab): Promise<void>;
export function closeTab(hostId: string, ws: Workspace, tab: Tab): Promise<void>;   // group-close refusal → toast with "Close workspace…"
export function closePane(hostId: string, pane: PaneInfo): Promise<void>;

// @/features/worktree/FanOutDialog       kind "fanOut" { hostId?, cwd?, prompt? }
export function FanOutDialog(): JSX.Element | null;   // N worktrees fanout/<slug>/<variant>, agents <slug>-<variant>; finishes on the board with q = slug
export function parseFanOutBranch(branch?: string): { slug: string; variant: string } | null;

// Templates (Settings.templates): picker + "Save as template" live inside AgentFields (New worktree / New agent);
// helpers in workspace/shared/templates.tsx (applyTemplate, matchingTemplate, saveDraftAsTemplate).
// Agent options (workspace/shared/AgentOptions.tsx): <AgentOptions summary={chips} defaultOpen?>{<AgentOptionsSection title note?>…}</AgentOptions>,
// a collapsed "Agent options" box whose header shows each section's chip; in AgentFields (New worktree / New agent),
// each Fan out variant and the automation editor (Dispatch: "More agent options" dialog). Sections: the agent's own
// model roles + fallback chains (features/agentRoles AgentRolesSection → AgentSpec.roleModels / fallbackChains; the
// launch preview then adds `--config <tf-hostd home>/agent-config/<this agent>.yml`, and an own `default` role replaces
// `--model` / `--thinking`); decide for me (features/autoAnswer AutoAnswerSection: Host default · Off · On with the wait
// and "only while no app is connected" → AgentSpec.autoAnswer / AutomationDraft.autoAnswer; `toAgentSpec(draft, decides)`
// sends it only when set and the host has decide for me (`HostInfo.autoAnswer`), an older tf-hostd's section says to update).
// Templates carry neither roles nor decide for me: applying one keeps them, Save as template leaves them out.
// Branch/agent slugs from free text: workspace/shared/slug.ts (slugify, slugFromPrompt), used by Fan out and Dispatch.
// AI naming (omp's tiny model via @/core ai.ts; marks/buttons in workspace/shared/ai.tsx), each with its deterministic fallback:
//   New worktree: "Name it from the task" (new branch, empty name) → suggestBranch at Create (worktree/autoName.ts dedupes
//   vs existing branches; fallback baseSlug), agent name → suggestAgentName (fallback: from the branch);
//   New agent: suggestAgentName placeholder, used on Start (≤ 2 s wait); Fan out: suggestBranch for the untouched slug;
//   Rename workspace / session: "✨ Suggest" → suggestTitle; Save as template: name prefilled by suggestTemplateName.
//   promptText({ suggest?, prefill? }) in shared/overlays.tsx carries the last two.
// Review shows a "Compare" sibling switcher (review/FanOutSiblings.tsx) for fanout/* branches.

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
- Base of a new worktree branch (`worktree/base.tsx`, New worktree + Fan out): the untouched Base select shows the
  host's `defaultBase` (`origin/main`) and sends no `base` (hostd fetches it, forks, drops the upstream); the preview
  shows the fetch and `--base`. Explicit picks (local `main`, HEAD, any branch) are sent. Older hosts without
  `defaultBase` get the shown ref (default branch, else HEAD).
- After `worktree.create` / `agent.start` / `host.resume`, the dialog shows a success burst and navigates to the
  new agent's session as soon as it appears in host state (falls back to the pane's terminal after 15 s).
- Review: `git.status` + `git.diff`; virtualized diff (unified/split, wrap, per-file collapse, pinned file header,
  intra-line change spans, line-level syntax highlighting in `review/diff/highlight.ts`), refreshes when an agent in
  the workspace finishes a turn. Ship pipeline: commit (or ask the omp agent to write the message via `agent.prompt`
  and read its reply) → push → `gh.prCreate` → checks (polled) → `gh.prMerge` → archive agents / remove worktree.
