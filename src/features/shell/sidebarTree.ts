/** Which rows a workspace shows in the sidebar tree, and how a lone one folds into its workspace's line. */

/** What a workspace row holds: the agents and the shell panes under it. */
export interface WorkspaceRows<A, S> {
  agents: readonly A[];
  shells: readonly S[];
}

/**
 * The one pane row of a workspace that has exactly one (an agent or a shell): it carries the workspace's
 * identity on a single line instead of sitting under a header of its own. Two or more rows, or none: undefined.
 */
export function soleRow<A, S>({ agents, shells }: WorkspaceRows<A, S>): { kind: "agent"; agent: A } | { kind: "shell"; shell: S } | undefined {
  if (agents.length + shells.length !== 1) return undefined;
  const agent = agents[0];
  if (agent !== undefined) return { kind: "agent", agent };
  const shell = shells[0];
  return shell === undefined ? undefined : { kind: "shell", shell };
}

/**
 * The pane's name as the muted second part of a folded row, or undefined when the workspace name already says
 * it (an agent called `fix-login` in the worktree `dispatch/fix-login`).
 */
export function foldedPaneLabel(identity: string, paneName: string): string | undefined {
  const name = paneName.trim();
  if (!name) return undefined;
  const id = identity.trim().toLowerCase();
  const n = name.toLowerCase();
  return id === n || id.endsWith(`/${n}`) ? undefined : name;
}
