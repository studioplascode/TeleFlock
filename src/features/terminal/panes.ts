import type { PaneInfo, Tab, Workspace } from "@/core/gen";
import { basename, tildify } from "@/features/workspace/shared/paths";

/** One herdr pane with where it lives (workspace, tab), as every pane list shows it. */
export interface PaneRef {
  ws: Workspace;
  tab: Tab;
  pane: PaneInfo;
}

/** Interactive shells: as a pane's foreground process they mean "nothing running", so the title says more. */
const SHELLS: Record<string, true> = {
  zsh: true,
  bash: true,
  fish: true,
  sh: true,
  dash: true,
  ksh: true,
  tcsh: true,
  csh: true,
  nu: true,
  elvish: true,
  xonsh: true,
  pwsh: true,
  powershell: true,
  cmd: true,
  "cmd.exe": true,
  login: true,
};

/** Every pane of a host's workspaces in workspace order, then tab order, then pane order. */
export function hostPanes(workspaces: readonly Workspace[]): PaneRef[] {
  return [...workspaces].sort((a, b) => a.order - b.order).flatMap((ws) => ws.tabs.flatMap((tab) => tab.panes.map((pane) => ({ ws, tab, pane }))));
}

/**
 * What a pane is called in lists: a program running in it (`vim`, `bun`) unless the title already
 * names it, else its title, else the shell, its folder, its id.
 */
export function paneName(pane: PaneInfo): string {
  const proc = pane.process;
  const title = pane.title?.trim();
  if (proc && !SHELLS[proc.replace(/^-/, "").toLowerCase()] && !title?.toLowerCase().includes(proc.toLowerCase())) return proc;
  return title || proc || (pane.cwd ? basename(pane.cwd) : "") || pane.id;
}

/**
 * The line under a pane's name: its process when the name doesn't show it, then its folder
 * (`~`-relative; `./sub` or nothing inside `base`, the folder of the list it sits under).
 */
export function paneDetail(pane: PaneInfo, home?: string, base?: string): string {
  const name = paneName(pane).toLowerCase();
  const parts: string[] = [];
  if (pane.process && !name.includes(pane.process.toLowerCase())) parts.push(pane.process);
  const cwd = pane.cwd?.replace(/[\\/]+$/, "");
  const root = base?.replace(/[\\/]+$/, "");
  if (cwd && cwd !== root) parts.push(root && cwd.startsWith(`${root}/`) ? `.${cwd.slice(root.length)}` : tildify(cwd, home));
  return parts.join(" · ");
}

