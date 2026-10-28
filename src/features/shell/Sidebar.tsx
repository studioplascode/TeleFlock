import {
  Activity,
  Archive,
  ArchiveRestore,
  BarChart3,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Columns2,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitBranchPlus,
  GitFork,
  History,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  MessageSquareReply,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Server,
  Settings2,
  SquareTerminal,
  SquareX,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type PointerEvent as ReactPointerEvent, useEffect, useState } from "react";
import {
  Badge,
  Button,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  CountBadge,
  IconButton,
  Kbd,
  ScrollArea,
  Shimmer,
  Sparkline,
  spring,
  type Status,
  StatusOrb,
  Tooltip,
  useMediaQuery,
} from "@/design";
import { navigate, type Route, useAgent, useAgentKeys, useHostIds, useHosts, useHostStale, useInbox, useNotifications, useRoute, useUi, useWorkspaces } from "@/core";
import { routeKey } from "@/app/routes";
import type { HerdrState, PaneInfo, Workspace } from "@/core/gen";
import { archiveWithUndo, openAnswerHud, setArchived } from "@/features/board/agentActions";
import { connAction } from "@/features/hosts/ConnStatusCard";
import { hostAccent } from "@/features/hosts/kinds";
import { openNewAgent } from "@/features/workspace/NewAgentDialog";
import { closePane, WorkspaceActionsMenu } from "@/features/workspace/workspaceActions";
import { paneDetail, paneName } from "@/features/terminal/panes";
import { useHealthHistory } from "./healthHistory";
import { agentTier, COLUMN_STATUS, connSummary, PHASE_STATUS } from "./status";
import { SIDEBAR_DEFAULT_W, SIDEBAR_LABELS_W, SIDEBAR_RAIL_QUERY, toggleSidebar, useSidebarPeek, useSidebarWidth } from "./sidebarState";
import { ACTIONS, type ActionDef, agentStateId, STATE_SHORT, VIEWS } from "./vocab";

const ROLLUP_STATUS: Record<HerdrState, Status> = {
  working: "running",
  blocked: "needs-you",
  idle: "idle",
  done: "review",
  unknown: "idle",
};

const COLLAPSED_W = 64;

/** Tooltip body for an action or view: its label, then its one-line description. */
function ActionTip({ def }: { def: ActionDef }) {
  return (
    <span className="flex max-w-60 flex-col">
      <span className="font-bold">{def.label}</span>
      {def.description && <span className="text-mute">{def.description}</span>}
    </span>
  );
}

/** Monitoring views in the nav; Hosts and Settings live in the HOSTS header and the footer. */
const NAV: readonly { id: "board" | "inbox" | "activity" | "usage" | "automations"; icon: LucideIcon }[] = [
  { id: "board", icon: LayoutDashboard },
  { id: "inbox", icon: Inbox },
  { id: "activity", icon: Activity },
  { id: "usage", icon: BarChart3 },
  { id: "automations", icon: Clock3 },
];

function NavItem({ id, icon: Icon, collapsed, active, badge, unread }: { id: Route["name"] & keyof typeof VIEWS; icon: LucideIcon; collapsed: boolean; active: boolean; badge?: number; unread?: number }) {
  const def: ActionDef = VIEWS[id];
  const dot = !!unread && (
    <span className={cn("size-1.5 rounded-full bg-accent-hi shadow-[0_0_8px_rgb(163_92_240/0.9)]", collapsed ? "absolute top-1.5 left-2" : "relative")} aria-label={`${unread} unread update${unread === 1 ? "" : "s"}`} />
  );
  return (
    <Tooltip content={<ActionTip def={def} />} shortcut={def.shortcut} side="right">
      <button
        type="button"
        onClick={() => navigate({ name: id } as Route)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-sm font-bold transition-colors focus-ring",
          active ? "text-ink" : "text-mute hover:bg-white/4 hover:text-ink",
          collapsed && "justify-center px-0",
        )}
      >
        {active && <motion.span layoutId="tf-nav-active" transition={spring.snappy} className="absolute inset-0 rounded-md bg-white/7 shadow-[inset_0_0_0_1px_var(--color-line-2)]" aria-hidden />}
        {active && <motion.span layoutId="tf-nav-bar" transition={spring.snappy} className="absolute top-2 bottom-2 -left-2 w-[3px] rounded-full bg-omp shadow-[0_0_10px_rgb(163_92_240/0.9)]" aria-hidden />}
        <Icon className={cn("relative size-4 shrink-0", active && "text-accent-hi")} />
        {!collapsed && <span className="relative flex-1 truncate text-left">{def.label}</span>}
        {dot}
        {badge !== undefined && badge > 0 && (collapsed ? <span className="absolute top-1 right-2 size-2 rounded-full bg-sun-2 shadow-glow-sun" /> : <CountBadge count={badge} className="relative" />)}
      </button>
    </Tooltip>
  );
}

/** `index` is the row's place in its workspace: the only thing that moves it, so the only thing that makes it measure its layout. */
function AgentRow({ agentKey: key, depth, index }: { agentKey: string; depth: number; index: number }) {
  const a = useAgent(key);
  const route = useRoute();
  const { setSplit } = useUi();
  if (!a) return null;
  const active = route.name === "agent" && route.hostId === a.hostId && route.agentId === a.id;
  const status = COLUMN_STATUS[a.column];
  const open = () => navigate({ name: "agent", hostId: a.hostId, agentId: a.id });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <motion.button
          layout="position"
          layoutDependency={index}
          type="button"
          onClick={open}
          aria-current={active ? "page" : undefined}
          title={a.live.line ?? a.title}
          className={cn(
            "group relative flex h-7 w-full items-center gap-2 rounded-sm pr-1.5 text-left text-xs font-semibold transition-colors focus-ring",
            active ? "bg-accent/14 text-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)]" : "text-ink-2 hover:bg-white/4",
          )}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <StatusOrb status={status} activity={agentTier(a)} size={7} label={status === "needs-you" ? "Needs you" : null} />
          <span className="min-w-0 flex-1 truncate">{a.name}</span>
          {a.column === "running" && a.live.tool && <span className="max-w-16 truncate font-mono text-[10px] text-tool">{a.live.tool.name}</span>}
          <Badge tone={status} className="h-4 px-1.5 text-[8.5px]">
            {STATE_SHORT[agentStateId(a)]}
          </Badge>
        </motion.button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={<Bot />} shortcut={ACTIONS.openSession.shortcut} onSelect={open}>
          {ACTIONS.openSession.label}
        </ContextMenuItem>
        {a.column === "needs" && (
          <ContextMenuItem icon={<MessageSquareReply />} onSelect={() => openAnswerHud(a.key)}>
            {ACTIONS.answer.label}
          </ContextMenuItem>
        )}
        <ContextMenuItem icon={<SquareTerminal />} onSelect={() => navigate({ name: "terminal", hostId: a.hostId, agentId: a.id })}>
          {ACTIONS.terminal.label}
        </ContextMenuItem>
        <ContextMenuItem icon={<Columns2 />} onSelect={() => setSplit({ kind: "session", key: a.key })}>
          Open beside
        </ContextMenuItem>
        <ContextMenuItem icon={<Columns2 />} shortcut={ACTIONS.terminalBeside.shortcut} onSelect={() => setSplit({ kind: "terminal", hostId: a.hostId, agentId: a.id })}>
          {ACTIONS.terminalBeside.label}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {a.archived ? (
          <ContextMenuItem icon={<ArchiveRestore />} onSelect={() => void setArchived(a.key, false).catch(() => {})}>
            {ACTIONS.reopen.label}
          </ContextMenuItem>
        ) : (
          <ContextMenuItem icon={<Archive />} onSelect={() => void archiveWithUndo([a.key])}>
            {ACTIONS.markDone.label}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Shell rows shown under a workspace before "N more". */
const SHELLS_SHOWN = 3;

/** A pane no agent owns (a shell, or whatever runs in it): opens its terminal; nothing is created. */
function ShellRow({ hostId, pane, tabLabel, depth }: { hostId: string; pane: PaneInfo; tabLabel: string; depth: number }) {
  const route = useRoute();
  const { setSplit } = useUi();
  const active = route.name === "terminal" && route.hostId === hostId && route.paneId === pane.id;
  const open = () => navigate({ name: "terminal", hostId, paneId: pane.id });
  const name = paneName(pane);
  const detail = paneDetail(pane);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={open}
          aria-current={active ? "page" : undefined}
          aria-label={`Shell ${name}`}
          title={[name, `tab ${tabLabel}`, detail].filter(Boolean).join(" · ")}
          className={cn(
            "flex h-6 w-full items-center gap-2 rounded-sm pr-1.5 text-left text-[11px] font-semibold transition-colors focus-ring",
            active ? "bg-accent/14 text-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)]" : "text-mute hover:bg-white/4 hover:text-ink-2",
          )}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <SquareTerminal className={cn("size-3 shrink-0", active ? "text-accent-hi" : "text-mute-2")} />
          <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={<SquareTerminal />} onSelect={open}>
          Open terminal
        </ContextMenuItem>
        <ContextMenuItem icon={<Columns2 />} onSelect={() => setSplit({ kind: "terminal", hostId, paneId: pane.id })}>
          Open beside
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem icon={<SquareX />} danger onSelect={() => void closePane(hostId, pane)}>
          Close shell…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function WorkspaceRow({ hostId, ws, nested }: { hostId: string; ws: Workspace; nested: boolean }) {
  const keys = useAgentKeys({ hostId, workspaceId: ws.id });
  const [allShells, setAllShells] = useState(false);
  const route = useRoute();
  const active = route.name === "review" && route.hostId === hostId && route.workspaceId === ws.id;
  const branch = ws.worktree?.branch ?? ws.repo?.branch ?? ws.label;
  const Icon = ws.worktree ? GitBranch : ws.repo ? FolderGit2 : FolderOpen;
  const dirty = ws.repo?.dirty ?? 0;
  const shells = ws.tabs.flatMap((t) => t.panes.filter((p) => !p.agentId).map((pane) => ({ pane, tabLabel: t.label })));
  const shown = allShells ? shells : shells.slice(0, SHELLS_SHOWN);
  const depth = nested ? 2 : 1;
  return (
    <li>
      <WorkspaceActionsMenu hostId={hostId} workspace={ws} mode="context">
        <button
          type="button"
          onClick={() => ws.repo && navigate({ name: "review", hostId, workspaceId: ws.id })}
          // Plain folders have no review screen: the row only carries the right-click menu, so no pointer.
          className={cn(
            "flex h-7 w-full items-center gap-2 rounded-sm pr-1.5 text-left text-xs font-bold transition-colors focus-ring",
            active ? "bg-white/7 text-ink" : "text-mute hover:bg-white/4 hover:text-ink-2",
            !ws.repo && "cursor-default",
          )}
          style={{ paddingLeft: nested ? 22 : 8 }}
          title={`${ws.label} · ${ws.cwd}`}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{branch}</span>
          {dirty > 0 && (
            <Tooltip content={`${dirty} uncommitted file${dirty === 1 ? "" : "s"}`}>
              <span className="font-mono text-[10px] text-warn">●{dirty}</span>
            </Tooltip>
          )}
          <StatusOrb status={ROLLUP_STATUS[ws.rollup]} size={6} label={null} />
        </button>
      </WorkspaceActionsMenu>
      {keys.length > 0 && (
        <ul className="flex flex-col gap-px">
          {keys.map((k, i) => (
            <li key={k}>
              <AgentRow agentKey={k} depth={depth} index={i} />
            </li>
          ))}
        </ul>
      )}
      {shells.length > 0 && (
        <ul className="flex flex-col gap-px" aria-label={`Shells in ${ws.label}`}>
          {shown.map(({ pane, tabLabel }) => (
            <li key={pane.id}>
              <ShellRow hostId={hostId} pane={pane} tabLabel={tabLabel} depth={depth} />
            </li>
          ))}
          {shells.length > SHELLS_SHOWN && (
            <li>
              <button
                type="button"
                onClick={() => setAllShells((v) => !v)}
                aria-expanded={allShells}
                className="flex h-5 w-full items-center rounded-sm pr-1.5 text-left text-[10.5px] font-bold text-mute-2 transition-colors focus-ring hover:text-ink-2"
                style={{ paddingLeft: 8 + depth * 14 + 20 }}
              >
                {allShells ? "Fewer shells" : `${shells.length - SHELLS_SHOWN} more shell${shells.length - SHELLS_SHOWN === 1 ? "" : "s"}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

interface RepoGroup {
  key: string;
  name: string;
  root?: string;
  items: Workspace[];
}

function groupWorkspaces(list: Workspace[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  const byId = new Map(list.map((w) => [w.id, w]));
  for (const ws of [...list].sort((a, b) => a.order - b.order)) {
    const primary = ws.worktree?.primaryWorkspaceId ? byId.get(ws.worktree.primaryWorkspaceId) : undefined;
    const root = primary?.repo?.root ?? ws.repo?.root;
    const key = root ?? `ws:${ws.id}`;
    const g = groups.get(key) ?? { key, name: primary?.repo?.name ?? ws.repo?.name ?? ws.label, root, items: [] };
    g.items.push(ws);
    groups.set(key, g);
  }
  for (const g of groups.values()) g.items.sort((a, b) => Number(!!a.worktree) - Number(!!b.worktree) || a.order - b.order);
  return [...groups.values()];
}

function RepoTree({ hostId, group }: { hostId: string; group: RepoGroup }) {
  const [open, setOpen] = useState(true);
  const { openDialog } = useUi();
  const multi = group.items.length > 1 || !!group.root;
  if (!multi) {
    const only = group.items[0];
    return only ? <WorkspaceRow hostId={hostId} ws={only} nested={false} /> : null;
  }
  return (
    <li>
      <div className="group/repo flex h-7 items-center gap-1 rounded-sm pr-1 hover:bg-white/3">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm pl-1 text-left text-xs font-extrabold text-ink focus-ring">
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} className="grid place-items-center">
            <ChevronRight className="size-3.5 text-mute-2" />
          </motion.span>
          <span className="truncate">{group.name}</span>
        </button>
        <IconButton
          label={`${ACTIONS.newWorktree.label} in ${group.name}`}
          size="sm"
          className="size-5.5 opacity-0 group-hover/repo:opacity-100 focus-visible:opacity-100"
          onClick={() => openDialog({ kind: "newWorktree", hostId, cwd: group.root })}
        >
          <Plus />
        </IconButton>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring.smooth} className="flex flex-col gap-px overflow-hidden">
            {group.items.map((ws) => (
              <WorkspaceRow key={ws.id} hostId={hostId} ws={ws} nested />
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </li>
  );
}

function HostTree({ hostId, showHeader }: { hostId: string; showHeader: boolean }) {
  const workspaces = useWorkspaces(hostId);
  const stale = useHostStale(hostId);
  const name = useHosts((h) => h.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const groups = groupWorkspaces(workspaces);
  return (
    <section className={cn("flex flex-col gap-0.5 transition-[filter,opacity] duration-500", stale && "opacity-70 saturate-[0.35]")} aria-label={`${name} workspaces`}>
      {(showHeader || stale) && (
        <div className="flex items-center gap-2 px-2 pt-2 pb-1">
          {showHeader && <span className="kicker">{name}</span>}
          {stale && <Shimmer className="text-2xs font-bold">stale · reconnecting</Shimmer>}
        </div>
      )}
      {groups.length === 0 ? (
        <p className="px-2 py-1 text-xs text-mute-2">No workspaces yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {groups.map((g) => (
            <RepoTree key={g.key} hostId={hostId} group={g} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** CPU sparkline and RAM bar for an online host (the old health footer, now on the host's own row). */
function HostHealth({ hostId, name }: { hostId: string; name: string }) {
  const { health, cpu } = useHealthHistory(hostId);
  if (!health) return null;
  const cpuPct = Math.round(health.cpuPct);
  const mem = health.memTotal ? Math.round((health.memUsed / health.memTotal) * 100) : 0;
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-semibold text-mute-2" title={`${name}: CPU ${cpuPct}% · RAM ${mem}% · load ${health.load1.toFixed(2)}`}>
      <span>cpu</span>
      <Sparkline values={cpu.length > 1 ? cpu : [health.cpuPct, health.cpuPct]} height={12} status="idle" live={false} className="min-w-0 flex-1" aria-label={`${name} CPU`} />
      <span className="w-7 text-right font-mono tabular">{cpuPct}%</span>
      <span className="ml-1">ram</span>
      <span className="relative h-1 w-8 shrink-0 overflow-hidden rounded-full bg-white/8" aria-hidden>
        <span className={cn("tf-glide-width absolute inset-y-0 left-0 rounded-full", mem >= 90 ? "bg-warn" : "bg-white/45")} style={{ width: `${mem}%` }} />
      </span>
      <span className="w-7 text-right font-mono tabular">{mem}%</span>
    </span>
  );
}

/** One host: the row filters the flock to it (✓ when selected); a separate verb button when it isn't online. */
function HostRow({ id, collapsed }: { id: string; collapsed: boolean }) {
  const profile = useHosts((h) => h.profiles.find((p) => p.id === id));
  const status = useHosts((h) => h.status[id]);
  const { filter, setFilter } = useHosts();
  if (!profile) return null;
  const phase = status?.phase ?? "idle";
  const online = phase === "online" || phase === "reconnecting";
  const selected = filter === id;
  const summary = connSummary(status);
  const action = connAction(status, id);
  const filterTo = selected ? "all" : id;
  const orb = <StatusOrb status={PHASE_STATUS[phase]} size={9} label={null} />;
  if (collapsed) {
    // Rail: an online host's orb filters (as the row does); a host that isn't online offers its one verb.
    const tip = action ? `${action.label} ${profile.name} · ${summary}` : `${profile.name} · ${summary}${selected ? " · filtered" : ""}`;
    return (
      <Tooltip content={tip} side="right">
        <button
          type="button"
          onClick={action ? action.run : () => setFilter(filterTo)}
          aria-pressed={action ? undefined : selected}
          className={cn("grid size-9 place-items-center rounded-md focus-ring hover:bg-white/5", selected && "bg-white/7")}
          aria-label={action ? `${action.label} ${profile.name}: ${summary}` : `${profile.name}: ${summary}`}
        >
          {orb}
        </button>
      </Tooltip>
    );
  }
  return (
    <div className={cn("flex items-center gap-1 rounded-md transition-colors", selected ? "bg-white/7 shadow-[inset_0_0_0_1px_var(--color-line-2)]" : "hover:bg-white/4")}>
      <button
        type="button"
        onClick={() => setFilter(filterTo)}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md py-1.5 pr-1 pl-2.5 text-left focus-ring"
        title={selected ? "Show all hosts" : `Show only ${profile.name}`}
      >
        <span className="flex w-full items-center gap-2 text-sm">
          {orb}
          <span className="size-2 shrink-0 rounded-[2px]" style={{ background: hostAccent(profile.color) }} aria-hidden />
          <span className="min-w-0 truncate font-bold text-ink-2">{profile.name}</span>
          {selected && <Check className="size-3.5 shrink-0 text-accent-hi" aria-label="Filtered to this host" />}
          {online && <span className="ml-auto shrink-0 font-mono text-2xs text-mute tabular">{summary}</span>}
        </span>
        <span className="pl-[17px]">
          {online ? (
            <HostHealth hostId={id} name={profile.name} />
          ) : (
            <span className={cn("block truncate font-mono text-2xs", phase === "error" ? "text-error" : phase === "authRequired" || phase === "hostKey" ? "text-sun-2" : "text-mute-2")}>{summary}</span>
          )}
        </span>
      </button>
      {action && (
        <Button size="sm" variant="secondary" className="mr-1 h-6 shrink-0 px-2 text-2xs" onClick={action.run}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

/** One start-work launcher: icon + label (wrapping row) from 240 px, icon only below; tooltip = label, key, description. */
function Launcher({ def, icon: Icon, onClick, collapsed, labelled }: { def: ActionDef; icon: LucideIcon; onClick: () => void; collapsed: boolean; labelled: boolean }) {
  return (
    <Tooltip content={<ActionTip def={def} />} shortcut={def.shortcut} side={collapsed ? "right" : "top"}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex items-center gap-2 rounded-md text-xs font-bold text-mute transition-colors pressable focus-ring hover:bg-white/6 hover:text-ink",
          labelled ? "h-8 px-2" : collapsed ? "size-9 justify-center" : "size-8 justify-center",
        )}
        aria-label={def.label}
      >
        <Icon className="size-4 shrink-0" />
        {labelled && <span className="truncate">{def.label}</span>}
      </button>
    </Tooltip>
  );
}

/** Drag handle on the expanded sidebar's right edge (double-click resets the width). */
function ResizeHandle({ width, onDragging }: { width: number; onDragging: (on: boolean) => void }) {
  const setWidth = useSidebarWidth((s) => s.set);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startX = e.clientX;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    onDragging(true);
    const move = (ev: PointerEvent) => setWidth(width + ev.clientX - startX);
    const up = () => {
      onDragging(false);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_W)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setWidth(width - 16);
        if (e.key === "ArrowRight") setWidth(width + 16);
      }}
      className="group absolute inset-y-0 -right-0.5 z-raised w-2 cursor-col-resize focus-visible:outline-none"
    >
      <span className="absolute inset-y-0 right-0.5 w-px bg-transparent transition-colors group-hover:bg-accent/50 group-focus-visible:bg-accent" aria-hidden />
    </div>
  );
}

/** Collapsible desktop sidebar: New task, launchers, views, hosts with health, the live workspace tree, Settings. */
export function Sidebar() {
  const { sidebarCollapsed, openDialog } = useUi();
  const rail = useMediaQuery(SIDEBAR_RAIL_QUERY);
  const peek = useSidebarPeek((s) => s.open);
  const setPeek = useSidebarPeek((s) => s.set);
  const width = useSidebarWidth((s) => s.width);
  const [dragging, setDragging] = useState(false);
  const collapsed = rail ? !peek : sidebarCollapsed;
  const overlay = rail && peek;
  const route = useRoute();
  const ids = useHostIds();
  const { filter, status } = useHosts();
  const needs = useInbox().length;
  const unread = useNotifications((s) => s.unread);
  const onlineIds = ids.filter((id) => status[id]?.phase === "online" || status[id]?.phase === "reconnecting");
  const treeIds = filter === "all" ? ids : ids.filter((id) => id === filter);
  const host = filter === "all" ? onlineIds[0] : filter;
  const labelled = !collapsed && width >= SIDEBAR_LABELS_W;

  // The peek overlay closes on navigation, Escape, or when the window grows out of rail mode.
  const routeId = routeKey(route);
  useEffect(() => setPeek(false), [routeId, rail, setPeek]);
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPeek(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, setPeek]);

  const launchers: { def: ActionDef; icon: LucideIcon; run: () => void }[] = [
    { def: ACTIONS.newWorktree, icon: GitBranchPlus, run: () => openDialog({ kind: "newWorktree", hostId: host }) },
    { def: ACTIONS.newAgent, icon: Bot, run: () => openDialog({ kind: "newAgent", hostId: host }) },
    { def: ACTIONS.fanOut, icon: GitFork, run: () => openDialog({ kind: "fanOut", hostId: host }) },
    { def: ACTIONS.openFolder, icon: FolderOpen, run: () => openNewAgent({ hostId: host, openFolder: true }) },
    { def: ACTIONS.pastSessions, icon: History, run: () => openDialog({ kind: "pastSessions", hostId: host }) },
  ];
  const dispatching = route.name === "dispatch";
  const settingsActive = route.name === "settings";

  return (
    <div className="relative z-raised h-full shrink-0" style={rail ? { width: COLLAPSED_W } : undefined}>
      <AnimatePresence>
        {overlay && (
          <motion.div
            key="scrim"
            className="fixed inset-0 bg-[rgb(5_5_9/0.5)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onPointerDown={() => setPeek(false)}
            aria-hidden
          />
        )}
      </AnimatePresence>
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? COLLAPSED_W : width }}
      transition={dragging ? { duration: 0 } : spring.smooth}
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-hidden border-r border-line bg-[rgb(13_13_19/0.55)]",
        rail && "absolute inset-y-0 left-0",
        overlay && "bg-[rgb(15_15_22/0.94)] shadow-[var(--shadow-d3),1px_0_0_var(--color-line-2)]",
        dragging && "select-none",
      )}
      aria-label="Sidebar"
    >
      {/* Everything above the footer scrolls as one column on short windows, so nothing gets clipped;
          the workspace tree takes all remaining height and keeps its own scroller with a usable minimum. */}
      <div className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      <div className={cn("flex flex-col gap-1.5 p-2", collapsed && "items-center")}>
        <Tooltip content={<ActionTip def={ACTIONS.newTask} />} shortcut={ACTIONS.newTask.shortcut} side="right">
          {collapsed ? (
            <IconButton label={ACTIONS.newTask.label} variant="primary" onClick={() => navigate({ name: "dispatch" })} aria-current={dispatching ? "page" : undefined}>
              <Plus />
            </IconButton>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={<Plus />}
              trailing={<Kbd className="ml-auto h-[18px] bg-white/15 text-white/85 shadow-none">{ACTIONS.newTask.shortcut}</Kbd>}
              onClick={() => navigate({ name: "dispatch" })}
              aria-current={dispatching ? "page" : undefined}
              className={cn("h-9 w-full justify-start text-sm", dispatching && "ring-2 ring-accent-hi/60")}
            >
              {ACTIONS.newTask.label}
            </Button>
          )}
        </Tooltip>
        <div className={cn("flex", collapsed ? "flex-col items-center gap-0.5" : labelled ? "flex-wrap gap-x-0.5" : "justify-between")}>
          {launchers.map((l) => (
            <Launcher key={l.def.label} def={l.def} icon={l.icon} onClick={l.run} collapsed={collapsed} labelled={labelled} />
          ))}
        </div>
      </div>

      <div className={cn("flex flex-col gap-0.5 border-t border-line p-2", collapsed && "items-center")}>
        {NAV.map((d) => (
          <NavItem
            key={d.id}
            id={d.id}
            icon={d.icon}
            collapsed={collapsed}
            active={route.name === d.id}
            badge={d.id === "inbox" ? needs : undefined}
            unread={d.id === "inbox" ? unread : undefined}
          />
        ))}
      </div>

      <div className={cn("border-t border-line px-2 py-2", collapsed && "flex flex-col items-center")}>
        {collapsed ? (
          <Tooltip content={VIEWS.hosts.label} shortcut={VIEWS.hosts.shortcut} side="right">
            <button
              type="button"
              onClick={() => navigate({ name: "hosts" })}
              aria-current={route.name === "hosts" ? "page" : undefined}
              aria-label={VIEWS.hosts.label}
              className={cn("grid size-9 place-items-center rounded-md transition-colors focus-ring", route.name === "hosts" ? "bg-white/7 text-ink" : "text-mute hover:bg-white/6 hover:text-ink")}
            >
              <Server className="size-4" />
            </button>
          </Tooltip>
        ) : (
          <div className="flex items-center gap-1 pb-1 pl-2">
            <span className="kicker flex-1">Hosts</span>
            <Tooltip content={<ActionTip def={VIEWS.hosts} />} shortcut={VIEWS.hosts.shortcut}>
              <button
                type="button"
                onClick={() => navigate({ name: "hosts" })}
                aria-current={route.name === "hosts" ? "page" : undefined}
                className={cn("flex h-6 items-center gap-0.5 rounded-sm px-1.5 text-2xs font-bold transition-colors focus-ring", route.name === "hosts" ? "bg-white/7 text-ink" : "text-mute hover:bg-white/6 hover:text-ink")}
              >
                Manage
                <ChevronRight className="size-3" />
              </button>
            </Tooltip>
            <IconButton label="Add host" size="sm" className="size-6" onClick={() => openDialog({ kind: "hostEditor" })}>
              <Plus />
            </IconButton>
          </div>
        )}
        <div className={cn("flex flex-col gap-0.5", collapsed && "items-center")}>
          {ids.map((id) => (
            <HostRow key={id} id={id} collapsed={collapsed} />
          ))}
        </div>
      </div>

      {collapsed ? (
        <div className="flex-1" />
      ) : (
        <ScrollArea className="min-h-28 flex-1 border-t border-line" viewportClassName="px-2 py-2" fade>
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="kicker">Workspaces</span>
          </div>
          <div className="flex flex-col gap-2">
            {treeIds.map((id) => (
              <HostTree key={id} hostId={id} showHeader={treeIds.length > 1} />
            ))}
          </div>
        </ScrollArea>
      )}
      </div>

      <div className={cn("flex items-center gap-1 border-t border-line p-2", collapsed ? "flex-col" : "justify-between")}>
        <Tooltip content={<ActionTip def={VIEWS.settings} />} shortcut={VIEWS.settings.shortcut} side={collapsed ? "right" : "top"}>
          <button
            type="button"
            onClick={() => navigate({ name: "settings" })}
            aria-current={settingsActive ? "page" : undefined}
            aria-label={VIEWS.settings.label}
            className={cn(
              "flex h-8 items-center gap-2 rounded-md text-xs font-bold transition-colors focus-ring",
              settingsActive ? "bg-white/7 text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)]" : "text-mute hover:bg-white/6 hover:text-ink",
              collapsed ? "w-9 justify-center" : "px-2",
            )}
          >
            <Settings2 className="size-4" />
            {!collapsed && <span>{VIEWS.settings.label}</span>}
          </button>
        </Tooltip>
        <IconButton label={collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"} size="sm" onClick={toggleSidebar}>
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </IconButton>
      </div>
      {!collapsed && !rail && <ResizeHandle width={width} onDragging={setDragging} />}
    </motion.aside>
    </div>
  );
}
