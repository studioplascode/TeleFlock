import { FolderGit2, FolderOpen, GitBranch, Plus, SquareTerminal } from "lucide-react";
import { agentKey, navigate, useAgent, useHostIds, useHosts, useHostState } from "@/core";
import type { PaneInfo, Workspace } from "@/core/gen";
import { Button, cn, IconButton, ScrollArea, Select, StatusOrb } from "@/design";
import { agentTier, COLUMN_STATUS } from "@/features/shell/status";
import { agentStateWord } from "@/features/shell/vocab";
import { paneDetail, paneName } from "./panes";

/**
 * Desktop Terminal view: every pane running on the host (agents and shells), grouped by workspace
 * and tab. Picking one attaches to it; "New shell" (per workspace, and at the bottom) is the only
 * thing that creates a pane.
 */
export function PaneList({
  hostId,
  workspaces,
  active,
  current,
  onPick,
  onNewShell,
}: {
  hostId: string;
  workspaces: Workspace[];
  /** The attached pane. */
  active: string | undefined;
  /** Workspace a bare "New shell" opens in. */
  current: Workspace | undefined;
  onPick(paneId: string): void;
  onNewShell(workspaceId: string | null, cwd: string | null): void;
}) {
  const home = useHostState(hostId)?.info.home;
  const hostIds = useHostIds();
  const profiles = useHosts((h) => h.profiles);
  const sorted = [...workspaces].sort((a, b) => a.order - b.order);
  const count = sorted.reduce((n, w) => n + w.tabs.reduce((m, t) => m + t.panes.length, 0), 0);
  return (
    <aside aria-label="Running panes" className="flex w-64 shrink-0 flex-col overflow-hidden rounded-[18px] bg-tile-2 shadow-d1">
      <div className="flex shrink-0 flex-col gap-2 px-3 pt-3 pb-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="kicker">Running panes</span>
          <span className="font-mono text-2xs font-bold text-mute-2 tabular-nums">{count}</span>
        </div>
        {hostIds.length > 1 && (
          <Select
            aria-label="Host"
            value={hostId}
            onValueChange={(id) => navigate({ name: "terminal", hostId: id })}
            options={hostIds.map((id) => ({ value: id, label: profiles.find((p) => p.id === id)?.name ?? id }))}
          />
        )}
      </div>
      {/* Radix lays the content out as a table (inline style), which defeats `truncate`: block it; never scroll sideways. */}
      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-1.5 pb-2 overflow-x-hidden! [&>div]:block!" fade>
        {sorted.length === 0 ? (
          <p className="px-2 py-3 text-xs text-mute-2">No panes on this host yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sorted.map((ws) => (
              <WorkspaceGroup key={ws.id} hostId={hostId} ws={ws} home={home} active={active} onPick={onPick} onNewShell={onNewShell} />
            ))}
          </ul>
        )}
      </ScrollArea>
      <div className="shrink-0 border-t border-line p-2">
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus />}
          className="w-full"
          onClick={() => onNewShell(current?.id ?? null, current?.cwd ?? null)}
          title={current ? `New shell in ${current.label}` : "New shell in the home folder"}
        >
          <span className="truncate">New shell{current ? ` in ${current.label}` : ""}</span>
        </Button>
      </div>
    </aside>
  );
}

function WorkspaceGroup({
  hostId,
  ws,
  home,
  active,
  onPick,
  onNewShell,
}: {
  hostId: string;
  ws: Workspace;
  home: string | undefined;
  active: string | undefined;
  onPick(paneId: string): void;
  onNewShell(workspaceId: string | null, cwd: string | null): void;
}) {
  const Icon = ws.worktree ? GitBranch : ws.repo ? FolderGit2 : FolderOpen;
  const branch = ws.worktree?.branch ?? ws.repo?.branch;
  const tabs = ws.tabs.filter((t) => t.panes.length > 0);
  return (
    <li aria-label={`Workspace ${ws.label}`}>
      <div className="group/ws flex h-7 items-center gap-1.5 pr-0.5 pl-2">
        <Icon className="size-3.5 shrink-0 text-mute-2" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-extrabold text-ink" title={`${ws.label} · ${ws.cwd}`}>
          {ws.label}
          {branch && branch !== ws.label && <span className="ml-1.5 font-mono text-[10.5px] font-semibold text-mute-2">{branch}</span>}
        </span>
        <IconButton
          label={`New shell in ${ws.label}`}
          size="sm"
          className="size-6 opacity-0 group-hover/ws:opacity-100 focus-visible:opacity-100"
          onClick={() => onNewShell(ws.id, ws.cwd)}
        >
          <Plus />
        </IconButton>
      </div>
      <ul className="flex flex-col gap-px">
        {tabs.map((tab) => (
          <li key={tab.id} aria-label={tabs.length > 1 ? `Tab ${tab.label}` : undefined}>
            {tabs.length > 1 && <div className="truncate px-2 pt-1 pb-0.5 pl-7 text-[10.5px] font-bold tracking-wide text-mute-2 uppercase">{tab.label}</div>}
            <ul className="flex flex-col gap-px">
              {tab.panes.map((pane) => (
                <li key={pane.id}>
                  <PaneRow hostId={hostId} pane={pane} tabLabel={tab.label} home={home} base={ws.cwd} active={pane.id === active} onPick={onPick} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </li>
  );
}

function PaneRow({
  hostId,
  pane,
  tabLabel,
  home,
  base,
  active,
  onPick,
}: {
  hostId: string;
  pane: PaneInfo;
  tabLabel: string;
  home: string | undefined;
  /** The workspace folder: a pane there shows no folder, one below it `./sub`. */
  base: string;
  active: boolean;
  onPick(paneId: string): void;
}) {
  const agent = useAgent(agentKey(hostId, pane.agentId ?? ""));
  const name = agent?.name ?? paneName(pane);
  const detail = agent ? agentStateWord(agent) : paneDetail(pane, home, base);
  return (
    <button
      type="button"
      onClick={() => onPick(pane.id)}
      aria-current={active ? "true" : undefined}
      title={`${name} · tab ${tabLabel} · ${pane.id}`}
      data-pane-id={pane.id}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md py-1.5 pr-2 pl-2.5 text-left transition-colors focus-ring",
        active ? "bg-accent/14 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)]" : "hover:bg-white/5",
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center">
        {agent ? (
          <StatusOrb status={COLUMN_STATUS[agent.column]} activity={agent.column === "running" ? agentTier(agent) : "calm"} size={7} label={null} />
        ) : (
          <SquareTerminal className={cn("size-3.5", active ? "text-accent-hi" : "text-mute-2")} aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-xs font-bold", active ? "text-ink" : "text-ink-2")}>{name}</span>
        {detail && <span className="block truncate font-mono text-[10.5px] text-mute-2">{detail}</span>}
      </span>
    </button>
  );
}
