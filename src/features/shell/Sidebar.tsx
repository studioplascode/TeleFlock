import {
  Activity,
  Archive,
  ArchiveRestore,
  BarChart3,
  Bot,
  ChevronRight,
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
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import {
  Badge,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  CountBadge,
  IconButton,
  ScrollArea,
  Shimmer,
  Sparkline,
  spring,
  type Status,
  StatusOrb,
  Tooltip,
  useMediaQuery,
} from "@/design";
import { core, navigate, type Route, useAgent, useAgentKeys, useHostIds, useHosts, useHostStale, useInbox, useRoute, useUi, useWorkspaces } from "@/core";
import { routeKey } from "@/app/routes";
import type { HerdrState, Workspace } from "@/core/gen";
import { connect } from "@/features/hosts/ConnStatusCard";
import { hostCall } from "@/features/palette/sessionCommands";
import { openNewAgent } from "@/features/workspace/NewAgentDialog";
import { WorkspaceActionsMenu } from "@/features/workspace/workspaceActions";
import { useHealthHistory } from "./healthHistory";
import { agentTier, COLUMN_SHORT, COLUMN_STATUS, connSummary, PHASE_STATUS } from "./status";
import { SIDEBAR_RAIL_QUERY, toggleSidebar, useSidebarPeek } from "./sidebarState";

const ROLLUP_STATUS: Record<HerdrState, Status> = {
  working: "running",
  blocked: "needs-you",
  idle: "idle",
  done: "review",
  unknown: "idle",
};

const EXPANDED_W = 264;
const COLLAPSED_W = 64;

interface NavDef {
  label: string;
  icon: LucideIcon;
  route: Route;
  match: Route["name"][];
  shortcut?: string;
}

const NAV: readonly NavDef[] = [
  { label: "Board", icon: LayoutDashboard, route: { name: "board" }, match: ["board"], shortcut: "Ctrl 1" },
  { label: "Inbox", icon: Inbox, route: { name: "inbox" }, match: ["inbox"], shortcut: "Ctrl 2" },
  { label: "Activity", icon: Activity, route: { name: "activity" }, match: ["activity"], shortcut: "Ctrl 3" },
  { label: "Usage", icon: BarChart3, route: { name: "usage" }, match: ["usage"], shortcut: "Ctrl 4" },
  { label: "Hosts", icon: Server, route: { name: "hosts" }, match: ["hosts"], shortcut: "Ctrl 5" },
  { label: "Settings", icon: Settings2, route: { name: "settings" }, match: ["settings"], shortcut: "Ctrl 6" },
];

function NavItem({ def, collapsed, active, badge }: { def: NavDef; collapsed: boolean; active: boolean; badge?: number }) {
  const Icon = def.icon;
  const body = (
    <button
      type="button"
      onClick={() => navigate(def.route)}
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
      {badge !== undefined && badge > 0 && (collapsed ? <span className="absolute top-1 right-2 size-2 rounded-full bg-sun-2 shadow-glow-sun" /> : <CountBadge count={badge} className="relative" />)}
    </button>
  );
  return collapsed ? (
    <Tooltip content={def.label} shortcut={def.shortcut} side="right">
      {body}
    </Tooltip>
  ) : (
    body
  );
}

function AgentRow({ agentKey: key, depth }: { agentKey: string; depth: number }) {
  const a = useAgent(key);
  const route = useRoute();
  const { setSplit, setAnswerNext } = useUi();
  if (!a) return null;
  const active = route.name === "agent" && route.hostId === a.hostId && route.agentId === a.id;
  const status = COLUMN_STATUS[a.column];
  const open = () => navigate({ name: "agent", hostId: a.hostId, agentId: a.id });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <motion.button
          layout="position"
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
            {COLUMN_SHORT[a.column]}
          </Badge>
        </motion.button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={<Bot />} onSelect={open}>
          Open session
        </ContextMenuItem>
        {a.column === "needs" && (
          <ContextMenuItem icon={<MessageSquareReply />} shortcut="Ctrl J" onSelect={() => setAnswerNext(true)}>
            Answer
          </ContextMenuItem>
        )}
        <ContextMenuItem icon={<SquareTerminal />} onSelect={() => navigate({ name: "terminal", hostId: a.hostId, agentId: a.id })}>
          Open terminal
        </ContextMenuItem>
        <ContextMenuItem icon={<Columns2 />} onSelect={() => setSplit({ kind: "session", key: a.key })}>
          Open beside
        </ContextMenuItem>
        <ContextMenuItem icon={<Columns2 />} onSelect={() => setSplit({ kind: "terminal", hostId: a.hostId, agentId: a.id })}>
          Terminal beside
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={a.archived ? <ArchiveRestore /> : <Archive />}
          onSelect={() => void hostCall(a.archived ? "Unarchived" : "Archived", core.host(a.hostId).call("agent.archive", { agentId: a.id, archived: !a.archived }))}
        >
          {a.archived ? "Unarchive" : "Archive"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function WorkspaceRow({ hostId, ws, nested }: { hostId: string; ws: Workspace; nested: boolean }) {
  const keys = useAgentKeys({ hostId, workspaceId: ws.id });
  const route = useRoute();
  const active = route.name === "review" && route.hostId === hostId && route.workspaceId === ws.id;
  const branch = ws.worktree?.branch ?? ws.repo?.branch ?? ws.label;
  const Icon = ws.worktree ? GitBranch : ws.repo ? FolderGit2 : FolderOpen;
  return (
    <li>
      <WorkspaceActionsMenu hostId={hostId} workspace={ws} mode="context">
        <button
          type="button"
          onClick={() => ws.repo && navigate({ name: "review", hostId, workspaceId: ws.id })}
          className={cn("flex h-7 w-full items-center gap-2 rounded-sm pr-1.5 text-left text-xs font-bold transition-colors focus-ring", active ? "bg-white/7 text-ink" : "text-mute hover:bg-white/4 hover:text-ink-2")}
          style={{ paddingLeft: nested ? 22 : 8 }}
          title={`${ws.label} · ${ws.cwd}`}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{branch}</span>
          {ws.repo?.dirty ? <span className="font-mono text-[10px] text-warn">●{ws.repo.dirty}</span> : null}
          <StatusOrb status={ROLLUP_STATUS[ws.rollup]} size={6} label={null} />
        </button>
      </WorkspaceActionsMenu>
      {keys.length > 0 && (
        <ul className="flex flex-col gap-px">
          {keys.map((k) => (
            <li key={k}>
              <AgentRow agentKey={k} depth={nested ? 2 : 1} />
            </li>
          ))}
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
          label={`New worktree in ${group.name}`}
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

function HostRow({ id, collapsed }: { id: string; collapsed: boolean }) {
  const profile = useHosts((h) => h.profiles.find((p) => p.id === id));
  const status = useHosts((h) => h.status[id]);
  const { filter, setFilter } = useHosts();
  if (!profile) return null;
  const phase = status?.phase ?? "idle";
  const selected = filter === id;
  const onClick = () => {
    if (phase !== "online") void connect(id);
    else setFilter(selected ? "all" : id);
  };
  const orb = <StatusOrb status={PHASE_STATUS[phase]} size={9} label={null} />;
  if (collapsed) {
    return (
      <Tooltip content={`${profile.name} · ${connSummary(status)}`} side="right">
        <button type="button" onClick={onClick} className={cn("grid size-9 place-items-center rounded-md focus-ring hover:bg-white/5", selected && "bg-white/7")} aria-label={`${profile.name}: ${connSummary(status)}`}>
          {orb}
        </button>
      </Tooltip>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn("flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors focus-ring", selected ? "bg-white/7 shadow-[inset_0_0_0_1px_var(--color-line-2)]" : "hover:bg-white/4")}
      title={phase === "online" ? (selected ? "Show all hosts" : `Show only ${profile.name}`) : `Connect ${profile.name}`}
    >
      {orb}
      <span className="h-3.5 w-1 shrink-0 rounded-full" style={{ background: profile.color ?? "transparent" }} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-bold text-ink-2">{profile.name}</span>
      <span className={cn("font-mono text-2xs tabular", phase === "online" ? "text-mute" : phase === "authRequired" || phase === "hostKey" ? "text-sun-2" : "text-mute-2")}>{connSummary(status)}</span>
    </button>
  );
}

function QuickAction({ icon: Icon, label, onClick, collapsed }: { icon: LucideIcon; label: string; onClick: () => void; collapsed: boolean }) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-md text-xs font-bold text-mute transition-colors pressable focus-ring hover:bg-white/6 hover:text-ink",
        collapsed ? "size-9 justify-center" : "h-8 px-2",
      )}
      aria-label={label}
    >
      <Icon className="size-3.5 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  );
  return collapsed ? (
    <Tooltip content={label} side="right">
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}

function HealthMini({ hostId }: { hostId: string }) {
  const { health, cpu } = useHealthHistory(hostId);
  const name = useHosts((h) => h.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  if (!health) return null;
  const mem = health.memTotal ? Math.round((health.memUsed / health.memTotal) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-2xs" title={`${name}: CPU ${Math.round(health.cpuPct)}% · RAM ${mem}% · load ${health.load1.toFixed(2)}`}>
      <span className="w-14 truncate font-bold text-mute">{name}</span>
      <Sparkline values={cpu.length > 1 ? cpu : [health.cpuPct, health.cpuPct]} height={16} status="running" live={false} className="min-w-0 flex-1" aria-label={`${name} CPU`} />
      <span className="w-8 text-right font-mono text-mute-2 tabular">{Math.round(health.cpuPct)}%</span>
      <span className="relative h-1 w-8 overflow-hidden rounded-full bg-white/8" aria-hidden>
        <motion.span className="absolute inset-y-0 left-0 rounded-full bg-review" animate={{ width: `${mem}%` }} transition={spring.gentle} />
      </span>
    </div>
  );
}

/** Collapsible desktop sidebar: views, hosts, live workspace tree, quick actions, host health. */
export function Sidebar() {
  const { sidebarCollapsed, openDialog } = useUi();
  const rail = useMediaQuery(SIDEBAR_RAIL_QUERY);
  const peek = useSidebarPeek((s) => s.open);
  const setPeek = useSidebarPeek((s) => s.set);
  const collapsed = rail ? !peek : sidebarCollapsed;
  const overlay = rail && peek;
  const route = useRoute();
  const ids = useHostIds();
  const { filter, status } = useHosts();
  const needs = useInbox().length;
  const onlineIds = ids.filter((id) => status[id]?.phase === "online" || status[id]?.phase === "reconnecting");
  const treeIds = filter === "all" ? ids : ids.filter((id) => id === filter);
  const host = filter === "all" ? onlineIds[0] : filter;

  // The peek overlay closes on navigation, Escape, or when the window grows out of rail mode.
  const routeId = routeKey(route);
  useEffect(() => setPeek(false), [routeId, rail, setPeek]);
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPeek(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, setPeek]);

  const actions: { icon: LucideIcon; label: string; run: () => void }[] = [
    { icon: GitBranchPlus, label: "New worktree", run: () => openDialog({ kind: "newWorktree", hostId: host }) },
    { icon: Bot, label: "New agent", run: () => openDialog({ kind: "newAgent", hostId: host }) },
    { icon: GitFork, label: "Fan out…", run: () => openDialog({ kind: "fanOut", hostId: host }) },
    { icon: FolderOpen, label: "Open folder", run: () => openNewAgent({ hostId: host, openFolder: true }) },
    { icon: History, label: "Past sessions", run: () => openDialog({ kind: "pastSessions", hostId: host }) },
  ];

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
      animate={{ width: collapsed ? COLLAPSED_W : EXPANDED_W }}
      transition={spring.smooth}
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-hidden border-r border-line bg-[rgb(13_13_19/0.55)] backdrop-blur-xl",
        rail && "absolute inset-y-0 left-0",
        overlay && "bg-[rgb(15_15_22/0.94)] shadow-[var(--shadow-d3),1px_0_0_var(--color-line-2)]",
      )}
      aria-label="Sidebar"
    >
      <div className={cn("flex flex-col gap-0.5 p-2", collapsed && "items-center")}>
        {NAV.map((d) => (
          <NavItem key={d.label} def={d} collapsed={collapsed} active={d.match.includes(route.name)} badge={d.route.name === "inbox" ? needs : undefined} />
        ))}
      </div>

      <div className={cn("border-t border-line px-2 py-2", collapsed && "flex flex-col items-center")}>
        {!collapsed && (
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="kicker">Hosts</span>
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
        <ScrollArea className="min-h-0 flex-1 border-t border-line" viewportClassName="px-2 py-2" fade>
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

      <div className={cn("grid gap-0.5 border-t border-line p-2", collapsed ? "grid-cols-1 justify-items-center" : "grid-cols-2 [&>*:last-child:nth-child(odd)]:col-span-2")}>
        {actions.map((a) => (
          <QuickAction key={a.label} icon={a.icon} label={a.label} onClick={a.run} collapsed={collapsed} />
        ))}
      </div>

      {!collapsed && onlineIds.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-line px-3 py-2.5">
          {onlineIds.map((id) => (
            <HealthMini key={id} hostId={id} />
          ))}
        </div>
      )}

      <div className={cn("flex border-t border-line p-2", collapsed ? "justify-center" : "justify-end")}>
        <IconButton label={collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"} size="sm" onClick={toggleSidebar}>
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </IconButton>
      </div>
    </motion.aside>
    </div>
  );
}
