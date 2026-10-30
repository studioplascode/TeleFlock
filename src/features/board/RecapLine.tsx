import { ScrollText } from "lucide-react";
import type { Agent, IdleRecap } from "@/core/gen";
import { cn, formatAge, Tooltip, useNow } from "@/design";
import { currentRecap, restingLine } from "./recap";

const CLAMP = { 1: "line-clamp-1", 2: "line-clamp-2" } as const;

/** Tooltip body: whose words these are and how old they are (the clock runs only while it is open). */
function RecapTip({ recap }: { recap: IdleRecap }) {
  const now = useNow(30_000);
  return (
    <span className="block">
      <span className="block text-2xs font-bold text-mute">omp's recap · {formatAge(now - recap.at)}</span>
      <span className="mt-0.5 block font-normal">{recap.text}</span>
    </span>
  );
}

/** omp's idle recap as a quiet line: a scroll mark, the text, its age in the tooltip. */
export function RecapText({ recap, lines = 2, className }: { recap: IdleRecap; lines?: 1 | 2; className?: string }) {
  return (
    <Tooltip content={<RecapTip recap={recap} />}>
      <p tabIndex={0} data-recap className={cn(CLAMP[lines], "rounded-xs text-xs text-ink-2 focus-ring", className)}>
        <ScrollText className="mr-1 inline size-3 -translate-y-px text-accent-hi" aria-label="omp's recap:" />
        {recap.text}
      </p>
    </Tooltip>
  );
}

/** Review and Done cards, phone rows: omp's idle recap, else the last assistant line. */
export function RestingLine({ agent, lines = 2, className }: { agent: Pick<Agent, "column" | "omp" | "live">; lines?: 1 | 2; className?: string }) {
  const line = restingLine(agent);
  if (!line) return null;
  if (line.recap) return <RecapText recap={line.recap} lines={lines} className={className} />;
  return <p className={cn(CLAMP[lines], "text-xs text-mute", className)}>{line.text}</p>;
}

/**
 * Session headers and phone rows: the recap while the agent is idle and has a current one, nothing
 * otherwise (a header's transcript shows the last reply; phone rows stay short).
 */
export function RecapLine({ agent, lines = 1, className }: { agent: Pick<Agent, "column" | "omp">; lines?: 1 | 2; className?: string }) {
  const recap = currentRecap(agent);
  return recap ? <RecapText recap={recap} lines={lines} className={className} /> : null;
}
