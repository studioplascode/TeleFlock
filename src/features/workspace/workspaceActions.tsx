import { Bot, FileDiff, GitBranchPlus, History, type LucideIcon, PanelTopClose, PencilLine, SquareArrowOutUpRight, SquareTerminal, SquareX, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { aiNamingEnabled, core, draftKey, drafts, getAgentViews, navigate, suggestTitle, useUi } from "@/core";
import type { PaneInfo, Tab, Workspace } from "@/core/gen";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from "@/design";
import { ACTIONS } from "@/features/shell/vocab";
import { paneName } from "@/features/terminal/panes";
import { openPastSessions } from "../history/PastSessionsDialog";
import { openNewAgent } from "./NewAgentDialog";
import { classifyHerdrError, describeError } from "./shared/errors";
import { confirmAction, promptText } from "./shared/overlays";
import { tildify } from "./shared/paths";

export type WorkspaceActionId =
  | "review"
  | "newAgent"
  | "newShell"
  | "newWorktree"
  | "pastSessions"
  | "rename"
  | "close"
  | "removeWorktree"
  | `renameTab:${string}`
  | `openPane:${string}`
  | `closeTab:${string}`
  | `closePane:${string}`;

export interface WorkspaceAction {
  id: WorkspaceActionId;
  label: string;
  icon: LucideIcon;
  /** One-line explanation (menu item tooltip), from `ACTIONS` where the action is a shared one. */
  description?: string;
  danger?: boolean;
  group: "create" | "manage" | "tabs" | "danger";
  /** Sub-heading inside the group (the tab's label for per-tab actions). */
  section?: string;
  /** Handles its own confirms, toasts and errors; never rejects. */
  run(): Promise<void>;
}

function failToast(title: string, e: unknown) {
  const d = describeError(e);
  toast({ title, description: d.hint ? `${d.title} — ${d.hint}` : d.title, status: "error" });
}

export async function openReview(hostId: string, ws: Workspace): Promise<void> {
  navigate({ name: "review", hostId, workspaceId: ws.id });
}

export async function newAgentIn(hostId: string, ws: Workspace): Promise<void> {
  openNewAgent({ hostId, workspaceId: ws.id });
}

export async function newWorktreeFrom(hostId: string, ws: Workspace): Promise<void> {
  useUi.getState().openDialog({ kind: "newWorktree", hostId, cwd: ws.repo?.root ?? ws.cwd });
}

export async function revealPastSessions(hostId: string, ws: Workspace): Promise<void> {
  openPastSessions({ hostId, cwd: ws.worktree?.path ?? ws.cwd, workspaceId: ws.id });
}

/** New shell pane in the workspace (herdr creates it on `term.open`), then the terminal view on it. */
export async function newShell(hostId: string, ws: Workspace): Promise<void> {
  try {
    const opened = await core.host(hostId).call("term.open", {
      target: { kind: "shell", workspaceId: ws.id, cwd: null, split: "right" },
      cols: 120,
      rows: 32,
      mode: "control",
      takeover: false,
    });
    // The terminal view opens its own stream sized to the real viewport; this one only created the pane.
    await core.host(hostId).call("term.close", { termId: opened.termId });
    navigate({ name: "terminal", hostId, paneId: opened.paneId });
  } catch (e) {
    failToast(`Couldn't open a shell in ${ws.label}`, e);
  }
}

/** What the workspace is about, for the tiny model: its agents' titles (session title or first prompt), then branch and label. */
function workspaceAbout(hostId: string, ws: Workspace): string {
  const titles = getAgentViews()
    .filter((a) => a.hostId === hostId && a.workspaceId === ws.id && a.title.trim())
    .map((a) => a.title.trim());
  return [...titles, ws.worktree?.branch ?? ws.repo?.branch, ws.label].filter(Boolean).join("\n");
}

export async function renameWorkspace(hostId: string, ws: Workspace): Promise<void> {
  const key = draftKey("workspace.rename", hostId, ws.id);
  const label = await promptText({
    title: "Rename workspace",
    label: "Label",
    initial: ws.label,
    draftKey: key,
    confirmLabel: "Rename",
    suggest: aiNamingEnabled(hostId) ? () => suggestTitle(hostId, workspaceAbout(hostId, ws)) : undefined,
  });
  if (!label || label === ws.label) return;
  try {
    await core.host(hostId).call("workspace.rename", { workspaceId: ws.id, label });
    drafts.clear(key);
    toast({ title: `Renamed to ${label}`, duration: 2500 });
  } catch (e) {
    failToast("Couldn't rename the workspace", e);
  }
}

export async function closeWorkspace(hostId: string, ws: Workspace): Promise<void> {
  const ok = await confirmAction({
    title: `Close ${ws.label}?`,
    body: "Closes the workspace's tabs and panes in herdr, including any agents running in them. Files on disk are untouched.",
    confirmLabel: "Close workspace",
    danger: true,
  });
  if (!ok) return;
  const call = (group: boolean) => core.host(hostId).call("workspace.close", { workspaceId: ws.id, group });
  try {
    await call(false);
    toast({ title: `Closed ${ws.label}`, duration: 2500 });
  } catch (e) {
    if (classifyHerdrError(e).kind !== "groupCloseRequired") return failToast(`Couldn't close ${ws.label}`, e);
    const group = await confirmAction({
      title: `${ws.label} has linked worktrees`,
      body: "This is the primary checkout of a repository whose worktrees are open as their own workspaces. herdr closes them together. The worktrees stay on disk.",
      confirmLabel: "Close all of them",
      danger: true,
    });
    if (!group) return;
    try {
      await call(true);
      toast({ title: `Closed ${ws.label} and its worktrees`, duration: 2500 });
    } catch (e2) {
      failToast(`Couldn't close ${ws.label}`, e2);
    }
  }
}

/**
 * Remove a linked worktree: confirm, then `worktree.remove` (a second, explicit confirm to force when it has
 * uncommitted changes; a trust prompt for repos owned by another user). Toasts its own outcome and never
 * rejects; resolves true once the worktree is gone. `confirm` overrides the first dialog's title and button.
 */
export async function removeWorktree(hostId: string, ws: Workspace, confirm?: { title: string; confirmLabel: string }): Promise<boolean> {
  const path = ws.worktree?.path ?? ws.cwd;
  const branch = ws.worktree?.branch;
  const dirty = ws.repo?.dirty ?? 0;
  const ok = await confirmAction({
    title: confirm?.title ?? `Remove worktree ${branch ?? ws.label}?`,
    body: (
      <>
        Deletes the checkout at <span className="font-mono">{path}</span> and closes its workspace.
        {branch && (
          <>
            {" "}
            The branch <span className="font-mono">{branch}</span> is kept.
          </>
        )}
        {dirty > 0 && <span className="mt-2 block font-semibold text-warn">{dirty} uncommitted change{dirty === 1 ? "" : "s"} will need a force remove.</span>}
      </>
    ),
    confirmLabel: confirm?.confirmLabel ?? "Remove worktree",
    danger: true,
  });
  if (!ok) return false;
  let force = false;
  let trust = false;
  for (;;) {
    try {
      await core.host(hostId).call("worktree.remove", { workspaceId: ws.id, force, trust });
      toast({ title: `Removed worktree ${branch ?? ws.label}`, description: force ? "Forced — local changes were discarded." : undefined, duration: 3000 });
      return true;
    } catch (e) {
      const f = classifyHerdrError(e);
      if (f.kind === "dirtyNeedsForce" && !force) {
        force = await confirmAction({
          title: "The worktree has uncommitted changes",
          body: (
            <>
              Modified or untracked files in <span className="font-mono">{path}</span> will be <b>permanently deleted</b>. Commit or stash them first if you need
              them.
            </>
          ),
          confirmLabel: "Force remove",
          danger: true,
        });
        if (!force) return false;
        continue;
      }
      if (f.kind === "untrusted" && !trust) {
        trust = await confirmAction({
          title: "This repository is owned by another user",
          body: "git refuses to touch it (“dubious ownership”). Trusting it passes -c safe.directory for this removal only; your gitconfig is not changed.",
          confirmLabel: "Trust & remove",
        });
        if (!trust) return false;
        continue;
      }
      failToast(`Couldn't remove ${branch ?? ws.label}`, e);
      return false;
    }
  }
}

export async function renameTab(hostId: string, tab: Tab): Promise<void> {
  const key = draftKey("tab.rename", hostId, tab.id);
  const label = await promptText({ title: "Rename tab", label: "Label", initial: tab.label, draftKey: key, confirmLabel: "Rename" });
  if (!label || label === tab.label) return;
  try {
    await core.host(hostId).call("tab.rename", { tabId: tab.id, label });
    drafts.clear(key);
    toast({ title: `Renamed tab to ${label}`, duration: 2500 });
  } catch (e) {
    failToast("Couldn't rename the tab", e);
  }
}

export async function closeTab(hostId: string, ws: Workspace, tab: Tab): Promise<void> {
  const agents = tab.panes.filter((p) => p.agentId).length;
  const ok = await confirmAction({
    title: `Close tab ${tab.label}?`,
    body: `Closes its ${tab.panes.length} pane${tab.panes.length === 1 ? "" : "s"}${agents ? `, including ${agents} running agent${agents === 1 ? "" : "s"}` : ""}. Files on disk are untouched.`,
    confirmLabel: "Close tab",
    danger: true,
  });
  if (!ok) return;
  try {
    await core.host(hostId).call("tab.close", { tabId: tab.id });
    toast({ title: `Closed tab ${tab.label}`, duration: 2500 });
  } catch (e) {
    if (classifyHerdrError(e).kind !== "groupCloseRequired") return failToast(`Couldn't close ${tab.label}`, e);
    const d = describeError(e);
    // herdr refuses to close the last tab of a primary workspace that still has linked worktrees.
    toast({
      title: `${tab.label} is the last tab of ${ws.label}`,
      description: d.hint ?? "herdr closes this workspace together with its linked worktrees.",
      status: "error",
      action: { label: "Close workspace…", onClick: () => void closeWorkspace(hostId, ws) },
    });
  }
}

export async function closePane(hostId: string, pane: PaneInfo): Promise<void> {
  const name = paneName(pane);
  const ok = await confirmAction({
    title: `Close shell ${name}?`,
    body: "Ends the shell and any command still running in it.",
    confirmLabel: "Close pane",
    danger: true,
  });
  if (!ok) return;
  try {
    await core.host(hostId).call("pane.close", { paneId: pane.id });
    toast({ title: `Closed ${name}`, duration: 2500 });
  } catch (e) {
    failToast(`Couldn't close ${name}`, e);
  }
}

/** Every action that applies to `ws`, in menu order. Pure; safe to call in render. */
export function workspaceActions(hostId: string, ws: Workspace): WorkspaceAction[] {
  const bind = (fn: (h: string, w: Workspace) => Promise<void>) => () => fn(hostId, ws);
  const actions: WorkspaceAction[] = [
    { id: "newAgent", label: "New agent here", description: ACTIONS.newAgent.description, icon: Bot, group: "create", run: bind(newAgentIn) },
    { id: "newShell", label: "New shell", icon: SquareTerminal, group: "create", run: bind(newShell) },
  ];
  if (ws.repo) {
    actions.push({ id: "newWorktree", label: "New worktree from this repo", description: ACTIONS.newWorktree.description, icon: GitBranchPlus, group: "create", run: bind(newWorktreeFrom) });
    actions.push({ id: "review", label: ACTIONS.review.label, description: ACTIONS.review.description, icon: FileDiff, group: "manage", run: bind(openReview) });
  }
  actions.push(
    { id: "pastSessions", label: "Past sessions…", description: ACTIONS.pastSessions.description, icon: History, group: "manage", run: bind(revealPastSessions) },
    { id: "rename", label: "Rename…", icon: PencilLine, group: "manage", run: bind(renameWorkspace) },
  );
  if (ws.worktree)
    actions.push({ id: "removeWorktree", label: "Remove worktree…", icon: Trash2, danger: true, group: "danger", run: async () => void (await removeWorktree(hostId, ws)) });
  for (const tab of ws.tabs) {
    // Per tab: attach to what already runs there (nothing is created), then rename / close.
    for (const pane of tab.panes) {
      const agent = pane.agentId ? getAgentViews().find((a) => a.hostId === hostId && a.id === pane.agentId) : undefined;
      actions.push({
        id: `openPane:${pane.id}`,
        label: agent ? `Open ${agent.name}'s terminal` : `Open shell ${paneName(pane)}`,
        icon: SquareArrowOutUpRight,
        group: "tabs",
        section: tab.label,
        run: async () => navigate({ name: "terminal", hostId, paneId: pane.id }),
      });
    }
    actions.push(
      { id: `renameTab:${tab.id}`, label: "Rename tab…", icon: PencilLine, group: "tabs", section: tab.label, run: () => renameTab(hostId, tab) },
      { id: `closeTab:${tab.id}`, label: "Close tab…", icon: PanelTopClose, danger: true, group: "tabs", section: tab.label, run: () => closeTab(hostId, ws, tab) },
    );
    for (const pane of tab.panes) {
      if (pane.agentId) continue;
      actions.push({
        id: `closePane:${pane.id}`,
        label: `Close shell ${paneName(pane)}…`,
        icon: SquareX,
        danger: true,
        group: "tabs",
        section: tab.label,
        run: () => closePane(hostId, pane),
      });
    }
  }
  actions.push({ id: "close", label: "Close workspace…", icon: X, danger: true, group: "danger", run: bind(closeWorkspace) });
  return actions;
}

export interface WorkspaceActionsMenuProps {
  hostId: string;
  workspace: Workspace;
  /** The trigger (rendered with `asChild`). */
  children: ReactNode;
  /** `dropdown` (click, default) or `context` (right-click / long-press). */
  mode?: "dropdown" | "context";
  home?: string;
}

/** Ready-made menu of `workspaceActions` for the sidebar tree and board. */
export function WorkspaceActionsMenu({ hostId, workspace, children, mode = "dropdown", home }: WorkspaceActionsMenuProps) {
  const actions = workspaceActions(hostId, workspace);
  const groups = (["create", "manage", "tabs", "danger"] as const).map((g) => actions.filter((a) => a.group === g)).filter((g) => g.length > 0);
  // Per-tab actions get the tab label as a heading before their first item.
  const heading = (g: WorkspaceAction[], i: number) => (g[i]?.section && g[i]?.section !== g[i - 1]?.section ? g[i]?.section : undefined);
  if (mode === "context") {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="max-h-[min(560px,var(--radix-context-menu-content-available-height))] overflow-y-auto">
          {groups.map((g, i) => (
            <div key={g[0]?.group}>
              {i > 0 && <ContextMenuSeparator />}
              {g.map((a, j) => (
                <div key={a.id}>
                  {heading(g, j) && <ContextMenuLabel className="truncate">Tab · {a.section}</ContextMenuLabel>}
                  <ContextMenuItem icon={<a.icon />} danger={a.danger} title={a.description} onSelect={() => void a.run()}>
                    {a.label}
                  </ContextMenuItem>
                </div>
              ))}
            </div>
          ))}
        </ContextMenuContent>
      </ContextMenu>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(560px,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto">
        <DropdownMenuLabel className="max-w-64 truncate normal-case tracking-normal">
          {workspace.label} <span className="font-mono font-normal text-mute-2">{tildify(workspace.cwd, home)}</span>
        </DropdownMenuLabel>
        {groups.map((g) => (
          <div key={g[0]?.group}>
            <DropdownMenuSeparator />
            {g.map((a, j) => (
              <div key={a.id}>
                {heading(g, j) && <DropdownMenuLabel className="truncate">Tab · {a.section}</DropdownMenuLabel>}
                <DropdownMenuItem icon={<a.icon />} danger={a.danger} title={a.description} onSelect={() => void a.run()}>
                  {a.label}
                </DropdownMenuItem>
              </div>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
