import { Cpu, Hourglass } from "lucide-react";
import type { JobsSummary } from "@/core/gen";
import { cn, Tooltip } from "@/design";
import { glanceText, meterText, waitingText } from "@/features/session/jobs/jobsModel";

/** Card meter `jobs 2 · 140/190 tests`: running background jobs and omp's freshest widget glance. */
export function JobsMeter({ jobs }: { jobs: JobsSummary }) {
  if (jobs.running === 0) return null;
  const glance = glanceText(jobs.glance);
  return (
    <Tooltip content={<span className="block max-w-64">{`${jobs.running} background job${jobs.running === 1 ? "" : "s"} running${glance && jobs.glanceJob ? ` · ${jobs.glanceJob}: ${glance}` : ""}. Open the session's Jobs tab for output and Kill.`}</span>}>
      <span className="inline-flex max-w-full min-w-0 items-center gap-1 font-mono text-2xs text-mute tabular">
        <Cpu className="size-3 shrink-0 text-accent-hi" aria-hidden />
        jobs <b className="truncate font-bold text-ink-2">{meterText(jobs)}</b>
      </span>
    </Tooltip>
  );
}

/** The running lane's line while the turn is over and only a background job's result can resume it. */
export function WaitingForJobs({ jobs, className }: { jobs: JobsSummary; className?: string }) {
  const glance = glanceText(jobs.glance);
  return (
    <p className={cn("flex min-w-0 items-center gap-2 text-xs text-ink-2", className)} role="status">
      <Hourglass className="size-3.5 shrink-0 text-accent-hi" aria-hidden />
      <span className="min-w-0 truncate">{waitingText(jobs)}</span>
      {glance && <span className="shrink-0 rounded-full bg-white/6 px-1.5 font-mono text-2xs font-bold text-ink-2">{glance}</span>}
    </p>
  );
}
