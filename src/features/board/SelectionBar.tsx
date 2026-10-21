import { Archive, ArchiveRestore, Bell, BellOff, Columns2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCore, useSettings, useUi } from "@/core";
import { Kbd, NumberTicker, cn, spring } from "@/design";
import { haptic } from "@/features/shell/haptics";
import { openAgent, setArchived, setMuted, stopAgent } from "./agentActions";
import { useBoard } from "./boardStore";
import { requestArchive } from "./CardMenu";

function BarButton({ label, count, icon, onClick, tone = "neutral", mobile }: { label: string; count?: number; icon: ReactNode; onClick(): void; tone?: "neutral" | "danger" | "accent"; mobile: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md font-bold whitespace-nowrap pressable focus-ring [&_svg]:size-4",
        mobile ? "h-12 flex-col justify-center gap-0.5 px-2.5 text-[10.5px]" : "h-9 px-3 text-xs",
        tone === "danger" ? "text-[#ff8aa5] hover:bg-error/15" : tone === "accent" ? "text-accent-ink hover:bg-accent/20" : "text-ink hover:bg-white/8",
      )}
    >
      {icon}
      <span>
        {label}
        {count !== undefined && count > 0 && <span className="ml-1 text-mute tabular">{count}</span>}
      </span>
    </button>
  );
}

/**
 * Floating bar for the board's multi-selection: archive / unarchive, stop, mute, open in split.
 * Springs up from the bottom while anything is selected. Esc clears (desktop keys live in useBoardKeys).
 */
export function SelectionBar({ mobile = false }: { mobile?: boolean }) {
  const picked = useBoard((s) => s.picked);
  const clear = useBoard((s) => s.clearPicked);
  // lanes of the picked agents, in pick order ("" when the agent vanished)
  const columns = useCore(useShallow((s) => picked.map((k) => s.agents[k]?.column ?? "")));
  const mutedList = useSettings((s) => s.mutedAgents ?? []);

  // drop agents that disappeared (closed panes) from the selection
  useEffect(() => {
    if (columns.some((c) => c === "")) useBoard.setState((s) => ({ picked: s.picked.filter((_, i) => columns[i] !== "") }));
  }, [columns]);

  const keysIn = (col: string) => picked.filter((_, i) => columns[i] === col);
  const review = keysIn("review");
  const done = keysIn("done");
  const running = keysIn("running");
  const allMuted = picked.length > 0 && picked.every((k) => mutedList.includes(k));
  const run = (fn: () => void) => () => {
    haptic("select");
    fn();
  };

  return (
    <AnimatePresence>
      {picked.length > 0 && (
        <motion.div
          key="selection-bar"
          role="toolbar"
          aria-label={`${picked.length} selected`}
          initial={{ y: 80, opacity: 0, scale: 0.94 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 80, opacity: 0, scale: 0.94 }}
          transition={spring.bouncy}
          className={cn(
            mobile ? "bottom-[calc(84px+env(safe-area-inset-bottom))] max-w-[calc(100vw-20px)] overflow-x-auto no-scrollbar" : "bottom-6",
            "fixed left-1/2 z-sticky flex items-center gap-1 rounded-lg glass p-1.5 shadow-[var(--shadow-d3),0_0_0_1px_rgb(163_92_240/0.35),0_18px_50px_-12px_rgb(163_92_240/0.5)]",
          )}
          style={{ x: "-50%" }}
        >
          <span className={cn("flex shrink-0 items-center gap-1.5 rounded-md bg-accent/16 font-display font-bold text-accent-ink", mobile ? "h-12 px-3 text-sm" : "h-9 px-3 text-sm")}>
            <NumberTicker value={picked.length} />
            {!mobile && " selected"}
          </span>
          {review.length > 0 && <BarButton mobile={mobile} label="Archive" count={review.length} icon={<Archive />} onClick={run(() => requestArchive(review))} />}
          {done.length > 0 && (
            <BarButton mobile={mobile} label="Unarchive" count={done.length} icon={<ArchiveRestore />} onClick={run(() => done.forEach((k) => void setArchived(k, false).catch(() => {})))} />
          )}
          {running.length > 0 && (
            <BarButton
              mobile={mobile}
              label="Stop"
              count={running.length}
              tone="danger"
              icon={
                <svg viewBox="0 0 16 16" aria-hidden>
                  <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
              }
              onClick={run(() => running.forEach((k) => void stopAgent(k)))}
            />
          )}
          <BarButton
            mobile={mobile}
            label={allMuted ? "Unmute" : "Mute"}
            icon={allMuted ? <Bell /> : <BellOff />}
            onClick={run(() => void setMuted(picked, !allMuted))}
          />
          <BarButton
            mobile={mobile}
            label={mobile ? "Open" : "Open in split"}
            tone="accent"
            icon={<Columns2 />}
            onClick={run(() => {
              const first = picked[0];
              if (!first) return;
              if (mobile) openAgent(first);
              else useUi.getState().setSplit({ kind: "session", key: first });
            })}
          />
          <span className="mx-0.5 h-6 w-px shrink-0 bg-line-2" aria-hidden />
          <BarButton mobile={mobile} label="Clear" icon={<X />} onClick={run(clear)} />
          {!mobile && <Kbd className="mr-1.5 ml-0.5">Esc</Kbd>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
