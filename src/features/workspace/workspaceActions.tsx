import { Bot, FileDiff, GitBranchPlus, History, type LucideIcon, PencilLine, SquareTerminal, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { core, navigate, useUi } from "@/core";
import type { Workspace } from "@/core/gen";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
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
import { openPastSessions } from "../history/PastSessionsDialog";
import { openNewAgent } from "./NewAgentDialog";
import { classifyHerdrError, describeError } from "./shared/errors";
import { confirmAction, promptText } from "./shared/overlays";
import { tildify } from "./shared/paths";

export type WorkspaceActionId = "review" | "newAgent" | "newShell" | "newWorktree" | "pastSessions" | "rename" | "close" | "removeWorktree";

export interface WorkspaceAction {
  id: WorkspaceActionId;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  group: "create" | "manage" | "danger";
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

export async function renameWorkspace(hostId: string, ws: Workspace): Promise<void> {
  const label = await promptText({ title: "Rename workspace", label: "Label", initial: ws.label, confirmLabel: "Rename" });
  if (!label || label === ws.label) return;
  try {
    await core.host(hostId).call("workspace.rename", { workspaceId: ws.id, label });
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

export async function removeWorktree(hostId: string, ws: Workspace): Promise<void> {
  const path = ws.worktree?.path ?? ws.cwd;
  const branch = ws.worktree?.branch;
  const dirty = ws.repo?.dirty ?? 0;
  const ok = await confirmAction({
    title: `Remove worktree ${branch ?? ws.label}?`,
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
    confirmLabel: "Remove worktree",
    danger: true,
  });
  if (!ok) return;
  let force = false;
  let trust = false;
  for (;;) {
    try {
      await core.host(hostId).call("worktree.remove", { workspaceId: ws.id, force, trust });
      toast({ title: `Removed worktree ${branch ?? ws.label}`, description: force ? "Forced — local changes were discarded." : undefined, duration: 3000 });
      return;
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
        if (!force) return;
        continue;
      }
      if (f.kind === "untrusted" && !trust) {
        trust = await confirmAction({
          title: "This repository is owned by another user",
          body: "git refuses to touch it (“dubious ownership”). Trusting it passes -c safe.directory for this removal only; your gitconfig is not changed.",
          confirmLabel: "Trust & remove",
        });
        if (!trust) return;
        continue;
      }
      return failToast(`Couldn't remove ${branch ?? ws.label}`, e);
    }
  }
}

/** Every action that applies to `ws`, in menu order. Pure; safe to call in render. */
export function workspaceActions(hostId: string, ws: Workspace): WorkspaceAction[] {
  const bind = (fn: (h: string, w: Workspace) => Promise<void>) => () => fn(hostId, ws);
  const actions: WorkspaceAction[] = [
    { id: "newAgent", label: "New agent here", icon: Bot, group: "create", run: bind(newAgentIn) },
    { id: "newShell", label: "New shell", icon: SquareTerminal, group: "create", run: bind(newShell) },
  ];
  if (ws.repo) {
    actions.push({ id: "newWorktree", label: "New worktree from this repo", icon: GitBranchPlus, group: "create", run: bind(newWorktreeFrom) });
    actions.push({ id: "review", label: "Review & ship changes", icon: FileDiff, group: "manage", run: bind(openReview) });
  }
  actions.push(
    { id: "pastSessions", label: "Past sessions…", icon: History, group: "manage", run: bind(revealPastSessions) },
    { id: "rename", label: "Rename…", icon: PencilLine, group: "manage", run: bind(renameWorkspace) },
  );
  if (ws.worktree) actions.push({ id: "removeWorktree", label: "Remove worktree…", icon: Trash2, danger: true, group: "danger", run: bind(removeWorktree) });
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
  const groups = (["create", "manage", "danger"] as const).map((g) => actions.filter((a) => a.group === g)).filter((g) => g.length > 0);
  if (mode === "context") {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          {groups.map((g, i) => (
            <div key={g[0]?.group}>
              {i > 0 && <ContextMenuSeparator />}
              {g.map((a) => (
                <ContextMenuItem key={a.id} icon={<a.icon />} danger={a.danger} onSelect={() => void a.run()}>
                  {a.label}
                </ContextMenuItem>
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
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="max-w-64 truncate normal-case tracking-normal">
          {workspace.label} <span className="font-mono font-normal text-mute-2">{tildify(workspace.cwd, home)}</span>
        </DropdownMenuLabel>
        {groups.map((g) => (
          <div key={g[0]?.group}>
            <DropdownMenuSeparator />
            {g.map((a) => (
              <DropdownMenuItem key={a.id} icon={<a.icon />} danger={a.danger} onSelect={() => void a.run()}>
                {a.label}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
