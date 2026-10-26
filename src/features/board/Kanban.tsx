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
import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { navigate, useAgent, useUi } from "@/core";
import type { Column } from "@/core/gen";
import { AnimatePresence, CardFlight, CountBadge, EmptyState, LayoutGroup, NumberTicker, StatusOrb, cn, spring, toast, useCalmMotion, z } from "@/design";
import { ACTIONS } from "@/features/shell/vocab";
import { AgentCard } from "./AgentCard";
import { archiveWithUndo, openAgent, setArchived } from "./agentActions";
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
      description: from === "running" ? "Stop it or let it finish; finished agents move to Review by themselves." : "Answer its question first; then you can review it and mark it done.",
    };
  return null;
}

/**
 * Clears an optimistic lane override once the host state agrees (or after a grace period), or once
 * the agent is gone (a parked agent dropped back into Review resumes under a new id).
 */
function MoveWatcher({ agentKey, target }: { agentKey: string; target: Column }) {
  const column = useAgent(agentKey)?.column;
  const setMove = useBoard((s) => s.setMove);
  useEffect(() => {
    if (column === target || column === undefined) setMove(agentKey, null);
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

/** Card click: Ctrl/⌘ toggles the multi-selection, Shift extends it, a plain click opens (or toggles while selecting). */
export function onCardClick(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, agentKey: string): void {
  const board = useBoard.getState();
  useUi.getState().select(agentKey);
  if (e.shiftKey) board.pickRange(agentKey);
  else if (e.ctrlKey || e.metaKey || board.picked.length > 0) board.togglePick(agentKey);
  else openAgent(agentKey);
}

function DraggableCard({ agentKey, lane, selected, hero }: { agentKey: string; lane: Column; selected: boolean; hero: boolean }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: agentKey, data: { lane } });
  const picked = useBoard((s) => s.picked.includes(agentKey));
  return (
    <CardFlight flightId={agentKey} grounded={isDragging} className={cn("relative", isDragging && "opacity-30")}>
      <div
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        role="button"
        tabIndex={-1}
        aria-roledescription="Agent card. Drag between Review and Done to mark it done or reopen it."
        aria-pressed={picked}
        data-agent-key={agentKey}
        onClick={(e) => onCardClick(e, agentKey)}
        onMouseDown={(e) => {
          // Shift-click must not start a text selection across cards
          if (e.shiftKey) e.preventDefault();
        }}
        className="cursor-pointer touch-manipulation rounded-xl outline-none active:cursor-grabbing"
      >
        <AgentCard agentKey={agentKey} lane={lane} selected={selected} picked={picked} hero={hero} />
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
  const q = useBoard((s) => s.q);
  // the floating selection bar covers the lane bottoms: leave room (its live height, published by SelectionBar)
  // to scroll the last card above it
  const selecting = useBoard((s) => s.picked.length > 0);
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
        {meta.column === "needs" ? (
          // the lane is the board's answer list; its header leads to the full Inbox (agent said, option details)
          <button
            type="button"
            onClick={() => navigate({ name: "inbox" })}
            title="Open the Inbox"
            className="group/needs -mx-1 flex shrink-0 items-center gap-2 rounded-sm px-1 focus-ring hover:bg-white/6"
          >
            <h3 className="font-display text-sm font-bold text-ink">{meta.title}</h3>
            {keys.length > 0 ? <CountBadge count={keys.length} /> : <NumberTicker value={0} className="rounded-full bg-white/6 px-1.5 text-2xs font-bold text-mute" />}
            <ArrowRight className="size-3.5 text-mute transition-transform group-hover/needs:translate-x-0.5 group-hover/needs:text-ink" aria-hidden />
          </button>
        ) : (
          <>
            <h3 className="font-display text-sm font-bold text-ink">{meta.title}</h3>
            <NumberTicker value={keys.length} className="rounded-full bg-white/6 px-1.5 text-2xs font-bold text-mute" />
          </>
        )}
        <span className="ml-auto min-w-0 truncate text-2xs font-semibold text-mute-2" title={meta.legend}>
          {meta.legend}
        </span>
      </header>
      {refused && isOver && (
        <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mx-3 mb-2 rounded-md bg-error/10 px-3 py-2 text-2xs font-semibold text-[#ff9fb2]">
          {refused.title}
        </motion.p>
      )}
      {/* -mt/pt pair: headroom so a lifted (selected) card and its check badge aren't clipped by the scroller;
          the edge fades soften glows cut by the scroll box, and the bottom radius matches the lane's so a card
          scrolled past the end is clipped inside the rounded lane, not through its corners.
          Very wide lanes (ultrawide) flow cards in two columns. */}
      <motion.div
        layoutScroll
        className={cn(
          "no-scrollbar -mt-3 grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] content-start items-start gap-2.5 overflow-y-auto rounded-b-tile px-2.5 pt-3 pb-3 [mask-image:linear-gradient(to_bottom,transparent,#000_8px,#000_calc(100%-14px),transparent)]",
          selecting && "pb-[calc(var(--tf-selbar-h,48px)+24px)]",
        )}
      >
        <AnimatePresence initial={false}>
          {accepting && (
            <motion.div
              key="drop-slot"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 64 }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring.snappy}
              className={cn(
                "col-span-full grid shrink-0 place-items-center rounded-xl border-[1.5px] border-dashed text-2xs font-bold transition-colors",
                isOver ? "border-[rgb(var(--st-rgb)/0.9)] bg-[rgb(var(--st-rgb)/0.12)] st-text" : "border-[rgb(var(--st-rgb)/0.35)] text-mute",
              )}
            >
              {meta.column === "done" ? `Drop to ${ACTIONS.markDone.label.toLowerCase()}` : "Drop to reopen for review"}
            </motion.div>
          )}
        </AnimatePresence>
        {keys.map((k, i) => (
          // the oldest question leads the board with the sunset treatment (it replaces the old hero tile)
          <DraggableCard key={k} agentKey={k} lane={meta.column} selected={k === selectedKey} hero={meta.column === "needs" && i === 0} />
        ))}
        {keys.length === 0 &&
          (q.trim() ? (
            <EmptyState compact title="No matches" description={`Nothing in ${meta.title} matches “${q.trim()}”.`} className="col-span-full my-6" />
          ) : (
            <EmptyState compact title={meta.empty.title} description={meta.empty.description} className="col-span-full my-6" />
          ))}
        {meta.column === "done" && (
          // the other homes of "finished": the activity log and closed panes
          <p className="col-span-full flex flex-wrap justify-center gap-x-3 gap-y-1 pt-1 text-2xs font-semibold text-mute-2">
            <button type="button" className="rounded-xs focus-ring hover:text-ink hover:underline" onClick={() => navigate({ name: "activity" })}>
              Older → Activity
            </button>
            <button type="button" className="rounded-xs focus-ring hover:text-ink hover:underline" onClick={() => useUi.getState().openDialog({ kind: "pastSessions" })}>
              Closed panes → {ACTIONS.pastSessions.label}
            </button>
          </p>
        )}
      </motion.div>
    </section>
  );
}

/** Four status lanes with card flights and Review ↔ Done drag to mark done / reopen. */
export function Kanban({ lanes, selectedKey }: { lanes: LaneKeys; selectedKey: string | null }) {
  const moves = useBoard((s) => s.moves);
  const setMove = useBoard((s) => s.setMove);
  const calm = useCalmMotion();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [drag, setDrag] = useState<{ key: string; from: Column } | null>(null);
  const [dropOk, setDropOk] = useState(false);
  const dragAgent = useAgent(drag?.key ?? "");
  const view = applyMoves(lanes, moves);
  // Whole-document grabbing cursor while a card is in flight (lanes and cards underneath would show their own).
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.dataset.dragging = "";
    return () => {
      delete document.documentElement.dataset.dragging;
    };
  }, [dragging]);

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
    if (to === "done") void archiveWithUndo([key]).then((done) => done.length === 0 && setMove(key, null));
    else setArchived(key, false).catch(() => setMove(key, null));
  };

  return (
    <DndContext sensors={sensors} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => setDrag(null)}>
      <LayoutGroup id="board">
        {/* Bleeds into the board padding so a narrow window scrolls lanes edge to edge instead of clipping them short. */}
        <div className="-mx-4 grid min-h-0 flex-1 snap-x scroll-px-4 grid-cols-[repeat(4,minmax(216px,1fr))] gap-3 overflow-x-auto overscroll-x-contain px-4 short:-mx-3 short:scroll-px-3 short:px-3 [&>section]:snap-start">
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
      {/* Portalled: any transformed/filtered ancestor would offset the fixed-position overlay. */}
      {createPortal(
        <DragOverlay zIndex={z.drag} dropAnimation={dropOk || calm ? null : { ...defaultDropAnimation, duration: 420, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" }}>
          {drag && (
            <motion.div initial={{ scale: 1, rotate: 0 }} animate={{ scale: 1.03, rotate: -1.5 }} className="cursor-grabbing">
              <AgentCard agentKey={drag.key} lane={drag.from} floating />
            </motion.div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
