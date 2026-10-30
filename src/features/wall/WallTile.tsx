import { ArrowLeft, ArrowRight, Check, Ellipsis, EyeOff, GripVertical, Maximize2, Pin, PinOff, Plus, Reply, Replace, SquareTerminal, Square } from "lucide-react";
import { type DragEvent, lazy, Suspense, useEffect, useState } from "react";
import { parseAgentKey, useAgent, useCore, useHostStale, useHosts, useSuccessor } from "@/core";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  formatAge,
  IconButton,
  Spinner,
  Tooltip,
  useNow,
  useWindowVisible,
} from "@/design";
import { archiveWithUndo, openAgent, openTerminal, stopAgent } from "@/features/board/agentActions";
import { HostTag } from "@/features/board/AgentCard";
import { AgentOrb, useQuiet } from "@/features/board/LiveBits";
import { retryOf } from "@/features/board/retry";
import { RepoTag } from "@/features/board/RepoTag";
import { SessionPane } from "@/features/session/SessionPane";
import { useSessionUi } from "@/features/session/state";
import { COLUMN_STATUS } from "@/features/shell/status";
import { ACTIONS, type AgentStateId, agentStateId, agentStateWord, stateTime } from "@/features/shell/vocab";
import { AgentPicker } from "./AgentPicker";
import { isPinned, useWall } from "./store";

const TerminalPane = lazy(() => import("@/features/terminal/TerminalPane").then((m) => ({ default: m.TerminalPane })));

/** Drag payload: the index of the tile being moved (internal to the wall, never a file). */
const TILE_MIME = "application/x-teleflock-wall-tile";

/**
 * A non-omp agent (Claude Code, Codex, …) has no transcript: its tile watches the real terminal
 * like the board's live tile (observe mode: the pane keeps its size and its driver's input; DOM
 * renderer, so nine tiles never hold nine WebGL contexts). Terminal (⋯) opens it to type.
 */
function TileTerminal({ agentKey }: { agentKey: string }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  return (
    <div className="relative m-2 min-h-0 flex-1 overflow-hidden rounded-[20px] bg-bg-deep shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
      <Suspense fallback={<div className="grid h-full place-items-center"><Spinner size={18} /></div>}>
        <TerminalPane hostId={hostId} target={{ kind: "agent", agentId }} mode="observe" compact className="absolute inset-0" />
      </Suspense>
    </div>
  );
}

/** The state's time with its verb ("turn 4:07", "waiting 0:41"); ticks only while it changes by the second. */
function TileTime({ hostId, state, since, stale }: { hostId: string; state: AgentStateId; since: number | undefined; stale: boolean }) {
  const lastOnlineAt = useHosts((s) => s.status[hostId]?.lastOnlineAt);
  const now = useNow(!stale && (state === "running" || state === "needs") ? 1000 : 30_000);
  const text = stale ? `last seen ${lastOnlineAt ? formatAge(now - lastOnlineAt) : "—"}` : stateTime(state, since, now);
  return <span className="shrink-0 text-2xs font-bold text-mute tabular">{text}</span>;
}

function TileMenu({ index, agentKey, pinned, size, onReply }: { index: number; agentKey: string; pinned: boolean; size: number; onReply: () => void }) {
  const agent = useAgent(agentKey);
  if (!agent) return null;
  const wall = useWall.getState;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={`Tile actions for ${agent.name}`} size="sm">
          <Ellipsis />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          Tile {index + 1} · {agent.name}
        </DropdownMenuLabel>
        {agent.omp != null && (
          <DropdownMenuItem icon={<Reply />} onSelect={onReply}>
            Reply
          </DropdownMenuItem>
        )}
        {agent.column === "running" && (
          <DropdownMenuItem icon={<Square />} onSelect={() => void stopAgent(agentKey)}>
            {ACTIONS.stopTurn.label}
          </DropdownMenuItem>
        )}
        {agent.column === "review" && (
          <DropdownMenuItem icon={<Check />} onSelect={() => void archiveWithUndo([agentKey])}>
            {ACTIONS.markDone.label}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem icon={<Maximize2 />} onSelect={() => openAgent(agentKey)}>
          Open full view
        </DropdownMenuItem>
        <DropdownMenuItem icon={<SquareTerminal />} onSelect={() => openTerminal(agentKey, false)}>
          {ACTIONS.terminal.label}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {pinned ? (
          <DropdownMenuItem icon={<PinOff />} onSelect={() => wall().unpin(index)}>
            Unpin (fill automatically)
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem icon={<Pin />} onSelect={() => wall().place(index, agentKey)}>
            Pin to this tile
          </DropdownMenuItem>
        )}
        <DropdownMenuItem icon={<ArrowLeft />} disabled={index === 0} onSelect={() => wall().swap(index, index - 1)}>
          Move to tile {index}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<ArrowRight />} disabled={index >= size - 1} onSelect={() => wall().swap(index, index + 1)}>
          Move to tile {index + 2}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<EyeOff />} onSelect={() => wall().remove(index)}>
          Remove from the wall
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TileHeader({ index, agentKey, pinned, size, onReply }: { index: number; agentKey: string; pinned: boolean; size: number; onReply: () => void }) {
  const agent = useAgent(agentKey);
  const stale = useHostStale(agent?.hostId ?? "");
  const multiHost = useHosts((s) => s.profiles.length > 1);
  const quiet = useQuiet(agent?.column === "running" && !stale && !retryOf(agent), agent?.live.lastEventAt);
  if (!agent) return null;
  const state = agentStateId(agent);
  const status = state === "fresh" ? "idle" : COLUMN_STATUS[agent.column];
  const since = state === "needs" ? agent.needs?.since : state === "running" ? (agent.omp?.turnStartedAt ?? agent.stateSince) : agent.stateSince;
  return (
    <header
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TILE_MIME, String(index));
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn("flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-line pr-1.5 pl-1 active:cursor-grabbing", stale && "grayscale-[0.6]")}
    >
      <GripVertical className="size-3.5 shrink-0 text-mute-2" aria-hidden />
      <AgentOrb agentKey={agentKey} status={status} tool={stale ? undefined : agent.live.tool} quiet={quiet} size={8} />
      <AgentPicker index={index}>
        <button type="button" className="min-w-0 shrink truncate rounded-xs text-left text-sm font-extrabold text-ink focus-ring hover:text-accent-hi" title={`${agent.title || agent.name} — click to show another agent here`}>
          {agent.name}
        </button>
      </AgentPicker>
      <span data-status={status} className={cn("shrink-0 rounded-full px-2 py-0.5 font-display text-[9.5px] font-bold tracking-[0.12em] uppercase", state === "needs" ? "st-bg" : state === "fresh" ? "bg-white/6 text-mute" : "st-soft")}>
        {agentStateWord(agent)}
        {state === "running" && agent.live.tool && !stale && <span className="normal-case tracking-normal"> · {agent.live.tool.name}</span>}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {multiHost && <HostTag hostId={agent.hostId} />}
        <RepoTag hostId={agent.hostId} repo={agent.repo} branch={agent.branch} cwd={agent.cwd} className="min-w-0" />
      </span>
      <TileTime hostId={agent.hostId} state={state} since={since} stale={stale} />
      {pinned && (
        <Tooltip content="Pinned to this tile">
          <Pin className="size-3.5 shrink-0 fill-current text-accent-hi" aria-label="Pinned" />
        </Tooltip>
      )}
      <Tooltip content="Open full view">
        <IconButton label="Open full view" size="sm" onClick={() => openAgent(agentKey)}>
          <Maximize2 />
        </IconButton>
      </Tooltip>
      <TileMenu index={index} agentKey={agentKey} pinned={pinned} size={size} onReply={onReply} />
    </header>
  );
}

function EmptyTile({ index, auto }: { index: number; auto: boolean }) {
  return (
    <div className="grid flex-1 place-items-center p-4 text-center">
      <div className="flex max-w-64 flex-col items-center gap-3">
        <p className="text-sm text-mute">{auto ? "Nothing else is waiting, running or ready for review." : `Tile ${index + 1} is empty.`}</p>
        <AgentPicker index={index}>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-tile-4 px-3 text-xs font-bold text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] pressable focus-ring hover:bg-tile-5"
          >
            <Plus className="size-3.5" aria-hidden />
            Pick an agent
          </button>
        </AgentPicker>
      </div>
    </div>
  );
}

export interface WallTileProps {
  index: number;
  /** The agent shown, or null for an empty tile. */
  agentKey: string | null;
  size: number;
  /** The active tile shows its composer (one at a time; the others show transcript and questions). */
  active: boolean;
  onActivate: (index: number) => void;
}

/**
 * One tile: a compact header (state, name, repo, time; drag it onto another tile to trade places,
 * click the name to show another agent) over the agent's live transcript. Questions and approvals
 * are answered right in the tile; the active tile also has the composer.
 */
export function WallTile({ index, agentKey, size, active, onActivate }: WallTileProps) {
  const pinned = useWall((s) => isPinned(s, index));
  const auto = useWall((s) => s.auto);
  // narrow selectors: the tile itself re-renders on a lane change, not with every streamed token
  const status = useCore((s) => (agentKey ? s.agents[agentKey]?.column : undefined));
  const terminal = useCore((s) => {
    const a = agentKey ? s.agents[agentKey] : undefined;
    return a !== undefined && a.omp == null;
  });
  const successor = useSuccessor(agentKey ?? "");
  // While the window is hidden (minimized, another tab) the transcripts let go of their sessions.
  const visible = useWindowVisible();
  const [dropping, setDropping] = useState(false);

  // A parked agent resumed under a new id while the wall wasn't watching: follow it.
  useEffect(() => {
    if (agentKey && successor) useWall.getState().rename(agentKey, successor);
  }, [agentKey, successor]);

  const reply = () => {
    onActivate(index);
    if (agentKey) useSessionUi.getState().focusComposer(agentKey);
  };
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(TILE_MIME);

  return (
    <section
      aria-label={`Tile ${index + 1}`}
      data-status={status === "needs" ? "needs-you" : undefined}
      onPointerDownCapture={() => onActivate(index)}
      onFocusCapture={() => onActivate(index)}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        if (!accepts(e)) return;
        e.preventDefault();
        const from = Number(e.dataTransfer.getData(TILE_MIME));
        if (Number.isInteger(from)) useWall.getState().swap(from, index);
      }}
      className={cn(
        "glass relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-tile shadow-[inset_0_0_0_1px_var(--color-line)]",
        status === "needs" && "shadow-[inset_0_0_0_1.5px_rgb(var(--st-rgb)/0.55)]",
        active && "shadow-[inset_0_0_0_1.5px_rgb(163_92_240/0.7)]",
        dropping && "shadow-[inset_0_0_0_2px_rgb(163_92_240/0.95)]",
      )}
    >
      {agentKey ? (
        <>
          <TileHeader index={index} agentKey={agentKey} pinned={pinned} size={size} onReply={reply} />
          <div className="flex min-h-0 flex-1 flex-col">
            {!visible ? (
              <div className="grid flex-1 place-items-center text-xs text-mute-2">Paused while the window is hidden</div>
            ) : !terminal ? (
              <SessionPane key={agentKey} agentKey={agentKey} compact header={false} composer={active} bloom={false} />
            ) : (
              <TileTerminal key={agentKey} agentKey={agentKey} />
            )}
          </div>
        </>
      ) : (
        <EmptyTile index={index} auto={auto} />
      )}
      {dropping && <Replace className="pointer-events-none absolute top-1/2 left-1/2 size-8 -translate-1/2 text-accent-hi" aria-hidden />}
    </section>
  );
}
