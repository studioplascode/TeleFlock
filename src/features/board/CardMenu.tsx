import { ArchiveRestore, ArrowRightLeft, Bell, BellOff, CheckCheck, CheckSquare, ExternalLink, GitCompare, MessageSquare, MessageSquareReply, MoreHorizontal, Play, RotateCw, Square, SquareTerminal, Timer, TimerOff, Trash2, X } from "lucide-react";
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
import { archiveWithUndo, canReview, deleteWorktree, markDoneAndRemove, openAgent, openAnswerHud, openTerminal, promptAgent, resumeParked, setArchived, setMuted, stopAgent, useMuted } from "./agentActions";
import { cancelAutoResume, resumeNow } from "@/features/session/resume/actions";
import { ticketActions } from "@/features/session/resume/words";
import { useBoard } from "./boardStore";
import { useCanMove } from "@/features/move/hosts";
import { openMoveDialog } from "@/features/move/store";
import { shippedWords, useShippedPr } from "./worktreePr";
import { openDecideDialog } from "@/features/autoAnswer/DecideDialog";
import { useCanDecide } from "@/features/autoAnswer/hooks";

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
  // merged or closed pull request (Review/Done cards ask gh lazily; see worktreePr)
  const shipped = useShippedPr(agentKey, lane === "review" || lane === "done");
  const canMove = useCanMove(agentKey);
  const canDecide = useCanDecide(agentKey);
  if (!agent) return [];
  const { openSession, terminal, answer, review, markDone, markDoneRemove, deleteWorktree: deleteWt, reopen, resume, stopTurn, mute, unmute, select } = ACTIONS;
  const items: Item[] = [];
  if (lane === "needs") items.push({ id: "answer", ...answer, icon: <MessageSquareReply />, run: () => openAnswerHud(agentKey) });
  if (isFresh(agent)) items.push({ id: "prompt", label: "Prompt…", description: "Open the session with the composer focused", icon: <MessageSquare />, run: () => promptAgent(agentKey) });
  items.push({ id: "open", ...openSession, shortcut: mobile ? undefined : openSession.shortcut, icon: <ExternalLink />, run: () => openAgent(agentKey) });
  // parked (pane closed when it was marked done): Resume brings it back; Terminal resumes first. An ended card
  // (its omp ended without anyone closing it) comes back through its ticket's Continue instead.
  const ended = agent.parked?.ended;
  if (agent.parked && !ended) items.push({ id: "resume", ...resume, icon: <Play />, run: () => void resumeParked(agentKey) });
  // stopped on a provider limit, or ended: resume (continue) it now, or let it be
  const ticket = agent.autoResume ? ticketActions(agent.autoResume, { ended }) : null;
  if (ticket) {
    items.push({ id: "resumeNow", label: ticket.resume, description: ticket.resumeHint, icon: <RotateCw />, run: () => void resumeNow(agentKey) });
    items.push({ id: "noAutoResume", label: ticket.cancel, description: ticket.cancelHint, icon: ticket.dismiss ? <X /> : <TimerOff />, run: () => void cancelAutoResume(agentKey, ticket.dismiss) });
  }
  items.push({
    id: "term",
    ...terminal,
    description: agent.parked ? "Resume it, then open its new terminal" : terminal.description,
    shortcut: mobile ? undefined : terminal.shortcut,
    icon: <SquareTerminal />,
    run: () => openTerminal(agentKey, mobile),
  });
  // omp agents, with a second connected host to go to (the dialog's preflight has the last word)
  if (canMove) items.push({ id: "move", ...ACTIONS.moveHost, icon: <ArrowRightLeft />, run: () => openMoveDialog(agentKey) });
  // omp agents on a host with decide for me (its own policy; the ask card handles one question)
  if (canDecide) items.push({ id: "decide", ...ACTIONS.decideForMe, icon: <Timer />, run: () => openDecideDialog(agentKey) });
  // a parked agent's workspace may be gone with its pane
  if ((lane === "review" || lane === "done") && canReview(agent) && !agent.parked)
    items.push({ id: "review", ...review, icon: <GitCompare />, run: () => navigate({ name: "review", hostId: agent.hostId, workspaceId: agent.workspaceId }) });
  const deleteItem = (andDone: boolean): Item | null =>
    shipped && {
      id: "deleteWorktree",
      ...deleteWt,
      description: `${shippedWords(shipped)}: delete the checkout folder${andDone ? " and mark it done" : ""} (asks first); the branch stays`,
      icon: <Trash2 />,
      danger: true,
      run: () => void deleteWorktree(agentKey),
    };
  if (lane === "review") {
    items.push({ id: "markDone", ...markDone, icon: <CheckCheck />, run: () => void archiveWithUndo([agentKey]) });
    // shipped: the same removal (it marks done too), named for what it is now
    const del = deleteItem(true);
    if (del) items.push(del);
    else if (inWorktree) items.push({ id: "markDoneRemove", ...markDoneRemove, icon: <Trash2 />, danger: true, run: () => void markDoneAndRemove(agentKey) });
  }
  if (lane === "done") {
    items.push({ id: "reopen", ...reopen, icon: <ArchiveRestore />, run: () => void setArchived(agentKey, false).catch(() => {}) });
    const del = deleteItem(false);
    if (del) items.push(del);
  }
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

/** The actions, mounted only while a menu is open: a closed menu doesn't follow every agent update. */
function DropdownItems({ agentKey, lane, mobile }: { agentKey: string; lane: Column; mobile: boolean }) {
  const items = useItems(agentKey, lane, mobile);
  return items.map((it) => (
    <DropdownMenuItem key={it.id} icon={it.icon} shortcut={it.shortcut} danger={it.danger} title={it.description} onSelect={it.run}>
      {it.label}
    </DropdownMenuItem>
  ));
}

function ContextItems({ agentKey, lane }: { agentKey: string; lane: Column }) {
  const items = useItems(agentKey, lane, false);
  return items.map((it) => (
    <ContextMenuItem key={it.id} icon={it.icon} shortcut={it.shortcut} danger={it.danger} title={it.description} onSelect={it.run}>
      {it.label}
    </ContextMenuItem>
  ));
}

/** "⋯" button with the card's actions. */
export function CardMenuButton({ agentKey, lane, mobile = false }: { agentKey: string; lane: Column; mobile?: boolean }) {
  const name = useCore((s) => s.agents[agentKey]?.name ?? "");
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
        <DropdownItems agentKey={agentKey} lane={lane} mobile={mobile} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Right-click menu around a desktop card (same actions as the ⋯ button). */
export function CardContextMenu({ agentKey, lane, children }: { agentKey: string; lane: Column; children: ReactNode }) {
  const name = useCore((s) => s.agents[agentKey]?.name ?? "");
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>{name}</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextItems agentKey={agentKey} lane={lane} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
