import { ArchiveRestore, Bell, BellOff, CheckCheck, CheckSquare, ExternalLink, GitCompare, MessageSquare, MessageSquareReply, MoreHorizontal, Square, SquareTerminal, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { navigate, useAgent, useCore } from "@/core";
import type { Column } from "@/core/gen";
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
  IconButton,
} from "@/design";
import { ACTIONS, isFresh } from "@/features/shell/vocab";
import { archiveWithUndo, canReview, markDoneAndRemove, openAgent, openAnswerHud, openTerminal, promptAgent, setArchived, setMuted, stopAgent, useMuted } from "./agentActions";
import { useBoard } from "./boardStore";

/* ───────────── the card menu (⋯ button and right-click) ───────────── */

interface Item {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  /** One line from ACTIONS, shown as the item's tooltip. */
  description?: string;
  danger?: boolean;
  run(): void;
}

function useItems(agentKey: string, lane: Column, mobile: boolean): Item[] {
  const agent = useAgent(agentKey);
  const muted = useMuted(agentKey);
  const picked = useBoard((s) => s.picked.includes(agentKey));
  // "Mark done & remove worktree…" only where there is a linked worktree to remove
  const inWorktree = useCore((s) => {
    const a = s.agents[agentKey];
    return !!a && !!s.hosts[a.hostId]?.state.workspaces.find((w) => w.id === a.workspaceId)?.worktree;
  });
  if (!agent) return [];
  const { openSession, terminal, answer, review, markDone, markDoneRemove, reopen, stopTurn, mute, unmute, select } = ACTIONS;
  const items: Item[] = [];
  if (lane === "needs") items.push({ id: "answer", ...answer, icon: <MessageSquareReply />, run: () => openAnswerHud(agentKey) });
  if (isFresh(agent)) items.push({ id: "prompt", label: "Prompt…", description: "Open the session with the composer focused", icon: <MessageSquare />, run: () => promptAgent(agentKey) });
  items.push(
    { id: "open", ...openSession, shortcut: mobile ? undefined : openSession.shortcut, icon: <ExternalLink />, run: () => openAgent(agentKey) },
    { id: "term", ...terminal, shortcut: mobile ? undefined : terminal.shortcut, icon: <SquareTerminal />, run: () => openTerminal(agentKey, mobile) },
  );
  if ((lane === "review" || lane === "done") && canReview(agent))
    items.push({ id: "review", ...review, icon: <GitCompare />, run: () => navigate({ name: "review", hostId: agent.hostId, workspaceId: agent.workspaceId }) });
  if (lane === "review") {
    items.push({ id: "markDone", ...markDone, icon: <CheckCheck />, run: () => void archiveWithUndo([agentKey]) });
    if (inWorktree) items.push({ id: "markDoneRemove", ...markDoneRemove, icon: <Trash2 />, danger: true, run: () => void markDoneAndRemove(agentKey) });
  }
  if (lane === "done") items.push({ id: "reopen", ...reopen, icon: <ArchiveRestore />, run: () => void setArchived(agentKey, false).catch(() => {}) });
  if (lane === "running")
    // reversible, so not styled as danger; its Esc key belongs to the session view, not the board
    items.push({
      id: "stop",
      label: stopTurn.label,
      description: stopTurn.description,
      icon: (
        <svg viewBox="0 0 16 16" aria-hidden>
          <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
      ),
      run: () => void stopAgent(agentKey),
    });
  items.push(
    muted ? { id: "unmute", ...unmute, icon: <Bell />, run: () => void setMuted([agentKey], false) } : { id: "mute", ...mute, icon: <BellOff />, run: () => void setMuted([agentKey], true) },
    {
      id: "select",
      ...select,
      label: picked ? "Deselect" : select.label,
      shortcut: mobile ? undefined : select.shortcut,
      icon: picked ? <Square /> : <CheckSquare />,
      run: () => useBoard.getState().togglePick(agentKey),
    },
  );
  return items;
}

/** "⋯" button with the card's actions. */
export function CardMenuButton({ agentKey, lane, mobile = false }: { agentKey: string; lane: Column; mobile?: boolean }) {
  const items = useItems(agentKey, lane, mobile);
  const name = useAgent(agentKey)?.name ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={`More actions for ${name}`} size="sm" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>{name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((it) => (
          <DropdownMenuItem key={it.id} icon={it.icon} shortcut={it.shortcut} danger={it.danger} title={it.description} onSelect={it.run}>
            {it.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Right-click menu around a desktop card (same actions as the ⋯ button). */
export function CardContextMenu({ agentKey, lane, children }: { agentKey: string; lane: Column; children: ReactNode }) {
  const items = useItems(agentKey, lane, false);
  const name = useAgent(agentKey)?.name ?? "";
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>{name}</ContextMenuLabel>
        <ContextMenuSeparator />
        {items.map((it) => (
          <ContextMenuItem key={it.id} icon={it.icon} shortcut={it.shortcut} danger={it.danger} title={it.description} onSelect={it.run}>
            {it.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
