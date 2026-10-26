import { MoonStar } from "lucide-react";
import { useResuming } from "@/core";
import { cn, Shimmer, Tooltip } from "@/design";

/**
 * Quiet "closed" chip of a parked agent: Mark done closed its pane (and worktree workspace); its
 * omp session stays on disk and resumes when you open its terminal, prompt it, or press Resume.
 */
export function ParkedChip({ agentKey, className }: { agentKey: string; className?: string }) {
  const resuming = useResuming(agentKey);
  return (
    <Tooltip content={resuming ? "Resuming the session in a new pane…" : "Pane closed when it was marked done · resumes when you need it"}>
      <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full bg-white/6 px-1.5 py-px text-[9.5px] font-bold text-mute-2", className)}>
        <MoonStar className="size-2.5" aria-hidden />
        {resuming ? <Shimmer>resuming…</Shimmer> : "closed"}
      </span>
    </Tooltip>
  );
}
