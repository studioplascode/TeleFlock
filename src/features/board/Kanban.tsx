import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  defaultDropAnimation,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { useAgent, useUi } from "@/core";
import type { Column } from "@/core/gen";
import { CardFlight, CountBadge, EmptyState, LayoutGroup, StatusOrb, cn, toast, useCalmMotion } from "@/design";
import { AgentCard } from "./AgentCard";
import { openAgent, setArchived } from "./agentActions";
import { useBoard } from "./boardStore";
import { LANES, LANE_BY_COLUMN, type LaneMeta } from "./lanes";

export type LaneKeys = Record<Column, string[]>;

const ARCHIVE_LANES: readonly Column[] = ["review", "done"];

/** Why a drop from `from` into `to` is refused, or null when it's an archive move. */
function refusal(from: Column, to: Column, name: string): { title: string; description: string } | null {
  if (from === to) return null;
  if (LANE_BY_COLUMN[to].live)
    return {
      title: `${LANE_BY_COLUMN[to].title} follows live state`,
      description: `Cards land in ${LANE_BY_COLUMN[to].title} on their own when the agent ${to === "running" ? "starts working" : "asks you something"}. Prompt ${name} from its session to put it back to work.`,
    };
  if (LANE_BY_COLUMN[from].live)
    return {
      title: `${name} is still ${from === "running" ? "working" : "waiting on you"}`,
      description: from === "running" ? "Stop it or let it finish; finished agents move to In review by themselves." : "Answer its question first; then you can review and archive it.",
    };
  return null;
}

/** Clears an optimistic lane override once the host state agrees (or after a grace period). */
function MoveWatcher({ agentKey, target }: { agentKey: string; target: Column }) {
  const column = useAgent(agentKey)?.column;
  const setMove = useBoard((s) => s.setMove);
  useEffect(() => {
    if (column === target) setMove(agentKey, null);
  }, [column, target, agentKey, setMove]);
  useEffect(() => {
    const t = window.setTimeout(() => setMove(agentKey, null), 6000);
    return () => clearTimeout(t);
  }, [agentKey, setMove]);
  return null;
}

/** Lane contents after applying optimistic moves. */
export function applyMoves(lanes: LaneKeys, moves: Record<string, Column>): LaneKeys {
  const keys = Object.keys(moves);
  if (keys.length === 0) return lanes;
  const out = {} as LaneKeys;
  for (const lane of LANES) {
    const own = lanes[lane.column].filter((k) => !(k in moves) || moves[k] === lane.column);
    const incoming = keys.filter((k) => moves[k] === lane.column && !own.includes(k));
    out[lane.column] = [...incoming, ...own];
  }
  return out;
}

function DraggableCard({ agentKey, lane, selected }: { agentKey: string; lane: Column; selected: boolean }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: agentKey, data: { lane } });
  const select = useUi((s) => s.select);
  return (
    <CardFlight flightId={agentKey} grounded={isDragging} className={cn("relative", isDragging && "opacity-30")}>
      <div
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        role="button"
        tabIndex={-1}
        aria-roledescription="Agent card. Drag between In review and Done to archive."
        data-agent-key={agentKey}
        onClick={() => {
          select(agentKey);
          openAgent(agentKey);
        }}
        className="cursor-pointer touch-manipulation rounded-xl outline-none"
      >
        <AgentCard agentKey={agentKey} lane={lane} selected={selected} />
      </div>
    </CardFlight>
  );
}

function Lane({
  meta,
  keys,
  selectedKey,
  dragFrom,
  dragName,
}: {
  meta: LaneMeta;
  keys: string[];
  selectedKey: string | null;
  dragFrom: Column | null;
  dragName: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: meta.column });
  const refused = dragFrom !== null && dragFrom !== meta.column ? refusal(dragFrom, meta.column, dragName) : null;
  const accepting = dragFrom !== null && dragFrom !== meta.column && !refused;
  return (
    <section
      ref={setNodeRef}
      data-status={meta.status}
      aria-label={`${meta.title}, ${keys.length} agents`}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col rounded-tile bg-white/[0.018] shadow-hairline transition-[box-shadow,background-color] duration-300",
        accepting && "bg-[rgb(var(--st-rgb)/0.05)] shadow-[inset_0_0_0_1.5px_rgb(var(--st-rgb)/0.35)]",
        accepting && isOver && "bg-[rgb(var(--st-rgb)/0.1)] shadow-[inset_0_0_0_2px_rgb(var(--st-rgb)/0.7),0_0_40px_-10px_rgb(var(--st-rgb)/0.6)]",
        refused && isOver && "shadow-[inset_0_0_0_1.5px_rgb(255_77_94/0.5)]",
      )}
    >
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
        <StatusOrb status={meta.status} size={8} label={null} activity={keys.length > 2 ? "busy" : "steady"} />
        <h3 className="font-display text-sm font-bold text-ink">{meta.title}</h3>
        {meta.column === "needs" && keys.length > 0 ? (
          <CountBadge count={keys.length} />
        ) : (
          <span className="rounded-full bg-white/6 px-1.5 text-2xs font-bold text-mute tabular">{keys.length}</span>
        )}
        <span className="ml-auto text-2xs font-semibold text-mute-2">{meta.hint}</span>
      </header>
      {refused && isOver && (
        <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mx-3 mb-2 rounded-md bg-error/10 px-3 py-2 text-2xs font-semibold text-[#ff9fb2]">
          {refused.title}
        </motion.p>
      )}
      <motion.div layoutScroll className="no-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-2.5 pb-3">
        {keys.map((k) => (
          <DraggableCard key={k} agentKey={k} lane={meta.column} selected={k === selectedKey} />
        ))}
        {keys.length === 0 && <EmptyState compact title={meta.empty.title} description={meta.empty.description} className="my-6" />}
      </motion.div>
    </section>
  );
}

/** Four status lanes with card flights and Review ↔ Done drag-to-archive. */
export function Kanban({ lanes, selectedKey }: { lanes: LaneKeys; selectedKey: string | null }) {
  const moves = useBoard((s) => s.moves);
  const setMove = useBoard((s) => s.setMove);
  const calm = useCalmMotion();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [drag, setDrag] = useState<{ key: string; from: Column } | null>(null);
  const [dropOk, setDropOk] = useState(false);
  const dragAgent = useAgent(drag?.key ?? "");
  const view = applyMoves(lanes, moves);

  const onStart = (e: DragStartEvent) => {
    const from = e.active.data.current?.lane as Column | undefined;
    if (from) setDrag({ key: String(e.active.id), from });
    setDropOk(false);
  };
  const onOver = (e: DragOverEvent) => {
    const to = e.over?.id as Column | undefined;
    setDropOk(!!drag && !!to && to !== drag.from && ARCHIVE_LANES.includes(to) && ARCHIVE_LANES.includes(drag.from));
  };
  const onEnd = (e: DragEndEvent) => {
    const current = drag;
    setDrag(null);
    const to = e.over?.id as Column | undefined;
    if (!current || !to || to === current.from) return;
    const name = dragAgent?.name ?? "This agent";
    const why = refusal(current.from, to, name);
    if (why) {
      toast({ title: why.title, description: why.description, status: LANE_BY_COLUMN[to].live ? LANE_BY_COLUMN[to].status : "idle" });
      return;
    }
    const key = current.key;
    setMove(key, to);
    setArchived(key, to === "done").catch(() => setMove(key, null));
  };

  return (
    <DndContext sensors={sensors} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => setDrag(null)}>
      <LayoutGroup id="board">
        <div className="grid min-h-0 flex-1 grid-cols-4 gap-3">
          {LANES.map((meta) => (
            <Lane
              key={meta.column}
              meta={meta}
              keys={view[meta.column]}
              selectedKey={selectedKey}
              dragFrom={drag?.from ?? null}
              dragName={dragAgent?.name ?? "This agent"}
            />
          ))}
        </div>
      </LayoutGroup>
      {Object.entries(moves).map(([k, target]) => (
        <MoveWatcher key={k} agentKey={k} target={target} />
      ))}
      <DragOverlay dropAnimation={dropOk || calm ? null : { ...defaultDropAnimation, duration: 420, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" }}>
        {drag && (
          <motion.div initial={{ scale: 1, rotate: 0 }} animate={{ scale: 1.03, rotate: -1.5 }} className="cursor-grabbing">
            <AgentCard agentKey={drag.key} lane={drag.from} floating />
          </motion.div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
