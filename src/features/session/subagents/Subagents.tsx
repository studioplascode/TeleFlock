import type { Subagent, SubagentStatus } from "@/core/gen";
import { cn, Elapsed, formatElapsed, formatUsd, Shimmer, type Status, StatusOrb } from "@/design";
import { SubagentMeters } from "./SubagentMeters";
import { outcomeOf } from "./grouping";

/** `parked` (omp's idle park, only from older hostds and caches) is a finished agent: green like done, not its own colour. */
export const SUB_STATUS: Record<SubagentStatus, Status> = { running: "running", done: "done", failed: "error", aborted: "idle", parked: "done" };
export const SUB_LABEL: Record<SubagentStatus, string> = { running: "Running", done: "Done", failed: "Failed", aborted: "Stopped", parked: "Done" };

/** One subagent: orb, name, live line, completion estimate + context, timer. Click opens its transcript + controls. */
export function SubagentCard({ sub, onOpen, dense = false }: { sub: Subagent; onOpen?: () => void; dense?: boolean }) {
  const running = sub.status === "running";
  const outcome = outcomeOf(sub.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-status={SUB_STATUS[sub.status]}
      className={cn(
        "group/sub focus-ring pressable relative flex w-full min-w-0 items-start gap-2.5 overflow-hidden rounded-lg text-left",
        dense ? "px-2 py-1.5 hover:bg-white/[0.04]" : "bg-white/[0.025] px-3 py-2 shadow-hairline hover:bg-white/[0.05] max-md:px-2.5 max-md:py-1.5",
      )}
    >
      {running && <span className="tf-loop live-gradient absolute inset-x-0 top-0 h-[1.5px] opacity-80" aria-hidden />}
      <StatusOrb status={SUB_STATUS[sub.status]} activity={running ? "busy" : "silent"} size={8} className="mt-[5px]" label={SUB_LABEL[sub.status]} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <b className="max-w-full shrink-0 truncate text-[12.5px] font-extrabold text-ink">{sub.name}</b>
          {!dense && sub.description && <span className="min-w-0 truncate text-xs text-mute">{sub.description}</span>}
        </span>
        {sub.line && (
          <span className="mt-0.5 block truncate font-mono text-[11px] text-mute">{running ? <Shimmer>{sub.line}</Shimmer> : sub.line}</span>
        )}
        <SubagentMeters sub={sub} className="mt-1" />
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-2xs font-bold tabular">
        <span className={cn(outcome === "done" ? "text-done" : outcome === "failed" ? "text-error" : "text-mute")}>
          {outcome === "done" && "✓ "}
          {outcome === "failed" && "✗ "}
          {sub.startedAt ? running ? <Elapsed since={sub.startedAt} /> : formatElapsed((sub.endedAt ?? sub.startedAt) - sub.startedAt) : SUB_LABEL[sub.status]}
        </span>
        {!dense && (sub.costUsd != null || sub.toolCount != null) && (
          <span className="text-mute-2">
            {sub.toolCount != null && `${sub.toolCount} tools`}
            {sub.toolCount != null && sub.costUsd != null && " · "}
            {sub.costUsd != null && formatUsd(sub.costUsd)}
          </span>
        )}
      </span>
    </button>
  );
}
