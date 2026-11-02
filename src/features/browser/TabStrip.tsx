import { Globe, Hand, MoreHorizontal, Plus, Undo2, Unplug, X } from "lucide-react";
import { Fragment, type MouseEvent as ReactMouseEvent, useEffect, useRef } from "react";
import { cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, IconButton, Spinner, Tooltip } from "@/design";
import { detachAgent, handBack, takeOver } from "./actions";
import { browserController } from "./controller";
import { groupTabActions, type TabGroup } from "./owners";
import { type Tab, tabLabel } from "./tabs";

interface TabStripProps {
  groups: TabGroup[];
  active: string | null;
  /** Host display names (shown with several hosts). */
  hostName(hostId: string): string | null;
  compact: boolean;
}

/**
 * The tabs, grouped by owner: the user's first, then each agent's in its colour with its name,
 * host and a live dot while it drives. A group's menu takes its tabs over, hands them back,
 * detaches the agent or closes its tabs.
 */
export function TabStrip({ groups, active, hostName, compact }: TabStripProps) {
  const ctl = browserController();
  const agents = groups.length > 1;
  return (
    // One flex row: every tab shrinks like Chrome's before the strip scrolls (an inactive one down to its icon, the shown one
    // to a readable width). A mouse wheel scrolls it sideways; the new-tab button stays at its right edge, where the shown
    // tab leaves room for it.
    <div role="tablist" aria-label="Browser tabs" onWheel={(e) => !e.deltaX && (e.currentTarget.scrollLeft += e.deltaY)} className="no-scrollbar scroll-pr-10 flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto px-2 pt-1.5">
      {groups.map((g, i) => (
        <Fragment key={g.key}>
          {i > 0 && <span aria-hidden className="w-1 shrink-0" />}
          {g.owner.kind === "agent" ? <AgentLabel group={g} hostName={g.hostId ? hostName(g.hostId) : null} compact={compact} /> : agents && <span className="kicker self-center pr-0.5 text-[10px] text-mute-2">You</span>}
          {g.tabs.map((t) => (
            <TabButton key={t.id} tab={t} group={g} active={t.id === active} compact={compact} onSelect={() => ctl.activate(t.id)} onClose={() => ctl.closeTab(t.id)} />
          ))}
          {g.owner.kind === "user" && (
            <IconButton label="New tab (Ctrl+T)" size="sm" className="sticky right-0 mb-0.5 shrink-0 bg-tile-1" onClick={() => void ctl.newTab()}>
              <Plus />
            </IconButton>
          )}
        </Fragment>
      ))}
    </div>
  );
}

function TabButton({ tab, group, active, compact, onSelect, onClose }: { tab: Tab; group: TabGroup; active: boolean; compact: boolean; onSelect(): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  // The shown tab stays in view (an agent's tab shown from its banner may sit past the strip's edge).
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  const owner = group.owners[tab.id] ?? group.owner;
  const label = tabLabel(tab);
  const detached = owner.kind === "agent" && owner.detached;
  const note = owner.kind !== "agent" ? "" : owner.detached ? `from ${owner.agentName} (detached)` : owner.takenOver ? "you took it over" : owner.lent ? `lent to ${owner.agentName}` : `the tab of ${owner.agentName}`;
  const onAux = (e: ReactMouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      onClose();
    }
  };
  return (
    <div
      ref={ref}
      className={cn(
        "group/tab @container/tab relative flex h-7.5 shrink items-center rounded-t-md text-xs font-semibold transition-colors",
        compact ? "basis-36" : "basis-48",
        active ? "min-w-28 bg-tile-3 text-ink shadow-[inset_0_1px_0_var(--color-line-2)]" : "min-w-10 text-mute hover:bg-ink/5 hover:text-ink-2",
      )}
      style={group.color ? { boxShadow: `inset 0 -2px 0 ${group.color}` } : undefined}
    >
      <button type="button" role="tab" aria-selected={active} title={[label, note, tab.url].filter(Boolean).join("\n")} onClick={onSelect} onAuxClick={onAux} className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pl-2.5 text-left outline-none focus-visible:underline @max-[80px]/tab:justify-center @max-[80px]/tab:pl-0">
        {tab.loading ? <Spinner size={14} /> : tab.favicon ? <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-[3px]" draggable={false} /> : <Globe className="size-3.5 shrink-0 text-mute-2" />}
        <span className={cn("min-w-0 truncate @max-[80px]/tab:hidden", detached && "italic")}>{tab.crashed ? `Crashed · ${label}` : label}</span>
        {owner.kind === "agent" && owner.takenOver && <Hand aria-label="You took it over" className="size-3 shrink-0 text-accent-hi" />}
      </button>
      <button
        type="button"
        aria-label={`Close ${label}`}
        title="Close tab"
        onClick={onClose}
        className={cn("mr-1 ml-1.5 grid size-5 shrink-0 place-items-center rounded-sm text-mute-2 hover:bg-ink/10 hover:text-ink @max-[80px]/tab:hidden", !active && "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100")}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function AgentLabel({ group, hostName, compact }: { group: TabGroup; hostName: string | null; compact: boolean }) {
  if (group.owner.kind !== "agent") return null;
  const { hostId, agentId, agentName } = group.owner;
  const acts = groupTabActions(group);
  const detached = !group.attached && acts.takeOver.length === 0 && acts.handBack.length === 0;
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));
  const state = detached ? "detached" : group.driving ? "driving now" : group.attached ? "can control its tabs" : "";
  return (
    <DropdownMenu>
      <Tooltip content={`${agentName}${hostName ? ` on ${hostName}` : ""}${state ? ` · ${state}` : ""}`}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="mb-0.5 flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-bold text-ink-2 hover:bg-ink/6 focus-ring"
            style={{ background: `color-mix(in srgb, ${group.color ?? "var(--color-mute)"} 16%, transparent)` }}
          >
            <span className="relative grid size-2 place-items-center">
              {group.driving && <span className="absolute inline-flex size-full animate-ping rounded-full opacity-70" style={{ background: group.color }} />}
              <span className="relative size-2 rounded-full" style={{ background: detached ? "var(--color-mute-2)" : group.color }} />
            </span>
            <span className={cn("truncate", detached && "text-mute line-through decoration-mute-2/60")}>{agentName}</span>
            {hostName && !compact && <span className="truncate font-semibold text-mute">· {hostName}</span>}
            <MoreHorizontal className="size-3 shrink-0 text-mute" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>
          {agentName}
          {hostName ? ` · ${hostName}` : ""}
          {detached ? " (detached)" : ""}
        </DropdownMenuLabel>
        {acts.takeOver.length > 0 && (
          <DropdownMenuItem icon={<Hand />} onSelect={() => acts.takeOver.forEach((id) => void takeOver(id))}>
            Take over {plural(acts.takeOver.length, "its tab", "its # tabs")}
          </DropdownMenuItem>
        )}
        {acts.handBack.length > 0 && (
          <DropdownMenuItem icon={<Hand />} onSelect={() => acts.handBack.forEach((id) => void handBack(id))}>
            Hand {plural(acts.handBack.length, "it", "them")} back to {agentName}
          </DropdownMenuItem>
        )}
        {acts.giveBack.length > 0 && (
          <DropdownMenuItem icon={<Undo2 />} onSelect={() => acts.giveBack.forEach((id) => void takeOver(id))}>
            Take back {plural(acts.giveBack.length, "the tab you lent it", "the # tabs you lent it")}
          </DropdownMenuItem>
        )}
        {group.attached && (
          <DropdownMenuItem icon={<Unplug />} onSelect={() => void detachAgent(hostId, agentId, agentName)}>
            Detach {agentName}
          </DropdownMenuItem>
        )}
        {acts.close.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<X />} danger onSelect={() => browserController().closeTabs(acts.close)}>
              Close {plural(acts.close.length, "its tab", "its # tabs")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
