import { useAgent, useHostStale } from "@/core";
import type { AgentProgress } from "@/core/gen";
import { paceText, roundPct, TIME_LEFT_TICK_MS, timeLeft, timeLeftText } from "@/core/progress";
import { cn, formatAge, ProgressRing, Tooltip, useNow } from "@/design";
import { useHerdrDownState } from "@/features/hosts/HerdrControls";

/**
 * The main agent's own estimate of its current turn (`OmpInfo.progress`, TeleFlock's bridge ≥ 2.6.0) while
 * it runs on a host this device reaches with herdr up; else undefined (hostd drops it when the turn ends).
 */
export function useTurnProgress(agentKey: string): AgentProgress | undefined {
  const agent = useAgent(agentKey);
  const stale = useHostStale(agent?.hostId ?? "");
  const herdrDown = useHerdrDownState(agent?.hostId ?? "") !== undefined;
  return agent?.column === "running" && !stale && !herdrDown ? agent.omp?.progress : undefined;
}

/** How old an estimate made at `at` is: "just now" within its first minute (estimates are about minutes), then "3m ago". */
export function madeAgo(at: number, now: number): string {
  return now - at < 60_000 ? "just now" : formatAge(now - at);
}

/** Tooltip lines for a main agent's estimate: the number and its age, the step it named then, the pace it implies. */
export function turnProgressHint(p: AgentProgress, now: number): string[] {
  return [
    `About ${roundPct(p.pct)}% done: the agent's own estimate of its current task, made ${madeAgo(p.at, now)}.`,
    ...(p.stage ? [`Working on: ${p.stage}`] : []),
    paceText(p, now),
    "TeleFlock asks the agent a few times during a turn (first after 2 minutes).",
  ];
}

/**
 * Card meter (desktop card footer, phone row facts): a ring, "64% done" and "· ~7m left" once the estimate
 * tells; the agent's current step and the pace in the tooltip. Nothing until the agent answered, nor once
 * it stops running. Its own 15 s clock: the card never re-renders for it.
 */
export function ProgressChip({ agentKey, className }: { agentKey: string; className?: string }) {
  const progress = useTurnProgress(agentKey);
  const now = useNow(progress ? TIME_LEFT_TICK_MS : null);
  if (!progress) return null;
  const pct = roundPct(progress.pct);
  const left = timeLeft(progress, now);
  return (
    <Tooltip
      content={
        <span className="flex max-w-72 flex-col gap-1">
          {turnProgressHint(progress, now).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      }
    >
      <span className={cn("inline-flex shrink-0 items-center gap-1 font-mono text-2xs text-mute tabular", className)}>
        <ProgressRing done={pct} total={100} size={12} stroke={2} status="idle" label={null} ariaLabel={`About ${pct}% done (the agent's own estimate)`} />
        <span>
          <b className="font-bold text-ink-2">{pct}%</b> done{left && ` · ${timeLeftText(left)}`}
        </span>
      </span>
    </Tooltip>
  );
}
