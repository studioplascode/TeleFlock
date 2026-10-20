import { Maximize2, SquareTerminal, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { lazy, type PointerEvent as ReactPointerEvent, type ReactNode, Suspense, useRef, useState } from "react";
import { cn, IconButton, Spinner, spring, StatusOrb, Tooltip } from "@/design";
import { agentKey, navigate, parseAgentKey, type SplitState, useAgent, useHosts, useUi } from "@/core";
import type { TermTarget } from "@/core/gen";
import { COLUMN_STATUS } from "./status";

const TerminalPane = lazy(() => import("@/features/terminal/TerminalPane").then((m) => ({ default: m.TerminalPane })));
const SessionPane = lazy(() => import("@/features/session/SessionPane").then((m) => ({ default: m.SessionPane })));

const RATIO_KEY = "tf.splitRatio";
const MIN = 0.28;
const MAX = 0.72;

function readRatio(): number {
  const v = Number(localStorage.getItem(RATIO_KEY));
  return v >= MIN && v <= MAX ? v : 0.56;
}

function SplitHeader({ split }: { split: SplitState }) {
  const { setSplit } = useUi();
  const key = split.kind === "session" ? split.key : split.agentId ? agentKey(split.hostId, split.agentId) : "";
  const agent = useAgent(key);
  const hostName = useHosts((h) => (split.kind === "terminal" ? (h.profiles.find((p) => p.id === split.hostId)?.name ?? split.hostId) : ""));
  const title = split.kind === "session" ? (agent?.name ?? "Session") : agent ? `${agent.name} · terminal` : `Terminal · ${hostName}`;
  const expand = () => {
    setSplit(null);
    if (split.kind === "session") {
      const { hostId, agentId } = parseAgentKey(split.key);
      navigate({ name: "agent", hostId, agentId });
    } else navigate({ name: "terminal", hostId: split.hostId, paneId: split.paneId, agentId: split.agentId });
  };
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
      {split.kind === "terminal" ? <SquareTerminal className="size-4 text-mute" /> : agent && <StatusOrb status={COLUMN_STATUS[agent.column]} size={8} label={null} />}
      <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink-2">{title}</span>
      <Tooltip content="Open full view">
        <IconButton label="Open full view" size="sm" onClick={expand}>
          <Maximize2 />
        </IconButton>
      </Tooltip>
      <Tooltip content="Close split" shortcut="Ctrl \">
        <IconButton label="Close split" size="sm" onClick={() => setSplit(null)}>
          <X />
        </IconButton>
      </Tooltip>
    </div>
  );
}

function SplitBody({ split }: { split: SplitState }) {
  if (split.kind === "session") return <SessionPane agentKey={split.key} compact />;
  const target: TermTarget | null = split.paneId ? { kind: "pane", paneId: split.paneId } : split.agentId ? { kind: "agent", agentId: split.agentId } : null;
  if (!target) return <div className="grid h-full place-items-center p-6 text-sm text-mute">Pick an agent to open its terminal here.</div>;
  return <TerminalPane hostId={split.hostId} target={target} mode="control" autoFocus />;
}

/**
 * Split-view frame: the main view on the left, `useUi().split` (terminal or a second session) on
 * the right behind a draggable, keyboard-resizable divider. The ratio persists.
 */
export function SplitFrame({ children }: { children: ReactNode }) {
  const split = useUi((s) => s.split);
  const [ratio, setRatio] = useState(readRatio);
  const [dragging, setDragging] = useState(false);
  const frame = useRef<HTMLDivElement>(null);

  const commit = (r: number) => {
    const v = Math.min(MAX, Math.max(MIN, r));
    setRatio(v);
    localStorage.setItem(RATIO_KEY, String(v));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = frame.current;
    if (!el) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => commit((ev.clientX - rect.left) / rect.width);
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={frame} className={cn("flex h-full min-h-0 min-w-0", dragging && "cursor-col-resize select-none")}>
      <div className="min-h-0 min-w-0" style={{ flex: split ? `0 0 ${ratio * 100}%` : "1 1 100%" }}>
        {children}
      </div>
      <AnimatePresence>
        {split && (
          <motion.div
            key="split"
            className="flex min-h-0 min-w-0 flex-1"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            transition={spring.smooth}
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize split"
              aria-valuemin={MIN * 100}
              aria-valuemax={MAX * 100}
              aria-valuenow={Math.round(ratio * 100)}
              tabIndex={0}
              onPointerDown={onPointerDown}
              onDoubleClick={() => commit(0.5)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") commit(ratio - 0.03);
                else if (e.key === "ArrowRight") commit(ratio + 0.03);
              }}
              className="group relative w-2 shrink-0 cursor-col-resize focus-visible:outline-none"
            >
              <span
                className={cn(
                  "absolute inset-y-3 left-1/2 w-px -translate-x-1/2 rounded-full bg-line-2 transition-all duration-200 group-hover:w-[3px] group-hover:bg-accent group-hover:shadow-[0_0_12px_rgb(163_92_240/0.8)] group-focus-visible:w-[3px] group-focus-visible:bg-accent",
                  dragging && "w-[3px] bg-accent shadow-[0_0_14px_rgb(163_92_240/0.9)]",
                )}
              />
            </div>
            <section className="glass m-2 ml-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-tile" aria-label="Split view">
              <SplitHeader split={split} />
              <div className="min-h-0 flex-1">
                <Suspense fallback={<div className="grid h-full place-items-center"><Spinner size={20} /></div>}>
                  <SplitBody key={split.kind === "session" ? split.key : `${split.hostId}:${split.agentId ?? split.paneId}`} split={split} />
                </Suspense>
              </div>
            </section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
