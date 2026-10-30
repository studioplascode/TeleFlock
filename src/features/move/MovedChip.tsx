import { ArrowRightLeft, MoveRight } from "lucide-react";
import { useResuming } from "@/core";
import type { ParkedMove } from "@/core/gen";
import { cn, Shimmer, Tooltip } from "@/design";
import { useMovedTarget } from "./hosts";
import { openMovedAgent } from "./store";

const base = "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-bold";

/**
 * The parked card's chip for an agent that is moving to another host, was interrupted on the way, or
 * moved: `moving to <host>…`, `move interrupted`, `moved → <host>` (opens it there when this app
 * knows the host and the agent's id on it).
 */
export function MovedChip({ agentKey, moved, className }: { agentKey: string; moved: ParkedMove; className?: string }) {
  const resuming = useResuming(agentKey);
  const target = useMovedTarget(moved);
  if (resuming) {
    return (
      <span className={cn(base, "bg-white/6 text-mute-2", className)}>
        <Shimmer>resuming…</Shimmer>
      </span>
    );
  }
  if (moved.state === "moving") {
    return (
      <Tooltip content={`Being moved to ${moved.to}: its branch, changes and session are on the way`}>
        <span className={cn(base, "bg-accent/14 text-accent-ink", className)}>
          <ArrowRightLeft className="size-2.5" aria-hidden />
          <Shimmer>moving to {moved.to}…</Shimmer>
        </span>
      </Tooltip>
    );
  }
  if (moved.state === "interrupted") {
    return (
      <Tooltip content={`The move to ${moved.to} stopped before it was confirmed. ${moved.to} may or may not run this agent now: check ${moved.to} before resuming here.`}>
        <span className={cn(base, "bg-warn/14 text-warn", className)}>
          <ArrowRightLeft className="size-2.5" aria-hidden />
          move interrupted
        </span>
      </Tooltip>
    );
  }
  const open = target && moved.agentId ? () => openMovedAgent(target.id, moved.agentId as string) : undefined;
  const tip = `Moved to ${moved.to} on ${new Date(moved.at).toLocaleString()}${open ? " · click to open it there" : ""}. Resuming here continues an older copy as a fork.`;
  const inner = (
    <>
      <MoveRight className="size-2.5" aria-hidden />
      moved → {moved.to}
    </>
  );
  return (
    <Tooltip content={tip}>
      {open ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
          className={cn(base, "bg-white/6 text-mute-2 transition-colors hover:bg-white/10 hover:text-ink focus-ring", className)}
        >
          {inner}
        </button>
      ) : (
        <span className={cn(base, "bg-white/6 text-mute-2", className)}>{inner}</span>
      )}
    </Tooltip>
  );
}
