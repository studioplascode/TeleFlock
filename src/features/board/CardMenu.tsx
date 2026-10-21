import { Bell, BellOff, CheckSquare, Archive, ArchiveRestore, ExternalLink, GitCompare, MoreHorizontal, Square, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { create } from "zustand";
import { navigate, parseAgentKey, useAgent, useSettings } from "@/core";
import type { Column } from "@/core/gen";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
} from "@/design";
import { archiveWithUndo, openAgent, openTerminal, setArchived, setMuted, stopAgent, useMuted } from "./agentActions";
import { useBoard } from "./boardStore";

/* ───────────── archive with optional confirm (menus, selection bar) ───────────── */

const useArchiveAsk = create<{ keys: string[] | null; set(keys: string[] | null): void }>()((set) => ({ keys: null, set: (keys) => set({ keys }) }));

/** Archive agents, asking first when `Settings.confirmArchive` is on. */
export function requestArchive(keys: readonly string[]): void {
  if (keys.length === 0) return;
  if (useSettings.getState().confirmArchive) useArchiveAsk.getState().set([...keys]);
  else if (keys.length === 1) void setArchived(keys[0] ?? "", true).catch(() => {});
  else void archiveWithUndo(keys);
}

/** Confirm dialog for `requestArchive`; mount once per board surface. */
export function ArchiveConfirmDialog() {
  const keys = useArchiveAsk((s) => s.keys);
  const set = useArchiveAsk((s) => s.set);
  const first = useAgent(keys?.[0] ?? "");
  const n = keys?.length ?? 0;
  const label = n === 1 ? (first?.name ?? parseAgentKey(keys?.[0] ?? "").agentId) : `${n} agents`;
  const confirm = () => {
    const k = keys ?? [];
    set(null);
    if (k.length === 1) void setArchived(k[0] ?? "", true).catch(() => {});
    else void archiveWithUndo(k);
  };
  return (
    <Dialog open={keys !== null} onOpenChange={(o) => !o && set(null)}>
      <DialogContent
        width={420}
        title={`Archive ${label}?`}
        description="Archived agents move to Done. Drag them back to In review any time."
        footer={
          <>
            <Button variant="ghost" onClick={() => set(null)}>
              Cancel
            </Button>
            <Button variant="primary" autoFocus onClick={confirm}>
              Archive
            </Button>
          </>
        }
      />
    </Dialog>
  );
}

/* ───────────── the card menu (⋯ button and right-click) ───────────── */

interface Item {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  danger?: boolean;
  run(): void;
}

function useItems(agentKey: string, lane: Column, mobile: boolean): Item[] {
  const agent = useAgent(agentKey);
  const muted = useMuted(agentKey);
  const picked = useBoard((s) => s.picked.includes(agentKey));
  if (!agent) return [];
  const items: Item[] = [
    { id: "open", label: "Open session", icon: <ExternalLink />, shortcut: "↵", run: () => openAgent(agentKey) },
    { id: "term", label: mobile ? "Terminal" : "Terminal (split)", icon: <SquareTerminal />, shortcut: "T", run: () => openTerminal(agentKey, mobile) },
  ];
  if (lane === "review" || lane === "done")
    items.push({ id: "diff", label: "Review diff", icon: <GitCompare />, run: () => navigate({ name: "review", hostId: agent.hostId, workspaceId: agent.workspaceId }) });
  if (lane === "review") items.push({ id: "archive", label: "Archive", icon: <Archive />, run: () => requestArchive([agentKey]) });
  if (lane === "done") items.push({ id: "reopen", label: "Reopen for review", icon: <ArchiveRestore />, run: () => void setArchived(agentKey, false).catch(() => {}) });
  if (lane === "running")
    items.push({
      id: "stop",
      label: "Stop turn",
      icon: (
        <svg viewBox="0 0 16 16" aria-hidden>
          <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
      ),
      danger: true,
      run: () => void stopAgent(agentKey),
    });
  items.push(
    muted
      ? { id: "unmute", label: "Unmute notifications", icon: <Bell />, run: () => void setMuted([agentKey], false) }
      : { id: "mute", label: "Mute notifications", icon: <BellOff />, run: () => void setMuted([agentKey], true) },
    {
      id: "select",
      label: picked ? "Deselect" : "Select",
      icon: picked ? <Square /> : <CheckSquare />,
      shortcut: "X",
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
          <DropdownMenuItem key={it.id} icon={it.icon} shortcut={it.shortcut} danger={it.danger} onSelect={it.run}>
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
          <ContextMenuItem key={it.id} icon={it.icon} shortcut={it.shortcut} danger={it.danger} onSelect={it.run}>
            {it.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
