import { MoonStar } from "lucide-react";
import { useAgent, useResuming } from "@/core";
import { cn, Shimmer, Tooltip } from "@/design";
import { MovedChip } from "@/features/move/MovedChip";
import { EndedChip } from "./EndedChip";

/**
 * Quiet "closed" chip of a parked agent: Mark done closed its pane (and worktree workspace); its
 * omp session stays on disk and resumes when you open its terminal, prompt it, or press Resume. An
 * ended card (its omp ended without anyone closing it) shows `EndedChip` instead, with its ticket.
 */
export function ParkedChip({ agentKey, className }: { agentKey: string; className?: string }) {
  const agent = useAgent(agentKey);
  const parked = agent?.parked;
  const resuming = useResuming(agentKey);
  if (parked?.moved) return <MovedChip agentKey={agentKey} moved={parked.moved} className={className} />;
  if (parked?.ended) return <EndedChip agentKey={agentKey} ended={parked.ended} ar={agent?.autoResume} className={className} />;
  return (
    <Tooltip content={resuming ? "Resuming the session in a new pane…" : "Pane closed when it was marked done · resumes when you need it"}>
      <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full bg-white/6 px-1.5 py-px text-[9.5px] font-bold text-mute-2", className)}>
        <MoonStar className="size-2.5" aria-hidden />
        {resuming ? <Shimmer>resuming…</Shimmer> : "closed"}
      </span>
    </Tooltip>
  );
}
